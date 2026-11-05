/**
 * meetRoom —— 跨舱会议室（彭总 2026-09-03 令：舱主精灵向其它舱发起项目/经营/订单会议，以会议室形式）。
 *
 * 定位：跨舱协同的「正式场合」——cabinTalk 是串口信，meetRoom 是开大会。
 * - 三类会议：project 项目会 / business 经营会 / order 订单会
 * - 发起：某舱舱主（或成员）发起，邀请一或多个目标舱；两舱成员进同一会议室（st_meetings + participants）
 * - 会议室复用现有会议体系（st_meetings + st_meeting_messages + 纪要生成管线）
 * - 纪律：同厂跨舱；参与人落 participants JSON；发起人+各目标舱舱长收 action 级通知
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { rawRows } from "./terminal";
import { sessionMe } from "./wbSession";
import { emitReport } from "./reportBus";

const MEET_TYPES = ["project", "business", "order"] as const;
const MEET_LABEL: Record<string, string> = { project: "项目会议", business: "经营会议", order: "订单会议" };

export const meetRoomRouter = createRouter({
  /** createCrossCabin（mutation）：发起跨舱会议（发起人所在舱 + 目标舱列表） */
  createCrossCabin: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      meetType: z.enum(MEET_TYPES),
      topic: z.string().trim().min(2).max(128),
      brief: z.string().trim().max(500).optional(),
      targetCabinCodes: z.array(z.string().trim().min(1).max(32)).min(1).max(6),
    }))
    .mutation(async ({ input }) => {
      const session = await sessionMe(input.token);
      const db = getDb();

      // 我的舱：先查我任舱长的舱；没有再看我有任务的舱（两段朴素查询，避开 ORDER BY 表达式坑）
      let myCabin: { id: number; name: string; code: string } | null = null;
      const headRows = rawRows(
        await db.execute(
          sql`SELECT id, name, code FROM st_ent_cabins
              WHERE factory_id=${session.factory.id} AND disabled=0 AND head_user_id=${session.user.id}
              ORDER BY sort ASC LIMIT 1`,
        ),
      ) as unknown as { id: number; name: string; code: string }[];
      if (headRows[0]) {
        myCabin = headRows[0];
      } else {
        const taskRows = rawRows(
          await db.execute(
            sql`SELECT DISTINCT c.id, c.name, c.code FROM st_ent_cabins c
                JOIN st_cabin_tasks t ON t.cabin_id=c.id AND t.assignee_user_id=${session.user.id}
                WHERE c.factory_id=${session.factory.id} AND c.disabled=0 LIMIT 1`,
          ),
        ) as unknown as { id: number; name: string; code: string }[];
        myCabin = taskRows[0] ?? null;
      }

      // 目标舱校验
      const targets: { id: number; name: string; code: string; head_user_id: number | null }[] = [];
      for (const code of input.targetCabinCodes) {
        const rows = rawRows(
          await db.execute(
            sql`SELECT id, name, code, head_user_id FROM st_ent_cabins
                WHERE factory_id=${session.factory.id} AND code=${code} AND disabled=0 LIMIT 1`,
          ),
        ) as unknown as typeof targets;
        const t = rows[0];
        if (!t) throw new TRPCError({ code: "NOT_FOUND", message: `舱码 ${code} 不存在或已停用` });
        if (myCabin && t.id === myCabin.id) continue; // 自己舱不用邀
        targets.push(t);
      }
      if (targets.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "至少要有一个别的舱" });

      // 参与人：发起人 + 我方舱长 + 各目标舱舱长（去重）
      const participantIds = new Set<number>([Number(session.user.id)]);
      if (myCabin) {
        const myHead = rawRows(await db.execute(sql`SELECT head_user_id AS h FROM st_ent_cabins WHERE id=${myCabin.id} LIMIT 1`));
        if (myHead[0]?.h) participantIds.add(Number(myHead[0].h));
      }
      for (const t of targets) if (t.head_user_id) participantIds.add(Number(t.head_user_id));
      const participants = [...participantIds];

      // 建会议室（复用 st_meetings；dept_key=发起舱码，projectTag 记录跨舱组合）
      const cabinNames = [myCabin?.name, ...targets.map((t) => t.name)].filter(Boolean).join("×");
      const ins = await db.execute(
        sql`INSERT INTO st_meetings (topic, status, meetingType, room_type, dept_key, createdBy, participants, projectTag)
            VALUES (${`【${MEET_LABEL[input.meetType]}】${input.topic}`}, 'open', 'full', 'cross-cabin',
                    ${myCabin?.code ?? "x_none"}, ${session.user.id}, ${JSON.stringify(participants)},
                    ${`cross:${cabinNames}`.slice(0, 64)})`,
      );
      const first = Array.isArray(ins) ? (ins as unknown[])[0] : ins;
      const meetingId = Number((first as { insertId?: number })?.insertId ?? 0);

      // 开场消息（会议室第一条，写明议题+舱位组合）
      if (input.brief) {
        try {
          await db.execute(
            sql`INSERT INTO st_meeting_messages (meeting_id, user_id, content, createdAt)
                VALUES (${meetingId}, ${session.user.id}, ${input.brief.slice(0, 500)}, NOW())`,
          );
        } catch { /* 消息表结构差异静默 */ }
      }

      // 通知：发起舱舱长 + 各目标舱舱长（action 级）
      const label = MEET_LABEL[input.meetType];
      for (const uid of participants) {
        if (uid === Number(session.user.id)) continue;
        await emitReport({
          audience: "personal",
          userId: uid,
          factoryId: session.factory.id,
          level: "action",
          sourceRing: "cabin",
          title: `🛰 跨舱${label}邀请：${input.topic}`,
          body: `${session.user.displayName}（${myCabin?.name ?? "个人"}）发起，舱位：${cabinNames}。会议室已开，进工作台参加会议。`,
          dedupeKey: `meet-${meetingId}-${uid}`,
        });
      }
      return { ok: true as const, meetingId, cabins: cabinNames, participants: participants.length };
    }),

  /** myMeetRooms（query）：我的跨舱会议室（我发起/我被邀） */
  myMeetRooms: publicQuery
    .input(z.object({ token: z.string().trim().min(1), limit: z.number().int().min(1).max(30).default(10) }))
    .query(async ({ input }) => {
      const session = await sessionMe(input.token);
      const rows = rawRows(
        await getDb().execute(
          sql`SELECT id, topic, status, meetingType, projectTag, createdBy, createdAt
              FROM st_meetings WHERE room_type='cross-cabin'
              AND (createdBy=${session.user.id} OR JSON_CONTAINS(participants, ${String(Number(session.user.id))}))
              ORDER BY id DESC LIMIT ${input.limit}`,
        ),
      );
      return { meetings: rows };
    }),
});
