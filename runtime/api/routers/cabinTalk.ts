/**
 * cabinTalk —— 舱间协同通道（彭总 2026-09-03 令：精灵通过个人舱与别的舱通话协同）。
 *
 * 定位：精灵是载体——「帮我问问市场舱这周推广排期」→ 生成跨舱协作消息；
 * 目标舱成员（舱长优先）在超终/工作台收到，回话后原路返回发起舱。
 *
 * 纪律：
 * - 同厂跨舱（factory 隔离，跨厂永远摸不到）；
 * - 一切消息留档 st_cabin_messages（审计）；
 * - 目标舱不存在/无成员 → 诚实提示，不假装送达；
 * - 免打扰纪律：emitReport 级 info（不炸人），舱长收 action 级。
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { rawRows } from "./terminal";
import { sessionMe } from "./wbSession";
import { emitReport } from "./reportBus";
import { callSlotChat } from "./modelGateway";

/** 舱码 → 部门码（HQ 舱 x_ops ↔ 部门 ops；企业舱无前缀则原样） */
function cabinToDeptCode(cabinCode: string): string {
  return cabinCode.startsWith("x_") ? cabinCode.slice(2) : cabinCode;
}

/**
 * 驻部智能体起草回话（fire-and-forget）：
 * 目标舱驻部智能体（st_agents.deptCode=舱码剥前缀，active 取第一位）读消息起草建议回话
 * → 存 draft_reply → 舱主收「已起草，请确认」通知；智能体缺席则静默（舱主自己回）。
 */
async function draftByResidentAgent(msgId: number, cabinId: number, factoryId: number, body: string): Promise<void> {
  const db = getDb();
  const cabinRows = rawRows(
    await db.execute(sql`SELECT code, name, head_user_id FROM st_ent_cabins WHERE id=${cabinId} LIMIT 1`),
  ) as unknown as { code: string; name: string; head_user_id: number | null }[];
  const cabin = cabinRows[0];
  if (!cabin) return;
  const deptCode = cabinToDeptCode(cabin.code);
  const agents = rawRows(
    await db.execute(
      sql`SELECT id, name, title FROM st_agents WHERE deptCode=${deptCode} AND status='active' ORDER BY id ASC LIMIT 1`,
    ),
  ) as unknown as { id: number; name: string; title: string }[];
  const agent = agents[0];
  if (!agent) return; // 无驻部智能体 → 舱主自己回（静默）

  const r = await callSlotChat("flash", {
    messages: [
      { role: "system", content: `你是${cabin.name}的驻部智能体「${agent.name}」（${agent.title}）。另一舱的同事发来协作消息，你替舱主起草一段简短回话（≤80 字，专业、给确定口径；数据不确定就说需要舱主确认）。只输出回话文本。` },
      { role: "user", content: body.slice(0, 400) },
    ],
    maxTokens: 200,
    temperature: 0.4,
    timeoutMs: 20000,
    context: "cabin_draft",
  });
  if (!r.ok || !r.content?.trim()) return;
  await db.execute(
    sql`UPDATE st_cabin_messages SET draft_reply=${r.content.trim().slice(0, 500)}, draft_agent_id=${agent.id} WHERE id=${msgId}`,
  );
  // 舱主精灵收「起草完毕请确认」（无舱长 → 全厂 action 级兜底）
  await emitReport({
    audience: cabin.head_user_id ? "personal" : "factory",
    userId: cabin.head_user_id ?? undefined,
    factoryId,
    level: "action",
    sourceRing: "cabin",
    title: `🤖 ${agent.name}（${cabin.name}驻部）已起草回话，请确认`,
    body: r.content.trim().slice(0, 280),
    dedupeKey: `cabin-draft-${msgId}`,
  });
}

