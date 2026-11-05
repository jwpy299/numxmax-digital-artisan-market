/**
 * terminalMeetings —— 会议/群智/枢总参谋模块（v155 从 terminal.ts 拆出，P2 巨兽拆分）。
 * 行为零变化：函数逐字搬迁；terminal.ts 以 export * 再导出，既有 import 站点不受影响。
 *
 * P1-3 拆域收口：本件**不再直接依赖 terminal.ts**——与 terminal.ts 共用的基础件
 * （requireHqAdmin / stQuery / rawRows / listActiveAgents / listDepartments /
 *  buildContextDigest / HEAD_REQUIRED / TERMINAL_TABLES_HINT）已抽至 ./terminalShared。
 *
 * ⚠️ 环的真实状态（门禁 portal#31 轮1 票②指出，此处更正此前失实描述）：
 *   本件新引入的 `./staff` 静态 import 构成**间接环**：
 *     terminal.ts → terminalMeetings.ts → staff.ts → terminal.ts
 *   （staff.ts:24-32 从 ./terminal 静态 import 7 件）。
 *   **直连环已消除，间接环仍在**，且今天不崩**仅因** `requireStaff` 是提升的函数声明、
 *   只在 `meetingActor` 内部调用（非模块求值期）—— 这是**脆弱性，不是安全性**。
 *   真断环的步骤（后续项 P1-3b）：把 `findAgentByCode` / `llmReplyOrDegraded` / `clip`
 *   连同 `LlmReply` 接口与 `DEGRADED_PREFIX` 一并上提至 ./terminalShared，
 *   再把 staff.ts:24-32 的 import 从 ./terminal 改指 ./terminalShared。
 *   （其中 requireAdmin / rawRows / buildContextDigest / collectKpis **已在 terminalShared**，
 *    仅剩上述 3 件 + 2 个类型/常量需要上提；届时 staff.ts 对 ./terminal 的边即为 0。）
 */
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { isNoSuchTable, isBadFieldErr, infraUnavailable500 } from "../auth/identity"; // ④逐点核：canonical 政策件同引
import { getDb } from "../queries/connection";
import { dbProbeTimed } from "../queries/healthProbe"; // DB 自检单点（portal#30 票③：本件手搓探针收口）
import {
  buildContextDigest,
  HEAD_REQUIRED,
  listActiveAgents,
  listDepartments,
  rawRows,
  requireHqAdmin,
  stQuery,
  TERMINAL_TABLES_HINT,
} from "./terminalShared";
import { noteSilent } from "./silentWatch";
import { requireStaff } from "./staff";
import type { SlotId } from "./modelGateway";


// ─── 迭代 28：会议双轨鉴权（admin / staff）───────────────────────────────────
export type MeetingActor =
  | { kind: "admin"; id: number; username: string; displayName: string }
  | { kind: "staff"; id: number; username: string; displayName: string; deptKey: string; staffRole: "head" | "staff" };

/**
 * 双轨鉴权：先 **`requireHqAdmin`**（总部管理员），失败再 `requireStaff`（两者都失败抛 UNAUTHORIZED）。
 *
 * ⚠️ 门禁 portal#31 轮2 票③：原 JSDoc 写「先 requireAdmin」，与实现不符。
 *   **核实结论：此处一直是 `requireHqAdmin`，不是 P1-3 改的** ——
 *   `git show 2e1fefd:api/routers/terminalMeetings.ts:21` 即 `const admin = await requireHqAdmin(token);`，
 *   P1-3 的 diff 未触碰本函数的鉴权分支（仅动了 import 与 `requireMeetingHead` 的 export）。
 *   故门禁票中「本次重构把 requireAdmin 换成 requireHqAdmin」的因果判断**不成立**，
 *   但它指出的**文档与实现失配**成立（且早于本次重构），本轮按实现更正 JSDoc。
 *
 * 语义差（供复核）：`requireAdmin` 接受任意 `role==='admin'`；`requireHqAdmin` 额外拒绝非总部管理员，
 *   被拒者会落到 `requireStaff` 分支。**此处取 HQ 口径是有意的**（会议/群智/枢总属总部职能面）。
 */
