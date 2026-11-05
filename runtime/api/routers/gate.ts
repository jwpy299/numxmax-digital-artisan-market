/**
 * gate —— iter100「组织中枢」闸门层（M1）。
 *
 * 范式：1 个中枢 × N 个战甲。龙虾（任何发起方）只有申请单（意图），没有枪；
 * 执行器只认闸门签发的双签票据（60 秒过期、一次性）。
 *
 * 链路：意图 st_intents → 双通道投票（策略=授权链 / 宪法=A/B/C/D 分级）
 *      → 双签票据 st_gate_tickets → WAL 执行（st_exec_wal，先写遗嘱再动手，
 *      失败自动 ROLLBACK）→ 日志 append-only（本文件无任何 UPDATE/DELETE 日志路径）。
 *
 * 五条铁律（立项书）：
 * 1. 未知动作类型一律拒绝（白名单 = st_protocols active）；
 * 2. 超时/异常 = 反对票，并产 D 级信号；
 * 3. C 级协议两段式：先 pending_confirm，owner confirm 后才出票执行；
 * 4. 冻结态（st_freeze_events 最新为 freeze 且无后续双方解冻）→ 全厂只读拒绝；
 * 5. 宪法面前人人平等：owner 也不能触发 D 级或绕过票据。
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { stQuery } from "./terminal";
import { GATE_TABLES_HINT, GATE_MISC_TABLES_HINT, BASE_TABLES_HINT } from "./tableHints"; // R7-c144-③/R7-c145-①/R7-c148-①⑤/R7-c160-⑥：412 话术归中立足——gate 族表=sync-iter100 系（sync-terminal.mts 不建本族——指错脚本=运维空跑面封死）
import { txInsertId } from "../queries/txInsertId"; // R7-c144-③/R7-c145-①：事务径单点叶同引（devices 两站同叶——六站锁步；
//  getDb/rawRows/identity 政策件随叶内聚——本文件死绑定摘除）
import { sessionMe } from "./wbSession";
import { requireWbHead } from "./claw";
import { emitSignal } from "./autoEngine";
import { requireAdmin } from "./terminal";
import { runSandboxDispatchCore } from "./sandboxCore";
import { CAP_LEVEL, CAPS_WHITELIST, cancelPendingDeviceCommand, enqueueDeviceCommand } from "./devices";
import { amendmentPayload, notarySign } from "../constitutionNotary";
import { refreshDutyBriefingSnapshot } from "./snapshots";
import { publishBroadcast } from "./streamBus";

/** gate 族查询兜底（R7-c147-③/R7-c149-⑪ bug medium）：stQuery 带本族提示——iter100 系表缺表不再指错 sync-terminal.mts
 *  （412 指错脚本=运维空跑死不露面封死） */
const gateQuery = (statement: ReturnType<typeof sql>) => stQuery(statement, GATE_TABLES_HINT);
// R7-c154-⑩/R7-c160-⑥：三提示常量归中立足单源（tableHints）——本文件不各持（跨文件分裂漂移面封死）
const gateMiscQuery = (statement: ReturnType<typeof sql>) => stQuery(statement, GATE_MISC_TABLES_HINT);
const baseQuery = (statement: ReturnType<typeof sql>) => stQuery(statement, BASE_TABLES_HINT);

/** 双跑开关（按厂灰度）：st_factory_gate.mode，缺省 legacy */
export async function getFactoryGateMode(factoryId: number): Promise<"legacy" | "gate"> {
  try {
    const rows = await gateQuery(
      sql`SELECT mode FROM st_factory_gate WHERE factory_id = ${factoryId} LIMIT 1`,
    );
    return rows[0] && String(rows[0].mode) === "gate" ? "gate" : "legacy";
  } catch {
    return "legacy";
  }
}

// ─── 类型 ────────────────────────────────────────────────────────────────────

interface ProtocolRow {
  code: string;
  name: string;
  level: "A" | "B" | "C" | "D";
  status: string;
}

interface Actor {
  username: string;
  role: string; // owner/admin/member
  factoryId: number;
}

// ─── 白名单：具名协议（active）─────────────────────────────────────────────

async function loadProtocol(code: string): Promise<ProtocolRow | null> {
  const rows = await gateQuery(
    sql`SELECT code, name, level, status FROM st_protocols WHERE code = ${code} AND status = 'active' LIMIT 1`,
  );
  if (!rows[0]) return null;
  return {
    code: String(rows[0].code),
    name: String(rows[0].name),
    level: String(rows[0].level) as ProtocolRow["level"],
    status: String(rows[0].status),
  };
}

// ─── 冻结态 ─────────────────────────────────────────────────────────────────

/** 本厂当前是否冻结：最新 freeze 之后未出现「unfreeze_request + unfreeze」双方序列 */
export async function isFactoryFrozen(factoryId: number): Promise<boolean> {
  const rows = await gateQuery(
    sql`SELECT action FROM st_freeze_events WHERE factory_id = ${factoryId} ORDER BY id DESC LIMIT 20`,
  );
  let frozen = false;
  let sawRequest = false;
  // 倒序扫描：遇 freeze 置 frozen；遇完整解冻序列（request+confirm）解除
  for (const r of rows) {
    const a = String(r.action);
    if (a === "freeze") {
      frozen = true;
      break;
    }
    if (a === "unfreeze") {
      sawRequest = true; // 复用变量：标记已见 confirm
    }
    if (a === "unfreeze_request" && sawRequest) {
      frozen = false;
      break;
    }
  }
  return frozen;
}

// ─── 双通道投票 ─────────────────────────────────────────────────────────────

/** 策略引擎（管人）：owner 为根；admin 为平台根（S3 终端代提）；其余角色须持有效授权链（scope 覆盖该协议） */
async function policyVote(actor: Actor, protocol: ProtocolRow): Promise<{ pass: boolean; note: string }> {
  if (actor.role === "owner") return { pass: true, note: "owner 根授权" };
  if (actor.role === "admin") return { pass: true, note: "admin 平台授权（终端代提）" };
  const rows = await gateQuery(
    sql`SELECT scope FROM st_auth_chains
        WHERE factory_id = ${actor.factoryId} AND grantee = ${actor.username}
          AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY id DESC LIMIT 10`,
  );
  for (const r of rows) {
    try {
      const scope = JSON.parse(String(r.scope)) as unknown;
      if (Array.isArray(scope) && (scope.includes("*") || scope.includes(protocol.code))) {
        return { pass: true, note: `授权链命中（${actor.username} ← 链上授权）` };
      }
    } catch {
      // 非法 scope 行跳过（不认）
    }
  }
  return { pass: false, note: `无有效授权链（${actor.role} ${actor.username} 未被授权 ${protocol.code}）` };
}

/**
 * 宪法引擎（管事）：A/B 按本厂宪法上限；C 不进自动通道（两段式 confirm）；
 * D 永远反对。任何异常 = 反对票 + D 级信号（fail-safe）。
 * M3：宪法引擎可独立部署——env CONSTITUTION_URL 指向独立宪法服务时走 HTTP，
 * 未配置回落本地库（同库同表，行为一致）。
 */
async function readConstitutionLevel(factoryId: number): Promise<string> {
  const remote = process.env.CONSTITUTION_URL;
  if (remote) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    try {
      const resp = await fetch(`${remote.replace(/\/$/, "")}/constitution/${factoryId}`, { signal: ctrl.signal });
      if (!resp.ok) throw new Error(`constitution svc http ${resp.status}`);
      const data = (await resp.json()) as { maxAutoLevel?: string };
      return String(data.maxAutoLevel ?? "A");
    } finally {
      clearTimeout(timer);
    }
  }
  const rows = await gateMiscQuery(
    sql`SELECT max_auto_level AS lv FROM st_auto_constitution WHERE factory_id = ${factoryId} LIMIT 1`,
  );
  return rows[0] ? String(rows[0].lv) : "A";
}

