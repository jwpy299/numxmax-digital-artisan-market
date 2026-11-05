/**
 * dshGovernance —— DSH 服务端治理适配器（生产前沙箱版）。
 *
 * 目标：把「找技能/雇佣数字员工」从 APP 内存态演示收口为服务端治理闭环：
 * propose（合同提案）→ C 级一次性票据 → shadow 影子试用 → 预算记账 → evaluate 晋升 → retire/rollback。
 *
 * 红线：
 * - factoryId 只来自服务端 sessionMe/requireWbRole，绝不接受客户端传入；
 * - C 级 install/rollback/retire 必须 pending ticket，confirmTicket 原子消费，票据一次性；
 * - 预算扣减使用条件 UPDATE（budget_used + cost <= budget_monthly），不先查后改；
 * - 审计与返回字段统一脱敏，密钥/口令/邀请码类串不落审计；
 * - 本模块只写 st_dsh_* 四张治理表，不改旧雇佣/插件表语义。
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { sql, type SQLWrapper } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { affectedRowsOf, insertIdOf } from "../lib/dbResult";
import { getDb } from "../queries/connection";
import { requireWbRole, sessionMe } from "./wbSession";
import type {
  DshAuditDto,
  DshContractDto,
  DshContractStatus,
  DshGovernanceAutonomy,
  DshGovernanceKind,
  DshGovernanceRisk,
  DshTicketAction,
  DshTicketDto,
} from "@contracts/dshGovernance";
import { isDupEntry } from "../lib/dupEntry"; // 共享件单源（本地副本退役——门禁票）

const ADMIN_REQUIRED = "仅企业负责人可治理 DSH 能力";
const TRIAL_REQUIRED = "仅企业负责人或部门负责人可记录试用";
const GENERIC_FORBIDDEN = "仅可操作本企业 DSH 治理对象";
const SECRET_RE = /(sk-[A-Za-z0-9_-]+|pass\s*[:=]|secret\s*[:=]|api[_-]?key\s*[:=]|token\s*[:=]\s*[^\s,]+|iv_[a-f0-9]{48}|nt_[a-f0-9]{48})/gi;
const INJECTION_RE = /忽略.{0,12}(指令|要求|规则)|ignore\s+(all\s+)?(previous\s+)?instructions?|system\s*prompt|jailbreak/gi;

const tokenInput = z.object({ token: z.string().trim().min(1) });
const riskSchema = z.enum(["A", "B", "C"]);
const autonomySchema = z.enum(["L0", "L1", "L2", "L3", "L4"]);
const kindSchema = z.enum(["skill", "employee", "workflow"]);
const statusSchema = z.enum(["proposed", "shadow", "active", "retired", "rolled_back"]);
const permissionSchema = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_.-]*$/, "权限点格式不合法")
  .refine((v) => !v.includes("*") && !/^admin([_.-]|$)/i.test(v), "外部能力不允许通配或管理权限");

type Row = Record<string, unknown>;
type SqlExecutor = { execute: (q: SQLWrapper) => Promise<unknown> };

function rowsOf(result: unknown): Row[] {
  if (Array.isArray(result) && Array.isArray(result[0])) return result[0] as Row[];
  return (result ?? []) as Row[];
}

function sanitizeText(v: unknown, max = 500): string {
  return String(v ?? "")
    .replace(/[​-‏⁠‪-‮]/g, "")
    .replace(INJECTION_RE, "[已过滤]")
    .replace(SECRET_RE, "[已脱敏]")
    .trim()
    .slice(0, max);
}

function jsonText(v: unknown, max = 1200): string {
  return sanitizeText(JSON.stringify(v ?? {}), max);
}

function parsePermissions(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  try {
    const arr = JSON.parse(String(v ?? "[]")) as unknown;
    return Array.isArray(arr) ? arr.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

function newNo(prefix: "DSHC" | "DSHT"): string {
  return `${prefix}${Date.now().toString(36).toUpperCase()}${randomBytes(5).toString("hex").toUpperCase()}`;
}

function actorOf(user: { username?: unknown; displayName?: unknown }): string {
  return sanitizeText(user.username ?? user.displayName ?? "unknown", 64) || "unknown";
}

function contractDto(r: Row): DshContractDto {
  return {
    id: Number(r.id),
    contractNo: String(r.contract_no ?? ""),
    requestId: String(r.request_id ?? ""),
    factoryId: Number(r.factory_id),
    capabilityKey: String(r.capability_key ?? ""),
    kind: String(r.kind) as DshGovernanceKind,
    risk: String(r.risk) as DshGovernanceRisk,
    autonomy: String(r.autonomy) as DshGovernanceAutonomy,
    permissions: parsePermissions(r.permissions_json),
    budgetMonthly: Number(r.budget_monthly ?? 0),
    budgetUsed: Number(r.budget_used ?? 0),
    status: String(r.status) as DshContractStatus,
    successCount: Number(r.success_count ?? 0),
    failCount: Number(r.fail_count ?? 0),
    evalScore: Number(r.eval_score ?? 0),
    createdBy: String(r.created_by ?? ""),
    createdAt: String(r.created_at ?? ""),
    updatedAt: String(r.updated_at ?? ""),
  };
}

function ticketDto(r: Row): DshTicketDto {
  return {
    id: Number(r.id),
    ticketNo: String(r.ticket_no ?? ""),
    factoryId: Number(r.factory_id),
    contractId: Number(r.contract_id),
    action: String(r.action) as DshTicketAction,
    status: String(r.status) as DshTicketDto["status"],
    createdBy: String(r.created_by ?? ""),
    confirmedBy: r.confirmed_by == null ? null : String(r.confirmed_by),
    createdAt: String(r.created_at ?? ""),
    consumedAt: r.consumed_at == null ? null : String(r.consumed_at),
  };
}

function auditDto(r: Row): DshAuditDto {
  return {
    id: Number(r.id),
    factoryId: Number(r.factory_id),
    contractId: r.contract_id == null ? null : Number(r.contract_id),
    actor: String(r.actor ?? ""),
    action: String(r.action ?? ""),
    risk: r.risk == null ? null : (String(r.risk) as DshGovernanceRisk),
    detail: sanitizeText(r.detail_json ?? "{}", 1200),
    createdAt: String(r.created_at ?? ""),
  };
}

async function contractById(db: SqlExecutor, factoryId: number, contractId: number): Promise<Row | null> {
  const rows = rowsOf(
    await db.execute(sql`
      SELECT * FROM st_dsh_contracts
      WHERE id = ${contractId} AND factory_id = ${factoryId}
      LIMIT 1
    `),
  );
  return rows[0] ?? null;
}

async function writeAudit(
  db: SqlExecutor,
  entry: {
    factoryId: number;
    contractId: number | null;
    actor: string;
    action: string;
    risk: DshGovernanceRisk | null;
    detail: unknown;
  },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO st_dsh_audit
      (factory_id, contract_id, actor, action, risk, detail_json, created_at)
    VALUES
      (${entry.factoryId}, ${entry.contractId}, ${sanitizeText(entry.actor, 64)},
       ${sanitizeText(entry.action, 64)}, ${entry.risk}, ${jsonText(entry.detail)}, NOW())
  `);
}

function assertContract(row: Row | null): Row {
  if (!row) throw new TRPCError({ code: "FORBIDDEN", message: GENERIC_FORBIDDEN });
  return row;
}

function assertAutonomousAllowed(contract: Row, autonomous: boolean): void {
  if (!autonomous) return;
  const autonomy = String(contract.autonomy) as DshGovernanceAutonomy;
  const risk = String(contract.risk) as DshGovernanceRisk;
  const level = Number(autonomy.slice(1));
  const allowed =
    risk === "A" ? level >= 1 :
    risk === "B" ? level >= 2 :
    false; // C 级永远不允许无人确认自动执行
  if (!allowed) {
    throw new TRPCError({ code: "FORBIDDEN", message: "当前自治等级不允许自动试用该风险能力" });
  }
}

function evaluateScore(contract: Row): { score: number; canPromote: boolean } {
  const success = Number(contract.success_count ?? 0);
  const fail = Number(contract.fail_count ?? 0);
  const risk = String(contract.risk) as DshGovernanceRisk;
  const score = Math.max(0, Math.min(100, 50 + success * 10 - fail * 20 - (risk === "C" ? 10 : 0)));
  return { score, canPromote: success >= 3 && fail === 0 && score >= 80 };
}

export const dshGovernanceRouter = createRouter({
  /** 当前企业 DSH 合同列表（任何本厂登录角色可看；跨厂由会话天然隔离） */
  contracts: publicQuery
    .input(tokenInput.extend({ status: statusSchema.optional() }))
    .query(async ({ input }) => {
      const { factory } = await sessionMe(input.token);
      const db = getDb();
      const rows = input.status
        ? rowsOf(await db.execute(sql`
            SELECT * FROM st_dsh_contracts
            WHERE factory_id = ${factory.id} AND status = ${input.status}
            ORDER BY id DESC LIMIT 100
          `))
        : rowsOf(await db.execute(sql`
            SELECT * FROM st_dsh_contracts
            WHERE factory_id = ${factory.id}
            ORDER BY id DESC LIMIT 100
          `));
      return rows.map(contractDto);
    }),

  /**
   * 能力安装/雇佣提案。A/B 直接进入 shadow；C 进入 proposed 并签发 install 票据。
   * requestId 幂等：同一企业同一 requestId 重试返回原合同，不重复建单。
   */
  propose: publicQuery
    .input(tokenInput.extend({
      requestId: z.string().trim().min(6).max(64).regex(/^[A-Za-z0-9_.:-]+$/),
      capabilityKey: z.string().trim().min(2).max(96).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/),
      kind: kindSchema,
      risk: riskSchema,
      autonomy: autonomySchema,
      permissions: z.array(permissionSchema).max(16).default([]),
      budgetMonthly: z.number().int().min(0).max(1_000_000),
    }))
    .mutation(async ({ input }) => {
      const { user, factory } = await requireWbRole(input.token, ["admin"], ADMIN_REQUIRED);
      const db = getDb();
      // 幂等命中（含并发撞唯一键后的回补）：返回原合同与其 pending install 票据。
      const idempotentReply = async () => {
        const existed = rowsOf(await db.execute(sql`
          SELECT * FROM st_dsh_contracts
          WHERE factory_id = ${factory.id} AND request_id = ${input.requestId}
          LIMIT 1
        `));
        if (!existed[0]) return null;
        const pending = rowsOf(await db.execute(sql`
          SELECT * FROM st_dsh_tickets
          WHERE factory_id = ${factory.id} AND contract_id = ${Number(existed[0].id)}
            AND action = 'install' AND status = 'pending'
          ORDER BY id DESC LIMIT 1
        `));
        return {
          ok: true as const,
          idempotent: true as const,
          contract: contractDto(existed[0]),
          ticket: pending[0] ? ticketDto(pending[0]) : null,
        };
      };
      const hit = await idempotentReply();
      if (hit) return hit;

      const actor = actorOf(user);
      const contractNo = newNo("DSHC");
      const ticketNo = input.risk === "C" ? newNo("DSHT") : null;
      const status: DshContractStatus = input.risk === "C" ? "proposed" : "shadow";
      let created: number;
      try {
        created = await db.transaction(async (tx) => {
          const ins = await tx.execute(sql`
            INSERT INTO st_dsh_contracts
              (contract_no, request_id, factory_id, capability_key, kind, risk, autonomy,
               permissions_json, budget_monthly, budget_used, status, success_count, fail_count,
               eval_score, created_by, created_at, updated_at)
            VALUES
              (${contractNo}, ${input.requestId}, ${factory.id}, ${input.capabilityKey}, ${input.kind},
               ${input.risk}, ${input.autonomy}, ${JSON.stringify(input.permissions)}, ${input.budgetMonthly},
               0, ${status}, 0, 0, 0, ${actor}, NOW(), NOW())
          `);
          const contractId = insertIdOf(ins);
          if (ticketNo) {
            await tx.execute(sql`
              INSERT INTO st_dsh_tickets
                (ticket_no, factory_id, contract_id, action, status, created_by, created_at)
              VALUES
                (${ticketNo}, ${factory.id}, ${contractId}, 'install', 'pending', ${actor}, NOW())
            `);
          }
          await writeAudit(tx, {
            factoryId: factory.id,
            contractId,
            actor,
            action: "propose",
            risk: input.risk,
            detail: { capabilityKey: input.capabilityKey, kind: input.kind, autonomy: input.autonomy, status },
          });
          return contractId;
        });
      } catch (err) {
        // 并发同 requestId：唯一键兜底，撞到后回补幂等返回而不是抛原始 1062。
        if (isDupEntry(err)) {
          const replay = await idempotentReply();
          if (replay) return replay;
        }
        throw err;
      }
      const row = assertContract(await contractById(db, factory.id, created));
      let ticket: DshTicketDto | null = null;
      if (ticketNo) {
        const rows = rowsOf(await db.execute(sql`
          SELECT * FROM st_dsh_tickets
          WHERE factory_id = ${factory.id} AND ticket_no = ${ticketNo}
          LIMIT 1
        `));
        ticket = rows[0] ? ticketDto(rows[0]) : null;
      }
      return { ok: true as const, idempotent: false as const, contract: contractDto(row), ticket };
    }),

  /** 为 C 级 rollback/retire 申请一次性票据（install 票据由 propose 自动签发） */
  requestTicket: publicQuery
    .input(tokenInput.extend({
      contractId: z.number().int().positive(),
      action: z.enum(["rollback", "retire"]),
    }))
    .mutation(async ({ input }) => {
      const { user, factory } = await requireWbRole(input.token, ["admin"], ADMIN_REQUIRED);
      const db = getDb();
      const contract = assertContract(await contractById(db, factory.id, input.contractId));
      if (String(contract.risk) !== "C") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "A/B 级回滚或退休无需 C 级票据" });
      }
      if (!["shadow", "active"].includes(String(contract.status))) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "当前合同状态不可申请该动作" });
      }
      const existed = rowsOf(await db.execute(sql`
        SELECT * FROM st_dsh_tickets
        WHERE factory_id = ${factory.id} AND contract_id = ${input.contractId}
          AND action = ${input.action} AND status = 'pending'
        ORDER BY id DESC LIMIT 1
      `));
      if (existed[0]) return { ok: true as const, idempotent: true as const, ticket: ticketDto(existed[0]) };
      const actor = actorOf(user);
      const ticketNo = newNo("DSHT");
      const id = await db.transaction(async (tx) => {
        const ins = await tx.execute(sql`
          INSERT INTO st_dsh_tickets
            (ticket_no, factory_id, contract_id, action, status, created_by, created_at)
          VALUES
            (${ticketNo}, ${factory.id}, ${input.contractId}, ${input.action}, 'pending', ${actor}, NOW())
        `);
        const ticketId = insertIdOf(ins);
        await writeAudit(tx, {
          factoryId: factory.id,
          contractId: input.contractId,
          actor,
          action: `ticket:${input.action}`,
          risk: "C",
          detail: { ticketNo, action: input.action },
        });
        return ticketId;
      });
      const rows = rowsOf(await db.execute(sql`
        SELECT * FROM st_dsh_tickets WHERE id = ${id} AND factory_id = ${factory.id} LIMIT 1
      `));
      return { ok: true as const, idempotent: false as const, ticket: ticketDto(rows[0]!) };
    }),

  /** 一次性确认票据：原子消费 pending ticket，并按票据动作推进合同状态。 */
  confirmTicket: publicQuery
    .input(tokenInput.extend({ ticketNo: z.string().trim().min(12).max(48) }))
    .mutation(async ({ input }) => {
      const { user, factory } = await requireWbRole(input.token, ["admin"], ADMIN_REQUIRED);
      const db = getDb();
      const ticketRows = rowsOf(await db.execute(sql`
        SELECT * FROM st_dsh_tickets
        WHERE factory_id = ${factory.id} AND ticket_no = ${input.ticketNo}
        LIMIT 1
      `));
      const ticket = ticketRows[0];
      if (!ticket || String(ticket.status) !== "pending") {
        throw new TRPCError({ code: "FORBIDDEN", message: "票据无效或已使用" });
      }
      const contract = assertContract(await contractById(db, factory.id, Number(ticket.contract_id)));
      const action = String(ticket.action) as DshTicketAction;
      const nextStatus: DshContractStatus =
        action === "install" ? "shadow" :
        action === "rollback" ? "rolled_back" :
        "retired";
      if (action === "install" && (String(contract.status) !== "proposed" || String(contract.risk) !== "C")) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "安装票据与合同状态不匹配" });
      }
      if ((action === "rollback" || action === "retire") && !["shadow", "active"].includes(String(contract.status))) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "当前合同状态不可确认该动作" });
      }
      const actor = actorOf(user);
      // C 级双签：发起人不能给自己的票据做最终确认；确认人必须不同且同属本厂 admin。
      if (actor === String(ticket.created_by ?? "")) {
        throw new TRPCError({ code: "FORBIDDEN", message: "C 级票据必须由另一名企业负责人确认" });
      }
      await db.transaction(async (tx) => {
        const consumed = await tx.execute(sql`
          UPDATE st_dsh_tickets
          SET status = 'consumed', confirmed_by = ${actor}, consumed_at = NOW()
          WHERE id = ${Number(ticket.id)} AND factory_id = ${factory.id} AND status = 'pending'
        `);
        if (affectedRowsOf(consumed) !== 1) {
          throw new TRPCError({ code: "FORBIDDEN", message: "票据无效或已使用" });
        }
        const moved = await tx.execute(sql`
          UPDATE st_dsh_contracts
          SET status = ${nextStatus}, updated_at = NOW()
          WHERE id = ${Number(contract.id)} AND factory_id = ${factory.id}
        `);
        if (affectedRowsOf(moved) !== 1) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "合同状态推进失败" });
        }
        await writeAudit(tx, {
          factoryId: factory.id,
          contractId: Number(contract.id),
          actor,
          action: `confirm:${action}`,
          risk: String(contract.risk) as DshGovernanceRisk,
          detail: { ticketNo: input.ticketNo, from: String(contract.status), to: nextStatus },
        });
      });
      const row = assertContract(await contractById(db, factory.id, Number(contract.id)));
      return { ok: true as const, contract: contractDto(row) };
    }),

  /** 影子/正式试用记账：条件扣预算 + 成功失败计数 + 审计。 */
  trial: publicQuery
    .input(tokenInput.extend({
      contractId: z.number().int().positive(),
      success: z.boolean(),
      cost: z.number().int().min(0).max(100_000).default(0),
      autonomous: z.boolean().default(false),
      note: z.string().trim().max(300).optional(),
    }))
    .mutation(async ({ input }) => {
      const { user, factory } = await requireWbRole(input.token, ["admin", "manager"], TRIAL_REQUIRED);
      const db = getDb();
      const contract = assertContract(await contractById(db, factory.id, input.contractId));
      if (!["shadow", "active"].includes(String(contract.status))) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "合同未处于可试用状态" });
      }
      assertAutonomousAllowed(contract, input.autonomous);
      const actor = actorOf(user);
      const safeNote = input.note ? sanitizeText(input.note, 300) : "";
      await db.transaction(async (tx) => {
        const okInc = input.success ? 1 : 0;
        const failInc = input.success ? 0 : 1;
        const updated = await tx.execute(sql`
          UPDATE st_dsh_contracts
          SET budget_used = budget_used + ${input.cost},
              success_count = success_count + ${okInc},
              fail_count = fail_count + ${failInc},
              updated_at = NOW()
          WHERE id = ${input.contractId}
            AND factory_id = ${factory.id}
            AND status IN ('shadow', 'active')
            AND budget_used + ${input.cost} <= budget_monthly
        `);
        if (affectedRowsOf(updated) !== 1) {
          throw new TRPCError({ code: "FORBIDDEN", message: "预算不足或合同不可试用" });
        }
        if (input.cost > 0) {
          await tx.execute(sql`
            INSERT INTO st_dsh_budget_ledger
              (factory_id, contract_id, kind, amount, actor, note, created_at)
            VALUES
              (${factory.id}, ${input.contractId}, 'debit', ${input.cost}, ${actor}, ${safeNote}, NOW())
          `);
        }
        await writeAudit(tx, {
          factoryId: factory.id,
          contractId: input.contractId,
          actor,
          action: "trial",
          risk: String(contract.risk) as DshGovernanceRisk,
          detail: { success: input.success, cost: input.cost, autonomous: input.autonomous, note: safeNote },
        });
      });
      const row = assertContract(await contractById(db, factory.id, input.contractId));
      return { ok: true as const, contract: contractDto(row) };
    }),

  /** 沙箱评估：达到服务端门槛才晋升 active；不达标保持 shadow。 */
  evaluate: publicQuery
    .input(tokenInput.extend({ contractId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const { user, factory } = await requireWbRole(input.token, ["admin"], ADMIN_REQUIRED);
      const db = getDb();
      const contract = assertContract(await contractById(db, factory.id, input.contractId));
      if (String(contract.status) !== "shadow") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "仅影子试用合同可评估晋升" });
      }
      const verdict = evaluateScore(contract);
      const nextStatus: DshContractStatus = verdict.canPromote ? "active" : "shadow";
      const actor = actorOf(user);
      await db.transaction(async (tx) => {
        const moved = await tx.execute(sql`
          UPDATE st_dsh_contracts
          SET eval_score = ${verdict.score}, status = ${nextStatus}, updated_at = NOW()
          WHERE id = ${input.contractId} AND factory_id = ${factory.id} AND status = 'shadow'
        `);
        if (affectedRowsOf(moved) !== 1) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "合同状态已变化，请重试" });
        }
        await writeAudit(tx, {
          factoryId: factory.id,
          contractId: input.contractId,
          actor,
          action: verdict.canPromote ? "promote" : "evaluate:stay-shadow",
          risk: String(contract.risk) as DshGovernanceRisk,
          detail: { score: verdict.score, successCount: Number(contract.success_count), failCount: Number(contract.fail_count) },
        });
      });
      const row = assertContract(await contractById(db, factory.id, input.contractId));
      return { ok: true as const, promoted: verdict.canPromote, score: verdict.score, contract: contractDto(row) };
    }),

  /** A/B 直接回滚；C 必须先 requestTicket + confirmTicket。 */
  rollback: publicQuery
    .input(tokenInput.extend({ contractId: z.number().int().positive(), reason: z.string().trim().min(2).max(300) }))
    .mutation(async ({ input }) => {
      const { user, factory } = await requireWbRole(input.token, ["admin"], ADMIN_REQUIRED);
      const db = getDb();
      const contract = assertContract(await contractById(db, factory.id, input.contractId));
      if (!["shadow", "active"].includes(String(contract.status))) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "当前合同状态不可回滚" });
      }
      if (String(contract.risk) === "C") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "C 级能力回滚必须先申请一次性票据" });
      }
      const actor = actorOf(user);
      await db.transaction(async (tx) => {
        const moved = await tx.execute(sql`
          UPDATE st_dsh_contracts
          SET status = 'rolled_back', updated_at = NOW()
          WHERE id = ${input.contractId} AND factory_id = ${factory.id}
            AND status IN ('shadow', 'active')
        `);
        if (affectedRowsOf(moved) !== 1) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "合同状态已变化，请重试" });
        }
        await writeAudit(tx, {
          factoryId: factory.id,
          contractId: input.contractId,
          actor,
          action: "rollback",
          risk: String(contract.risk) as DshGovernanceRisk,
          detail: { reason: sanitizeText(input.reason, 300) },
        });
      });
      const row = assertContract(await contractById(db, factory.id, input.contractId));
      return { ok: true as const, contract: contractDto(row) };
    }),

  /** A/B 直接退休；C 必须先 requestTicket + confirmTicket。 */
  retire: publicQuery
    .input(tokenInput.extend({ contractId: z.number().int().positive(), reason: z.string().trim().min(2).max(300) }))
    .mutation(async ({ input }) => {
      const { user, factory } = await requireWbRole(input.token, ["admin"], ADMIN_REQUIRED);
      const db = getDb();
      const contract = assertContract(await contractById(db, factory.id, input.contractId));
      if (!["shadow", "active"].includes(String(contract.status))) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "当前合同状态不可退休" });
      }
      if (String(contract.risk) === "C") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "C 级能力退休必须先申请一次性票据" });
      }
      const actor = actorOf(user);
      await db.transaction(async (tx) => {
        const moved = await tx.execute(sql`
          UPDATE st_dsh_contracts
          SET status = 'retired', updated_at = NOW()
          WHERE id = ${input.contractId} AND factory_id = ${factory.id}
            AND status IN ('shadow', 'active')
        `);
        if (affectedRowsOf(moved) !== 1) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "合同状态已变化，请重试" });
        }
        await writeAudit(tx, {
          factoryId: factory.id,
          contractId: input.contractId,
          actor,
          action: "retire",
          risk: String(contract.risk) as DshGovernanceRisk,
          detail: { reason: sanitizeText(input.reason, 300) },
        });
      });
      const row = assertContract(await contractById(db, factory.id, input.contractId));
      return { ok: true as const, contract: contractDto(row) };
    }),

  /** 本厂治理审计（可选按合同过滤；跨厂不可见）。 */
  audit: publicQuery
    .input(tokenInput.extend({ contractId: z.number().int().positive().optional() }))
    .query(async ({ input }) => {
      const { factory } = await sessionMe(input.token);
      const db = getDb();
      const rows = input.contractId
        ? rowsOf(await db.execute(sql`
            SELECT * FROM st_dsh_audit
            WHERE factory_id = ${factory.id} AND contract_id = ${input.contractId}
            ORDER BY id DESC LIMIT 100
          `))
        : rowsOf(await db.execute(sql`
            SELECT * FROM st_dsh_audit
            WHERE factory_id = ${factory.id}
            ORDER BY id DESC LIMIT 100
          `));
      return rows.map(auditDto);
    }),
});