export async function meetingActor(token: string): Promise<MeetingActor> {
  try {
    const admin = await requireHqAdmin(token);
    return {
      kind: "admin",
      id: Number(admin.id),
      username: String(admin.username),
      displayName: String(admin.displayName ?? admin.username ?? "管理员"),
    };
  } catch (err) {
    if (!(err instanceof TRPCError)) throw err;
  }
  const staff = await requireStaff(token);
  return {
    kind: "staff",
    id: staff.id,
    username: staff.username,
    displayName: staff.displayName,
    deptKey: staff.deptKey,
    staffRole: staff.role,
  };
}

/** 会议管理类操作守卫：admin 或 staff 负责人；member → FORBIDDEN（P1-3：导出供 terminal.ts 使用） */
export function requireMeetingHead(actor: MeetingActor): void {
  if (actor.kind === "staff" && actor.staffRole !== "head") {
    throw new TRPCError({ code: "FORBIDDEN", message: HEAD_REQUIRED });
  }
}

// ─── 迭代 37：班组 swarm 辅助 ─────────────────────────────────────────────────
/** 模型能力画像 → 网关槽位（preferredModel → SlotId） */
export const SWARM_MODEL_SLOT: Record<string, SlotId> = {
  kimi: "brain",
  deepseek: "flash",
  glm: "chat",
  minimax: "creative",
  // 2026-08-19 海禛云 /v1/models 全量同步扩键（与 modelGateway.ts GATEWAY_CATALOG vendor 对齐）
  claude: "brain",
  gpt: "brain",
  qwen: "chat",
  "gpt-oss": "flash",
  gemma: "flash",
  idoictos: "chat",
};

/** 加载 swarm 任务，不存在即 404 */
export async function loadSwarmOrThrow(swarmId: number): Promise<Record<string, unknown>> {
  const rows = await stQuery(sql`SELECT * FROM st_swarm_tasks WHERE id = ${swarmId} LIMIT 1`);
  if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "协同任务不存在" });
  return rows[0];
}

/** 作用域锁：staff 仅可触本部门 swarm（P8 越权防线） */
export function assertSwarmScope(actor: MeetingActor, swarm: Record<string, unknown>): void {
  if (actor.kind === "staff" && actor.deptKey !== String(swarm.deptKey)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "无权操作其他部门的协同任务" });
  }
}

/** 迭代 38：资料引用留痕（st_dept_doc_refs + usedCount+1；独立副本避免循环依赖）
 *  （P1-3：导出供 terminal.ts 使用） */
export async function recordSwarmDocRefs(
  docIds: number[],
  swarmId: number,
  seatIds: number[],
  actor: string,
): Promise<void> {
  if (docIds.length === 0) return;
  try {
    const db = getDb();
    for (const docId of docIds) {
      for (const seatId of seatIds.length > 0 ? seatIds : [null]) {
        await db.execute(
          sql`INSERT INTO st_dept_doc_refs (docId, usedBy, refId, agentSeatId, actor)
              VALUES (${docId}, 'swarm', ${String(swarmId)}, ${seatId}, ${actor})`,
        );
      }
      await db.execute(sql`UPDATE st_kb_docs SET usedCount = usedCount + 1 WHERE id = ${docId}`);
    }
  } catch {
    // 留痕失败不阻断主流程
  }
}

// ─── 迭代 28：圆桌席位配置（st_meeting_config，无配置回落 5 位默认驻部智能体）─
export interface MeetingSeat {
  deptKey: string;
  agentName: string;
  personaHint: string;
  enabled: boolean;
  isDefault: boolean;
  /** iter99：席位挂熊猫军团成员（"role:ref_key"，NULL=未挂） */
  memberKey: string | null;
}