async function constitutionVote(
  factoryId: number,
  protocol: ProtocolRow,
): Promise<{ pass: boolean; needConfirm: boolean; note: string }> {
  try {
    if (protocol.level === "D") {
      return { pass: false, needConfirm: false, note: "D 级协议：永远人工，引擎无权出票" };
    }
    if (protocol.level === "C") {
      return { pass: false, needConfirm: true, note: "C 级协议：需企业主确认后方可出票" };
    }
    const lv = await readConstitutionLevel(factoryId);
    if (protocol.level === "A") return { pass: true, needConfirm: false, note: "A 级：只读自动放行" };
    if (lv === "B") return { pass: true, needConfirm: false, note: "B 级：本厂宪法已开放 B 级自动" };
    return { pass: false, needConfirm: false, note: "B 级协议但本厂宪法上限为 A，拒签" };
  } catch (e) {
    // fail-safe：宪法引擎异常 = 反对票 + D 级信号
    await emitSignal(
      factoryId,
      "ticket",
      "D",
      "宪法引擎投票异常（fail-safe 拒签）",
      `协议 ${protocol.code} 投票时异常：${e instanceof Error ? e.message.slice(0, 120) : "unknown"}，按反对票处理`,
    );
    return { pass: false, needConfirm: false, note: "宪法引擎异常，fail-safe 拒签（已产 D 级信号）" };
  }
}

// ─── 票据 ────────────────────────────────────────────────────────────────────

/** 出票：双签缺一不可；60 秒过期 */
async function issueTicket(
  intentId: number,
  factoryId: number,
  policy: string,
  constitution: string,
): Promise<number> {
  // R7-c143-②/R7-c144-③：事务径走 txInsertId 单点（竞态封死+政策兜底一处）
  return txInsertId(
    // INTERVAL 不能参数化（服务端常量，安全内联）
    sql`INSERT INTO st_gate_tickets (intent_id, factory_id, policy_vote, constitution_vote, expires_at)
        VALUES (${intentId}, ${factoryId}, ${policy}, ${constitution},
                DATE_ADD(NOW(), INTERVAL 60 SECOND))`,
    "[routers/gate] 出票写入失败",
    GATE_TABLES_HINT,
  );
}

/** 执行器入口唯一凭证校验：存在、未过期、未使用、属本厂本意图 → 标记已用（一次性） */
async function consumeTicket(ticketId: number, intentId: number, factoryId: number): Promise<void> {
  const rows = await gateQuery(
    sql`SELECT id, used_at AS usedAt, expires_at AS expiresAt FROM st_gate_tickets
        WHERE id = ${ticketId} AND intent_id = ${intentId} AND factory_id = ${factoryId} LIMIT 1`,
  );
  const t = rows[0];
  if (!t) throw new TRPCError({ code: "FORBIDDEN", message: "票据不存在或与意图不符" });
  if (t.usedAt) throw new TRPCError({ code: "FORBIDDEN", message: "票据已使用（一次性）" });
  if (new Date(String(t.expiresAt)).getTime() < Date.now()) {
    throw new TRPCError({ code: "FORBIDDEN", message: "票据已过期（60 秒有效期）" });
  }
  await gateQuery(sql`UPDATE st_gate_tickets SET used_at = NOW() WHERE id = ${ticketId} AND used_at IS NULL`);
}

// ─── WAL 日志（append-only：本文件只有 INSERT）──────────────────────────────

async function wal(
  ticketId: number,
  intentId: number,
  factoryId: number,
  phase: "prepare" | "execute" | "commit" | "rollback",
  undoPayload: unknown,
  result: unknown,
): Promise<void> {
  await gateQuery(
    sql`INSERT INTO st_exec_wal (ticket_id, intent_id, factory_id, phase, undo_payload, result)
        VALUES (${ticketId}, ${intentId}, ${factoryId}, ${phase},
                ${undoPayload == null ? null : JSON.stringify(undoPayload).slice(0, 4000)},
                ${result == null ? null : JSON.stringify(result).slice(0, 4000)})`,
  );
}

// ─── 协议执行器注册表（真实动作 + 逆操作）──────────────────────────────────

export interface ExecCtx {
  factoryId: number;
  actor: Actor;
  payload: Record<string, unknown>;
  intentId?: number;
  ticketId?: number;
}
interface Executor {
  prepare(ctx: ExecCtx): Promise<unknown>;
  execute(ctx: ExecCtx, prepared: unknown): Promise<unknown>;
  undo(ctx: ExecCtx, prepared: unknown): Promise<void>;
}