async function ensureCabinTalk(): Promise<void> {
  await getDb().execute(sql`
    CREATE TABLE IF NOT EXISTS st_cabin_messages (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      factory_id BIGINT UNSIGNED NOT NULL,
      from_user_id BIGINT UNSIGNED NOT NULL,
      from_cabin_id BIGINT UNSIGNED NULL,
      to_cabin_id BIGINT UNSIGNED NOT NULL,
      kind VARCHAR(12) NOT NULL DEFAULT 'ask',
      body TEXT NOT NULL,
      status VARCHAR(12) NOT NULL DEFAULT 'pending',
      reply TEXT NULL,
      replied_by BIGINT UNSIGNED NULL,
      replied_at DATETIME NULL,
      draft_reply TEXT NULL,
      draft_agent_id BIGINT UNSIGNED NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_to_cabin (to_cabin_id, status),
      KEY idx_from (from_user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

export const cabinTalkRouter = createRouter({
  /** myCabinView（query）：舱视角首屏数据——我所在舱+该舱今天在办+驻官+我舱纪要数（全量用户） */
  myCabinView: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const session = await sessionMe(input.token);
      const db = getDb();
      // 我在哪个舱（舱长优先，其次有任务的舱）
      let myCabin: { id: number; name: string; code: string; head_user_id: number | null } | null = null;
      const headRows = rawRows(
        await db.execute(
          sql`SELECT id, name, code, head_user_id FROM st_ent_cabins
              WHERE factory_id=${session.factory.id} AND disabled=0 AND head_user_id=${session.user.id}
              ORDER BY sort ASC LIMIT 1`,
        ),
      ) as unknown as typeof myCabin extends null ? never : { id: number; name: string; code: string; head_user_id: number | null }[];
      if (headRows[0]) {
        myCabin = headRows[0];
      } else {
        const taskRows = rawRows(
          await db.execute(
            sql`SELECT DISTINCT c.id, c.name, c.code, c.head_user_id FROM st_ent_cabins c
                JOIN st_cabin_tasks t ON t.cabin_id=c.id AND t.assignee_user_id=${session.user.id}
                WHERE c.factory_id=${session.factory.id} AND c.disabled=0 LIMIT 1`,
          ),
        ) as unknown as { id: number; name: string; code: string; head_user_id: number | null }[];
        myCabin = taskRows[0] ?? null;
      }
      if (!myCabin) return { cabin: null };

      const cid = myCabin.id;
      // 全舱在办任务（不只我的）
      const openTasks = rawRows(
        await db.execute(
          sql`SELECT t.title, t.status, u.displayName AS assignee, t.created_at AS createdAt
              FROM st_cabin_tasks t LEFT JOIN wb_users u ON u.id=t.assignee_user_id
              WHERE t.cabin_id=${cid} AND t.status='open'
              ORDER BY t.created_at DESC LIMIT 8`,
        ),
      );
      // 驻官（该舱对应部门的 active 智能体）
      const deptCode = myCabin.code.startsWith("x_") ? myCabin.code.slice(2) : myCabin.code;
      const agentRows = rawRows(
        await db.execute(
          sql`SELECT name, title, avatarEmoji FROM st_agents WHERE deptCode=${deptCode} AND status='active' ORDER BY id ASC LIMIT 1`,
        ),
      );
      // 我舱今日纪要数
      let todayMeetings = 0;
      try {
        const m = rawRows(await db.execute(
          sql`SELECT COUNT(*) AS c FROM st_meetings WHERE dept_key=${myCabin.code} AND createdAt >= CURDATE()`,
        ));
        todayMeetings = Number(m[0]?.c ?? 0);
      } catch { /* 静默 */ }
      // 舱长名
      let headName: string | null = null;
      if (myCabin.head_user_id) {
        const h = rawRows(await db.execute(sql`SELECT displayName FROM wb_users WHERE id=${myCabin.head_user_id} LIMIT 1`));
        headName = h[0]?.displayName ? String(h[0].displayName) : null;
      }
      return {
        cabin: {
          id: cid, name: myCabin.name, code: myCabin.code,
          isHead: Number(myCabin.head_user_id) === Number(session.user.id),
          headName,
          agent: agentRows[0] ?? null,
          openTasks, todayMeetings,
        },
      };
    }),

  /** sendToCabin（mutation）：精灵/工作台向目标舱发协作消息 */
  sendToCabin: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      toCabinCode: z.string().trim().min(1).max(32),
      body: z.string().trim().min(1).max(500),
      kind: z.enum(["ask", "request", "fyi"]).default("ask"),
    }))
    .mutation(async ({ input }) => {
      const session = await sessionMe(input.token);
      const db = getDb();
      await ensureCabinTalk();

      // 目标舱
      const target = rawRows(
        await db.execute(
          sql`SELECT id, name, head_user_id FROM st_ent_cabins
              WHERE factory_id=${session.factory.id} AND code=${input.toCabinCode} AND disabled=0 LIMIT 1`,
        ),
      ) as unknown as { id: number; name: string; head_user_id: number | null }[];
      const cabin = target[0];
      if (!cabin) throw new TRPCError({ code: "NOT_FOUND", message: "没找到这个舱（舱码不对或已停用）" });

      // 我的源舱（我是舱长或我有任务的舱，取第一个）
      const mine = rawRows(
        await db.execute(
          sql`SELECT DISTINCT c.id, c.name FROM st_ent_cabins c
              LEFT JOIN st_cabin_tasks t ON t.cabin_id=c.id AND t.assignee_user_id=${session.user.id}
              WHERE c.factory_id=${session.factory.id} AND c.disabled=0
                AND (c.head_user_id=${session.user.id} OR t.id IS NOT NULL)
              LIMIT 1`,
        ),
      ) as unknown as { id: number; name: string }[];
      const fromCabinId = mine[0]?.id ?? null;

      const ins = await db.execute(
        sql`INSERT INTO st_cabin_messages (factory_id, from_user_id, from_cabin_id, to_cabin_id, kind, body)
            VALUES (${session.factory.id}, ${session.user.id}, ${fromCabinId}, ${cabin.id}, ${input.kind}, ${input.body})`,
      );
      const first = Array.isArray(ins) ? (ins as unknown[])[0] : ins;
      const msgId = Number((first as { insertId?: number })?.insertId ?? 0);

      // 彭总令（2026-09-03）：目标舱驻部智能体先起草回话 → 舱主确认后才回对方舱主
      void draftByResidentAgent(msgId, cabin.id, session.factory.id, input.body).catch(() => {});

      // 通知目标舱：舱长 action 级，无舱长则全舱（enterprise 级 info）
      const kindLabel = input.kind === "request" ? "协作请求" : input.kind === "fyi" ? "知会" : "问询";
      await emitReport({
        audience: cabin.head_user_id ? "personal" : "factory",
        userId: cabin.head_user_id ?? undefined,
        factoryId: session.factory.id,
        level: cabin.head_user_id ? "action" : "info",
        sourceRing: "cabin",
        title: `🛰 舱间${kindLabel}：→ ${cabin.name}`,
        body: `${session.user.displayName}${mine[0] ? `（${mine[0].name}）` : ""}：${input.body.slice(0, 300)}`,
        dedupeKey: `cabin-msg-${msgId}`,
      });
      return { ok: true as const, msgId, toCabin: cabin.name };
    }),

  /** inbox（query）：我舱收到的跨舱消息（舱长看全舱，成员看自己相关） */
  inbox: publicQuery
    .input(z.object({ token: z.string().trim().min(1), status: z.enum(["pending", "replied", "all"]).default("pending") }))
    .query(async ({ input }) => {
      const session = await sessionMe(input.token);
      const db = getDb();
      await ensureCabinTalk();
      // 我是舱长的舱收到的消息 + 发给我的
      const rows = rawRows(
        await db.execute(
          sql`SELECT m.id, m.kind, m.body, m.status, m.reply, m.created_at AS createdAt,
                     u.displayName AS fromName, fc.name AS fromCabinName, tc.name AS toCabinName
              FROM st_cabin_messages m
              JOIN wb_users u ON u.id=m.from_user_id
              LEFT JOIN st_ent_cabins fc ON fc.id=m.from_cabin_id
              JOIN st_ent_cabins tc ON tc.id=m.to_cabin_id
              WHERE m.factory_id=${session.factory.id}
                AND (tc.head_user_id=${session.user.id} OR m.from_user_id=${session.user.id})
                ${input.status === "all" ? sql`` : sql`AND m.status=${input.status}`}
              ORDER BY m.id DESC LIMIT 30`,
        ),
      );
      return { messages: rows };
    }),

  /** approveDraft（mutation）：舱主确认智能体起草（可改稿）→ 正式回话发发起方 */
  approveDraft: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      msgId: z.number().int().positive(),
      finalReply: z.string().trim().min(1).max(500).optional(), // 不传=用起草原文
    }))
    .mutation(async ({ input }) => {
      const session = await sessionMe(input.token);
      const db = getDb();
      const rows = rawRows(
        await db.execute(
          sql`SELECT m.id, m.from_user_id, m.status, m.draft_reply, tc.head_user_id, tc.name AS toName
              FROM st_cabin_messages m JOIN st_ent_cabins tc ON tc.id=m.to_cabin_id
              WHERE m.id=${input.msgId} AND m.factory_id=${session.factory.id} LIMIT 1`,
        ),
      ) as unknown as { id: number; from_user_id: number; status: string; draft_reply: string | null; head_user_id: number | null; toName: string }[];
      const msg = rows[0];
      if (!msg) throw new TRPCError({ code: "NOT_FOUND", message: "消息不存在" });
      if (msg.status !== "pending") throw new TRPCError({ code: "CONFLICT", message: "已回过话了" });
      if (msg.head_user_id != null && Number(msg.head_user_id) !== Number(session.user.id)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "只有目标舱舱长能确认回话" });
      }
      const finalText = (input.finalReply ?? msg.draft_reply ?? "").trim();
      if (!finalText) throw new TRPCError({ code: "BAD_REQUEST", message: "没有可回的内容（起草为空，请手写）" });
      await db.execute(
        sql`UPDATE st_cabin_messages SET status='replied', reply=${finalText}, replied_by=${session.user.id}, replied_at=NOW()
            WHERE id=${input.msgId}`,
      );
      await emitReport({
        audience: "personal",
        userId: Number(msg.from_user_id),
        factoryId: session.factory.id,
        level: "info",
        sourceRing: "cabin",
        title: `🛰 ${msg.toName} 回话了`,
        body: finalText.slice(0, 300),
        dedupeKey: `cabin-reply-${input.msgId}`,
      });
      return { ok: true as const };
    }),

  /** reply（mutation）：回话（目标舱成员回；原路返回发起舱+通知发起人） */
  reply: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      msgId: z.number().int().positive(),
      reply: z.string().trim().min(1).max(500),
    }))
    .mutation(async ({ input }) => {
      const session = await sessionMe(input.token);
      const db = getDb();
      const rows = rawRows(
        await db.execute(
          sql`SELECT m.id, m.from_user_id, m.status, tc.head_user_id, tc.name AS toName
              FROM st_cabin_messages m JOIN st_ent_cabins tc ON tc.id=m.to_cabin_id
              WHERE m.id=${input.msgId} AND m.factory_id=${session.factory.id} LIMIT 1`,
        ),
      ) as unknown as { id: number; from_user_id: number; status: string; head_user_id: number | null; toName: string }[];
      const msg = rows[0];
      if (!msg) throw new TRPCError({ code: "NOT_FOUND", message: "消息不存在" });
      if (msg.status !== "pending") throw new TRPCError({ code: "CONFLICT", message: "已回过话了" });
      // 回话权：舱长在则仅舱长；舱无主（head_user_id NULL）→ 同厂成员可回（防死信）
      if (msg.head_user_id != null && Number(msg.head_user_id) !== Number(session.user.id)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "只有目标舱舱长能回话" });
      }
      await db.execute(
        sql`UPDATE st_cabin_messages SET status='replied', reply=${input.reply}, replied_by=${session.user.id}, replied_at=NOW()
            WHERE id=${input.msgId}`,
      );
      await emitReport({
        audience: "personal",
        userId: Number(msg.from_user_id),
        factoryId: session.factory.id,
        level: "info",
        sourceRing: "cabin",
        title: `🛰 ${msg.toName} 回话了`,
        body: input.reply.slice(0, 300),
        dedupeKey: `cabin-reply-${input.msgId}`,
      });
      return { ok: true as const };
    }),
});