/** 读取圆桌席位：st_meeting_config 覆盖默认值（按 deptKey 对齐 st_agents.deptCode） */
export async function loadMeetingSeats(): Promise<MeetingSeat[]> {
  const defaults = await listActiveAgents();
  let cfgRows: Array<Record<string, unknown>> = [];
  try {
    cfgRows = rawRows(
      await getDb().execute(
        sql`SELECT dept_key, agent_name, persona_hint, member_key, enabled FROM st_meeting_config`,
      ),
    );
  } catch (err) {
    // ④逐点核对齐 wb canonical：cause 链判别单源（旧顶层正则永不中=死代码面封死）
    if (isNoSuchTable(err)) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: TERMINAL_TABLES_HINT });
    }
    // member_key 列缺失（迁移窗口）：回落无军团席位读取——判别走 isBadFieldErr cause 链（旧 message 正则同族死代码面修）
    if (isBadFieldErr(err)) {
      const fallback = rawRows(
        await getDb().execute(
          sql`SELECT dept_key, agent_name, persona_hint, enabled FROM st_meeting_config`,
        ),
      );
      return seatsFromCfg(defaults, fallback);
    }
    infraUnavailable500("[routers/terminalMeetings] loadMeetingSeats 失败（1146/1054 以外）", err);
  }
  return seatsFromCfg(defaults, cfgRows);
}

/** 配置行 → 席位列表（member_key 归一化） */
function seatsFromCfg(
  defaults: Array<{ deptCode: string; name: string; title: string }>,
  cfgRows: Array<Record<string, unknown>>,
): MeetingSeat[] {
  const cfgByDept = new Map(cfgRows.map((r) => [String(r.dept_key), r]));
  const seatList: MeetingSeat[] = defaults.map((a) => {
    const c = cfgByDept.get(a.deptCode);
    if (!c) {
      return {
        deptKey: a.deptCode,
        agentName: `${a.name}·${a.title}`,
        personaHint: "",
        enabled: true,
        isDefault: true,
        memberKey: null,
      };
    }
    return {
      deptKey: a.deptCode,
      agentName: String(c.agent_name ?? `${a.name}·${a.title}`),
      personaHint: c.persona_hint == null ? "" : String(c.persona_hint),
      enabled: Number(c.enabled ?? 1) === 1,
      isDefault: false,
      memberKey: c.member_key == null || c.member_key === "" ? null : String(c.member_key),
    };
  });
  // M52：配置表启用行中、在役花名册部门之外的席位（如 brand/marketing 部门工作台）
  // 一并纳入——否则这些部门永远无法开会/协作
  const extra: MeetingSeat[] = [];
  for (const [deptKey, c] of cfgByDept) {
    if (defaults.some((a) => a.deptCode === deptKey)) continue;
    if (Number(c.enabled ?? 1) !== 1) continue;
    extra.push({
      deptKey,
      agentName: String(c.agent_name ?? deptKey),
      personaHint: c.persona_hint == null ? "" : String(c.persona_hint),
      enabled: true,
      isDefault: false,
      memberKey: c.member_key == null || c.member_key === "" ? null : String(c.member_key),
    });
  }
  return [...seatList, ...extra];
}

/** iter99：批量读取席位挂载的军团成员档案（enabled=1；memberKey="role:ref_key"） */
export async function loadSeatMembers(
  memberKeys: Array<string | null>,
): Promise<Map<string, { role: string; refKey: string; duty: string; factoryId: number | null }>> {
  const keys = [...new Set(memberKeys.filter((k): k is string => !!k && k.includes(":")))];
  const map = new Map<string, { role: string; refKey: string; duty: string; factoryId: number | null }>();
  for (const key of keys.slice(0, 20)) {
    const [role, refKey] = key.split(":", 2);
    if (!role || !refKey) continue;
    try {
      const rows = await stQuery(
        sql`SELECT role, ref_key AS refKey, duty, factory_id AS factoryId
            FROM st_panda_members
            WHERE role = ${role} AND ref_key = ${refKey} AND enabled = 1 LIMIT 1`,
      );
      if (rows[0]) {
        map.set(key, {
          role: String(rows[0].role),
          refKey: String(rows[0].refKey),
          duty: rows[0].duty == null ? "" : String(rows[0].duty),
          factoryId: rows[0].factoryId == null ? null : Number(rows[0].factoryId),
        });
      }
    } catch (e) {
      noteSilent("meeting.seatMember.load", e);
    }
  }
  return map;
}