export const EXECUTORS: Record<string, Executor> = {
  // P1《沙箱训练派单》B 级：与 legacy dispatch 同一核心，undo=删任务行+回退计数
  // M12 扩展：payload.memberKey='device:<id>' 时路由到设备指令队列（st_device_commands pending），
  // undo=取消该 pending 命令。C 级设备能力（lock/run_script）须 payload.confirmed===true——
  // 执行器跑到即说明已过闸双签，confirmed 是企业主两段式确认的显式回执，缺一不入队。
  sandbox_dispatch: {
    async prepare(ctx) {
      const mk = ctx.payload.memberKey == null ? "" : String(ctx.payload.memberKey);
      if (!mk.startsWith("device:")) return null;
      const deviceId = Number(mk.slice("device:".length));
      if (!Number.isInteger(deviceId) || deviceId <= 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `非法设备路由 memberKey=${mk}（应为 device:<正整数id>）` });
      }
      const cap = ctx.payload.cap == null ? "run_script" : String(ctx.payload.cap).trim();
      if (!(CAPS_WHITELIST as readonly string[]).includes(cap)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `未知设备能力 ${cap}：不在白名单内` });
      }
      if (CAP_LEVEL[cap as keyof typeof CAP_LEVEL] === "C" && ctx.payload.confirmed !== true) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `C 级设备能力 ${cap} 须 payload.confirmed===true（企业主两段式确认回执）`,
        });
      }
      return { deviceRoute: true as const, deviceId, cap };
    },
    async execute(ctx, prepared) {
      if (prepared) {
        const p = prepared as { deviceRoute: true; deviceId: number; cap: string };
        // 幂等键 = gate:<intentId>：同一意图重复执行/重放不会重复下设备命令
        const { memberKey: _mk, confirmed: _cf, cap: _cap, ...cmdPayload } = ctx.payload;
        const r = await enqueueDeviceCommand({
          factoryId: ctx.factoryId,
          deviceId: p.deviceId,
          cap: p.cap,
          payload: cmdPayload,
          // ctx.ticketId 是已核销的执行票据，仅作溯源记录（闸口双签已完成，设备侧不再二次验票）
          ticketId: ctx.ticketId ?? null,
          clientKey: ctx.intentId ? `gate:${ctx.intentId}` : null,
        });
        return { queued: true, deviceId: p.deviceId, commandId: r.commandId, deduped: r.deduped };
      }
      const corps = await gateMiscQuery(
        sql`SELECT id FROM st_corps WHERE factory_id = ${ctx.factoryId} AND status = 'deployed' LIMIT 1`,
      );
      if (!corps[0]) throw new TRPCError({ code: "FORBIDDEN", message: "本厂军团尚未驻场（deployed）" });
      const planRows = await gateMiscQuery(
        sql`SELECT llm_daily_limit AS lim FROM st_factory_plan WHERE factory_id = ${ctx.factoryId} LIMIT 1`,
      );
      const lim = planRows[0] ? Number(planRows[0].lim) : 200;
      const res = await runSandboxDispatchCore(ctx.factoryId, Number(corps[0].id), lim, {
        instruction: String(ctx.payload.instruction ?? ""),
        skillKey: String(ctx.payload.skillKey ?? ""),
        memberKey: ctx.payload.memberKey == null ? undefined : String(ctx.payload.memberKey),
      });
      return { reply: res.reply, score: res.score, pass: res.pass, undo: res.undo };
    },
    async undo(ctx, prepared) {
      // 设备路由：取消该意图入队的 pending 命令（仅 pending 可取消；已 claimed 则说明 agent 已拿走，不动）
      if (prepared && (prepared as { deviceRoute?: boolean }).deviceRoute && ctx.intentId) {
        const rows = await gateMiscQuery(
          sql`SELECT id FROM st_device_commands
              WHERE factory_id = ${ctx.factoryId} AND client_key = ${`gate:${ctx.intentId}`} AND status = 'pending'
              ORDER BY id DESC LIMIT 5`,
        );
        for (const r of rows) await cancelPendingDeviceCommand(Number(r.id), ctx.factoryId);
      }
      // 数字员工路径：execute 把 undo 载荷放在 result.undo，rollback 时不可得；副作用在最后一步才落库，无需逆操作
    },
  },

  // P2《全厂LLM限额调整》C 级：undo=恢复旧限额
  llm_limit_adjust: {
    async prepare(ctx) {
      const rows = await gateMiscQuery(
        sql`SELECT llm_daily_limit AS lim FROM st_factory_plan WHERE factory_id = ${ctx.factoryId} LIMIT 1`,
      );
      if (!rows[0]) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "本厂无套餐记录" });
      return { oldLimit: Number(rows[0].lim) };
    },
    async execute(ctx, prepared) {
      const newLimit = Number(ctx.payload.newLimit);
      if (!Number.isInteger(newLimit) || newLimit < 0 || newLimit > 100000) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "newLimit 须为 0-100000 的整数" });
      }
      await gateMiscQuery(
        sql`UPDATE st_factory_plan SET llm_daily_limit = ${newLimit} WHERE factory_id = ${ctx.factoryId}`,
      );
      return { oldLimit: (prepared as { oldLimit: number }).oldLimit, newLimit };
    },
    async undo(ctx, prepared) {
      const p = prepared as { oldLimit: number };
      await gateMiscQuery(
        sql`UPDATE st_factory_plan SET llm_daily_limit = ${p.oldLimit} WHERE factory_id = ${ctx.factoryId}`,
      );
    },
  },

  // P3《员工离职数字资产清算》C 级：快照→强制下线+收回授权链；undo=恢复
  employee_offboard: {
    async prepare(ctx) {
      const username = String(ctx.payload.username ?? "");
      if (!username) throw new TRPCError({ code: "BAD_REQUEST", message: "payload.username 必填" });
      const users = await baseQuery( // R7-c153-⑤：基座表提示归位
        sql`SELECT id, authToken AS tk FROM wb_users WHERE factoryId = ${ctx.factoryId} AND username = ${username} LIMIT 1`, // tk 只判非空（hadToken）——P3-6 指纹化后语义不变（不做值匹配）
      );
      if (!users[0]) throw new TRPCError({ code: "NOT_FOUND", message: `员工 ${username} 不存在` });
      const chains = await gateQuery(
        sql`SELECT id FROM st_auth_chains
            WHERE factory_id = ${ctx.factoryId} AND grantee = ${username} AND revoked_at IS NULL`,
      );
      return {
        userId: Number(users[0].id),
        hadToken: users[0].tk != null,
        chainIds: chains.map((c) => Number(c.id)),
      };
    },
    async execute(ctx, prepared) {
      const p = prepared as { userId: number; chainIds: number[] };
      const username = String(ctx.payload.username ?? "");
      await baseQuery(sql`UPDATE wb_users SET authToken = NULL WHERE id = ${p.userId}`); // R7-c153-⑤/R7-c154-⑨：基座表提示归位（与同 handler 上方 SELECT 同口径——同表两句不分裂）
      for (const cid of p.chainIds) {
        await gateQuery(sql`UPDATE st_auth_chains SET revoked_at = NOW() WHERE id = ${cid} AND revoked_at IS NULL`);
      }
      return { offboarded: username, revokedChains: p.chainIds.length };
    },
    async undo(_ctx, prepared) {
      const p = prepared as { userId: number; chainIds: number[] };
      // 会话不可逆（安全设计：恢复需员工重新登录），仅恢复授权链
      for (const cid of p.chainIds) {
        await gateQuery(sql`UPDATE st_auth_chains SET revoked_at = NULL WHERE id = ${cid}`);
      }
    },
  },

  // P4《设备预演工单》B 级（M2-4）：生成预演工单；undo=作废工单
  device_rehearsal: {
    async prepare(ctx) {
      const deviceName = String(ctx.payload.deviceName ?? "").trim();
      if (!deviceName || deviceName.length > 128) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "payload.deviceName 必填（≤128 字）" });
      }
      const script = ctx.payload.script == null ? null : String(ctx.payload.script).slice(0, 4000);
      return { deviceName, script };
    },
    async execute(ctx, prepared) {
      const p = prepared as { deviceName: string; script: string | null };
      // R7-c143-②/R7-c144-③：事务径走 txInsertId 单点
      const rehearsalId = await txInsertId(
        sql`INSERT INTO st_device_rehearsals (factory_id, intent_id, ticket_id, device_name, script, status)
            VALUES (${ctx.factoryId}, ${ctx.intentId ?? 0}, ${ctx.ticketId ?? 0},
                    ${p.deviceName}, ${p.script}, 'done')`,
        "[routers/gate] 彩排登记写入失败",
        GATE_TABLES_HINT,
      );
      return { rehearsalId, deviceName: p.deviceName, status: "done" };
    },
    async undo(ctx) {
      // 作废本意图生成的那张预演工单（按 intent_id 精确定位）
      await gateQuery(
        sql`UPDATE st_device_rehearsals SET status = 'cancelled', cancelled_at = NOW()
            WHERE factory_id = ${ctx.factoryId} AND intent_id = ${ctx.intentId ?? 0} AND status = 'done'`,
      );
    },
  },

  // M7-d《集群规划元意图》C 级：读取 st_intent_plans 步骤，逐一独立过闸（每步双签+WAL）；
  // 子步骤含 C 级 → 该步 pending_confirm（两段确认），计划整体挂起待办；任一步失败即中止（依赖有序）。
  // undo：子步骤已各自 WAL 背书，元意图仅将计划标记 cancelled 如实记录，不反向重放（防止双重回滚）。
  intent_plan_submit: {
    async prepare(ctx) {
      const planId = Number(ctx.payload.planId);
      if (!Number.isInteger(planId) || planId <= 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "payload.planId 必填（正整数）" });
      }
      const rows = await gateMiscQuery(
        sql`SELECT id, actor, actor_role AS actorRole, plan_json AS planJson, status
            FROM st_intent_plans WHERE id = ${planId} AND factory_id = ${ctx.factoryId} LIMIT 1`,
      );
      if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: `计划 #${planId} 不存在` });
      const status = String(rows[0].status);
      if (status !== "draft" && status !== "submitted") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: `计划 #${planId} 当前状态 ${status}，不可执行` });
      }
      let steps: Array<{ seq: number; actionType: string; payload?: Record<string, unknown>; dept?: string | null; reason?: string }>;
      try {
        steps = JSON.parse(String(rows[0].planJson)) as typeof steps;
      } catch {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: `计划 #${planId} 步骤数据损坏` });
      }
      if (!Array.isArray(steps) || steps.length === 0) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: `计划 #${planId} 无步骤` });
      }
      return { planId, actor: String(rows[0].actor), actorRole: String(rows[0].actorRole), steps };
    },
    async execute(ctx, prepared) {
      const p = prepared as {
        planId: number;
        actor: string;
        actorRole: string;
        steps: Array<{ seq: number; actionType: string; payload?: Record<string, unknown>; reason?: string }>;
      };
      const results: Array<Record<string, unknown>> = [];
      let hasPending = false;
      let failedNote: string | null = null;
      for (const step of p.steps) {
        try {
          const r = await submitIntent({
            // AI actor 上链：ai:planner:<发起人>，角色沿用发起人快照（认链不认人同一套）
            actor: { username: `ai:planner:${p.actor}`, role: p.actorRole, factoryId: ctx.factoryId },
            actionType: step.actionType,
            payload: step.payload ?? {},
            reason: `规划#${p.planId}·步骤${step.seq}${step.reason ? `：${step.reason}` : ""}`.slice(0, 255),
          });
          results.push({ seq: step.seq, actionType: step.actionType, status: r.status, intentId: r.intentId });
          if (r.status === "pending_confirm") hasPending = true;
        } catch (e) {
          failedNote = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
          results.push({ seq: step.seq, actionType: step.actionType, status: "failed", note: failedNote });
          break; // 步骤有序有依赖：失败即中止，后续不再执行
        }
      }
      const planStatus = failedNote ? "failed" : hasPending ? "pending_confirm" : "executed";
      await gateMiscQuery(
        sql`UPDATE st_intent_plans SET status = ${planStatus}, result_json = ${JSON.stringify(results)},
            handled_at = NOW() WHERE id = ${p.planId} AND factory_id = ${ctx.factoryId}`,
      );
      return { planId: p.planId, planStatus, steps: results };
    },
    async undo(ctx, prepared) {
      const p = prepared as { planId: number };
      await gateMiscQuery(
        sql`UPDATE st_intent_plans SET status = 'cancelled', handled_at = NOW()
            WHERE id = ${p.planId} AND factory_id = ${ctx.factoryId} AND status IN ('draft','submitted','pending_confirm')`,
      );
    },
  },
};

