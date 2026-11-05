/**
 * wbRooms —— M30 班组语音房（腾讯会议式：人与多 Agent 同席协同）。
 *
 * 协同模型：
 * - 真人：TRTC 群组语音房同席说话（join 发 UserSig，与 wbCalls 同密钥同源）；
 * - Agent：不占麦位零房费——房友说一句 @某智能体 的话（say + mention），
 *   服务端走 M28 agentBridge 管线生成应答（≤80字播报体）落房流（kind=agent），
 *   各端本机 TTS 播报——「部门与部门的 Agent 同席对话」由此成立；
 * - 房流（st_voice_room_msgs）是协同总线：人话/Agent 答/系统消息同流按序分发。
 *
 * 权限（与 M16 三级归一一致）：
 * - 开房：admin / manager；进房/说话/拉流：本企业全员（含 staff）；
 * - 关房：房主本人或 admin；Agent 应答永不越权（agentBridge 内部自带技能白名单）。
 *
 * 安全红线（与 wbCalls 同款）：
 * - UserSig 只服务端签发，SecretKey 仅 env（TRTC_SDK_APP_ID/TRTC_SECRET_KEY），绝不下发/打日志；
 * - 房间与消息严格 factoryId 隔离；房号 room_{id} 不可枚举（join 必须显式房 id+企业校验）；
 * - agentSpeak 限频：同房 60s 内 ≤12 次 Agent 应答（防房流轰炸）。
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { sessionMe, normalizeRole } from "./wbSession";
import { stQuery } from "./terminal";
import { sql } from "drizzle-orm";
import { trtcSdkAppId, userSigFor } from "./wbCalls";
import { findAgentByCode } from "./terminal";
import { runWorkbenchAgentTask } from "./agentBridge";

const tokenInput = z.object({ token: z.string().trim().min(1) });

/** Agent 应答限频：同房 60s ≤12 次 */
// 限频窗口常量（口径文档用；实现按 SQL DATE_SUB 1 分钟窗口）
void 0;
const AGENT_SPEAK_LIMIT = 12;

interface RoomRow {
  id: number;
  factoryId: number;
  roomId: string;
  title: string;
  createdBy: number;
  agentCodes: string;
  status: string;
  createdAt: unknown;
}

/**
 * agentCodes 解析（双驱动兼容）：mysql2 对 JSON 列默认返回已解析的 JS 数组，
 * 部分链路返回 JSON 文本——两种都接；绝不 String(数组)（会变成 "a,b" 伪 JSON）。
 */
function parseAgentCodes(raw: unknown): string[] {
  try {
    if (Array.isArray(raw)) return raw.map((x) => String(x)).filter(Boolean).slice(0, 8);
    if (typeof raw === "string" && raw.trim()) {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean).slice(0, 8) : [];
    }
    return [];
  } catch {
    return [];
  }
}

async function loadRoom(roomDbId: number, factoryId: number): Promise<RoomRow> {
  const rows = await stQuery(
    sql`SELECT id, factoryId, roomId, title, createdBy, agentCodes, status, createdAt
        FROM st_voice_rooms WHERE id = ${roomDbId} AND factoryId = ${factoryId} LIMIT 1`,
  );
  const r = rows[0];
  if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "语音房不存在" });
  return {
    id: Number(r.id),
    factoryId: Number(r.factoryId),
    roomId: String(r.roomId),
    title: String(r.title),
    createdBy: Number(r.createdBy),
    // 原样保留（数组或 JSON 文本），统一由 parseAgentCodes 归一
    agentCodes: (r.agentCodes ?? "[]") as string,
    status: String(r.status),
    createdAt: r.createdAt,
  };
}

function requireOpen(room: RoomRow): void {
  if (room.status !== "open") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "语音房已关闭" });
  }
}

async function insertMsg(opts: {
  roomId: number;
  factoryId: number;
  userId?: number | null;
  agentCode?: string | null;
  kind: "user" | "agent" | "system";
  text: string;
}): Promise<number> {
  const db = getDb();
  const res = (await db.execute(
    sql`INSERT INTO st_voice_room_msgs (roomId, factoryId, userId, agentCode, kind, text)
        VALUES (${opts.roomId}, ${opts.factoryId}, ${opts.userId ?? null}, ${opts.agentCode ?? null},
                ${opts.kind}, ${opts.text.slice(0, 2000)})`,
  )) as unknown;
  const header = Array.isArray(res) ? (res[0] as { insertId?: number }) : {};
  return Number(header?.insertId ?? 0);
}