// ─── iter76 熊猫组织底座：企业会议室同步流 ──────────────────────────────────
/** 非企业会议室的每条消息同步进 st_enterprise_feed（src_msg_id 幂等；失败打点不阻断）
 *  （P1-3：导出供 terminal.ts 使用） */
export async function pushToEnterpriseFeed(input: {
  srcMsgId: number;
  meetingId: number;
  roomType: string;
  deptKey: string | null;
  participant: string;
  content: string;
  round: number;
}): Promise<void> {
  if (input.roomType === "enterprise" || input.roomType === "legacy") return;
  try {
    await getDb().execute(
      sql`INSERT IGNORE INTO st_enterprise_feed
          (src_msg_id, src_meeting_id, room_type, dept_key, participant, content, round)
          VALUES (${input.srcMsgId}, ${input.meetingId}, ${input.roomType}, ${input.deptKey},
                  ${input.participant.slice(0, 64)}, ${input.content}, ${input.round})`,
    );
  } catch (e) {
    noteSilent("meeting.enterpriseFeed.push", e);
  }
}

/** 读取会议室类型信息（无 room_type 列时回落 legacy）（P1-3：导出供 terminal.ts 使用） */
export async function loadMeetingRoom(meetingId: number): Promise<{ roomType: string; deptKey: string | null }> {
  try {
    const rows = await stQuery(
      sql`SELECT room_type, dept_key FROM st_meetings WHERE id = ${meetingId} LIMIT 1`,
    );
    if (!rows[0]) return { roomType: "legacy", deptKey: null };
    return {
      roomType: String(rows[0].room_type ?? "legacy"),
      deptKey: rows[0].dept_key == null ? null : String(rows[0].dept_key),
    };
  } catch (e) {
    noteSilent("meeting.roomType.load", e);
    return { roomType: "legacy", deptKey: null };
  }
}

// ─── iter89：总经理 AI 参谋「枢总」───────────────────────────────────────────
export const GM_ADVISOR_CODE = "gm-advisor";

/** 「枢总」人设（st_agents 无档案时的内置兜底，与 sync-iter89.mts 落库文案一致）
 *  （P1-3：导出供 terminal.ts 的 gmChat 使用） */
export const GM_ADVISOR_PROMPT =
  "你是「枢总」，广东灵智枢生态科技有限公司 · NumX Max 的总经理 AI 参谋。语气干练务实，回答直给结论与可执行动作，分点表述，不空谈。" +
  "你可以基于驾驶舱实时数据回答经营问题（问数），也可以承接文档类派活（生成周报/任务计划/数据报告等产出物）。" +
  "Token 只按「结算/兑换/计量」口径表述，严禁使用金融/炒作/投机类词汇；不确定的数据不臆造，须说明数据时点与口径。";

/** 驾驶舱聚合上下文（KPI 9 项摘要 + 健康 + 部门/在岗智能体数），单项失败不拖垮整体 */
export async function buildGmContext(): Promise<string> {
  const digest = await buildContextDigest();
  let deptCount = 0;
  let activeAgentCount = 0;
  try {
    const [depts, agentsList] = await Promise.all([listDepartments(), listActiveAgents()]);
    deptCount = depts.length;
    activeAgentCount = agentsList.length;
  } catch {
    // st_ 表未初始化：忽略
  }
  // portal#30 票③：改走共享探针单点（同一 MAX_EXECUTION_TIME hint + 同一脱敏节流留痕）。
  //  此前此处手搓 `SELECT 1`：无语句级上限（挂死语句只能等服务端收尾）、失败静默不留痕——
  //  正是「DB 自检单点」这条纪律的漏网点。
  const { ok: dbOk, latencyMs: dbLatencyMs } = await dbProbeTimed();
  const dbHealth = dbOk ? `正常（${dbLatencyMs}ms）` : "异常";
  return `${digest}\n组织阵列：${deptCount} 个部门、驻部在岗智能体 ${activeAgentCount} 位；统一数据库健康：${dbHealth}。`.slice(0, 600);
}