// ─── 闸门核心：意图 → 双签 → WAL 执行 ──────────────────────────────────────

export interface GateSubmitResult {
  intentId: number;
  status: "executed" | "pending_confirm";
  ticketId?: number;
  result?: unknown;
  votes?: { policy: string; constitution: string };
}

/**
 * 提交意图并（可能）执行。C 级协议：confirm=false → pending_confirm；
 * confirm=true（owner 二次确认）→ 出票执行。B/A 级：当场投票出票执行。
 */
export async function submitIntent(opts: {
  actor: Actor;
  actionType: string;
  payload: Record<string, unknown>;
  reason?: string;
  confirm?: boolean;
}): Promise<GateSubmitResult> {
  const { actor } = opts;
  const fid = actor.factoryId;

  // 铁律4：冻结态全厂只读
  if (await isFactoryFrozen(fid)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "本厂处于冻结状态（紧急协议生效中），一切执行只读拒绝" });
  }

  // 铁律1：白名单
  const protocol = await loadProtocol(opts.actionType);
  if (!protocol) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `未知动作类型 ${opts.actionType}：危险动作只允许触发已评审的具名协议`,
    });
  }

  // 落意图单
  // R7-c143-②/R7-c144-③：事务径走 txInsertId 单点
  const intentId = await txInsertId(
    sql`INSERT INTO st_intents (factory_id, actor, action_type, payload, reason, status)
        VALUES (${fid}, ${actor.username}, ${protocol.code}, ${JSON.stringify(opts.payload).slice(0, 4000)},
                ${opts.reason?.slice(0, 255) ?? null}, 'pending')`,
    "[routers/gate] 意图登记写入失败",
    GATE_TABLES_HINT,
  );

  // 双通道投票
  const pv = await policyVote(actor, protocol);
  const cv = await constitutionVote(fid, protocol);

  if (!pv.pass) {
    await gateQuery(sql`UPDATE st_intents SET status = 'rejected', handled_at = NOW() WHERE id = ${intentId}`);
    throw new TRPCError({ code: "FORBIDDEN", message: `策略引擎拒签：${pv.note}` });
  }
  if (cv.needConfirm && !opts.confirm) {
    await gateQuery(sql`UPDATE st_intents SET status = 'pending_confirm' WHERE id = ${intentId}`);
    return {
      intentId,
      status: "pending_confirm",
      votes: { policy: pv.note, constitution: cv.note },
    };
  }
  if (!cv.pass && !cv.needConfirm) {
    await gateQuery(sql`UPDATE st_intents SET status = 'rejected', handled_at = NOW() WHERE id = ${intentId}`);
    throw new TRPCError({ code: "FORBIDDEN", message: `宪法引擎拒签：${cv.note}` });
  }
  if (cv.needConfirm && opts.confirm && actor.role !== "owner" && actor.role !== "admin") {
    await gateQuery(sql`UPDATE st_intents SET status = 'rejected', handled_at = NOW() WHERE id = ${intentId}`);
    throw new TRPCError({ code: "FORBIDDEN", message: "C 级协议确认必须由企业主（owner）或平台管理员（admin）本人发起" });
  }

  // 出票（双签；票据列存短码，投票说明进返回与日志）
  const ticketId = await issueTicket(
    intentId,
    fid,
    pv.pass ? "pass" : "reject",
    cv.needConfirm ? "confirm" : cv.pass ? "pass" : "reject",
  );

  // WAL 执行（执行器只认票据）
  const executor = EXECUTORS[protocol.code];
  if (!executor) {
    await gateQuery(sql`UPDATE st_intents SET status = 'failed', handled_at = NOW() WHERE id = ${intentId}`);
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `协议 ${protocol.code} 执行器未注册` });
  }
  const ctx: ExecCtx = { factoryId: fid, actor, payload: opts.payload, intentId, ticketId };
  let prepared: unknown = null;
  try {
    await consumeTicket(ticketId, intentId, fid); // 铁律：无票/废票不得执行
    prepared = await executor.prepare(ctx);
    await wal(ticketId, intentId, fid, "prepare", prepared, null);
    const result = await executor.execute(ctx, prepared);
    await wal(ticketId, intentId, fid, "execute", null, result);
    await wal(ticketId, intentId, fid, "commit", null, { ok: true });
    await gateQuery(sql`UPDATE st_intents SET status = 'executed', handled_at = NOW() WHERE id = ${intentId}`);
    // M8-b 快照引擎钩子：执行成功落库后异步刷新值守晨报快照（fire-and-forget，绝不阻塞/影响主流程返回值）
    refreshDutyBriefingSnapshot();
    // M9-a 主动播报钩子：执行成功 → 广播事件（同步返回、内部吞异常，persona 规则只播 B/C 级）
    publishBroadcast({ factoryId: fid, level: protocol.level, title: `协议执行成功：${protocol.name}` });
    return { intentId, status: "executed", ticketId, result, votes: { policy: pv.note, constitution: cv.note } };
  } catch (e) {
    // 失败 → ROLLBACK：重放逆操作（sandbox_dispatch 的 undo 载荷在 execute 结果里取不到时按协议特判）
    let undoErr: string | null = null;
    try {
      // sandbox_dispatch 数字员工路径 undo 为空操作（副作用在最后一步落库，LLM 失败前无写入）；
      // device:<id> 路由路径 undo 会取消 pending 设备命令（仅 pending 可取消，安全）
      await executor.undo(ctx, prepared);
      await wal(ticketId, intentId, fid, "rollback", prepared, { undone: true });
    } catch (ue) {
      undoErr = ue instanceof Error ? ue.message.slice(0, 200) : String(ue).slice(0, 200);
      await wal(ticketId, intentId, fid, "rollback", prepared, { undone: false, error: undoErr });
    }
    await gateQuery(sql`UPDATE st_intents SET status = 'failed', handled_at = NOW() WHERE id = ${intentId}`);
    await emitSignal(
      fid,
      "ticket",
      "C",
      `协议执行失败已回滚：${protocol.name}`,
      `意图 #${intentId} 执行失败（${e instanceof Error ? e.message.slice(0, 120) : "unknown"}），WAL 已回滚${undoErr ? `（回滚异常：${undoErr}）` : ""}，需企业关注`,
    );
    throw e instanceof TRPCError
      ? e
      : new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "协议执行失败，已自动回滚" });
  }
}

// ─── 评审核心（供 protocolReview/protocolDeprecate 端点与 M7-e adminAi.reviewCommand 复用）──

/** 评审协议：approve→active / reject→rejected，全程 st_protocol_reviews 留痕 */
export async function reviewProtocolCore(
  reviewer: string,
  code: string,
  decision: "approve" | "reject",
  comment?: string,
): Promise<{ ok: true; code: string; status: string }> {
  const rows = await gateQuery(sql`SELECT status FROM st_protocols WHERE code = ${code} LIMIT 1`);
  if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: `协议 ${code} 不存在` });
  const st = String(rows[0].status);
  if (st !== "draft" && st !== "reviewing") {
    throw new TRPCError({ code: "BAD_REQUEST", message: `协议 ${code} 当前为 ${st}，不在待评审状态（draft/reviewing）` });
  }
  const next = decision === "approve" ? "active" : "rejected";
  await gateQuery(
    sql`UPDATE st_protocols SET status = ${next}, reviewed_by = ${decision === "approve" ? reviewer : null} WHERE code = ${code}`,
  );
  await gateQuery(
    sql`INSERT INTO st_protocol_reviews (protocol_code, action, reviewer, comment) VALUES (${code}, ${decision}, ${reviewer}, ${comment ?? null})`,
  );
  return { ok: true as const, code, status: next };
}