interface MsgDto {
  id: number;
  kind: string;
  userId: number | null;
  agentCode: string | null;
  speaker: string;
  text: string;
  createdAt: unknown;
}

async function listMsgs(roomDbId: number, factoryId: number, afterId: number, limit: number): Promise<MsgDto[]> {
  const rows = await stQuery(
    sql`SELECT m.id, m.kind, m.userId, m.agentCode, m.text, m.createdAt,
               COALESCE(u.displayName, u.username, '') AS speakerName
        FROM st_voice_room_msgs m
        LEFT JOIN wb_users u ON u.id = m.userId
        WHERE m.roomId = ${roomDbId} AND m.factoryId = ${factoryId} AND m.id > ${afterId}
        ORDER BY m.id ASC LIMIT ${limit}`,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    kind: String(r.kind),
    userId: r.userId == null ? null : Number(r.userId),
    agentCode: r.agentCode == null ? null : String(r.agentCode),
    speaker: String(r.speakerName ?? "") || (r.agentCode ? String(r.agentCode) : "系统"),
    text: String(r.text),
    createdAt: r.createdAt,
  }));
}

export const wbRoomsRouter = createRouter({
  /**
   * create（mutation，admin/manager）：开班组语音房。
   * agentCodes：同席智能体（≤8，必须在役）；房间号 room_{id}。
   */
  create: publicQuery
    .input(
      tokenInput.extend({
        title: z.string().trim().min(2).max(64),
        agentCodes: z.array(z.string().trim().min(1).max(32)).max(8).default([]),
      }),
    )
    .mutation(async ({ input }) => {
      const { user, factory } = await sessionMe(input.token);
      const role = normalizeRole(user.role);
      if (role === "staff") {
        throw new TRPCError({ code: "FORBIDDEN", message: "开语音房需要负责人或管理员权限" });
      }
      // 校验同席智能体在役（不在役直接点名拒绝，绝不静默放行）
      const agents: { code: string; name: string; title: string }[] = [];
      for (const code of input.agentCodes) {
        const a = await findAgentByCode(code);
        if (!a || a.status !== "active") {
          throw new TRPCError({ code: "BAD_REQUEST", message: `智能体 ${code} 不存在或未启用` });
        }
        agents.push({ code: a.code, name: a.name, title: a.title });
      }
      const db = getDb();
      const res = (await db.execute(
        sql`INSERT INTO st_voice_rooms (factoryId, roomId, title, createdBy, agentCodes)
            VALUES (${factory.id}, '', ${input.title}, ${user.id}, ${JSON.stringify(input.agentCodes)})`,
      )) as unknown;
      const header = Array.isArray(res) ? (res[0] as { insertId?: number }) : {};
      const id = Number(header?.insertId ?? 0);
      const roomId = `room_${id}`;
      await db.execute(sql`UPDATE st_voice_rooms SET roomId = ${roomId} WHERE id = ${id}`);
      await insertMsg({
        roomId: id,
        factoryId: factory.id,
        kind: "system",
        text: `「${input.title}」语音房已创建${agents.length ? `，同席智能体：${agents.map((a) => a.name).join("、")}` : ""}。`,
      });
      return { ok: true as const, id, roomId, title: input.title, agents };
    }),

  /** list（query）：本企业语音房（open 在前，closed 近 5 间）。 */
  list: publicQuery.input(tokenInput).query(async ({ input }) => {
    const { factory } = await sessionMe(input.token);
    const rows = await stQuery(
      sql`SELECT r.id, r.roomId, r.title, r.status, r.agentCodes, r.createdAt,
                 COALESCE(u.displayName, u.username, '') AS creatorName
          FROM st_voice_rooms r LEFT JOIN wb_users u ON u.id = r.createdBy
          WHERE r.factoryId = ${factory.id}
          ORDER BY (r.status = 'open') DESC, r.id DESC LIMIT 30`,
    );
    return {
      rooms: rows.map((r) => ({
        id: Number(r.id),
        roomId: String(r.roomId),
        title: String(r.title),
        status: String(r.status),
        agentCodes: parseAgentCodes(r.agentCodes),
        creatorName: String(r.creatorName ?? ""),
        createdAt: r.createdAt,
      })),
    };
  }),

  /**
   * join（mutation，本企业全员）：进房取 TRTC 凭据 + 房流快照（近 50 条）。
   * trtcUserId = String(user.id)，与 UserSig 签发 identifier 同源（wbCalls 同口径）。
   */
  join: publicQuery
    .input(tokenInput.extend({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const { user, factory } = await sessionMe(input.token);
      const room = await loadRoom(input.id, factory.id);
      requireOpen(room);
      const agentCodes = parseAgentCodes(room.agentCodes);
      const agents: { code: string; name: string; title: string }[] = [];
      for (const code of agentCodes) {
        const a = await findAgentByCode(code);
        if (a && a.status === "active") agents.push({ code: a.code, name: a.name, title: a.title });
      }
      return {
        ok: true as const,
        id: room.id,
        roomId: room.roomId,
        title: room.title,
        sdkAppId: trtcSdkAppId(),
        trtcUserId: String(user.id),
        userSig: userSigFor(user.id),
        agents,
        messages: await listMsgs(room.id, factory.id, 0, 50),
      };
    }),

  /**
   * say（mutation）：人说话落房流（App ASR 终句上行，与 voice.utterance 同文本契约）。
   * mention：点名智能体（必须同房同席）；带 mention 时同步触发 Agent 应答（走 agentBridge）。
   */
  say: publicQuery
    .input(
      tokenInput.extend({
        id: z.number().int().positive(),
        text: z.string().trim().min(1).max(500),
        mention: z.string().trim().min(1).max(32).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { user, factory } = await sessionMe(input.token);
      const room = await loadRoom(input.id, factory.id);
      requireOpen(room);
      const msgId = await insertMsg({
        roomId: room.id,
        factoryId: factory.id,
        userId: Number(user.id),
        kind: "user",
        text: input.text,
      });

      // 点名智能体 → 同席校验 + 限频 + agentBridge 应答
      let agentReply: { agentCode: string; agentName: string; text: string; msgId: number } | null = null;
      if (input.mention) {
        const seat = parseAgentCodes(room.agentCodes);
        if (!seat.includes(input.mention)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "这位智能体不在本房席位上" });
        }
        const recent = await stQuery(
          sql`SELECT COUNT(*) AS c FROM st_voice_room_msgs
              WHERE roomId = ${room.id} AND kind = 'agent'
                AND createdAt > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE)`,
        );
        if (Number(recent[0]?.c ?? 0) >= AGENT_SPEAK_LIMIT) {
          throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "智能体应答太密，稍等片刻" });
        }
        const speaker = String(user.displayName ?? user.username ?? "同事");
        const run = await runWorkbenchAgentTask({
          agentCode: input.mention,
          task: `语音房「${room.title}」里，${speaker}对你说：${input.text}`,
          username: String(user.username),
        });
        if (run) {
          const replyText = `${run.reply}`;
          const agentMsgId = await insertMsg({
            roomId: room.id,
            factoryId: factory.id,
            agentCode: run.agentCode,
            kind: "agent",
            text: replyText,
          });
          agentReply = { agentCode: run.agentCode, agentName: run.agentName, text: replyText, msgId: agentMsgId };
        }
      }
      return { ok: true as const, msgId, agentReply };
    }),

  /** messages（query）：增量拉房流（afterId 之后，≤100 条；App 对 agent 消息本机 TTS）。 */
  messages: publicQuery
    .input(
      tokenInput.extend({
        id: z.number().int().positive(),
        afterId: z.number().int().min(0).default(0),
      }),
    )
    .query(async ({ input }) => {
      const { factory } = await sessionMe(input.token);
      const room = await loadRoom(input.id, factory.id);
      return {
        id: room.id,
        status: room.status,
        messages: await listMsgs(room.id, factory.id, input.afterId, 100),
      };
    }),

  /** close（mutation）：房主本人或 admin 关房（幂等）。 */
  close: publicQuery
    .input(tokenInput.extend({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const { user, factory } = await sessionMe(input.token);
      const room = await loadRoom(input.id, factory.id);
      const isOwner = room.createdBy === Number(user.id);
      const isAdmin = normalizeRole(user.role) === "admin";
      if (!isOwner && !isAdmin) {
        throw new TRPCError({ code: "FORBIDDEN", message: "只有房主或管理员能关房" });
      }
      if (room.status === "closed") return { ok: true as const, id: room.id, already: true as const };
      await getDb().execute(
        sql`UPDATE st_voice_rooms SET status = 'closed', closedAt = UTC_TIMESTAMP() WHERE id = ${room.id}`,
      );
      await insertMsg({ roomId: room.id, factoryId: factory.id, kind: "system", text: "语音房已关闭。" });
      return { ok: true as const, id: room.id, already: false as const };
    }),
});