/** 废止 active 协议（白名单即刻失效），全程留痕 */
export async function deprecateProtocolCore(
  reviewer: string,
  code: string,
  comment?: string,
): Promise<{ ok: true; code: string; status: string }> {
  const rows = await gateQuery(sql`SELECT status FROM st_protocols WHERE code = ${code} LIMIT 1`);
  if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: `协议 ${code} 不存在` });
  if (String(rows[0].status) !== "active") {
    throw new TRPCError({ code: "BAD_REQUEST", message: `仅 active 协议可废止（当前 ${String(rows[0].status)}）` });
  }
  await gateQuery(sql`UPDATE st_protocols SET status = 'deprecated' WHERE code = ${code}`);
  await gateQuery(
    sql`INSERT INTO st_protocol_reviews (protocol_code, action, reviewer, comment) VALUES (${code}, 'deprecate', ${reviewer}, ${comment ?? null})`,
  );
  return { ok: true as const, code, status: "deprecated" };
}

// ─── 路由 ────────────────────────────────────────────────────────────────────

const tokenInput = z.object({ token: z.string().trim().min(1) });

export const gateRouter = createRouter({
  /** gate.protocols（query, wb）：本厂可见的具名协议集（active） */
  protocols: publicQuery.input(tokenInput).query(async ({ input }) => {
    await sessionMe(input.token);
    const rows = await gateQuery(
      sql`SELECT code, name, level, version, script FROM st_protocols WHERE status = 'active' ORDER BY level, code`,
    );
    return {
      protocols: rows.map((r) => ({
        code: String(r.code),
        name: String(r.name),
        level: String(r.level),
        version: Number(r.version),
        script: r.script == null ? null : String(r.script),
      })),
    };
  }),

  /** gate.intentSubmit（mutation, wb）：提交意图（B 当场执行 / C 两段式） */
  intentSubmit: publicQuery
    .input(
      tokenInput.extend({
        actionType: z.string().trim().min(1).max(48),
        payload: z.record(z.string(), z.unknown()).optional().default({}),
        reason: z.string().trim().max(255).optional(),
        confirm: z.boolean().optional().default(false),
      }),
    )
    .mutation(async ({ input }) => {
      const { user, factory } = await sessionMe(input.token);
      return submitIntent({
        actor: { username: String(user.username), role: String(user.role), factoryId: Number(factory.id) },
        actionType: input.actionType,
        payload: input.payload as Record<string, unknown>,
        reason: input.reason,
        confirm: input.confirm,
      });
    }),

  /** gate.intents（query, wb）：本厂意图流水（最近 50） */
  intents: publicQuery.input(tokenInput).query(async ({ input }) => {
    const { factory } = await sessionMe(input.token);
    const rows = await gateQuery(
      sql`SELECT id, actor, action_type AS actionType, payload, status, reason, created_at AS createdAt, handled_at AS handledAt
          FROM st_intents WHERE factory_id = ${factory.id} ORDER BY id DESC LIMIT 50`,
    );
    return {
      intents: rows.map((r) => ({
        id: Number(r.id),
        actor: String(r.actor),
        actionType: String(r.actionType),
        // M11 补：确认重放需要原载荷（两段式 confirm 语义 = 同 actionType+payload+reason 带 confirm:true 重提）
        payload: r.payload == null ? null : String(r.payload).slice(0, 4000),
        status: String(r.status),
        reason: r.reason == null ? null : String(r.reason),
        createdAt: r.createdAt ? String(r.createdAt) : null,
        handledAt: r.handledAt ? String(r.handledAt) : null,
      })),
    };
  }),

  /** gate.wal（query, wb owner）：本厂执行日志（append-only，只读） */
  wal: publicQuery.input(tokenInput).query(async ({ input }) => {
    const { factory } = await requireWbHead(input.token);
    const rows = await gateQuery(
      sql`SELECT id, ticket_id AS ticketId, intent_id AS intentId, phase, result, created_at AS createdAt
          FROM st_exec_wal WHERE factory_id = ${factory.id} ORDER BY id DESC LIMIT 100`,
    );
    return {
      entries: rows.map((r) => ({
        id: Number(r.id),
        ticketId: Number(r.ticketId),
        intentId: Number(r.intentId),
        phase: String(r.phase),
        result: r.result == null ? null : String(r.result),
        createdAt: r.createdAt ? String(r.createdAt) : null,
      })),
    };
  }),

  // ─── 授权链 ──────────────────────────────────────────────────────────────

  /** gate.authGrant（mutation, wb）：向下授权。owner 直签 depth=0；持链者可把【自身链 scope 子集】向下转授（depth+1，级联） */
  authGrant: publicQuery
    .input(
      tokenInput.extend({
        grantee: z.string().trim().min(1).max(64),
        scope: z.array(z.string().trim().min(1).max(48)).min(1).max(20),
        expiresInDays: z.number().int().min(1).max(365).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { user, factory } = await sessionMe(input.token);
      const isOwner = String(user.role) === "owner";
      if (input.grantee === String(user.username)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "不能给自己签发授权链" });
      }
      // 被授权人须为本厂真实用户
      const target = await baseQuery( // R7-c153-⑤：基座表提示归位
        sql`SELECT username FROM wb_users WHERE factoryId = ${factory.id} AND username = ${input.grantee} LIMIT 1`,
      );
      if (!target[0]) throw new TRPCError({ code: "NOT_FOUND", message: `用户 ${input.grantee} 不在本厂` });

      // 级联校验：非 owner 的签发人必须持有覆盖所授 scope 的有效链；父链=最浅覆盖链
      let parentId: number | null = null;
      let depth = 0;
      let grantorExpiry: string | null = null;
      if (!isOwner) {
        const mine = await gateQuery(
          sql`SELECT id, scope, depth, expires_at AS expiresAt FROM st_auth_chains
              WHERE factory_id = ${factory.id} AND grantee = ${String(user.username)}
                AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())
              ORDER BY depth ASC, id DESC LIMIT 20`,
        );
        for (const want of input.scope) {
          const cover = mine.find((r) => {
            try {
              const s = JSON.parse(String(r.scope)) as unknown;
              return Array.isArray(s) && (s.includes("*") || s.includes(want));
            } catch {
              return false;
            }
          });
          if (!cover) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: `转授越界：你未持有覆盖 ${want} 的有效授权链（链断权死，无权转授）`,
            });
          }
          if (parentId === null) {
            parentId = Number(cover.id);
            depth = Number(cover.depth) + 1;
            grantorExpiry = cover.expiresAt ? String(cover.expiresAt) : null;
          }
        }
      }

      const days = input.expiresInDays ?? null;
      // INTERVAL 不能参数化：days 已经过 zod int 1-365 校验，Number 内联安全
      // 下游链有效期不得超过父链有效期（父链永不过期时不受限）
      const expiryFrag = days
        ? sql.raw(`DATE_ADD(NOW(), INTERVAL ${Number(days)} DAY)`)
        : sql.raw("NULL");
      await gateQuery(
        sql`INSERT INTO st_auth_chains (factory_id, parent_id, depth, grantor, grantee, scope, expires_at)
            VALUES (${factory.id}, ${parentId}, ${depth}, ${String(user.username)}, ${input.grantee},
                    ${JSON.stringify(input.scope)},
                    ${expiryFrag})`,
      );
      // 若父链有效期短于下游链，收敛下游有效期至父链（链在权在，链断权死）
      if (grantorExpiry) {
        await gateQuery(
          sql`UPDATE st_auth_chains SET expires_at = ${grantorExpiry}
              WHERE factory_id = ${factory.id} AND grantee = ${input.grantee} AND revoked_at IS NULL
                AND (expires_at IS NULL OR expires_at > ${grantorExpiry})`,
        );
      }
      return { ok: true as const, grantee: input.grantee, scope: input.scope, depth };
    }),

  /** gate.authRevoke（mutation, wb）：收回授权。owner 可收任何人；持链者可收自己签发的下游。级联吊销全部子孙链 */
  authRevoke: publicQuery
    .input(tokenInput.extend({ grantee: z.string().trim().min(1).max(64) }))
    .mutation(async ({ input }) => {
      const { user, factory } = await sessionMe(input.token);
      const isOwner = String(user.role) === "owner";
      const fid = Number(factory.id);
      const targets = await gateQuery(
        sql`SELECT id, grantor FROM st_auth_chains
            WHERE factory_id = ${fid} AND grantee = ${input.grantee} AND revoked_at IS NULL`,
      );
      const allowed = isOwner
        ? targets
        : targets.filter((t) => String(t.grantor) === String(user.username));
      if (targets.length > 0 && allowed.length === 0) {
        throw new TRPCError({ code: "FORBIDDEN", message: "仅企业主或该链签发人可收回授权" });
      }
      // 级联吊销：目标链 + BFS 全部子孙链（链断权死）
      const queue: number[] = allowed.map((t) => Number(t.id));
      for (const t of allowed) {
        await gateQuery(sql`UPDATE st_auth_chains SET revoked_at = NOW() WHERE id = ${Number(t.id)} AND revoked_at IS NULL`);
      }
      let cascaded = 0;
      while (queue.length > 0) {
        const pid = queue.shift()!;
        const children = await gateQuery(
          sql`SELECT id FROM st_auth_chains WHERE factory_id = ${fid} AND parent_id = ${pid} AND revoked_at IS NULL`,
        );
        for (const c of children) {
          await gateQuery(sql`UPDATE st_auth_chains SET revoked_at = NOW() WHERE id = ${Number(c.id)}`);
          cascaded++;
          queue.push(Number(c.id));
        }
      }
      return { ok: true as const, grantee: input.grantee, cascaded };
    }),

  /** gate.authChains（query, wb）：本厂授权链视图（含层级 parentId/depth） */
  authChains: publicQuery.input(tokenInput).query(async ({ input }) => {
    const { factory } = await sessionMe(input.token);
    const rows = await gateQuery(
      sql`SELECT id, parent_id AS parentId, depth, grantor, grantee, scope, expires_at AS expiresAt, revoked_at AS revokedAt, created_at AS createdAt
          FROM st_auth_chains WHERE factory_id = ${factory.id} ORDER BY depth ASC, id DESC LIMIT 100`,
    );
    return {
      chains: rows.map((r) => ({
        id: Number(r.id),
        parentId: r.parentId == null ? null : Number(r.parentId),
        depth: Number(r.depth ?? 0),
        grantor: String(r.grantor),
        grantee: String(r.grantee),
        scope: String(r.scope),
        expiresAt: r.expiresAt ? String(r.expiresAt) : null,
        revokedAt: r.revokedAt ? String(r.revokedAt) : null,
        createdAt: r.createdAt ? String(r.createdAt) : null,
      })),
    };
  }),

  // ─── 协议评审工作流（M2-1，S3 评审台）───────────────────────────────────────

  /** gate.protocolDraft（mutation, admin）：新建协议草案（active 协议不可被覆盖，只能废止后立新） */
  protocolDraft: publicQuery
    .input(
      tokenInput.extend({
        code: z.string().trim().min(2).max(48).regex(/^[a-z][a-z0-9_]*$/, "code 须小写蛇形"),
        name: z.string().trim().min(2).max(128),
        level: z.enum(["A", "B", "C", "D"]),
        script: z.string().trim().max(2000).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const admin = await requireAdmin(input.token);
      const existing = await gateQuery(
        sql`SELECT status, version FROM st_protocols WHERE code = ${input.code} LIMIT 1`,
      );
      if (existing[0]) {
        const st = String(existing[0].status);
        if (st === "active" || st === "reviewing") {
          throw new TRPCError({
            code: "CONFLICT",
            message: `协议 ${input.code} 当前为 ${st}：active 协议不可改写，请先废止（protocolDeprecate）再立新版本`,
          });
        }
        // draft/rejected/deprecated → 以草案重写并升版本
        await gateQuery(
          sql`UPDATE st_protocols SET name = ${input.name}, level = ${input.level},
                  script = ${input.script ?? null}, status = 'draft', version = version + 1, reviewed_by = NULL
              WHERE code = ${input.code}`,
        );
      } else {
        await gateQuery(
          sql`INSERT INTO st_protocols (code, name, level, script, status) VALUES (${input.code}, ${input.name}, ${input.level}, ${input.script ?? null}, 'draft')`,
        );
      }
      const reviewer = String(admin.username ?? "admin");
      await gateQuery(
        sql`INSERT INTO st_protocol_reviews (protocol_code, action, reviewer, comment) VALUES (${input.code}, 'draft', ${reviewer}, ${input.name})`,
      );
      return { ok: true as const, code: input.code, status: "draft" };
    }),

  /** gate.protocolReview（mutation, admin）：评审——approve→active / reject→rejected，全程留痕 */
  protocolReview: publicQuery
    .input(
      tokenInput.extend({
        code: z.string().trim().min(2).max(48),
        decision: z.enum(["approve", "reject"]),
        comment: z.string().trim().max(512).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const admin = await requireAdmin(input.token);
      return reviewProtocolCore(String(admin.username ?? "admin"), input.code, input.decision, input.comment);
    }),

  /** gate.protocolDeprecate（mutation, admin）：废止 active 协议（白名单即刻失效，意图提交将被拒） */
  protocolDeprecate: publicQuery
    .input(tokenInput.extend({ code: z.string().trim().min(2).max(48), comment: z.string().trim().max(512).optional() }))
    .mutation(async ({ input }) => {
      const admin = await requireAdmin(input.token);
      return deprecateProtocolCore(String(admin.username ?? "admin"), input.code, input.comment);
    }),

  /** gate.protocolList（query, admin）：全部协议（含状态）+ 最近评审记录 */
  protocolList: publicQuery.input(tokenInput).query(async ({ input }) => {
    await requireAdmin(input.token);
    const rows = await gateQuery(
      sql`SELECT code, name, level, version, status, reviewed_by AS reviewedBy, created_at AS createdAt FROM st_protocols ORDER BY code, version`,
    );
    const reviews = await gateQuery(
      sql`SELECT protocol_code AS code, action, reviewer, comment, created_at AS createdAt FROM st_protocol_reviews ORDER BY id DESC LIMIT 50`,
    );
    return {
      protocols: rows.map((r) => ({
        code: String(r.code),
        name: String(r.name),
        level: String(r.level),
        version: Number(r.version),
        status: String(r.status),
        reviewedBy: r.reviewedBy == null ? null : String(r.reviewedBy),
        createdAt: r.createdAt ? String(r.createdAt) : null,
      })),
      reviews: reviews.map((r) => ({
        code: String(r.code),
        action: String(r.action),
        reviewer: String(r.reviewer),
        comment: r.comment == null ? null : String(r.comment),
        createdAt: r.createdAt ? String(r.createdAt) : null,
      })),
    };
  }),

  // ─── 终端化收拢（M2-3，S3 代提）────────────────────────────────────────────

  /** gate.terminalIntentSubmit（mutation, admin）：超级终端代厂提交意图（同一 submitIntent，actor=admin:xxx，受冻结/宪法/两段式约束） */
  terminalIntentSubmit: publicQuery
    .input(
      tokenInput.extend({
        factoryId: z.number().int().positive(),
        actionType: z.string().trim().min(1).max(48),
        payload: z.record(z.string(), z.unknown()).optional().default({}),
        reason: z.string().trim().max(255).optional(),
        confirm: z.boolean().optional().default(false),
      }),
    )
    .mutation(async ({ input }) => {
      const admin = await requireAdmin(input.token);
      return submitIntent({
        actor: { username: `admin:${String(admin.username ?? "admin")}`, role: "admin", factoryId: input.factoryId },
        actionType: input.actionType,
        payload: input.payload as Record<string, unknown>,
        reason: input.reason,
        confirm: input.confirm,
      });
    }),

  /** gate.terminalIntents（query, admin）：跨厂意图流水（默认最近 50） */
  terminalIntents: publicQuery
    .input(tokenInput.extend({ factoryId: z.number().int().positive().optional() }))
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      const rows = input.factoryId
        ? await gateQuery(
            sql`SELECT id, factory_id AS factoryId, actor, action_type AS actionType, status, created_at AS createdAt
                FROM st_intents WHERE factory_id = ${input.factoryId} ORDER BY id DESC LIMIT 50`,
          )
        : await gateQuery(
            sql`SELECT id, factory_id AS factoryId, actor, action_type AS actionType, status, created_at AS createdAt
                FROM st_intents ORDER BY id DESC LIMIT 50`,
          );
      return {
        intents: rows.map((r) => ({
          id: Number(r.id),
          factoryId: Number(r.factoryId),
          actor: String(r.actor),
          actionType: String(r.actionType),
          status: String(r.status),
          createdAt: r.createdAt ? String(r.createdAt) : null,
        })),
      };
    }),

  // ─── 修宪三方签名（M3-2）─────────────────────────────────────────────────

  /** gate.constitutionPropose（mutation, wb owner）：修宪提案（企业主签署=第一方） */
  constitutionPropose: publicQuery
    .input(
      tokenInput.extend({
        toLevel: z.enum(["A", "B"]),
        reason: z.string().trim().max(512).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { user, factory } = await sessionMe(input.token);
      if (String(user.role) !== "owner") {
        throw new TRPCError({ code: "FORBIDDEN", message: "修宪提案必须由企业主（owner）发起" });
      }
      const fid = Number(factory.id);
      const from = await readConstitutionLevel(fid);
      if (from === input.toLevel) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `本厂宪法已是 ${from} 级，无需修改` });
      }
      // 同厂已有在途修正案 → 拒绝（一厂一案）
      const pending = await gateQuery(
        sql`SELECT id FROM st_constitution_amendments
            WHERE factory_id = ${fid} AND status IN ('pending_owner','pending_admin','pending_notary') LIMIT 1`,
      );
      if (pending[0]) {
        throw new TRPCError({ code: "CONFLICT", message: `已有在途修正案 #${Number(pending[0].id)}，待其完结后方可再提` });
      }
      // R7-c143-②/R7-c144-③：事务径走 txInsertId 单点
      const amendmentId = await txInsertId(
        sql`INSERT INTO st_constitution_amendments
              (factory_id, from_level, to_level, reason, proposer, owner_signed_by, owner_signed_at, status)
            VALUES (${fid}, ${from}, ${input.toLevel}, ${input.reason ?? null}, ${String(user.username)},
                    ${String(user.username)}, NOW(), 'pending_admin')`,
        "[routers/gate] 修正案登记写入失败",
        GATE_TABLES_HINT,
      );
      return { ok: true as const, amendmentId, from, to: input.toLevel, status: "pending_admin" };
    }),

  /** gate.constitutionSign（mutation, admin）：平台副署（第二方）→ 公证节点自动会签（第三方）→ 生效 */
  constitutionSign: publicQuery
    .input(
      tokenInput.extend({
        amendmentId: z.number().int().positive(),
        decision: z.enum(["sign", "reject"]),
      }),
    )
    .mutation(async ({ input }) => {
      const admin = await requireAdmin(input.token);
      const rows = await gateQuery(
        sql`SELECT id, factory_id AS factoryId, from_level AS fromLevel, to_level AS toLevel, proposer, status
            FROM st_constitution_amendments WHERE id = ${input.amendmentId} LIMIT 1`,
      );
      if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "修正案不存在" });
      const a = rows[0];
      if (String(a.status) !== "pending_admin") {
        throw new TRPCError({ code: "BAD_REQUEST", message: `修正案当前为 ${String(a.status)}，不在平台副署环节` });
      }
      const adminName = String(admin.username ?? "admin");
      if (input.decision === "reject") {
        await gateQuery(
          sql`UPDATE st_constitution_amendments SET status = 'rejected', admin_signed_by = ${adminName}, admin_signed_at = NOW()
              WHERE id = ${input.amendmentId}`,
        );
        return { ok: true as const, status: "rejected" };
      }
      // 第三方：公证节点会签（独立 HMAC 签名，密钥仅在 env）
      const payload = amendmentPayload(Number(a.id), Number(a.factoryId), String(a.fromLevel), String(a.toLevel), String(a.proposer));
      const sig = notarySign(payload);
      await gateQuery(
        sql`UPDATE st_constitution_amendments
            SET admin_signed_by = ${adminName}, admin_signed_at = NOW(),
                notary_sig = ${sig}, notary_signed_at = NOW(),
                status = 'applied', applied_at = NOW()
            WHERE id = ${input.amendmentId}`,
      );
      // 生效：写入宪法表（UPSERT）
      await gateMiscQuery(
        sql`INSERT INTO st_auto_constitution (factory_id, max_auto_level) VALUES (${Number(a.factoryId)}, ${String(a.toLevel)})
            ON DUPLICATE KEY UPDATE max_auto_level = ${String(a.toLevel)}`,
      );
      await emitSignal(
        Number(a.factoryId),
        "ticket",
        "C",
        `本厂宪法已修宪：${String(a.fromLevel)} → ${String(a.toLevel)}`,
        `修正案 #${Number(a.id)} 三方签署完成（企业主 ${String(a.proposer)} / 平台 ${adminName} / 公证节点 HMAC），已生效`,
      );
      return { ok: true as const, status: "applied", notarySig: sig.slice(0, 16) + "…" };
    }),

  /** gate.constitutionAmendments（query, wb/admin）：本厂或全量修正案流水 */
  constitutionAmendments: publicQuery.input(tokenInput).query(async ({ input }) => {
    // wb 用户看本厂；admin 看全量
    let rows;
    try {
      const admin = await requireAdmin(input.token);
      void admin;
      rows = await gateQuery(
        sql`SELECT id, factory_id AS factoryId, from_level AS fromLevel, to_level AS toLevel, proposer,
                   owner_signed_by AS ownerSignedBy, admin_signed_by AS adminSignedBy,
                   notary_sig IS NOT NULL AS notarySigned, status, created_at AS createdAt, applied_at AS appliedAt
            FROM st_constitution_amendments ORDER BY id DESC LIMIT 50`,
      );
    } catch {
      const { factory } = await sessionMe(input.token);
      rows = await gateQuery(
        sql`SELECT id, factory_id AS factoryId, from_level AS fromLevel, to_level AS toLevel, proposer,
                   owner_signed_by AS ownerSignedBy, admin_signed_by AS adminSignedBy,
                   notary_sig IS NOT NULL AS notarySigned, status, created_at AS createdAt, applied_at AS appliedAt
            FROM st_constitution_amendments WHERE factory_id = ${factory.id} ORDER BY id DESC LIMIT 50`,
      );
    }
    return {
      amendments: rows.map((r) => ({
        id: Number(r.id),
        factoryId: Number(r.factoryId),
        fromLevel: String(r.fromLevel),
        toLevel: String(r.toLevel),
        proposer: String(r.proposer),
        ownerSignedBy: r.ownerSignedBy == null ? null : String(r.ownerSignedBy),
        adminSignedBy: r.adminSignedBy == null ? null : String(r.adminSignedBy),
        notarySigned: Boolean(Number(r.notarySigned)),
        status: String(r.status),
        createdAt: r.createdAt ? String(r.createdAt) : null,
        appliedAt: r.appliedAt ? String(r.appliedAt) : null,
      })),
    };
  }),

  // ─── 中枢多实例（M3-1）────────────────────────────────────────────────────

  /** gate.instances（query, wb owner/admin）：中枢实例存活视图（60s 心跳窗口） */
  instances: publicQuery.input(tokenInput).query(async ({ input }) => {
    let admin = false;
    try {
      await requireAdmin(input.token);
      admin = true;
    } catch {
      const { user } = await sessionMe(input.token);
      if (String(user.role) !== "owner") {
        throw new TRPCError({ code: "FORBIDDEN", message: "仅企业主或平台管理员可查看中枢实例" });
      }
    }
    void admin;
    const rows = await gateQuery(
      sql`SELECT instance_id AS instanceId, host, port, started_at AS startedAt, last_heartbeat AS lastHeartbeat,
                 (last_heartbeat > DATE_SUB(NOW(), INTERVAL 60 SECOND)) AS alive
          FROM st_gate_instances ORDER BY last_heartbeat DESC LIMIT 20`,
    );
    return {
      instances: rows.map((r) => ({
        instanceId: String(r.instanceId),
        host: String(r.host),
        port: Number(r.port),
        startedAt: r.startedAt ? String(r.startedAt) : null,
        lastHeartbeat: r.lastHeartbeat ? String(r.lastHeartbeat) : null,
        alive: Boolean(Number(r.alive)),
      })),
    };
  }),

  // ─── 行业协议集（M3-3）────────────────────────────────────────────────────

  /** gate.protocolDeposit（mutation, admin）：把 active 协议沉淀进行业协议集（每签约一家厂沉淀协议） */
  protocolDeposit: publicQuery
    .input(
      tokenInput.extend({
        industry: z.string().trim().min(2).max(64),
        protocolCode: z.string().trim().min(2).max(48),
        sourceFactoryId: z.number().int().positive().optional(),
        note: z.string().trim().max(255).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const admin = await requireAdmin(input.token);
      const rows = await gateQuery(
        sql`SELECT name, level, status FROM st_protocols WHERE code = ${input.protocolCode} LIMIT 1`,
      );
      if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: `协议 ${input.protocolCode} 不存在` });
      if (String(rows[0].status) !== "active") {
        throw new TRPCError({ code: "BAD_REQUEST", message: `仅 active 协议可沉淀（当前 ${String(rows[0].status)}）` });
      }
      await gateQuery(
        sql`INSERT INTO st_industry_protocols (industry, protocol_code, protocol_name, level, source_factory_id, deposited_by, note)
            VALUES (${input.industry}, ${input.protocolCode}, ${String(rows[0].name)}, ${String(rows[0].level)},
                    ${input.sourceFactoryId ?? null}, ${String(admin.username ?? "admin")}, ${input.note ?? null})
            ON DUPLICATE KEY UPDATE protocol_name = VALUES(protocol_name), note = VALUES(note)`,
      );
      return { ok: true as const, industry: input.industry, protocolCode: input.protocolCode };
    }),

  /** gate.industryProtocols（query, wb/admin）：行业协议集（按行业分组） */
  industryProtocols: publicQuery
    .input(tokenInput.extend({ industry: z.string().trim().max(64).optional() }))
    .query(async ({ input }) => {
      await sessionMe(input.token).catch(() => requireAdmin(input.token));
      const rows = input.industry
        ? await gateQuery(
            sql`SELECT industry, protocol_code AS protocolCode, protocol_name AS protocolName, level,
                       source_factory_id AS sourceFactoryId, deposited_by AS depositedBy, note, created_at AS createdAt
                FROM st_industry_protocols WHERE industry = ${input.industry} ORDER BY id`,
          )
        : await gateQuery(
            sql`SELECT industry, protocol_code AS protocolCode, protocol_name AS protocolName, level,
                       source_factory_id AS sourceFactoryId, deposited_by AS depositedBy, note, created_at AS createdAt
                FROM st_industry_protocols ORDER BY industry, id`,
          );
      return {
        items: rows.map((r) => ({
          industry: String(r.industry),
          protocolCode: String(r.protocolCode),
          protocolName: String(r.protocolName),
          level: String(r.level),
          sourceFactoryId: r.sourceFactoryId == null ? null : Number(r.sourceFactoryId),
          depositedBy: String(r.depositedBy),
          note: r.note == null ? null : String(r.note),
          createdAt: r.createdAt ? String(r.createdAt) : null,
        })),
      };
    }),

  // ─── 冻结协议（急停按钮）─────────────────────────────────────────────────

  /** gate.freeze（mutation, wb owner）：一键冻结全厂执行权（只读保留） */
  freeze: publicQuery.input(tokenInput).mutation(async ({ input }) => {
    const { user, factory } = await sessionMe(input.token);
    if (String(user.role) !== "owner") {
      throw new TRPCError({ code: "FORBIDDEN", message: "冻结协议只能由企业主触发" });
    }
    await gateQuery(
      sql`INSERT INTO st_freeze_events (factory_id, action, operator) VALUES (${factory.id}, 'freeze', ${String(user.username)})`,
    );
    await emitSignal(factory.id, "ticket", "D", "企业主触发紧急冻结协议", "全厂执行权已冻结（只读保留），解冻需企业主请求+平台确认");
    return { ok: true as const, frozen: true };
  }),

  /** gate.unfreezeRequest（mutation, wb owner）：解冻第一步（owner 请求） */
  unfreezeRequest: publicQuery.input(tokenInput).mutation(async ({ input }) => {
    const { user, factory } = await sessionMe(input.token);
    if (String(user.role) !== "owner") {
      throw new TRPCError({ code: "FORBIDDEN", message: "解冻请求只能由企业主发起" });
    }
    await gateQuery(
      sql`INSERT INTO st_freeze_events (factory_id, action, operator) VALUES (${factory.id}, 'unfreeze_request', ${String(user.username)})`,
    );
    return { ok: true as const, step: "requested" as const, note: "已登记解冻请求，待平台管理员确认" };
  }),

  /** gate.unfreezeConfirm（mutation, admin）：解冻第二步（平台确认，单方无效） */
  unfreezeConfirm: publicQuery
    .input(tokenInput.extend({ factoryId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const admin = await requireAdmin(input.token);
      // 前置：必须存在 freeze 之后、最新的 unfreeze_request
      const rows = await gateQuery(
        sql`SELECT action FROM st_freeze_events WHERE factory_id = ${input.factoryId} ORDER BY id DESC LIMIT 5`,
      );
      const latest = rows[0] ? String(rows[0].action) : "";
      if (latest !== "unfreeze_request") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "无待确认的解冻请求（须企业主先发起 unfreezeRequest）" });
      }
      await gateQuery(
        sql`INSERT INTO st_freeze_events (factory_id, action, operator)
            VALUES (${input.factoryId}, 'unfreeze', ${String(admin.username ?? "admin")})`,
      );
      return { ok: true as const, frozen: false };
    }),

  /** gate.freezeStatus（query, wb）：本厂冻结态 */
  freezeStatus: publicQuery.input(tokenInput).query(async ({ input }) => {
    const { factory } = await sessionMe(input.token);
    return { frozen: await isFactoryFrozen(Number(factory.id)) };
  }),

  /**
   * gate.pendingUnfreezes（query, admin）：全平台待确认解冻清单（死端点处置 t8）。
   * 口径：每厂最新一条 freeze 事件为 unfreeze_request 的企业即在清单内。
   */
  pendingUnfreezes: publicQuery.input(tokenInput).query(async ({ input }) => {
    await requireAdmin(input.token);
    const rows = await gateQuery(
      sql`SELECT f.factory_id AS factoryId, f.action AS latestAction, f.created_at AS at,
                 w.enterpriseName
          FROM st_freeze_events f
          JOIN (SELECT factory_id, MAX(id) AS maxId FROM st_freeze_events GROUP BY factory_id) latest
            ON latest.factory_id = f.factory_id AND latest.maxId = f.id
          LEFT JOIN wb_factories w ON w.id = f.factory_id
          WHERE f.action = 'unfreeze_request'
          ORDER BY f.id DESC LIMIT 100`,
    );
    return {
      items: rows.map((r) => ({
        factoryId: Number(r.factoryId),
        enterpriseName: String(r.enterpriseName ?? `#${r.factoryId}`),
        requestedAt: r.at == null ? null : String(r.at),
      })),
    };
  }),
});
