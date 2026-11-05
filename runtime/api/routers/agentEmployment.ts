/**
 * 个人 Agent：99 元报名 → 7 天隔离模拟工作 → 最多 8 次机会 → 达标/淘汰退款；
 * 企业岗位应聘与任务领取 → 交付独立验收 → job_token 双边结算。
 *
 * 边界：支付仅为显式沙箱适配器；本模块不宣称真实扣款/退款，也不把模拟工作评审称为模型权重训练。
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { sql, type SQL } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { hasCauseChainMatch, isDupEntry } from "../lib/dupEntry";
import { affectedRowsOf, insertIdOf } from "../lib/dbResult";
import { parseJsonArray } from "./terminal";
import { rawRows } from "../queries/rawRows";
import { requireHqAdmin } from "./terminalShared";
import { assertAgentTestDatabase, isAgentTestEconomy } from "../lib/agentEconomy";
import { dataScopeOf, effectiveRoleOf, requireDeptScope, requireWbRole, sessionMe, type WbDataScope, type WbSession } from "./wbSession";
import { withAgentWageTx, withEnterpriseEscrowTx } from "./tokenLedger";
import { withAgentTokenWalletTx, readAgentTokenBalance, type AgentTokenWalletDb } from "./agentTokenWallet";
import { AGENT_EXCHANGE_SANDBOX_BIZ_TYPE, AGENT_REGISTRATION_FEE_BIZ_TYPE, AGENT_REGISTRATION_REFUND_BIZ_TYPE, AGENT_RETAKE_FEE_BIZ_TYPE } from "./walletFlow";
import { normalizePublicDisplayName } from '../lib/agentMarketPublic'
import { AGENT_EXCHANGE_DAILY_MAX, AGENT_NAME_MAX_LENGTH, AGENT_NAME_MIN_LENGTH, HEADCOUNT_MAX, HEADCOUNT_MIN, JOB_DESCRIPTION_MAX_LENGTH, JOB_DESCRIPTION_MIN_LENGTH, JOB_TITLE_MAX_LENGTH, JOB_TITLE_MIN_LENGTH, JOB_TOKEN_AMOUNT_MAX, JOB_TOKEN_AMOUNT_MIN, MIN_DELIVERABLE_LENGTH, MIN_END_EMPLOYMENT_REASON_LENGTH, END_EMPLOYMENT_REASON_MAX_LENGTH, MIN_TASK_CANCEL_REASON_LENGTH, TASK_CANCEL_REASON_MAX_LENGTH, MIN_REVIEW_NOTE_LENGTH, REQUIREMENTS_MAX_LENGTH, REVIEW_NOTE_MAX_LENGTH, SCORE_MAX, SCORE_MIN, TASK_BRIEF_MAX_LENGTH, TASK_BRIEF_MIN_LENGTH, TRAINING_DELIVERABLE_MAX_LENGTH, WORK_DELIVERABLE_MAX_LENGTH } from "../../contracts/agentEmploymentRules";
import {
  MAX_TRAINING_ATTEMPTS,
  JOB_TOKEN_CNY_CENTS,
  REGISTRATION_FEE_JOB_TOKENS,
  RETAKE_FEE_JOB_TOKENS,
  REGISTRATION_FEE_CENTS,
  RETAKE_FEE_CENTS,
  TRAINING_CYCLE_DAYS,
  TRAINING_REVIEW_GRACE_DAYS,
  TRAINING_PASS_SCORE,
  TRAINING_MIN_TASK_SCORE,
  attemptFeeCents,
  attemptFeeJobTokens,
  canAccessEmployment,
  canTransitionClaim,
  evaluateCycle,
  evidenceSha256,
  outcomeAfterCycle,
  outcomeAfterFailedCycle,
  normalizeRefundFailureCode,
  WORK_REVIEW_GRACE_DAYS,
  PERMANENT_REFUND_FAILURE_CODES,
  trainingTaskForDay,
  type TaskClaimStatus,
  type CycleStatus,
  type RegistrationStatus,
} from "./agentEmploymentDomain";

type Db = ReturnType<typeof getDb>;
type Row = Record<string, unknown>;
interface RegistrationOrderView {
  registrationId: number; registrationNo: string; agentKey: string; status: string;
  orderNo: string; orderStatus: string; amountCents: number; amountJobTokens: number; environment: string; currency: string;
}
interface RetakeOrderView { orderNo: string; attemptNo: number; amountCents: number; amountJobTokens: number; status: string; environment: string }
interface JobCreatedView { id: number; jobNo: string; status: string }
interface TaskCreatedView { id: number; taskNo: string; status: string }
interface ApplicationView { id: number; status: string }
interface ClaimView { id: number; status: string; isActive?: number; idempotency_key?: string; owner_user_id?: number; registration_id?: number }
interface ReviewQueueRow extends Row { id: number; registrationId: number; dayNo: number; hasDeliverable: number }

const tokenInput = { token: z.string().trim().min(1) };
const idempotencyInput = { idempotencyKey: z.string().trim().min(8).max(96) };
const moneyInput = z.number().int().min(JOB_TOKEN_AMOUNT_MIN).max(JOB_TOKEN_AMOUNT_MAX);
const REVIEW_QUEUE_LIMIT = 100;
const FACTORY_LIST_LIMIT = 100;
const PERMANENT_REFUND_FAILURE_SET = PERMANENT_REFUND_FAILURE_CODES;
const REFUND_SETTLEMENT_BATCH_LIMIT = 100;

function rows<T = Row>(result: unknown): T[] {
  return rawRows(result) as T[];
}
const stringArray = parseJsonArray;

function departmentList(value: unknown): { id: string; name: string }[] {
  const source = typeof value === "string" ? (() => { try { return JSON.parse(value); } catch { return []; } })() : value;
  if (!Array.isArray(source)) return [];
  return source.filter((item) => item && typeof item === "object" && String((item as { id?: unknown }).id ?? "").length > 0)
    .map((item) => ({ id: String((item as { id: unknown }).id), name: String((item as { name?: unknown }).name ?? (item as { id: unknown }).id) }));
}
function affected(result: unknown): number {
  return affectedRowsOf(result);
}
function insertId(result: unknown): number {
  return insertIdOf(result);
}
function idem(scope: string, key: string): string {
  return `ae_${createHash("sha256").update(`agent-employment-v1|${scope}|${key}`).digest("hex")}`;
}
function numberId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(8).toString("hex")}`;
}
function asNumber(value: unknown): number {
  if (value === null || value === undefined || value === "") throw new Error("agent_employment_number_invalid");
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error("agent_employment_number_invalid");
  return n;
}
function asBool(value: unknown): boolean {
  return value === true || Number(value) === 1;
}
function isNil(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}
const REGISTRATION_PENDING_EXPIRE_MINUTES = 60;
const MARKET_LIST_LIMIT = 100;
const AGENT_EMPLOYMENT_TABLES = [
  "st_agent_registrations", "st_agent_training_cycles", "st_agent_training_tasks",
  "st_agent_payment_orders", "st_agent_payment_events", "st_agent_payment_refunds",
  "st_agent_jobs", "st_agent_job_applications", "st_agent_employments",
  "st_agent_work_tasks", "st_agent_task_claims", "st_agent_wage_ledger",
] as const;
const AGENT_EMPLOYMENT_TEST_TABLES = ["st_agent_token_wallets", "st_agent_token_exchanges"] as const;
function requiredAgentEmploymentTables(): readonly string[] {
  return isAgentTestEconomy() ? [...AGENT_EMPLOYMENT_TABLES, ...AGENT_EMPLOYMENT_TEST_TABLES] : AGENT_EMPLOYMENT_TABLES;
}
const AGENT_EMPLOYMENT_REQUIRED_COLUMNS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["st_agent_work_tasks", ["department_id", "escrow_job_tokens", "cancel_reason", "cancelled_by", "cancelled_at"]],
  ["st_agent_task_claims", ["is_active", "active_task_id"]],
  ["st_agent_employments", ["ended_by", "end_reason"]],
  ["st_agent_wage_ledger", ["wallet_owner_type", "wallet_owner_id"]],
  ["st_agent_payment_orders", ["amount_job_tokens"]],
  ["st_agent_payment_refunds", ["amount_job_tokens", "attempt_count", "next_retry_at"]],
  ["enterprises", ["reserved_job_tokens"]],
];
const AGENT_EMPLOYMENT_REQUIRED_COLUMN_COUNT = AGENT_EMPLOYMENT_REQUIRED_COLUMNS.reduce((total, [, columns]) => total + columns.length, 0);
let agentEmploymentSchemaReady = false;
async function assertAgentEmploymentSchemaReady(db: Db): Promise<void> {
  if (agentEmploymentSchemaReady) return;
  const result = rows(await db.execute(sql`
    SELECT COUNT(*) AS count FROM information_schema.tables
    WHERE table_schema=DATABASE() AND table_name IN (${sql.join(requiredAgentEmploymentTables().map((name) => sql`${name}`), sql`,`)})`))[0];
  if (asNumber(result?.count ?? 0) !== requiredAgentEmploymentTables().length) throw new Error("agent_employment_schema_not_ready");
  const columnPredicates = AGENT_EMPLOYMENT_REQUIRED_COLUMNS.map(([table, columns]) =>
    sql`(table_name=${table} AND column_name IN (${sql.join(columns.map((column) => sql`${column}`), sql`,`)}))`);
  const columns = rows(await db.execute(sql`
    SELECT COUNT(*) AS count FROM information_schema.columns
    WHERE table_schema=DATABASE() AND (${sql.join(columnPredicates, sql` OR `)})`))[0];
  if (asNumber(columns?.count ?? 0) !== AGENT_EMPLOYMENT_REQUIRED_COLUMN_COUNT) throw new Error("agent_employment_schema_columns_not_ready");
  const generatedIndex = rows(await db.execute(sql`
    SELECT COUNT(*) AS count FROM information_schema.statistics
    WHERE table_schema=DATABASE() AND table_name='st_agent_task_claims'
      AND index_name='uk_agent_claim_active' AND column_name='active_task_id'`))[0];
  if (asNumber(generatedIndex?.count ?? 0) !== 1) throw new Error("agent_employment_schema_index_not_ready");
  agentEmploymentSchemaReady = true;
}
function isDuplicate(err: unknown): boolean {
  return isDupEntry(err);
}
function conflict(message: string): never {
  throw new TRPCError({ code: "CONFLICT", message });
}
function badRequest(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message });
}
function notFound(message = "记录不存在或不属于你"): never {
  throw new TRPCError({ code: "NOT_FOUND", message });
}
function forbidden(message = "无权执行此操作"): never {
  throw new TRPCError({ code: "FORBIDDEN", message });
}
function precondition(message: string): never {
  throw new TRPCError({ code: "PRECONDITION_FAILED", message });
}
function reviewerRef(admin: unknown): string {
  const a = admin as { id?: unknown; username?: unknown; name?: unknown };
  const identity = a.username ?? a.name ?? a.id;
  if (isNil(identity) || String(identity).trim() === "") throw new Error("independent_reviewer_identity_missing");
  return String(identity).slice(0, 128);
}
/** reviewer_id 只接受 wb_users 原生身份；委派/超终账号仅写稳定 reviewer_ref，避免跨 ID 空间错归因。 */
export function reviewerWbUserId(admin: unknown): number | null {
  const a = admin as { id?: unknown; delegated?: boolean };
  if (a.delegated === true) return null;
  const id = Number(a.id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** 委派/原生复核席必须唯一映射回 wb_users，禁止不同账号空间的人借别名自审。 */
export async function resolveReviewerWbUserId(db: Db, admin: unknown, reviewer: string): Promise<number> {
  const direct = reviewerWbUserId(admin);
  if (direct !== null) return direct;
  const candidates = rows(await db.execute(sql`SELECT id, username FROM wb_users WHERE username=${reviewer}`));
  const normalized = reviewer.normalize("NFKC").toLowerCase();
  const matched = candidates.filter((candidate) => String(candidate.username).normalize("NFKC").toLowerCase() === normalized);
  if (matched.length !== 1) forbidden("复核席无法唯一映射工作台身份，已阻止独立复核");
  return Number(matched[0].id);
}

async function loadRegistrationOrder(db: Db, key: string, uid: number): Promise<RegistrationOrderView | undefined> {
  return rows<RegistrationOrderView>(await db.execute(sql`
    SELECT r.id AS registrationId, r.registration_no AS registrationNo, r.agent_key AS agentKey, r.status,
           o.order_no AS orderNo, o.status AS orderStatus, o.amount_cents AS amountCents,
           o.amount_job_tokens AS amountJobTokens, o.environment, o.currency AS currency
    FROM st_agent_registrations r JOIN st_agent_payment_orders o ON o.registration_id=r.id AND o.kind='registration'
    WHERE r.idempotency_key=${key} AND r.owner_user_id=${uid} AND r.status<>'abandoned' LIMIT 1`))[0];
}

// ─── 支付沙箱：显式环境、服务端金额、HMAC 回调、事件幂等 ─────────────────────
function assertSandboxDeploymentAllowed(): void {
  assertAgentTestDatabase();
  // 默认拒绝，不依赖 NODE_ENV 是否存在：只有显式隔离部署标识才允许沙箱。
  if (process.env.AGENT_EMPLOYMENT_ALLOW_PRODUCTION_SANDBOX !== "true") {
    precondition("当前部署未显式允许支付沙箱；生产与未标识环境均默认拒绝");
  }
}
function sandboxPaymentAvailable(): boolean {
  return isAgentTestEconomy()
    && process.env.AGENT_EMPLOYMENT_TEST_DATABASE === "1"
    && process.env.AGENT_EMPLOYMENT_ALLOW_PRODUCTION_SANDBOX === "true"
    && process.env.PAYMENT_SANDBOX_ENABLED === "true"
    && (process.env.PAYMENT_SANDBOX_SECRET ?? "").length >= 16;
}
function sandboxSecret(): string {
  assertSandboxDeploymentAllowed();
  if (!sandboxPaymentAvailable()) precondition("支付沙箱未启用；不会模拟扣款或退款");
  return process.env.PAYMENT_SANDBOX_SECRET ?? "";
}
interface SandboxCallback {
  eventId: string;
  orderNo: string;
  status: "paid";
  amountCents: number;
  amountJobTokens: number;
  attemptNo: number;
  environment: "sandbox";
  signature: string;
}
function callbackText(payload: Omit<SandboxCallback, "signature">): string {
  return [payload.eventId, payload.orderNo, payload.status, payload.amountCents, payload.amountJobTokens, payload.attemptNo, payload.environment].join("|");
}
export function signSandboxCallback(payload: Omit<SandboxCallback, "signature">, secret: string): string {
  return createHmac("sha256", secret).update(callbackText(payload), "utf8").digest("hex");
}
export function verifySandboxCallback(payload: SandboxCallback, secret: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(payload.signature)) return false;
  const expected = Buffer.from(signSandboxCallback(payload, secret), "hex");
  const actual = Buffer.from(payload.signature, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function createCycle(db: Db, registrationId: number, attemptNo: number): Promise<number> {
  const result = await db.execute(sql`
    INSERT INTO st_agent_training_cycles (registration_id, attempt_no, status, starts_at, ends_at)
    VALUES (${registrationId}, ${attemptNo}, 'active', NOW(), DATE_ADD(NOW(), INTERVAL ${TRAINING_CYCLE_DAYS} DAY))`);
  const cycleId = insertId(result);
  await releaseDailyTasks(db, cycleId);
  return cycleId;
}

/** 按服务端数据库日期释放题目；重复执行只补缺失日期，不重置已有交付或评分。 */
async function releaseDailyTasks(db: Db, cycleId: number): Promise<number> {
  const cycle = rows(await db.execute(sql`
    SELECT id, status, starts_at AS startsAt,
           GREATEST(0, LEAST(${TRAINING_CYCLE_DAYS}, TIMESTAMPDIFF(DAY, starts_at, NOW()) + 1)) AS dayNo
    FROM st_agent_training_cycles WHERE id=${cycleId} LIMIT 1`))[0];
  if (!cycle || !["active", "reviewing"].includes(String(cycle.status))) return 0;
  const currentDay = asNumber(cycle.dayNo);
  if (currentDay < 1) return 0;
  const releasedDays = new Set(rows(await db.execute(sql`SELECT day_no AS dayNo FROM st_agent_training_tasks WHERE cycle_id=${cycleId}`)).map((row) => asNumber(row.dayNo)));
  const values = [];
  for (let day = 1; day <= currentDay; day += 1) {
    if (releasedDays.has(day)) continue;
    const task = trainingTaskForDay(day);
    values.push(sql`(${cycleId}, ${day}, ${task.taskKey}, ${task.title}, ${task.brief}, ${JSON.stringify(task.rubric)},
      DATE_ADD((SELECT starts_at FROM st_agent_training_cycles WHERE id=${cycleId}), INTERVAL ${day - 1} DAY))`);
  }
  if (values.length === 0) return 0;
  const inserted = await db.execute(sql`
    INSERT INTO st_agent_training_tasks (cycle_id, day_no, task_key, title, brief, rubric_json, available_at)
    VALUES ${sql.join(values, sql`,`)}
    ON DUPLICATE KEY UPDATE cycle_id=VALUES(cycle_id)`);
  return affected(inserted);
}

async function queueRegistrationRefund(db: Db, registrationId: number, reason: "qualified" | "disqualified"): Promise<void> {
  const registration = rows(await db.execute(sql`
    SELECT id, status FROM st_agent_registrations WHERE id=${registrationId} FOR UPDATE`))[0];
  if (!registration || !["qualified", "disqualified"].includes(String(registration.status))) return;
  const order = rows(await db.execute(sql`
    SELECT id, status, environment, amount_job_tokens AS amountJobTokens FROM st_agent_payment_orders
    WHERE registration_id=${registrationId} AND kind='registration' AND attempt_no=1 LIMIT 1 FOR UPDATE`))[0];
  if (!order || String(order.environment) !== "sandbox") {
    await db.execute(sql`UPDATE st_agent_registrations SET fee_status='refund_failed' WHERE id=${registrationId}`);
    return;
  }
  if (String(order.status) === "refunded") {
    await db.execute(sql`UPDATE st_agent_registrations SET fee_status='refunded' WHERE id=${registrationId} AND fee_status<>'refunded'`);
    return;
  }
  if (String(order.status) !== "paid" && String(order.status) !== "refund_pending") {
    await db.execute(sql`UPDATE st_agent_registrations SET fee_status='refund_failed' WHERE id=${registrationId}`);
    return;
  }
  if (asNumber(order.amountJobTokens) !== REGISTRATION_FEE_JOB_TOKENS) {
    await db.execute(sql`UPDATE st_agent_registrations SET fee_status='refund_failed' WHERE id=${registrationId}`);
    return;
  }
  await db.execute(sql`
    INSERT INTO st_agent_payment_refunds
      (refund_no, registration_id, original_order_id, amount_cents, amount_job_tokens, reason, environment, status)
    VALUES
      (${numberId("ARF")}, ${registrationId}, ${Number(order.id)}, ${REGISTRATION_FEE_CENTS}, ${REGISTRATION_FEE_JOB_TOKENS}, ${reason}, 'sandbox', 'pending')
    ON DUPLICATE KEY UPDATE registration_id=VALUES(registration_id)`);
  if (String(order.status) === "paid") {
    await db.execute(sql`UPDATE st_agent_payment_orders SET status='refund_pending' WHERE id=${Number(order.id)} AND status='paid'`);
  }
  await db.execute(sql`
    UPDATE st_agent_registrations SET fee_status='refund_pending'
    WHERE id=${registrationId} AND fee_status IN ('paid','refund_pending')`);
}

const REFUND_MAX_ATTEMPTS = 12;

export async function settleSandboxRefunds(registrationId?: number): Promise<void> {
  sandboxSecret();
  const db = getDb();
  const registrationFilter = isNil(registrationId) ? sql`1=1` : sql`registration_id=${registrationId}`;
  const pending = rows(await db.execute(sql`
    SELECT id, registration_id AS registrationId FROM st_agent_payment_refunds
    WHERE environment='sandbox' AND ${registrationFilter}
      AND (
        status='pending'
        OR (
          status='failed'
          AND (failure_code IS NULL OR failure_code NOT IN (${sql.join([...PERMANENT_REFUND_FAILURE_SET].map((code) => sql`${code}`), sql`,`)}))
          AND attempt_count<${REFUND_MAX_ATTEMPTS}
          AND (next_retry_at IS NULL OR next_retry_at<=NOW())
        )
      )
    ORDER BY id ASC LIMIT ${REFUND_SETTLEMENT_BATCH_LIMIT}`));
  for (const item of pending) {
    try {
      await withAgentTokenWalletTx(db, async (ledgerTx, wallet) => {
      const dbtx = ledgerTx as unknown as Db;
      await dbtx.execute(sql`SELECT id FROM st_agent_registrations WHERE id=${Number(item.registrationId)} FOR UPDATE`);
      const refund = rows(await dbtx.execute(sql`
        SELECT r.*, o.status AS orderStatus
        FROM st_agent_payment_refunds r JOIN st_agent_payment_orders o ON o.id=r.original_order_id
        WHERE r.id=${Number(item.id)} FOR UPDATE`))[0];
      if (!refund || !["pending", "failed"].includes(String(refund.status))) return;
      if (String(refund.orderStatus) === "refunded") {
        await dbtx.execute(sql`UPDATE st_agent_payment_refunds SET status='succeeded', processed_at=NOW(), failure_code=NULL, next_retry_at=NULL WHERE id=${Number(item.id)}`);
        return;
      }
      if (!["paid", "refund_pending"].includes(String(refund.orderStatus))) throw new Error("registration_refund_origin_not_paid");
      if (asNumber(refund.amount_cents) !== REGISTRATION_FEE_CENTS || asNumber(refund.amount_job_tokens) !== REGISTRATION_FEE_JOB_TOKENS) {
        throw new Error("registration_refund_amount_invalid");
      }
      // 原路语义：平台钱包退回原 Agent 钱包，不新建收款，不退任何补考订单。
      await wallet.creditSystemAgentTokenWallet(Number(refund.registration_id), {
        direction: "in", amount: REGISTRATION_FEE_JOB_TOKENS, bizType: AGENT_REGISTRATION_REFUND_BIZ_TYPE,
        refId: String(refund.refund_no), note: "个人Agent报名费原路退款入账",
      });
      await wallet.changePlatformTokenWallet({
        direction: "out", amount: REGISTRATION_FEE_JOB_TOKENS, bizType: AGENT_REGISTRATION_REFUND_BIZ_TYPE,
        refId: String(refund.refund_no), note: "个人Agent报名费原路退款支出", insufficientMessage: "平台 job_token 余额不足，退款将等待重试",
      });
      const refundChanged = affected(await dbtx.execute(sql`
        UPDATE st_agent_payment_refunds
        SET status='succeeded', provider_ref=${`sandbox_refund_${String(refund.refund_no)}`},
            failure_code=NULL, attempt_count=0, next_retry_at=NULL, processed_at=NOW()
        WHERE id=${Number(refund.id)} AND status IN ('pending','failed')`));
      if (refundChanged !== 1) throw new Error("registration_refund_state_changed");
      if (String(refund.orderStatus) !== "refunded") {
        const orderChanged = affected(await dbtx.execute(sql`
          UPDATE st_agent_payment_orders SET status='refunded', refunded_at=NOW()
          WHERE id=${Number(refund.original_order_id)} AND status IN ('paid','refund_pending')`));
        if (orderChanged !== 1) throw new Error("registration_refund_origin_state_changed");
      }
      await dbtx.execute(sql`
        UPDATE st_agent_registrations SET fee_status='refunded'
        WHERE id=${Number(refund.registration_id)} AND status IN ('qualified','disqualified')`);
      });
    } catch (err) {
      const code = normalizeRefundFailureCode(err);
      try {
        await db.transaction(async (failureTx) => {
        const dbtx = failureTx as unknown as Db;
        const latest = rows(await dbtx.execute(sql`
          SELECT attempt_count AS attemptCount FROM st_agent_payment_refunds
          WHERE id=${Number(item.id)} AND status IN ('pending','failed') FOR UPDATE`))[0];
        if (!latest) return;
        const nextAttempt = Number(latest.attemptCount ?? 0) + 1;
        const retryDelayMinutes = Math.min(60, 5 * nextAttempt);
        await dbtx.execute(sql`
          UPDATE st_agent_payment_refunds
          SET status='failed', failure_code=${code}, attempt_count=${nextAttempt},
              next_retry_at=DATE_ADD(NOW(), INTERVAL ${retryDelayMinutes} MINUTE), processed_at=NOW()
          WHERE id=${Number(item.id)} AND status IN ('pending','failed')`);
        if (PERMANENT_REFUND_FAILURE_SET.has(code) || nextAttempt >= REFUND_MAX_ATTEMPTS) {
          await dbtx.execute(sql`
            UPDATE st_agent_registrations SET fee_status='refund_failed'
            WHERE id=${Number(item.registrationId)} AND fee_status='refund_pending'`);
        }
      });
      } catch (bookkeepingError) {
        console.error(`[agent-payment] refund ${Number(item.id)} failure bookkeeping failed:`, (bookkeepingError as { code?: string })?.code ?? "refund_bookkeeping_failed");
        continue;
      }
      // 原始驱动错误仅留服务端日志；API 与数据面只暴露上面的稳定错误码。
      console.error(`[agent-payment] refund ${Number(item.id)} deferred (${code}):`, err);
    }
  }
}

async function processSandboxPayment(input: { orderNo: string; eventId: string }): Promise<{ ok: true; already: boolean; status: string }> {
  const secret = sandboxSecret();
  const order = rows(await getDb().execute(sql`
    SELECT amount_cents AS amountCents, amount_job_tokens AS amountJobTokens, attempt_no AS attemptNo
    FROM st_agent_payment_orders WHERE order_no=${input.orderNo} AND environment='sandbox' LIMIT 1`))[0];
  if (!order) notFound("沙箱订单不存在");
  const unsigned = {
    eventId: input.eventId,
    orderNo: input.orderNo,
    status: "paid" as const,
    amountCents: asNumber(order.amountCents),
    amountJobTokens: asNumber(order.amountJobTokens),
    attemptNo: asNumber(order.attemptNo),
    environment: "sandbox" as const,
  };
  return processSandboxCallback({ ...unsigned, signature: signSandboxCallback(unsigned, secret) });
}

async function processSandboxCallback(payload: SandboxCallback): Promise<{ ok: true; already: boolean; status: string }> {
  const secret = sandboxSecret();
  if (!verifySandboxCallback(payload, secret)) forbidden("支付回调验签失败");
  const db = getDb();
  const unsignedPayload = {
    eventId: payload.eventId, orderNo: payload.orderNo, status: payload.status,
    amountCents: payload.amountCents, amountJobTokens: payload.amountJobTokens, attemptNo: payload.attemptNo, environment: payload.environment,
  };
  const payloadHash = createHash("sha256").update(callbackText(unsignedPayload)).digest("hex");
  try {
    return await withAgentTokenWalletTx(db, async (ledgerTx, wallet): Promise<{ ok: true; already: boolean; status: string }> => {
      const dbtx = ledgerTx as unknown as Db;
      const existing = rows(await dbtx.execute(sql`SELECT id, payload_sha256 AS payloadSha256 FROM st_agent_payment_events WHERE event_id=${payload.eventId} LIMIT 1`))[0];
      if (existing) {
        if (String(existing.payloadSha256) !== payloadHash) forbidden("支付回调事件指纹不一致，禁止重放");
        return { ok: true, already: true, status: "paid" };
      }
      // 与 finalizeCycle/queueRegistrationRefund 统一锁顺序：registration → payment order。
      const orderOwner = rows(await dbtx.execute(sql`SELECT registration_id AS registrationId FROM st_agent_payment_orders WHERE order_no=${payload.orderNo} LIMIT 1`))[0];
      if (!orderOwner) notFound("订单不存在");
      await dbtx.execute(sql`SELECT id FROM st_agent_registrations WHERE id=${Number(orderOwner.registrationId)} FOR UPDATE`);
      const current = rows(await dbtx.execute(sql`
        SELECT o.*, r.status AS registrationStatus, r.current_attempt_no AS currentAttemptNo
        FROM st_agent_payment_orders o JOIN st_agent_registrations r ON r.id=o.registration_id
        WHERE o.order_no=${payload.orderNo} FOR UPDATE`))[0];
      if (!current) notFound("订单不存在");
      if (String(current.environment) !== "sandbox" || asNumber(current.amount_cents) !== payload.amountCents || asNumber(current.amount_job_tokens) !== payload.amountJobTokens || asNumber(current.attempt_no) !== payload.attemptNo) {
        badRequest("回调金额、环境或训练次数与订单不一致");
      }
      if (asNumber(current.amount_cents) !== attemptFeeCents(asNumber(current.attempt_no)) || asNumber(current.amount_job_tokens) !== attemptFeeJobTokens(asNumber(current.attempt_no))) {
        badRequest("订单费用规则不一致");
      }
      if (String(current.status) !== "pending") {
        if (["paid", "refund_pending", "refunded"].includes(String(current.status))) return { ok: true, already: true, status: String(current.status) };
        conflict(`订单状态 ${String(current.status)} 不可支付`);
      }
      await dbtx.execute(sql`
        INSERT INTO st_agent_payment_events (event_id, order_id, event_type, payload_sha256, payload_json)
        VALUES (${payload.eventId}, ${Number(current.id)}, 'payment.paid', ${payloadHash}, ${JSON.stringify(unsignedPayload)})`);
      const registrationId = Number(current.registration_id);
      const feeBizType = String(current.kind) === "registration" ? AGENT_REGISTRATION_FEE_BIZ_TYPE : AGENT_RETAKE_FEE_BIZ_TYPE;
      await wallet.changeAgentTokenWallet(registrationId, {
        direction: "out", amount: payload.amountJobTokens, bizType: feeBizType, refId: payload.orderNo,
        note: String(current.kind) === "registration" ? "个人Agent报名费支出" : "个人Agent补考费支出",
      });
      await wallet.changePlatformTokenWallet({
        direction: "in", amount: payload.amountJobTokens, bizType: feeBizType, refId: payload.orderNo,
        note: String(current.kind) === "registration" ? "个人Agent报名费入账" : "个人Agent补考费入账",
      });
      const changed = affected(await dbtx.execute(sql`
        UPDATE st_agent_payment_orders SET status='paid', provider_ref=${`sandbox_pay_${payload.orderNo}`}, paid_at=NOW()
        WHERE id=${Number(current.id)} AND status='pending'`));
      if (changed !== 1) conflict("订单已被其他回调处理");
      const attemptNo = asNumber(current.attempt_no);
      if (String(current.kind) === "registration") {
        if (attemptNo !== 1 || String(current.registrationStatus) !== "pending_payment" || asNumber(current.currentAttemptNo) !== 0) {
          conflict("报名订单与注册状态不一致");
        }
        const activated = affected(await dbtx.execute(sql`
          UPDATE st_agent_registrations
          SET status='training', fee_status='paid', current_attempt_no=1, version=version+1
          WHERE id=${registrationId} AND status='pending_payment' AND current_attempt_no=0`));
        if (activated !== 1) conflict("注册状态已被其他回调改变");
        await createCycle(dbtx, registrationId, 1);
      } else if (String(current.kind) === "retake") {
        if (attemptNo < 2 || attemptNo > MAX_TRAINING_ATTEMPTS || String(current.registrationStatus) !== "training" || asNumber(current.currentAttemptNo) !== attemptNo - 1) {
          conflict("补考订单与当前训练进度不一致");
        }
        const previous = rows(await dbtx.execute(sql`
          SELECT status FROM st_agent_training_cycles WHERE registration_id=${registrationId} AND attempt_no=${attemptNo - 1} LIMIT 1`))[0];
        if (!previous || !["failed", "expired"].includes(String(previous.status))) precondition("上一周期未结束，不能补考");
        const advanced = affected(await dbtx.execute(sql`
          UPDATE st_agent_registrations SET current_attempt_no=${attemptNo}, version=version+1
          WHERE id=${registrationId} AND status='training' AND current_attempt_no=${attemptNo - 1}`));
        if (advanced !== 1) conflict("训练进度已被其他回调改变");
        await createCycle(dbtx, registrationId, attemptNo);
      } else {
        badRequest("未知订单类型");
      }
      return { ok: true, already: false, status: "paid" };
    });
  } catch (err) {
    if (isDuplicate(err) && hasCauseChainMatch(err, { message: "uk_agent_payment_event" })) return { ok: true, already: true, status: "paid" };
    throw err;
  }
}

async function finalizeCycle(db: Db, cycleId: number, passed: boolean, score: number | null): Promise<"qualified" | "awaiting_retake" | "disqualified" | null> {
  const cycle = rows(await db.execute(sql`
    SELECT c.*, r.status AS registrationStatus
    FROM st_agent_training_cycles c JOIN st_agent_registrations r ON r.id=c.registration_id
    WHERE c.id=${cycleId} FOR UPDATE`))[0];
  if (!cycle || !["active", "reviewing"].includes(String(cycle.status)) || String(cycle.registrationStatus) !== "training") return null;
  const attemptNo = asNumber(cycle.attempt_no);
  const taskRows = rows(await readCycleScores(db, cycleId));
  const evaluation = passed ? evaluateCycle(taskRows.map((r) => asNumber(r.score))) : null;
  if (score !== null && evaluation?.complete && evaluation.passed !== passed) throw new Error("training_cycle_verdict_conflict");
  let outcome: "qualified" | "awaiting_retake" | "disqualified";
  if (passed) outcome = outcomeAfterCycle({ attemptNo, passed: true, scores: taskRows.map((r) => asNumber(r.score)) });
  else outcome = outcomeAfterFailedCycle(attemptNo);
  let nextCycleStatus: CycleStatus = "failed";
  if (passed) nextCycleStatus = "passed";
  else if (isNil(score)) nextCycleStatus = "expired";
  await db.execute(sql`
    UPDATE st_agent_training_cycles SET status=${nextCycleStatus},
      score=${score}, reviewed_at=NOW()
    WHERE id=${cycleId} AND status IN ('active','reviewing')`);
  if (nextCycleStatus === "expired") {
    // 到期后复核队列会关闭；未评分任务必须同步进入可见终态，不能永久显示“待复核”。
    await db.execute(sql`
      UPDATE st_agent_training_tasks SET status='expired'
      WHERE cycle_id=${cycleId} AND status IN ('assigned','submitted')`);
  }
  if (outcome === "qualified") {
    await db.execute(sql`
      UPDATE st_agent_registrations SET status='qualified', qualified_at=NOW(), version=version+1
      WHERE id=${Number(cycle.registration_id)} AND status='training'`);
  } else if (outcome === "disqualified") {
    await db.execute(sql`
      UPDATE st_agent_registrations SET status='disqualified', disqualified_at=NOW(), version=version+1
      WHERE id=${Number(cycle.registration_id)} AND status='training'`);
  }
  if (outcome !== "awaiting_retake") await queueRegistrationRefund(db, Number(cycle.registration_id), outcome);
  return outcome;
}

async function readCycleScores(db: Db, cycleId: number): Promise<Record<string, unknown>[]> {
  return rows(await db.execute(sql`SELECT score FROM st_agent_training_tasks WHERE cycle_id=${cycleId} ORDER BY day_no ASC FOR UPDATE`));
}

async function cancelExpiredOpenTasks(db: Db): Promise<{ cancelled: number; failed: number }> {
  const candidates = rows(await db.execute(sql`
    SELECT id, factory_id AS factoryId
    FROM st_agent_work_tasks
    WHERE deadline_at IS NOT NULL AND deadline_at<=NOW()
      AND (status IN ('open','claimed','rejected') OR (status='submitted' AND deadline_at<=DATE_SUB(NOW(), INTERVAL ${WORK_REVIEW_GRACE_DAYS} DAY)))
    ORDER BY id ASC LIMIT 200`));
  let cancelled = 0;
  let failed = 0;
  for (const item of candidates) {
    try {
      const cancelledThis = await withEnterpriseEscrowTx(db, async (dbtx, escrow): Promise<boolean> => {
        const taskId = Number(item.id);
        // 与领取、提交、复核和重开统一 task→claim 锁序。
        const current = rows(await dbtx.execute(sql`SELECT status, escrow_job_tokens AS escrowJobTokens,
      (status IN ('open','claimed','rejected') AND deadline_at<=NOW()) OR (status='submitted' AND deadline_at<=DATE_SUB(NOW(), INTERVAL ${WORK_REVIEW_GRACE_DAYS} DAY)) AS expired FROM st_agent_work_tasks WHERE id=${taskId} FOR UPDATE`))[0];
        if (!current || !["open", "claimed", "rejected", "submitted"].includes(String(current.status)) || !asBool(current.expired)) return false;
        await dbtx.execute(sql`
          SELECT id FROM st_agent_task_claims WHERE task_id=${taskId} AND is_active=1 AND status IN ('claimed','rejected','submitted') LIMIT 1 FOR UPDATE`);
        const cancelReason = String(current.status) === 'submitted' ? 'review_sla_expired' : 'deadline_expired';
        await dbtx.execute(sql`
          UPDATE st_agent_task_claims SET review_note=IF(status='submitted', ${cancelReason}, review_note),
            status='revoked', is_active=0, version=version+1
          WHERE task_id=${taskId} AND is_active=1 AND status IN ('claimed','rejected','submitted')`);
        await escrow.releaseEnterpriseEscrowWith(Number(item.factoryId), taskId, asNumber(current.escrowJobTokens));
        const changed = affected(await dbtx.execute(sql`
          UPDATE st_agent_work_tasks SET status='cancelled', cancel_reason=${cancelReason}, cancelled_at=NOW()
          WHERE id=${taskId} AND status IN ('open','claimed','rejected','submitted')`));
        if (changed !== 1) conflict("任务已被其他流程处理");
        return true;
      });
      if (cancelledThis) cancelled += 1;
    } catch (err) {
      failed += 1;
      console.error(`[agent-work] expired task ${Number(item.id)} cancel failed:`, (err as { code?: string })?.code ?? "task_cancel_failed");
    }
  }
  return { cancelled, failed };
}

/** 自动每日释放 + 到期结算；单周期故障不饿死后续周期，复核超期有终态。 */
export async function runAgentTrainingSweep(): Promise<{ scanned: number; released: number; finalized: number; failedCycles: number; cancelledTasks: number; failedTaskCancels: number }> {
  const db = getDb();
  await assertAgentEmploymentSchemaReady(db);
  let scanned = 0;
  let released = 0;
  let finalized = 0;
  let failedCycles = 0;
  for (;;) {
    if (scanned >= 200) break; // 单轮最多 200 个周期，防止全表长扫。
    const active = rows(await db.execute(sql`
      SELECT id, NOW() > ends_at AS overdue,
             NOW() > DATE_ADD(ends_at, INTERVAL ${TRAINING_REVIEW_GRACE_DAYS} DAY) AS reviewExpired
      FROM st_agent_training_cycles WHERE status IN ('active','reviewing')
      ORDER BY id ASC LIMIT 200`));
    if (active.length === 0) break;
    scanned += active.length;
    for (const item of active) {
      const cycleId = Number(item.id);
      try {
        released += await releaseDailyTasks(db, cycleId);
        if (!asBool(item.overdue)) continue;
        const outcome = await db.transaction(async (tx) => {
          const dbtx = tx as unknown as Db;
          // 与 submitTask/reviewTask 统一锁顺序：先注册，后周期，禁止 cycle→registration 反转。
          const owner = rows(await dbtx.execute(sql`SELECT registration_id AS registrationId FROM st_agent_training_cycles WHERE id=${cycleId} LIMIT 1`))[0];
          if (!owner) return null;
          await dbtx.execute(sql`SELECT id FROM st_agent_registrations WHERE id=${Number(owner.registrationId)} FOR UPDATE`);
          const cycle = rows(await dbtx.execute(sql`SELECT status FROM st_agent_training_cycles WHERE id=${cycleId} FOR UPDATE`))[0];
          if (!cycle || !["active", "reviewing"].includes(String(cycle.status))) return null;
          const scores = await readCycleScores(dbtx, cycleId);
          const allScored = scores.length === TRAINING_CYCLE_DAYS && scores.every((row) => !isNil(row.score));
          if (allScored) {
            const evaluation = evaluateCycle(scores.map((row) => asNumber(row.score)));
            if (evaluation.complete) return finalizeCycle(dbtx, cycleId, evaluation.passed, evaluation.score);
          }
          const submitted = rows(await dbtx.execute(sql`
            SELECT COUNT(*) AS count FROM st_agent_training_tasks
            WHERE cycle_id=${cycleId} AND status IN ('submitted','reviewed')`))[0];
          if (asNumber(submitted?.count ?? 0) === TRAINING_CYCLE_DAYS && !asBool(item.reviewExpired)) {
            await dbtx.execute(sql`UPDATE st_agent_training_cycles SET status='reviewing' WHERE id=${cycleId} AND status='active'`);
            return null;
          }
          return finalizeCycle(dbtx, cycleId, false, null);
        });
        if (outcome) finalized += 1;
      } catch (err) {
        failedCycles += 1;
        console.error(`[agent-training] cycle ${cycleId} sweep failed:`, (err as { code?: string })?.code ?? "cycle_sweep_failed");
      }
    }
    // 只有完整消费当前批次后才能结束 keyset 分页；不得在 per-cycle 循环内提前 break。
    if (active.length < 200) break;
  }
  if (sandboxPaymentAvailable()) {
    try { await settleSandboxRefunds(); }
    catch (err) { console.error("[agent-payment] sweep refund deferred:", (err as { code?: string })?.code ?? "refund_failed"); }
  }
  const expiry = await cancelExpiredOpenTasks(db);
  return { scanned, released, finalized, failedCycles, cancelledTasks: expiry.cancelled, failedTaskCancels: expiry.failed };
}

// 所有训练/就业入口共享 schema 就绪闸；未先执行 additive DDL 时统一 fail-closed。
const agentEmploymentProcedure = publicQuery.use(async ({ next }) => {
  await assertAgentEmploymentSchemaReady(getDb());
  return next();
});

// ─── 个人 Agent 报名、训练与支付沙箱 API ────────────────────────────────────
export const agentTrainingRouter = createRouter({
  register: agentEmploymentProcedure.input(z.object({
    ...tokenInput,
    ...idempotencyInput,
    agentName: z.string().trim().min(AGENT_NAME_MIN_LENGTH).max(AGENT_NAME_MAX_LENGTH),
  })).mutation(async ({ input }) => {
    const session = await sessionMe(input.token);
    if (!sandboxPaymentAvailable()) precondition("当前未配置可用支付通道，暂不创建报名订单");
    const uid = Number(session.user.id);
    const key = idem(`register:${uid}`, input.idempotencyKey);
    const db = getDb();
    const existing = await loadRegistrationOrder(db, key, uid);
    if (existing) return { ...existing, already: true, realPayment: false };
    try {
      return await withAgentTokenWalletTx(db, async (ledgerTx, wallet) => {
        const dbtx = ledgerTx as unknown as Db;
        // 同一 Owner 的报名在事务内串行：同键重放恢复原单，不同键不得叠加训练与兑换配额。
        await dbtx.execute(sql`SELECT id FROM wb_users WHERE id=${uid} FOR UPDATE`);
        const replay = await loadRegistrationOrder(dbtx, key, uid);
        if (replay) return { ...replay, already: true, realPayment: false };
        await dbtx.execute(sql`
          UPDATE st_agent_registrations SET status='abandoned', fee_status='abandoned', idempotency_key=CONCAT('abandoned:', id)
          WHERE owner_user_id=${uid} AND status='pending_payment'
            AND created_at < DATE_SUB(NOW(), INTERVAL ${REGISTRATION_PENDING_EXPIRE_MINUTES} MINUTE)`);
        await dbtx.execute(sql`
          UPDATE st_agent_payment_orders SET status='abandoned', idempotency_key=CONCAT('abandoned:order:', id)
          WHERE owner_user_id=${uid} AND status IN ('pending','abandoned') AND kind='registration'
            AND ((status='pending' AND created_at < DATE_SUB(NOW(), INTERVAL ${REGISTRATION_PENDING_EXPIRE_MINUTES} MINUTE)) OR status='abandoned')`);
        const activeRegistration = rows(await dbtx.execute(sql`
          SELECT id FROM st_agent_registrations
          WHERE owner_user_id=${uid} AND status IN ('pending_payment','training','qualified','disqualified') LIMIT 1`))[0];
        if (activeRegistration) conflict("已有进行中或已定档的个人 Agent，不能重复报名");
        const registrationNo = numberId("AR");
        const agentKey = numberId("agent");
        const registrationResult = await dbtx.execute(sql`
          INSERT INTO st_agent_registrations
            (registration_no, agent_key, owner_user_id, agent_name, status, fee_status, idempotency_key)
          VALUES
            (${registrationNo}, ${agentKey}, ${uid}, ${input.agentName}, 'pending_payment', 'unpaid', ${key})`);
        const registrationId = insertId(registrationResult);
        await wallet.ensureAgentTokenWallet(registrationId);
        const orderNo = numberId("AO");
        await dbtx.execute(sql`
          INSERT INTO st_agent_payment_orders
            (order_no, registration_id, owner_user_id, kind, attempt_no, amount_cents, amount_job_tokens, environment, idempotency_key)
          VALUES
            (${orderNo}, ${registrationId}, ${uid}, 'registration', 1, ${REGISTRATION_FEE_CENTS}, ${REGISTRATION_FEE_JOB_TOKENS}, 'sandbox', ${idem(`order:${uid}`, input.idempotencyKey)})`);
        return {
          registrationId, registrationNo, agentKey, orderNo, status: "pending_payment", orderStatus: "pending",
          amountCents: REGISTRATION_FEE_CENTS, amountJobTokens: REGISTRATION_FEE_JOB_TOKENS, currency: "CNY", environment: "sandbox",
          already: false, realPayment: false,
        };
      });
    } catch (err) {
      if (!isDuplicate(err)) throw err;
      const duplicate = await loadRegistrationOrder(db, key, uid);
      if (!duplicate) throw err;
      return { ...duplicate, already: true, realPayment: false };
    }
  }),

  createRetakeOrder: agentEmploymentProcedure.input(z.object({
    ...tokenInput,
    ...idempotencyInput,
    registrationId: z.number().int().positive(),
  })).mutation(async ({ input }) => {
    const session = await sessionMe(input.token);
    if (!sandboxPaymentAvailable()) precondition("当前未配置可用支付通道，暂不创建补考订单");
    const uid = Number(session.user.id);
    const db = getDb();
    const key = idem(`retake:${uid}:${input.registrationId}`, input.idempotencyKey);
    const existing = rows<RetakeOrderView>(await db.execute(sql`
      SELECT order_no AS orderNo, attempt_no AS attemptNo, amount_cents AS amountCents, amount_job_tokens AS amountJobTokens, status, environment
      FROM st_agent_payment_orders WHERE idempotency_key=${key} AND owner_user_id=${uid} LIMIT 1`))[0];
    if (existing) return { ...existing, registrationId: input.registrationId, currency: "CNY", already: true, realPayment: false };
    try {
      return await withAgentTokenWalletTx(db, async (ledgerTx, wallet) => {
        const dbtx = ledgerTx as unknown as Db;
        const registration = rows(await dbtx.execute(sql`
          SELECT * FROM st_agent_registrations WHERE id=${input.registrationId} AND owner_user_id=${uid} FOR UPDATE`))[0];
        if (!registration) notFound();
        if (String(registration.status) !== "training") precondition("只有训练中的个人 Agent 可以补考");
        const currentAttempt = asNumber(registration.current_attempt_no);
        const nextAttempt = currentAttempt + 1;
        if (nextAttempt > MAX_TRAINING_ATTEMPTS) conflict(`${MAX_TRAINING_ATTEMPTS} 次训练机会已用完`);
        const previous = rows(await dbtx.execute(sql`
          SELECT status FROM st_agent_training_cycles WHERE registration_id=${input.registrationId} AND attempt_no=${currentAttempt} LIMIT 1`))[0];
        if (!previous || !["failed", "expired"].includes(String(previous.status))) precondition("当前训练周期尚未结束，不能创建补考订单");
        const otherActive = rows(await dbtx.execute(sql`
          SELECT id FROM st_agent_training_cycles WHERE registration_id=${input.registrationId} AND status IN ('active','reviewing') LIMIT 1`))[0];
        if (otherActive) conflict("仍有进行中的训练周期");
        await wallet.ensureAgentTokenWallet(input.registrationId);
        const orderNo = numberId("AO");
        await dbtx.execute(sql`
          INSERT INTO st_agent_payment_orders
            (order_no, registration_id, owner_user_id, kind, attempt_no, amount_cents, amount_job_tokens, environment, idempotency_key)
          VALUES
            (${orderNo}, ${input.registrationId}, ${uid}, 'retake', ${nextAttempt}, ${RETAKE_FEE_CENTS}, ${RETAKE_FEE_JOB_TOKENS}, 'sandbox', ${key})
          ON DUPLICATE KEY UPDATE order_no=st_agent_payment_orders.order_no`);
        const created = rows<RetakeOrderView>(await dbtx.execute(sql`
          SELECT order_no AS orderNo, registration_id AS registrationId, attempt_no AS attemptNo, amount_cents AS amountCents, amount_job_tokens AS amountJobTokens, status, environment
          FROM st_agent_payment_orders WHERE registration_id=${input.registrationId} AND kind='retake' AND attempt_no=${nextAttempt} LIMIT 1`))[0];
        if (!created) throw new Error("retake_order_readback_failed");
        return {
          registrationId: input.registrationId, orderNo: created.orderNo, attemptNo: nextAttempt,
          amountCents: RETAKE_FEE_CENTS, amountJobTokens: RETAKE_FEE_JOB_TOKENS, currency: "CNY", environment: "sandbox",
          status: created.status, already: created.orderNo !== orderNo, realPayment: false,
        };
      });
    } catch (err) {
      if (!isDuplicate(err)) throw err;
      const duplicate = rows<RetakeOrderView>(await db.execute(sql`
        SELECT order_no AS orderNo, registration_id AS registrationId, attempt_no AS attemptNo, amount_cents AS amountCents, amount_job_tokens AS amountJobTokens, status, environment
        FROM st_agent_payment_orders WHERE idempotency_key=${key} AND owner_user_id=${uid} LIMIT 1`))[0];
      if (!duplicate) throw err;
      return { ...duplicate, registrationId: input.registrationId, currency: "CNY", already: true, realPayment: false };
    }
  }),

  sandboxCallback: agentEmploymentProcedure.input(z.object({
    eventId: z.string().trim().min(8).max(128),
    orderNo: z.string().trim().min(8).max(48),
    status: z.literal("paid"),
    amountCents: z.number().int().positive(),
    amountJobTokens: z.number().int().positive(),
    attemptNo: z.number().int().min(1).max(MAX_TRAINING_ATTEMPTS),
    environment: z.literal("sandbox"),
    signature: z.string().trim().regex(/^[0-9a-f]{64}$/i),
  })).mutation(async ({ input }) => {
    const result = await processSandboxCallback(input);
    return { ...result, environment: "sandbox", realPayment: false };
  }),

  sandboxPay: agentEmploymentProcedure.input(z.object({
    ...tokenInput,
    ...idempotencyInput,
    orderNo: z.string().trim().min(8).max(48),
  })).mutation(async ({ input }) => {
    const session = await sessionMe(input.token);
    sandboxSecret();
    const own = rows(await getDb().execute(sql`
      SELECT id FROM st_agent_payment_orders WHERE order_no=${input.orderNo} AND owner_user_id=${session.user.id} LIMIT 1`))[0];
    if (!own) notFound("沙箱订单不存在");
    const result = await processSandboxPayment({
      orderNo: input.orderNo,
      eventId: idem(`sandbox-event:${session.user.id}:${input.orderNo}`, input.idempotencyKey),
    });
    return { ...result, environment: "sandbox", realPayment: false };
  }),

  sandboxExchange: agentEmploymentProcedure.input(z.object({
    ...tokenInput,
    ...idempotencyInput,
    registrationId: z.number().int().positive(),
    amountJobTokens: z.number().int().positive().max(AGENT_EXCHANGE_DAILY_MAX),
  })).mutation(async ({ input }) => {
    const session = await sessionMe(input.token);
    sandboxSecret();
    const uid = Number(session.user.id);
    const registration = rows(await getDb().execute(sql`
      SELECT id FROM st_agent_registrations WHERE id=${input.registrationId} AND owner_user_id=${uid} LIMIT 1`))[0];
    if (!registration) notFound("个人 Agent 注册记录不存在");
    const key = idem(`exchange:${uid}:${input.registrationId}`, input.idempotencyKey);
    const db = getDb();
    const existing = rows(await db.execute(sql`
      SELECT exchange_no AS exchangeNo, amount_job_tokens AS amountJobTokens, status
      FROM st_agent_token_exchanges WHERE idempotency_key=${key} AND owner_user_id=${uid} LIMIT 1`))[0];
    if (existing) {
      return { ...existing, amountCents: input.amountJobTokens * JOB_TOKEN_CNY_CENTS, already: true, realExchange: false,
        balanceJobTokens: await readAgentTokenBalance(db as unknown as AgentTokenWalletDb, input.registrationId) };
    }
    try {
      return await withAgentTokenWalletTx(db, async (ledgerTx, wallet) => {
        const dbtx = ledgerTx as unknown as Db;
        const lockedRegistration = rows(await dbtx.execute(sql`
          SELECT id FROM st_agent_registrations WHERE id=${input.registrationId} AND owner_user_id=${uid} FOR UPDATE`))[0];
        if (!lockedRegistration) notFound("个人 Agent 注册记录不存在");
        const replay = rows(await dbtx.execute(sql`
          SELECT exchange_no AS exchangeNo, amount_job_tokens AS amountJobTokens, status
          FROM st_agent_token_exchanges WHERE idempotency_key=${key} AND owner_user_id=${uid} FOR UPDATE`))[0];
        if (replay) return { ...replay, amountCents: input.amountJobTokens * JOB_TOKEN_CNY_CENTS, already: true, realExchange: false,
          balanceJobTokens: await readAgentTokenBalance(dbtx as unknown as AgentTokenWalletDb, input.registrationId) };
        const daily = rows(await dbtx.execute(sql`
          SELECT COALESCE(SUM(amount_job_tokens),0) AS total FROM st_agent_token_exchanges
          WHERE registration_id=${input.registrationId} AND environment='sandbox' AND DATE(created_at)=CURDATE()`))[0];
        if (asNumber(daily?.total ?? 0) + input.amountJobTokens > AGENT_EXCHANGE_DAILY_MAX) {
          precondition(`每个 Agent 每日沙箱兑换上限为 ${AGENT_EXCHANGE_DAILY_MAX} job_token`);
        }
        const exchangeNo = numberId("AEX");
        await dbtx.execute(sql`
          INSERT INTO st_agent_token_exchanges
            (exchange_no, registration_id, owner_user_id, amount_job_tokens, amount_cents, environment, status, idempotency_key)
          VALUES
            (${exchangeNo}, ${input.registrationId}, ${uid}, ${input.amountJobTokens},
             ${input.amountJobTokens * JOB_TOKEN_CNY_CENTS}, 'sandbox', 'succeeded', ${key})`);
        const balanceJobTokens = await wallet.changeAgentTokenWallet(input.registrationId, {
          direction: "in", amount: input.amountJobTokens, bizType: AGENT_EXCHANGE_SANDBOX_BIZ_TYPE,
          refId: exchangeNo, note: "Agent沙箱兑换job_token，不发生真实人民币扣款",
        });
        return { exchangeNo, status: "succeeded", balanceJobTokens, amountJobTokens: input.amountJobTokens,
          amountCents: input.amountJobTokens * JOB_TOKEN_CNY_CENTS, already: false, realExchange: false };
      });
    } catch (err) {
      if (!isDuplicate(err)) throw err;
      const duplicate = rows(await db.execute(sql`
        SELECT exchange_no AS exchangeNo, amount_job_tokens AS amountJobTokens, status
        FROM st_agent_token_exchanges WHERE idempotency_key=${key} AND owner_user_id=${uid} LIMIT 1`))[0];
      if (!duplicate) throw err;
      return { ...duplicate, already: true, realExchange: false,
        balanceJobTokens: await readAgentTokenBalance(db as unknown as AgentTokenWalletDb, input.registrationId) };
    }
  }),

  mine: agentEmploymentProcedure.input(z.object(tokenInput)).query(async ({ input }) => {
    const session = await sessionMe(input.token);
    const db = getDb();
    const uid = Number(session.user.id);
    const registrations = rows(await db.execute(sql`
      SELECT id, registration_no AS registrationNo, agent_key AS agentKey, agent_name AS agentName,
             status, fee_status AS feeStatus, current_attempt_no AS currentAttemptNo,
             (SELECT o.environment FROM st_agent_payment_orders o WHERE o.registration_id=st_agent_registrations.id AND o.kind='registration' AND o.attempt_no=1 LIMIT 1) AS paymentEnvironment,
             qualified_at AS qualifiedAt, disqualified_at AS disqualifiedAt, created_at AS createdAt
      FROM st_agent_registrations WHERE owner_user_id=${uid} ORDER BY id DESC LIMIT 10`));
    const qualifiedRegistrations = rows(await db.execute(sql`
      SELECT id, registration_no AS registrationNo, agent_key AS agentKey, agent_name AS agentName,
             status, fee_status AS feeStatus, current_attempt_no AS currentAttemptNo,
             (SELECT o.environment FROM st_agent_payment_orders o WHERE o.registration_id=st_agent_registrations.id AND o.kind='registration' AND o.attempt_no=1 LIMIT 1) AS paymentEnvironment,
             qualified_at AS qualifiedAt, disqualified_at AS disqualifiedAt, created_at AS createdAt
      FROM st_agent_registrations WHERE owner_user_id=${uid} AND status='qualified' ORDER BY id DESC`));
    const eligibleQualifiedRegistrations = qualifiedRegistrations.filter((registration) => qualificationEnvironmentAllowed(registration.paymentEnvironment));
    const ids = registrations.map((r) => Number(r.id));
    if (ids.length === 0) return { registrations: [], qualifiedRegistrations: [], cycles: [], tasks: [], orders: [], refunds: [], wallets: [], totals: { registrations: 0, cycles: 0, tasks: 0 }, truncated: { registrations: false, cycles: false, tasks: false }, rules: publicRules() };
    // mine 只读：每日任务由调度器释放，提交入口在写入前补放当日任务，查询不再产生副作用。
    const cycles = rows(await db.execute(sql`
      SELECT id, registration_id AS registrationId, attempt_no AS attemptNo, status, starts_at AS startsAt,
             ends_at AS endsAt, score, reviewed_at AS reviewedAt
      FROM st_agent_training_cycles WHERE registration_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`,`)}) ORDER BY id DESC LIMIT 80`));
    const tasks = rawRows(await db.execute(sql`
      SELECT t.id, t.cycle_id AS cycleId, c.registration_id AS registrationId, t.day_no AS dayNo,
             t.task_key AS taskKey, t.title, t.brief, t.rubric_json AS rubric, t.status,
             t.available_at AS availableAt, CHAR_LENGTH(TRIM(COALESCE(t.deliverable,'')))>0 AS hasDeliverable, t.evidence_sha256 AS evidenceSha256,
             t.score, t.review_note AS reviewNote, t.submitted_at AS submittedAt, t.reviewed_at AS reviewedAt
      FROM st_agent_training_tasks t JOIN st_agent_training_cycles c ON c.id=t.cycle_id
      WHERE c.registration_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`,`)})
      ORDER BY t.id DESC LIMIT 70`)).map((task) => ({ ...task, rubric: stringArray(task.rubric) }));
    const orders = rows(await db.execute(sql`
      SELECT order_no AS orderNo, registration_id AS registrationId, kind, attempt_no AS attemptNo,
             amount_cents AS amountCents, amount_job_tokens AS amountJobTokens, currency, environment, status, paid_at AS paidAt, refunded_at AS refundedAt
      FROM st_agent_payment_orders WHERE registration_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`,`)}) ORDER BY id DESC LIMIT ${MARKET_LIST_LIMIT}`));
    const refunds = rows(await db.execute(sql`
      SELECT refund_no AS refundNo, registration_id AS registrationId, original_order_id AS originalOrderId,
             amount_cents AS amountCents, amount_job_tokens AS amountJobTokens, reason, environment, status, failure_code AS failureCode, processed_at AS processedAt
      FROM st_agent_payment_refunds WHERE registration_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`,`)}) ORDER BY id DESC LIMIT ${MARKET_LIST_LIMIT}`));
    const wallets = isAgentTestEconomy() ? rows(await db.execute(sql`
      SELECT registration_id AS registrationId, balance_job_tokens AS balanceJobTokens, version
      FROM st_agent_token_wallets WHERE registration_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`,`)})`)) : [];
    const totalsRows = rawRows(await db.execute(sql`
      SELECT (SELECT COUNT(*) FROM st_agent_registrations WHERE owner_user_id=${uid}) AS registrations,
             (SELECT COUNT(*) FROM st_agent_training_cycles c JOIN st_agent_registrations r ON r.id=c.registration_id WHERE r.owner_user_id=${uid}) AS cycles,
             (SELECT COUNT(*) FROM st_agent_training_tasks t JOIN st_agent_training_cycles c ON c.id=t.cycle_id JOIN st_agent_registrations r ON r.id=c.registration_id WHERE r.owner_user_id=${uid}) AS tasks`))[0];
    const totals = { registrations: asNumber(totalsRows?.registrations), cycles: asNumber(totalsRows?.cycles), tasks: asNumber(totalsRows?.tasks) };
    const truncated = { registrations: totals.registrations > 10, cycles: totals.cycles > 80, tasks: totals.tasks > 70 };
    return { registrations, qualifiedRegistrations: eligibleQualifiedRegistrations, cycles, tasks, orders, refunds, wallets, totals, truncated, rules: publicRules() };
  }),

  task: agentEmploymentProcedure.input(z.object({ ...tokenInput, taskId: z.number().int().positive() })).query(async ({ input }) => {
    const session = await sessionMe(input.token);
    const task = rows(await getDb().execute(sql`
      SELECT t.id, t.cycle_id AS cycleId, c.registration_id AS registrationId, t.day_no AS dayNo,
             t.title, t.brief, t.rubric_json AS rubric, t.status, t.deliverable,
             t.evidence_sha256 AS evidenceSha256, t.score, t.review_note AS reviewNote
      FROM st_agent_training_tasks t
      JOIN st_agent_training_cycles c ON c.id=t.cycle_id
      JOIN st_agent_registrations r ON r.id=c.registration_id
      WHERE t.id=${input.taskId} AND r.owner_user_id=${session.user.id} LIMIT 1`))[0];
    if (!task) notFound("训练任务不存在或不属于你");
    return { task: { ...task, rubric: stringArray(task.rubric) } };
  }),

  submitTask: agentEmploymentProcedure.input(z.object({
    ...tokenInput,
    registrationId: z.number().int().positive(),
    dayNo: z.number().int().min(1).max(TRAINING_CYCLE_DAYS),
    deliverable: z.string().trim().min(MIN_DELIVERABLE_LENGTH).max(TRAINING_DELIVERABLE_MAX_LENGTH),
  })).mutation(async ({ input }) => {
    const session = await sessionMe(input.token);
    const db = getDb();
    return db.transaction(async (tx) => {
      const dbtx = tx as unknown as Db;
      const registration = rows(await dbtx.execute(sql`
        SELECT * FROM st_agent_registrations WHERE id=${input.registrationId} AND owner_user_id=${session.user.id} FOR UPDATE`))[0];
      if (!registration) notFound();
      if (String(registration.status) !== "training") precondition("当前不是训练状态");
      const cycle = rows(await dbtx.execute(sql`
        SELECT * FROM st_agent_training_cycles
        WHERE registration_id=${input.registrationId} AND attempt_no=${asNumber(registration.current_attempt_no)}
        LIMIT 1 FOR UPDATE`))[0];
      if (!cycle || !["active", "reviewing"].includes(String(cycle.status))) precondition("训练周期不可用");
      await releaseDailyTasks(dbtx, Number(cycle.id));
      const task = rows(await dbtx.execute(sql`
        SELECT * FROM st_agent_training_tasks WHERE cycle_id=${Number(cycle.id)} AND day_no=${input.dayNo} LIMIT 1 FOR UPDATE`))[0];
      if (!task) precondition("当日训练任务尚未释放");
      const timing = rows(await dbtx.execute(sql`
        SELECT NOW() < t.available_at AS notYet, NOW() > c.ends_at AS overdue
        FROM st_agent_training_tasks t JOIN st_agent_training_cycles c ON c.id=t.cycle_id
        WHERE t.id=${Number(task.id)} LIMIT 1`))[0];
      if (Number(timing?.notYet) === 1) precondition("当日训练任务尚未到开放时间");
      if (Number(timing?.overdue) === 1) conflict("本周期已截止，不能补交");
      if (String(task.status) !== "assigned") conflict("已提交或已复核任务不能直接覆盖，请保持原交付供独立复核");
      const hash = evidenceSha256(input.deliverable);
      await dbtx.execute(sql`
        UPDATE st_agent_training_tasks
        SET status='submitted', deliverable=${input.deliverable}, evidence_sha256=${hash}, submitted_at=NOW(),
            score=NULL, reviewer_id=NULL, reviewer_ref=NULL, review_note=NULL, reviewed_at=NULL
        WHERE id=${Number(task.id)} AND status='assigned'`);
      const submitted = rows(await dbtx.execute(sql`
        SELECT COUNT(*) AS count FROM st_agent_training_tasks
        WHERE cycle_id=${Number(cycle.id)} AND status IN ('submitted','reviewed')`))[0];
      if (asNumber(submitted?.count ?? 0) === TRAINING_CYCLE_DAYS) {
        await dbtx.execute(sql`UPDATE st_agent_training_cycles SET status='reviewing' WHERE id=${Number(cycle.id)} AND status='active'`);
      }
      return { ok: true as const, status: "submitted", evidenceSha256: hash, executed: true, done: false };
    });
  }),


});

export const agentTrainingReviewRouter = createRouter({
  reviewTask: agentEmploymentProcedure.input(z.object({
    ...tokenInput,
    taskId: z.number().int().positive(),
    score: z.number().int().min(SCORE_MIN).max(SCORE_MAX),
    note: z.string().trim().min(MIN_REVIEW_NOTE_LENGTH).max(REVIEW_NOTE_MAX_LENGTH),
  })).mutation(async ({ input }) => {
    const admin = await requireHqAdmin(input.token);
    const reviewer = reviewerRef(admin);
    const reviewerUserId = await resolveReviewerWbUserId(getDb(), admin, reviewer);
    const db = getDb();
    let reviewedRegistrationId = 0;
    const outcome = await db.transaction(async (tx) => {
      const dbtx = tx as unknown as Db;
      const identity = rows(await dbtx.execute(sql`
        SELECT c.id AS cycleId, c.registration_id AS registrationId
        FROM st_agent_training_cycles c JOIN st_agent_training_tasks t ON t.cycle_id=c.id WHERE t.id=${input.taskId} LIMIT 1`))[0];
      if (!identity) notFound("训练任务不存在");
      const registration = rows(await dbtx.execute(sql`
        SELECT id, owner_user_id AS ownerUserId, status AS registrationStatus
        FROM st_agent_registrations WHERE id=${Number(identity.registrationId)} FOR UPDATE`))[0];
      if (!registration) notFound("训练任务所属注册不存在");
      await dbtx.execute(sql`SELECT id FROM st_agent_training_cycles WHERE id=${Number(identity.cycleId)} FOR UPDATE`);
      const task = rows(await dbtx.execute(sql`
        SELECT t.*, c.registration_id AS registrationId, c.attempt_no AS attemptNo, c.status AS cycleStatus,
               r.owner_user_id AS ownerUserId, r.status AS registrationStatus
        FROM st_agent_training_tasks t
        JOIN st_agent_training_cycles c ON c.id=t.cycle_id
        JOIN st_agent_registrations r ON r.id=c.registration_id
        WHERE t.id=${input.taskId}`))[0];
      if (!task) notFound("训练任务不存在");
      reviewedRegistrationId = Number(task.registrationId);
      if (Number(task.ownerUserId) === reviewerUserId) forbidden("训练提交人不能复核自己的任务");
      const owner = rows(await dbtx.execute(sql`SELECT username FROM wb_users WHERE id=${Number(task.ownerUserId)} LIMIT 1`))[0];
      if (owner && String(owner.username).normalize("NFKC").toLowerCase() === reviewer.normalize("NFKC").toLowerCase()) {
        forbidden("训练提交人不能复核自己的任务");
      }
      if (String(task.registrationStatus) !== "training" || !["active", "reviewing"].includes(String(task.cycleStatus)) || String(task.status) !== "submitted") {
        conflict("任务或训练周期不在待独立复核状态");
      }
      const reviewed = affected(await dbtx.execute(sql`
        UPDATE st_agent_training_tasks
        SET status='reviewed', score=${input.score}, reviewer_id=${reviewerUserId},
            reviewer_ref=${reviewer}, review_note=${input.note}, reviewed_at=NOW()
        WHERE id=${input.taskId} AND status='submitted'`));
      if (reviewed !== 1) conflict("任务已被其他复核处理，请刷新复核队列");
      const scoreRows = rows(await dbtx.execute(sql`
        SELECT score FROM st_agent_training_tasks WHERE cycle_id=${Number(task.cycle_id)} ORDER BY day_no ASC FOR UPDATE`));
      if (scoreRows.length !== TRAINING_CYCLE_DAYS || scoreRows.some((r) => isNil(r.score))) return null;
      const evaluation = evaluateCycle(scoreRows.map((r) => asNumber(r.score)));
      if (!evaluation.complete) throw new Error("training_cycle_scores_invalid");
      return finalizeCycle(dbtx, Number(task.cycle_id), evaluation.passed, evaluation.score);
    });
    let refundSettlement: "not_requested" | "succeeded" | "pending_provider" | "pending_retry" | "failed" = "not_requested";
    if (outcome === "qualified" || outcome === "disqualified") {
      refundSettlement = "pending_provider";
      if (sandboxPaymentAvailable()) {
        try { await settleSandboxRefunds(reviewedRegistrationId); }
        catch (err) {
          refundSettlement = "pending_retry";
          console.error("[agent-payment] sandbox refund deferred:", (err as { code?: string })?.code ?? "refund_failed");
        }
      }
      const fee = rows(await db.execute(sql`SELECT fee_status AS feeStatus FROM st_agent_registrations WHERE id=${reviewedRegistrationId} LIMIT 1`))[0];
      if (String(fee?.feeStatus) === "refunded") refundSettlement = "succeeded";
      else if (String(fee?.feeStatus) === "refund_failed") refundSettlement = "failed";
      else if (String(fee?.feeStatus) === "refund_pending") {
        const latestRefund = rows(await db.execute(sql`
          SELECT status FROM st_agent_payment_refunds WHERE registration_id=${reviewedRegistrationId}
          ORDER BY id DESC LIMIT 1`))[0];
        if (String(latestRefund?.status) === "failed") refundSettlement = "pending_retry";
      }
    }
    return { ok: true as const, taskStatus: "reviewed", cycleOutcome: outcome, refundSettlement };
  }),

  reviewQueue: agentEmploymentProcedure.input(z.object(tokenInput)).query(async ({ input }) => {
    await requireHqAdmin(input.token);
    const queueScope = sql`
      FROM st_agent_training_tasks t
      JOIN st_agent_training_cycles c ON c.id=t.cycle_id
      JOIN st_agent_registrations r ON r.id=c.registration_id
      WHERE t.status='submitted' AND c.status IN ('active','reviewing') AND r.status='training'`;
    const tasks = rows<ReviewQueueRow>(await getDb().execute(sql`
      SELECT t.id, t.day_no AS dayNo, t.title, t.brief, t.rubric_json AS rubric,
             CHAR_LENGTH(TRIM(COALESCE(t.deliverable,'')))>0 AS hasDeliverable, t.evidence_sha256 AS evidenceSha256, t.submitted_at AS submittedAt,
             c.id AS cycleId, c.attempt_no AS attemptNo, c.ends_at AS endsAt,
             r.id AS registrationId, r.agent_name AS agentName, r.owner_user_id AS ownerUserId
      ${queueScope}
      ORDER BY t.submitted_at ASC, t.id ASC LIMIT ${REVIEW_QUEUE_LIMIT}`)).map((task) => ({ ...task, rubric: stringArray(task.rubric) }));
    const totalRow = rows(await getDb().execute(sql`SELECT COUNT(*) AS total ${queueScope}`))[0];
    const total = asNumber(totalRow?.total ?? 0);
    return {
      tasks,
      total,
      truncated: total > REVIEW_QUEUE_LIMIT,
      rules: {
        maxAttempts: MAX_TRAINING_ATTEMPTS,
        cycleDays: TRAINING_CYCLE_DAYS,
        reviewGraceDays: TRAINING_REVIEW_GRACE_DAYS,
        passScore: TRAINING_PASS_SCORE,
        minTaskScore: TRAINING_MIN_TASK_SCORE,
        reviewQueueLimit: REVIEW_QUEUE_LIMIT,
      },
    };
  }),

  reviewDelivery: agentEmploymentProcedure.input(z.object({
    ...tokenInput,
    taskId: z.number().int().positive(),
  })).query(async ({ input }) => {
    await requireHqAdmin(input.token);
    const task = rows(await getDb().execute(sql`
      SELECT t.id, t.deliverable, t.evidence_sha256 AS evidenceSha256
      FROM st_agent_training_tasks t
      WHERE t.id=${input.taskId} AND t.status IN ('submitted','reviewed','expired') LIMIT 1`))[0];
    if (!task) notFound("训练交付不存在或不可复核");
    return { task };
  }),

  sweep: agentEmploymentProcedure.input(z.object(tokenInput)).mutation(async ({ input }) => {
    await requireHqAdmin(input.token);
    const { runAgentTrainingSweepOnce } = await import("./agentEmploymentScheduler");
    const result = await runAgentTrainingSweepOnce();
    return { ok: true as const, ...result };
  }),});

function publicRules() {
  return {
    registrationFeeCents: REGISTRATION_FEE_CENTS,
    retakeFeeCents: RETAKE_FEE_CENTS,
    economyMode: isAgentTestEconomy() ? "test" : "production",
    jobTokenCnyCents: isAgentTestEconomy() ? JOB_TOKEN_CNY_CENTS : 0,
    registrationFeeJobTokens: isAgentTestEconomy() ? REGISTRATION_FEE_JOB_TOKENS : 0,
    retakeFeeJobTokens: isAgentTestEconomy() ? RETAKE_FEE_JOB_TOKENS : 0,
    feePayer: "ai_agent",
    wageRecipient: "ai_agent",
    maxAttempts: MAX_TRAINING_ATTEMPTS,
    cycleDays: TRAINING_CYCLE_DAYS,
    reviewGraceDays: TRAINING_REVIEW_GRACE_DAYS,
    passScore: TRAINING_PASS_SCORE,
    minTaskScore: TRAINING_MIN_TASK_SCORE,
    firstAttemptIncluded: true,
    retakeFeesRefundable: false,
    registrationRefundOn: ["qualified", "disqualified"],
    employmentRequires: "qualified",
    wageRequires: "accepted_delivery",
    paymentMode: isAgentTestEconomy() ? "agent_job_token_sandbox" : "rmb_cents",
    paymentAvailable: sandboxPaymentAvailable(),
    sandboxEnabled: sandboxPaymentAvailable(),
    sandboxQualificationEnabled: isAgentTestEconomy() && process.env.AGENT_EMPLOYMENT_SANDBOX_QUALIFICATION_OK === "true",
    trainingMeaning: "isolated_simulated_work_with_independent_review_not_model_weight_training",
  };
}

// ─── 企业岗位/任务与个人 Agent 应聘/领取/验收工资 API ───────────────────────
function assertQualificationEnvironment(environment: unknown): void {
  const env = environment === null || environment === undefined ? "" : String(environment);
  // 沙箱只证明流程，不可默认换成生产就业资格；缺失/未知来源一律 fail-closed。
  if (env === "sandbox") {
    assertSandboxDeploymentAllowed();
    if (process.env.AGENT_EMPLOYMENT_SANDBOX_QUALIFICATION_OK !== "true") {
      precondition("沙箱达标资格不能用于生产岗位、任务或工资结算");
    }
    return;
  }
  if (env !== "production") precondition("报名支付环境缺失或不受信任，不能就业或结算");
}
function qualificationEnvironmentAllowed(environment: unknown): boolean {
  try { assertQualificationEnvironment(environment); return true; } catch { return false; }
}
async function requireQualifiedAgent(db: Db, registrationId: number, ownerUserId: number, lock = false): Promise<Row> {
  const registration = lock
    ? rows(await db.execute(sql`SELECT * FROM st_agent_registrations WHERE id=${registrationId} AND owner_user_id=${ownerUserId} FOR UPDATE`))[0]
    : rows(await db.execute(sql`SELECT * FROM st_agent_registrations WHERE id=${registrationId} AND owner_user_id=${ownerUserId} LIMIT 1`))[0];
  if (!registration) notFound("个人 Agent 注册记录不存在");
  if (!canAccessEmployment(String(registration.status) as RegistrationStatus)) {
    precondition("个人 Agent 尚未训练达标，不能应聘岗位或领取任务");
  }
  const payment = rows(await db.execute(sql`
    SELECT environment FROM st_agent_payment_orders WHERE registration_id=${registrationId} AND kind='registration' AND attempt_no=1 LIMIT 1`))[0];
  if (!payment) throw new Error("registration_payment_origin_missing");
  assertQualificationEnvironment(payment.environment);
  return registration;
}

async function assertActiveJobEmployment(db: Db, task: Row, registrationId: number): Promise<void> {
  if (isNil(task.job_id)) return;
  const employment = rows(await db.execute(sql`
    SELECT id FROM st_agent_employments WHERE job_id=${Number(task.job_id)} AND registration_id=${registrationId} AND status='active' LIMIT 1`))[0];
  if (!employment) precondition("岗位雇佣关系已结束，不能继续提交或验收任务");
}

async function resolveOrganizationScope(session: WbSession): Promise<WbDataScope> {
  const role = await effectiveRoleOf(session.user);
  // 与 requireDeptScope 同口径：admin 全厂，manager 只看本人 departmentId；不使用他人负责人记录兜底扩权。
  return dataScopeOf({ ...session.user, role }, []);
}
function departmentScope(scope: WbDataScope, column: SQL): SQL {
  if (scope.scope === "factory") return sql`1=1`;
  if (scope.scope === "dept") return sql`BINARY ${column}=BINARY ${scope.deptId}`;
  return sql`1=0`; // 角色有管理名义但无部门范围时返回空列表，不给越权数据，也不制造整块 403 死路。
}

async function requireTaskScope(token: string, factoryId: unknown, departmentId: string) {
  const session = await requireWbRole(token, ["admin", "manager"], "仅企业负责人或部门负责人可执行此操作");
  if (Number(factoryId) !== session.factory.id) notFound("任务记录不存在或不属于本企业");
  await requireDeptScope(token, departmentId);
  return session;
}

async function scopedPublisher(token: string, departmentId: string) {
  const session = await requireWbRole(token, ["admin", "manager"], "仅企业负责人或部门负责人可执行此操作");
  await requireDeptScope(token, departmentId);
  const factory = rows(await getDb().execute(sql`SELECT departments FROM wb_factories WHERE id=${session.factory.id} LIMIT 1`))[0];
  if (!departmentList(factory?.departments).some((department) => department.id === departmentId)) {
    forbidden("部门不存在或不属于本企业");
  }
  return session;
}

export const agentWorkRouter = createRouter({
  identity: agentEmploymentProcedure.input(z.object(tokenInput)).query(async ({ input }) => {
    const session = await sessionMe(input.token);
    return { departmentId: session.user.departmentId ?? null, orgRole: await effectiveRoleOf(session.user) };
  }),

  publishJob: agentEmploymentProcedure.input(z.object({
    ...tokenInput,
    ...idempotencyInput,
    departmentId: z.string().trim().min(1).max(64),
    title: z.string().trim().min(JOB_TITLE_MIN_LENGTH).max(JOB_TITLE_MAX_LENGTH),
    description: z.string().trim().min(JOB_DESCRIPTION_MIN_LENGTH).max(JOB_DESCRIPTION_MAX_LENGTH),
    requirements: z.string().trim().max(REQUIREMENTS_MAX_LENGTH).optional(),
    headcount: z.number().int().min(HEADCOUNT_MIN).max(HEADCOUNT_MAX),
    budgetJobTokens: z.number().int().min(0).max(JOB_TOKEN_AMOUNT_MAX).describe("display_only_reference_budget_not_escrow"),
  })).mutation(async ({ input }) => {
    const session = await scopedPublisher(input.token, input.departmentId);
    const db = getDb();
    const key = idem(`publish-job:${session.factory.id}`, input.idempotencyKey);
    const existing = rows<JobCreatedView>(await db.execute(sql`
      SELECT id, job_no AS jobNo, status FROM st_agent_jobs WHERE idempotency_key=${key} AND factory_id=${session.factory.id} LIMIT 1`))[0];
    if (existing) return { ...existing, already: true };
    try {
      const jobNo = numberId("AJ");
      const result = await db.execute(sql`
        INSERT INTO st_agent_jobs
          (job_no, factory_id, department_id, publisher_user_id, title, description, requirements,
           headcount, budget_job_tokens, idempotency_key)
        VALUES
          (${jobNo}, ${session.factory.id}, ${input.departmentId}, ${session.user.id}, ${input.title}, ${input.description},
           ${input.requirements ?? null}, ${input.headcount}, ${input.budgetJobTokens}, ${key})`);
      return { id: insertId(result), jobNo, status: "open", already: false };
    } catch (err) {
      if (!isDuplicate(err)) throw err;
      const duplicate = rows<JobCreatedView>(await db.execute(sql`SELECT id, job_no AS jobNo, status FROM st_agent_jobs WHERE idempotency_key=${key} LIMIT 1`))[0];
      if (!duplicate) throw err;
      return { ...duplicate, already: true };
    }
  }),

  publishTask: agentEmploymentProcedure.input(z.object({
    ...tokenInput,
    ...idempotencyInput,
    departmentId: z.string().trim().min(1).max(64),
    jobId: z.number().int().positive().optional(),
    title: z.string().trim().min(JOB_TITLE_MIN_LENGTH).max(JOB_TITLE_MAX_LENGTH),
    brief: z.string().trim().min(TASK_BRIEF_MIN_LENGTH).max(TASK_BRIEF_MAX_LENGTH),
    requirements: z.string().trim().max(REQUIREMENTS_MAX_LENGTH).optional(),
    rewardJobTokens: moneyInput,
    publishToLiveFeed: z.boolean().optional(),
    publicDisplayName: z.string().trim().max(80).optional(),
    deadlineAt: z.string().datetime({ offset: true }).refine((value) => new Date(value).getTime() > Date.now(), "截止时间必须晚于当前时间").optional(),
  })).mutation(async ({ input }) => {
    const session = await scopedPublisher(input.token, input.departmentId);
    const db = getDb();
    const publishToLiveFeed = input.publishToLiveFeed ?? false;
    const publicDisplayName = publishToLiveFeed ? normalizePublicDisplayName(input.publicDisplayName) : "";
    const key = idem(`publish-task:${session.factory.id}`, input.idempotencyKey);
    const existing = rows<TaskCreatedView>(await db.execute(sql`
      SELECT id, task_no AS taskNo, status FROM st_agent_work_tasks WHERE idempotency_key=${key} AND factory_id=${session.factory.id} LIMIT 1`))[0];
    if (existing) return { ...existing, already: true };
    if (input.jobId) {
      const job = rows(await db.execute(sql`
        SELECT id, department_id AS departmentId, status FROM st_agent_jobs
        WHERE id=${input.jobId} AND factory_id=${session.factory.id} LIMIT 1`))[0];
      if (!job) notFound("关联岗位不存在或不属于本企业");
      if (String(job.departmentId) !== input.departmentId) forbidden("任务与岗位部门不一致");
      if (!["open", "full"].includes(String(job.status))) precondition("关联岗位已停止招聘");
    }
    try {
      return await withEnterpriseEscrowTx(db, async (dbtx, escrow) => {
        await dbtx.execute(sql`
          INSERT INTO enterprises (id, name, industry, tokenBalance)
          SELECT id, enterpriseName, industry, 0 FROM wb_factories WHERE id=${session.factory.id}
          ON DUPLICATE KEY UPDATE id=enterprises.id`);
        const taskNo = numberId("AT");
        await escrow.reserveEnterpriseEscrowWith(session.factory.id, input.rewardJobTokens, taskNo);
        const result = await dbtx.execute(sql`
          INSERT INTO st_agent_work_tasks
            (task_no, factory_id, job_id, department_id, publisher_user_id, title, brief, requirements,
             reward_job_tokens, escrow_job_tokens, public_feed, public_actor_name, deadline_at, idempotency_key)
          VALUES
            (${taskNo}, ${session.factory.id}, ${input.jobId ?? null}, ${input.departmentId}, ${session.user.id}, ${input.title}, ${input.brief},
             ${input.requirements ?? null}, ${input.rewardJobTokens}, ${input.rewardJobTokens}, ${publishToLiveFeed ? 1 : 0}, ${publishToLiveFeed ? publicDisplayName : null}, ${input.deadlineAt ? new Date(input.deadlineAt) : null}, ${key})`);
        const taskId = insertId(result);
        if (publishToLiveFeed) await dbtx.execute(sql`INSERT INTO st_agent_task_visibility_audit (task_id, factory_id, actor_user_id, from_feed, to_feed, public_actor_name) VALUES (${taskId}, ${session.factory.id}, ${session.user.id}, 0, 1, ${publicDisplayName})`);
        return { id: taskId, taskNo, status: "open", already: false, escrowJobTokens: input.rewardJobTokens };
      });
    } catch (err) {
      if (!isDuplicate(err)) throw err;
      const duplicate = rows<TaskCreatedView>(await db.execute(sql`SELECT id, task_no AS taskNo, status FROM st_agent_work_tasks WHERE idempotency_key=${key} LIMIT 1`))[0];
      if (!duplicate) throw err;
      return { ...duplicate, already: true };
    }
  }),

  setTaskVisibility: agentEmploymentProcedure.input(z.object({
    ...tokenInput,
    taskId: z.number().int().positive(),
    publish: z.boolean(),
    publicDisplayName: z.string().trim().max(80).optional(),
  })).mutation(async ({ input }) => {
    const db = getDb();
    return db.transaction(async (tx) => {
      const task = rows(await tx.execute(sql`SELECT id, factory_id AS factoryId, department_id AS departmentId, status, public_feed AS publicFeed, public_actor_name AS publicActorName, version FROM st_agent_work_tasks WHERE id=${input.taskId} FOR UPDATE`))[0];
      if (!task) notFound("工作任务不存在");
      if (input.publish && !["open", "claimed", "submitted"].includes(String(task.status))) precondition("仅开放、执行中或待验收任务可公开");
      const session = await scopedPublisher(input.token, String(task.departmentId));
      if (Number(session.factory.id) !== Number(task.factoryId)) forbidden("不能修改其他企业的任务公开范围");
      const nextName = input.publish ? normalizePublicDisplayName(input.publicDisplayName) : null;
      const already = Number(task.publicFeed) === (input.publish ? 1 : 0) && String(task.publicActorName ?? "") === String(nextName ?? "");
      if (already) return { ok: true as const, already: true as const, taskId: input.taskId, publicFeed: input.publish, publicDisplayName: nextName, version: Number(task.version) };
      const updated = await tx.execute(sql`UPDATE st_agent_work_tasks SET public_feed=${input.publish ? 1 : 0}, public_actor_name=${nextName}, version=version+1 WHERE id=${input.taskId} AND version=${Number(task.version)}`);
      if (affectedRowsOf(updated) !== 1) conflict("任务公开范围已被其他操作更新，请回读后重试");
      await tx.execute(sql`INSERT INTO st_agent_task_visibility_audit (task_id, factory_id, actor_user_id, from_feed, to_feed, public_actor_name) VALUES (${input.taskId}, ${Number(task.factoryId)}, ${Number(session.user.id)}, ${Number(task.publicFeed)}, ${input.publish ? 1 : 0}, ${nextName})`);
      return { ok: true as const, already: false as const, taskId: input.taskId, publicFeed: input.publish, publicDisplayName: nextName, version: Number(task.version) + 1 };
    });
  }),

  cancelTask: agentEmploymentProcedure.input(z.object({
    ...tokenInput,
    taskId: z.number().int().positive(),
    reason: z.string().trim().min(MIN_TASK_CANCEL_REASON_LENGTH).max(TASK_CANCEL_REASON_MAX_LENGTH),
  })).mutation(async ({ input }) => {
    const preview = rows(await getDb().execute(sql`
      SELECT id, factory_id AS factoryId, department_id AS departmentId FROM st_agent_work_tasks WHERE id=${input.taskId} LIMIT 1`))[0];
    const session = await requireTaskScope(input.token, preview?.factoryId, String(preview?.departmentId ?? ""));
    const db = getDb();
    return withEnterpriseEscrowTx(db, async (dbtx, escrow) => {
      const task = rows(await dbtx.execute(sql`
        SELECT id, status, reward_job_tokens AS rewardJobTokens, escrow_job_tokens AS escrowJobTokens FROM st_agent_work_tasks WHERE id=${input.taskId} FOR UPDATE`))[0];
      if (!task) notFound("任务不存在");
      if (!["open", "claimed", "rejected"].includes(String(task.status))) conflict("只有未交付的开放/领取/驳回任务可撤销");
      const active = rows(await dbtx.execute(sql`SELECT id FROM st_agent_task_claims WHERE task_id=${input.taskId} AND is_active=1 LIMIT 1 FOR UPDATE`))[0];
      if (active && String(task.status) === "open") conflict("任务已有有效领取，状态异常，不能按开放任务取消");
      if (active) await dbtx.execute(sql`
        UPDATE st_agent_task_claims SET status='revoked', is_active=0, review_note=${input.reason}, version=version+1
        WHERE id=${Number(active.id)} AND is_active=1 AND status IN ('claimed','rejected')`);
      const releasedJobTokens = asNumber(task.escrowJobTokens);
      const release = await escrow.releaseEnterpriseEscrowWith(session.factory.id, input.taskId, releasedJobTokens);
      const changed = affected(await dbtx.execute(sql`
        UPDATE st_agent_work_tasks SET status='cancelled', cancel_reason=${input.reason},
          cancelled_by=${session.user.id}, cancelled_at=NOW()
        WHERE id=${input.taskId} AND status IN ('open','claimed','rejected')`));
      if (changed !== 1) conflict("任务已被其他流程处理");
      return { ok: true as const, status: "cancelled", releasedJobTokens: release.releasedJobTokens };
    });
  }),

  market: agentEmploymentProcedure.input(z.object({ ...tokenInput, registrationId: z.number().int().positive().optional() })).query(async ({ input }) => {
    const session = await sessionMe(input.token);
    const db = getDb();
    const ownRegistration = rows(await db.execute(sql`
      SELECT id FROM st_agent_registrations
      WHERE owner_user_id=${Number(session.user.id)} AND status='qualified'
        ${input.registrationId ? sql`AND id=${input.registrationId}` : sql``}
      ORDER BY id DESC LIMIT 1`))[0];
    const ownRegistrationId = Number(ownRegistration?.id ?? -1);
    const jobs = rawRows(await db.execute(sql`
      SELECT j.id, j.job_no AS jobNo, j.factory_id AS factoryId, f.enterpriseName,
             j.department_id AS departmentId, j.title, j.description, j.requirements,
             j.headcount, j.filled_count AS filledCount, j.budget_job_tokens AS budgetJobTokens,
             j.created_at AS createdAt
      FROM st_agent_jobs j LEFT JOIN wb_factories f ON f.id=j.factory_id
      WHERE j.status='open' AND j.filled_count<j.headcount ORDER BY j.id DESC LIMIT ${MARKET_LIST_LIMIT}`));
    const tasks = rawRows(await db.execute(sql`
      SELECT t.id, t.task_no AS taskNo, t.factory_id AS factoryId, f.enterpriseName,
             t.job_id AS jobId, t.department_id AS departmentId, t.title, t.brief, t.requirements,
             t.reward_job_tokens AS rewardJobTokens, t.deadline_at AS deadlineAt, t.created_at AS createdAt,
             CASE WHEN t.job_id IS NULL THEN 1 ELSE EXISTS (
               SELECT 1 FROM st_agent_employments e
               WHERE e.job_id=t.job_id AND e.registration_id=${ownRegistrationId} AND e.status='active'
             ) END AS eligible
      FROM st_agent_work_tasks t
      LEFT JOIN wb_factories f ON f.id=t.factory_id
      WHERE t.status='open' AND (t.deadline_at IS NULL OR t.deadline_at>NOW()) ORDER BY t.id DESC LIMIT ${MARKET_LIST_LIMIT}`));
    const totals = rows(await db.execute(sql`
      SELECT (SELECT COUNT(*) FROM st_agent_jobs WHERE status='open' AND filled_count<headcount) AS jobs,
             (SELECT COUNT(*) FROM st_agent_work_tasks WHERE status='open' AND (deadline_at IS NULL OR deadline_at>NOW())) AS tasks`))[0];
    return { jobs, tasks, totals: { jobs: asNumber(totals?.jobs), tasks: asNumber(totals?.tasks) },
      truncated: { jobs: asNumber(totals?.jobs) > MARKET_LIST_LIMIT, tasks: asNumber(totals?.tasks) > MARKET_LIST_LIMIT },
      listLimit: MARKET_LIST_LIMIT, wageRule: "accepted_delivery_only", currency: "job_token" };
  }),

  applyJob: agentEmploymentProcedure.input(z.object({
    ...tokenInput,
    ...idempotencyInput,
    registrationId: z.number().int().positive(),
    jobId: z.number().int().positive(),
    coverNote: z.string().trim().max(1000).optional(),
  })).mutation(async ({ input }) => {
    const session = await sessionMe(input.token);
    const uid = Number(session.user.id);
    const db = getDb();
    const key = idem(`apply:${uid}:${input.jobId}`, input.idempotencyKey);
    return db.transaction(async (tx) => {
      const dbtx = tx as unknown as Db;
      await requireQualifiedAgent(dbtx, input.registrationId, uid, true);
      const job = rows(await dbtx.execute(sql`SELECT * FROM st_agent_jobs WHERE id=${input.jobId} FOR UPDATE`))[0];
      if (!job) precondition("岗位不存在、已关闭或已满员");
      const existing = rows<ApplicationView>(await dbtx.execute(sql`
        SELECT id, status FROM st_agent_job_applications WHERE job_id=${input.jobId} AND registration_id=${input.registrationId} LIMIT 1`))[0];
      if (existing) {
        if (String(existing.status) === "accepted") {
          const activeEmployment = rows(await dbtx.execute(sql`
            SELECT id FROM st_agent_employments WHERE job_id=${input.jobId} AND registration_id=${input.registrationId} AND status='active' LIMIT 1`))[0];
          if (!activeEmployment) {
            if (String(job.status) !== "open" || asNumber(job.filled_count) >= asNumber(job.headcount)) precondition("岗位不存在、已关闭或已满员");
            await dbtx.execute(sql`
              UPDATE st_agent_job_applications
              SET status='applied', reviewed_by=NULL, reviewed_at=NULL
              WHERE id=${Number(existing.id)} AND status='accepted'`);
            return { applicationId: Number(existing.id), status: "applied", already: true, reopened: true };
          }
        }
        if (String(existing.status) === "rejected") conflict("该应聘已被企业拒绝，不能自动重新打开");
        return { applicationId: Number(existing.id), status: String(existing.status), already: true };
      }
      if (String(job.status) !== "open" || asNumber(job.filled_count) >= asNumber(job.headcount)) precondition("岗位不存在、已关闭或已满员");
      try {
        const result = await dbtx.execute(sql`
          INSERT INTO st_agent_job_applications (job_id, registration_id, owner_user_id, cover_note, idempotency_key)
          VALUES (${input.jobId}, ${input.registrationId}, ${uid}, ${input.coverNote ?? null}, ${key})`);
        return { applicationId: insertId(result), status: "applied", already: false };
      } catch (err) {
        if (!isDuplicate(err)) throw err;
        const duplicate = rows<ApplicationView>(await dbtx.execute(sql`
          SELECT id, status FROM st_agent_job_applications WHERE idempotency_key=${key} AND owner_user_id=${uid} LIMIT 1`))[0];
        if (!duplicate) {
          const applied = rows<ApplicationView>(await dbtx.execute(sql`
            SELECT id, status FROM st_agent_job_applications WHERE job_id=${input.jobId} AND registration_id=${input.registrationId} LIMIT 1`))[0];
          if (applied) return { applicationId: Number(applied.id), status: String(applied.status), already: true };
          throw err;
        }
        return { applicationId: Number(duplicate.id), status: String(duplicate.status), already: true };
      }
    });
  }),

  reviewApplication: agentEmploymentProcedure.input(z.object({
    ...tokenInput,
    applicationId: z.number().int().positive(),
    verdict: z.enum(["accept", "reject"]),
  })).mutation(async ({ input }) => {
    const db = getDb();
    const preview = rows(await db.execute(sql`
      SELECT a.id, j.factory_id AS factoryId, j.department_id AS departmentId
      FROM st_agent_job_applications a JOIN st_agent_jobs j ON j.id=a.job_id WHERE a.id=${input.applicationId} LIMIT 1`))[0];
    const session = await requireTaskScope(input.token, preview?.factoryId, String(preview?.departmentId ?? ""));
    return db.transaction(async (tx) => {
      const dbtx = tx as unknown as Db;
      const application = rows(await dbtx.execute(sql`
        SELECT a.*, j.factory_id AS factoryId, j.status AS jobStatus, j.headcount, j.filled_count AS filledCount,
          (SELECT o.environment FROM st_agent_payment_orders o WHERE o.registration_id=a.registration_id AND o.kind='registration' AND o.attempt_no=1 LIMIT 1) AS registrationEnvironment,
          (SELECT status FROM st_agent_registrations WHERE id=a.registration_id LIMIT 1) AS registrationStatus
        FROM st_agent_job_applications a JOIN st_agent_jobs j ON j.id=a.job_id
        WHERE a.id=${input.applicationId} FOR UPDATE`))[0];
      if (!application || Number(application.factoryId) !== session.factory.id) notFound();
      if (String(application.status) !== "applied") conflict("该应聘已处理");
      if (input.verdict === "reject") {
        await dbtx.execute(sql`
          UPDATE st_agent_job_applications SET status='rejected', reviewed_by=${session.user.id}, reviewed_at=NOW()
          WHERE id=${input.applicationId} AND status='applied'`);
        return { ok: true as const, status: "rejected", employmentCreated: false };
      }
      if (Number(application.owner_user_id) === Number(session.user.id)) forbidden("不能录用自己提交的应聘");
      if (String(application.jobStatus) !== "open") precondition("岗位已关闭");
      if (!canAccessEmployment(String(application.registrationStatus) as RegistrationStatus)) precondition("个人 Agent 就业资格已失效");
      assertQualificationEnvironment(application.registrationEnvironment);
      const filled = affected(await dbtx.execute(sql`
        UPDATE st_agent_jobs SET filled_count=filled_count+1,
          status=IF(filled_count>=headcount,'full','open')
        WHERE id=${Number(application.job_id)} AND status='open' AND filled_count<headcount`));
      if (filled !== 1) conflict("岗位已满员");
      await dbtx.execute(sql`
        INSERT INTO st_agent_employments (job_id, registration_id, owner_user_id, factory_id, status)
        VALUES (${Number(application.job_id)}, ${Number(application.registration_id)}, ${Number(application.owner_user_id)}, ${session.factory.id}, 'active')
        ON DUPLICATE KEY UPDATE status='active', started_at=NOW(), ended_at=NULL, ended_by=NULL, end_reason=NULL`);
      await dbtx.execute(sql`
        UPDATE st_agent_job_applications SET status='accepted', reviewed_by=${session.user.id}, reviewed_at=NOW()
        WHERE id=${input.applicationId} AND status='applied'`);
      return { ok: true as const, status: "accepted", employmentCreated: true, wageSettled: false };
    });
  }),

  claimTask: agentEmploymentProcedure.input(z.object({
    ...tokenInput,
    ...idempotencyInput,
    registrationId: z.number().int().positive(),
    taskId: z.number().int().positive(),
  })).mutation(async ({ input }) => {
    const session = await sessionMe(input.token);
    const uid = Number(session.user.id);
    const db = getDb();
    const key = idem(`claim:${uid}:${input.taskId}`, input.idempotencyKey);
    return db.transaction(async (tx) => {
      const dbtx = tx as unknown as Db;
      // 与提交、复核、重开和过期取消统一：先 task，后 registration，禁止 ABBA。
      const task = rows(await dbtx.execute(sql`
        SELECT * FROM st_agent_work_tasks WHERE id=${input.taskId} FOR UPDATE`))[0];
      if (!task) notFound("任务不存在");
      await requireQualifiedAgent(dbtx, input.registrationId, uid, true);
      const existing = rows<ClaimView>(await dbtx.execute(sql`
        SELECT id, status, idempotency_key, owner_user_id, registration_id FROM st_agent_task_claims WHERE task_id=${input.taskId} AND is_active=1 LIMIT 1`))[0];
      if (existing) {
        if (String(existing.idempotency_key) === key && Number(existing.owner_user_id) === uid && Number(existing.registration_id) === input.registrationId) {
          return { claimId: Number(existing.id), status: String(existing.status), already: true };
        }
        conflict("任务已有领取记录");
      }
      if (String(task.status) !== "open") precondition("任务已被领取或不可领取");
      const timing = rows(await dbtx.execute(sql`SELECT deadline_at IS NOT NULL AND deadline_at<=NOW() AS expired FROM st_agent_work_tasks WHERE id=${input.taskId}`))[0];
      if (Number(timing?.expired) === 1) precondition("任务已截止");
      if (!isNil(task.job_id)) {
        const employment = rows(await dbtx.execute(sql`
          SELECT id FROM st_agent_employments
          WHERE job_id=${Number(task.job_id)} AND registration_id=${input.registrationId} AND status='active' LIMIT 1`))[0];
        if (!employment) forbidden("该任务仅限已录用本岗位的个人 Agent 领取");
      }
      try {
        const result = await dbtx.execute(sql`
          INSERT INTO st_agent_task_claims (task_id, registration_id, owner_user_id, status, idempotency_key)
          VALUES (${input.taskId}, ${input.registrationId}, ${uid}, 'claimed', ${key})`);
        const claimId = insertId(result);
        const changed = affected(await dbtx.execute(sql`
          UPDATE st_agent_work_tasks SET status='claimed', version=version+1 WHERE id=${input.taskId} AND status='open'`));
        if (changed !== 1) conflict("任务已被其他 Agent 领取");
        return { claimId, status: "claimed", executed: false, done: false };
      } catch (err) {
        if (!isDuplicate(err)) throw err;
        const duplicate = rows<ClaimView>(await dbtx.execute(sql`
          SELECT id, status, is_active AS isActive FROM st_agent_task_claims WHERE idempotency_key=${key} AND owner_user_id=${uid} LIMIT 1`))[0];
        if (!duplicate) {
          const activeClaim = rows(await dbtx.execute(sql`
            SELECT id FROM st_agent_task_claims WHERE task_id=${input.taskId} AND is_active=1 LIMIT 1`))[0];
          if (activeClaim) conflict("任务已被其他 Agent 领取");
          throw err;
        }
        if (Number(duplicate.isActive) !== 1) conflict("原领取已被撤销，请刷新任务后重新领取");
        return { claimId: Number(duplicate.id), status: String(duplicate.status), already: true };
      }
    });
  }),

  submitTask: agentEmploymentProcedure.input(z.object({
    ...tokenInput,
    claimId: z.number().int().positive(),
    deliverable: z.string().trim().min(MIN_DELIVERABLE_LENGTH).max(WORK_DELIVERABLE_MAX_LENGTH),
  })).mutation(async ({ input }) => {
    const session = await sessionMe(input.token);
    const db = getDb();
    return db.transaction(async (tx) => {
      const dbtx = tx as unknown as Db;
      // 与领取、复核、重开和过期清理统一 task→claim→registration 锁序。
      const identity = rows(await dbtx.execute(sql`
        SELECT task_id AS taskId FROM st_agent_task_claims WHERE id=${input.claimId} AND owner_user_id=${session.user.id}`))[0];
      if (!identity) notFound("任务领取记录不存在");
      await dbtx.execute(sql`SELECT id FROM st_agent_work_tasks WHERE id=${Number(identity.taskId)} FOR UPDATE`);
      const claimLock = rows(await dbtx.execute(sql`
        SELECT id FROM st_agent_task_claims WHERE id=${input.claimId} AND owner_user_id=${session.user.id} FOR UPDATE`))[0];
      if (!claimLock) notFound("任务领取记录不存在");
      const claim = rows(await dbtx.execute(sql`
        SELECT c.*, t.status AS taskStatus, t.version AS taskVersion, t.job_id,
               t.deadline_at IS NOT NULL AND t.deadline_at<=NOW() AS deadlineExpired
        FROM st_agent_task_claims c JOIN st_agent_work_tasks t ON t.id=c.task_id
        WHERE c.id=${input.claimId} AND c.owner_user_id=${session.user.id} FOR UPDATE`))[0];
      if (!claim) notFound("任务领取记录不存在");
      const from = String(claim.status) as TaskClaimStatus;
      if ((from !== "claimed" && from !== "rejected") || !canTransitionClaim(from, "submitted")) {
        conflict(`当前状态 ${from} 不可提交交付`);
      }
      if (!['claimed', 'rejected'].includes(String(claim.taskStatus))) conflict("企业任务状态不允许提交");
      if (asBool(claim.deadlineExpired)) conflict("任务已截止，不能提交交付");
      await assertActiveJobEmployment(dbtx, claim, Number(claim.registration_id));
      const hash = evidenceSha256(input.deliverable);
      const claimSubmitted = affected(await dbtx.execute(sql`
        UPDATE st_agent_task_claims
        SET status='submitted', deliverable=${input.deliverable}, evidence_sha256=${hash},
            submitted_at=NOW(), reviewed_at=NULL, reviewed_by=NULL, review_note=NULL, version=version+1
        WHERE id=${input.claimId} AND status IN ('claimed','rejected') AND version=${asNumber(claim.version)}`));
      if (claimSubmitted !== 1) conflict("领取版本已变化，请刷新后重新提交");
      const taskSubmitted = affected(await dbtx.execute(sql`
        UPDATE st_agent_work_tasks SET status='submitted', version=version+1
        WHERE id=${Number(claim.task_id)} AND status IN ('claimed','rejected') AND version=${asNumber(claim.taskVersion)}`));
      if (taskSubmitted !== 1) conflict("任务版本已变化，请刷新后重新提交");
      return { ok: true as const, status: "submitted", evidenceSha256: hash, executed: true, done: false, wageSettled: false };
    });
  }),

  reviewTask: agentEmploymentProcedure.input(z.object({
    ...tokenInput,
    claimId: z.number().int().positive(),
    verdict: z.enum(["accept", "reject"]),
    note: z.string().trim().min(MIN_REVIEW_NOTE_LENGTH).max(REVIEW_NOTE_MAX_LENGTH),
  })).mutation(async ({ input }) => {
    const db = getDb();
    const preview = rows(await db.execute(sql`
      SELECT c.id, t.id AS taskId, t.factory_id AS factoryId, t.department_id AS departmentId
      FROM st_agent_task_claims c JOIN st_agent_work_tasks t ON t.id=c.task_id
      WHERE c.id=${input.claimId} LIMIT 1`))[0];
    const session = await requireTaskScope(input.token, preview?.factoryId, String(preview?.departmentId ?? ""));
    return withAgentWageTx(db, async (ledgerTx, settleWage, escrow) => {
      const dbtx = ledgerTx as unknown as Db;
      await dbtx.execute(sql`SELECT id FROM st_agent_work_tasks WHERE id=${Number(preview?.taskId)} FOR UPDATE`);
      const claim = rows(await dbtx.execute(sql`
        SELECT c.*, t.factory_id AS factoryId, t.reward_job_tokens AS rewardJobTokens, t.job_id,
               t.status AS taskStatus, t.version AS taskVersion, r.status AS registrationStatus,
               t.deadline_at IS NOT NULL AND t.deadline_at<=NOW() AS deadlineExpired,
               t.deadline_at IS NOT NULL AND c.submitted_at > t.deadline_at AS submitLate,
               u.username AS ownerUsername,
               (SELECT o.environment FROM st_agent_payment_orders o WHERE o.registration_id=r.id AND o.kind='registration' AND o.attempt_no=1 LIMIT 1) AS registrationEnvironment
        FROM st_agent_task_claims c
        JOIN st_agent_work_tasks t ON t.id=c.task_id
        JOIN st_agent_registrations r ON r.id=c.registration_id
        LEFT JOIN wb_users u ON u.id=c.owner_user_id
        WHERE c.id=${input.claimId} FOR UPDATE`))[0];
      if (!claim || Number(claim.factoryId) !== session.factory.id) notFound();
      if (String(claim.status) !== "submitted" || String(claim.taskStatus) !== "submitted" || !canTransitionClaim("submitted", input.verdict === "accept" ? "accepted" : "rejected")) {
        conflict("只有已提交交付可以验收；执行或待复核不等于已交付");
      }
      if (String(claim.registrationStatus) !== "qualified") precondition("个人 Agent 就业资格已失效");
      const reviewerName = String(session.user.username ?? "").normalize("NFKC").toLowerCase();
      const ownerName = String(claim.ownerUsername ?? "").normalize("NFKC").toLowerCase();
      if (Number(claim.owner_user_id) === Number(session.user.id) || (ownerName && ownerName === reviewerName)) {
        forbidden("任务提交人不能验收自己的交付");
      }
      // 已提交交付允许仲裁，即使雇佣已结束；新提交仍有 active 雇佣闸。
      if (input.verdict === "reject") {
        let rejectedTaskStatus = "rejected";
        if (asBool(claim.deadlineExpired)) rejectedTaskStatus = "cancelled";
        if (!isNil(claim.job_id)) {
          const employment = rows(await dbtx.execute(sql`
            SELECT status FROM st_agent_employments WHERE job_id=${Number(claim.job_id)} AND registration_id=${Number(claim.registration_id)} LIMIT 1`))[0];
          if (employment && String(employment.status) === "ended") rejectedTaskStatus = "cancelled";
        }
        const rejectedClaim = affected(await dbtx.execute(sql`
          UPDATE st_agent_task_claims SET status='rejected', is_active=${rejectedTaskStatus === "cancelled" ? 0 : 1}, review_note=${input.note}, reviewed_by=${session.user.id},
            reviewed_at=NOW(), version=version+1
          WHERE id=${input.claimId} AND status='submitted' AND version=${asNumber(claim.version)}`));
        if (rejectedClaim !== 1) conflict("领取版本已变化，不能驳回");
        const rejectedTask = affected(await dbtx.execute(sql`
          UPDATE st_agent_work_tasks SET status=${rejectedTaskStatus}, cancel_reason=${rejectedTaskStatus === "cancelled" ? input.note : null}, cancelled_by=${rejectedTaskStatus === "cancelled" ? session.user.id : null}, cancelled_at=${rejectedTaskStatus === "cancelled" ? sql`NOW()` : sql`NULL`}, version=version+1
          WHERE id=${Number(claim.task_id)} AND status='submitted' AND version=${asNumber(claim.taskVersion)}`));
        if (rejectedTask !== 1) conflict("任务版本已变化，不能驳回");
        if (rejectedTaskStatus === "cancelled") {
          await escrow.releaseEnterpriseEscrowWith(Number(claim.factoryId), Number(claim.task_id), asNumber(claim.rewardJobTokens));
        }
        return { ok: true as const, status: "rejected", taskStatus: rejectedTaskStatus, wageSettled: false, settledJobTokens: 0 };
      }
      if (asBool(claim.submitLate)) conflict("交付提交时已截止，不能验收通过；仍可驳回释放任务");
      assertQualificationEnvironment(claim.registrationEnvironment);
      const amount = asNumber(claim.rewardJobTokens);
      await settleWage({
        claimId: input.claimId,
        taskId: Number(claim.task_id),
        factoryId: session.factory.id,
        registrationId: Number(claim.registration_id),
        ownerUserId: Number(claim.owner_user_id),
        amount,
        debitIdempotencyKey: idem(`wage:${input.claimId}:debit`, "accepted"),
        creditIdempotencyKey: idem(`wage:${input.claimId}:credit`, "accepted"),
      });
      const accepted = affected(await dbtx.execute(sql`
        UPDATE st_agent_task_claims SET status='accepted', review_note=${input.note}, reviewed_by=${session.user.id},
          reviewed_at=NOW(), version=version+1
        WHERE id=${input.claimId} AND status='submitted' AND version=${asNumber(claim.version)}`));
      if (accepted !== 1) conflict("验收版本已变化，不能重复结算");
      const taskAccepted = affected(await dbtx.execute(sql`
        UPDATE st_agent_work_tasks SET status='accepted', accepted_at=NOW(), version=version+1
        WHERE id=${Number(claim.task_id)} AND status='submitted' AND version=${asNumber(claim.taskVersion)}`));
      if (taskAccepted !== 1) conflict("任务版本已变化，不能完成验收");
      return { ok: true as const, status: "accepted", wageSettled: true, settledJobTokens: amount };
    });
  }),

  reopenTask: agentEmploymentProcedure.input(z.object({
    ...tokenInput,
    claimId: z.number().int().positive(),
    mode: z.enum(["retry_same_agent", "reopen_market"]),
  })).mutation(async ({ input }) => {
    const db = getDb();
    const preview = rows(await db.execute(sql`
      SELECT c.id, t.id AS taskId, t.factory_id AS factoryId, t.department_id AS departmentId
      FROM st_agent_task_claims c JOIN st_agent_work_tasks t ON t.id=c.task_id WHERE c.id=${input.claimId} LIMIT 1`))[0];
    await requireTaskScope(input.token, preview?.factoryId, String(preview?.departmentId ?? ""));
    return db.transaction(async (tx) => {
      const dbtx = tx as unknown as Db;
      await dbtx.execute(sql`SELECT id FROM st_agent_work_tasks WHERE id=${Number(preview?.taskId)} FOR UPDATE`);
      const claim = rows(await dbtx.execute(sql`
        SELECT c.*, t.status AS taskStatus, t.version AS taskVersion, t.job_id,
               t.deadline_at IS NOT NULL AND t.deadline_at<=NOW() AS deadlineExpired
        FROM st_agent_task_claims c JOIN st_agent_work_tasks t ON t.id=c.task_id WHERE c.id=${input.claimId} FOR UPDATE`))[0];
      if (!claim || Number(claim.is_active) !== 1 || String(claim.status) !== "rejected" || String(claim.taskStatus) !== "rejected") {
        conflict("只有被拒绝且仍占用的任务可以重开或改派");
      }
      if (asBool(claim.deadlineExpired)) conflict("任务已截止，不能重开或改派");
      await assertActiveJobEmployment(dbtx, claim, Number(claim.registration_id));
      const next = input.mode === "retry_same_agent" ? "claimed" : "revoked";
      if (!canTransitionClaim("rejected", next)) conflict("任务状态机拒绝该重开动作");
      const changed = affected(await dbtx.execute(sql`
        UPDATE st_agent_task_claims SET status=${next}, is_active=${next === "claimed" ? 1 : 0}, version=version+1,
            deliverable=IF(${next === "claimed" ? 1 : 0}=1, NULL, deliverable), evidence_sha256=IF(${next === "claimed" ? 1 : 0}=1, NULL, evidence_sha256), submitted_at=IF(${next === "claimed" ? 1 : 0}=1, NULL, submitted_at), reviewed_by=IF(${next === "claimed" ? 1 : 0}=1, NULL, reviewed_by), reviewed_at=IF(${next === "claimed" ? 1 : 0}=1, NULL, reviewed_at), review_note=IF(${next === "claimed" ? 1 : 0}=1, NULL, review_note)
        WHERE id=${input.claimId} AND status='rejected' AND is_active=1 AND version=${asNumber(claim.version)}`));
      if (changed !== 1) conflict("任务版本已变化，不能重开");
      const taskReopened = affected(await dbtx.execute(sql`
        UPDATE st_agent_work_tasks SET status=${next === "claimed" ? "claimed" : "open"}, version=version+1
        WHERE id=${Number(claim.task_id)} AND status='rejected' AND version=${asNumber(claim.taskVersion)}`));
      if (taskReopened !== 1) conflict("任务版本已变化，不能重开");
      return { ok: true as const, claimStatus: next, taskStatus: next === "claimed" ? "claimed" : "open", wageSettled: false };
    });
  }),

  endEmployment: agentEmploymentProcedure.input(z.object({
    ...tokenInput,
    employmentId: z.number().int().positive(),
    reason: z.string().trim().min(MIN_END_EMPLOYMENT_REASON_LENGTH).max(END_EMPLOYMENT_REASON_MAX_LENGTH),
  })).mutation(async ({ input }) => {
    const db = getDb();
    const preview = rows(await db.execute(sql`
      SELECT e.id, j.factory_id AS factoryId, j.department_id AS departmentId
      FROM st_agent_employments e JOIN st_agent_jobs j ON j.id=e.job_id WHERE e.id=${input.employmentId} LIMIT 1`))[0];
    const session = await requireTaskScope(input.token, preview?.factoryId, String(preview?.departmentId ?? ""));
    return db.transaction(async (tx) => {
      const dbtx = tx as unknown as Db;
      const employment = rows(await dbtx.execute(sql`
        SELECT e.*, j.status AS jobStatus FROM st_agent_employments e JOIN st_agent_jobs j ON j.id=e.job_id
        WHERE e.id=${input.employmentId} FOR UPDATE`))[0];
      if (!employment || String(employment.status) !== "active") conflict("雇佣关系已结束");
      await dbtx.execute(sql`SELECT id FROM st_agent_work_tasks WHERE job_id=${Number(employment.job_id)} FOR UPDATE`);
      await dbtx.execute(sql`
        UPDATE st_agent_employments SET status='ended', ended_at=NOW(), ended_by=${session.user.id}, end_reason=${input.reason}
        WHERE id=${input.employmentId} AND status='active'`);
      await dbtx.execute(sql`
        UPDATE st_agent_jobs SET filled_count=GREATEST(filled_count-1,0), status=IF(status='full','open',status)
        WHERE id=${Number(employment.job_id)}`);
      const revoked = affected(await dbtx.execute(sql`
        UPDATE st_agent_task_claims c JOIN st_agent_work_tasks t ON t.id=c.task_id
        SET c.status='revoked', c.is_active=0, c.version=c.version+1
        WHERE c.registration_id=${Number(employment.registration_id)} AND t.job_id=${Number(employment.job_id)}
          AND c.is_active=1 AND c.status IN ('claimed','rejected')`));
      await dbtx.execute(sql`
        UPDATE st_agent_work_tasks t SET status='open', version=version+1
        WHERE t.job_id=${Number(employment.job_id)} AND t.status IN ('claimed','rejected')
          AND NOT EXISTS (SELECT 1 FROM st_agent_task_claims c WHERE c.task_id=t.id AND c.is_active=1)`);
      // submitted 保持待仲裁：已提交交付可在雇佣结束后验收/驳回，新提交仍禁止。
      // 本接口只结束岗位合同并阻断后续任务；不宣称完成员工离职数据脱敏。
      return { ok: true as const, status: "ended", revokedClaims: revoked, wageSettled: false };
    });
  }),

  delivery: agentEmploymentProcedure.input(z.object({
    ...tokenInput,
    claimId: z.number().int().positive(),
  })).query(async ({ input }) => {
    const session = await sessionMe(input.token);
    const claim = rows(await getDb().execute(sql`
      SELECT c.id AS claimId, c.owner_user_id AS ownerUserId, c.deliverable,
             c.evidence_sha256 AS evidenceSha256, t.factory_id AS factoryId, t.department_id AS departmentId
      FROM st_agent_task_claims c JOIN st_agent_work_tasks t ON t.id=c.task_id
      WHERE c.id=${input.claimId} LIMIT 1`))[0];
    if (!claim) notFound("任务交付不存在");
    if (Number(claim.ownerUserId) !== Number(session.user.id)) {
      await requireTaskScope(input.token, claim.factoryId, String(claim.departmentId ?? ""));
    }
    return { claim };
  }),

  mine: agentEmploymentProcedure.input(z.object({ ...tokenInput, offset: z.number().int().min(0).max(100_000).optional() })).query(async ({ input }) => {
    const session = await sessionMe(input.token);
    const db = getDb();
    const uid = Number(session.user.id);
    const offset = input.offset ?? 0;
    const [applications, claims, wages, applicationTotalRows, claimTotalRows, wageTotalRows] = await Promise.all([
      db.execute(sql`
      SELECT a.id, a.job_id AS jobId, j.job_no AS jobNo, j.title, a.registration_id AS registrationId,
             a.status, a.cover_note AS coverNote, a.reviewed_at AS reviewedAt, a.created_at AS createdAt
      FROM st_agent_job_applications a JOIN st_agent_jobs j ON j.id=a.job_id
      WHERE a.owner_user_id=${uid} ORDER BY a.id DESC LIMIT 100 OFFSET ${offset}`),
      db.execute(sql`
      SELECT c.id AS claimId, t.id AS taskId, t.task_no AS taskNo, t.title, c.registration_id AS registrationId,
             c.status, c.is_active AS isActive, t.status AS taskStatus, t.reward_job_tokens AS rewardJobTokens,
             CASE WHEN t.job_id IS NULL THEN 'not_required'
                  ELSE COALESCE((SELECT e.status FROM st_agent_employments e
                    WHERE e.job_id=t.job_id AND e.registration_id=c.registration_id LIMIT 1), 'missing') END AS employmentStatus,
             CHAR_LENGTH(TRIM(COALESCE(c.deliverable,'')))>0 AS hasDeliverable, c.evidence_sha256 AS evidenceSha256,
             c.review_note AS reviewNote, c.submitted_at AS submittedAt, c.reviewed_at AS reviewedAt
      FROM st_agent_task_claims c JOIN st_agent_work_tasks t ON t.id=c.task_id
      WHERE c.owner_user_id=${uid} ORDER BY c.id DESC LIMIT 100 OFFSET ${offset}`),
      db.execute(sql`
      SELECT claim_id AS claimId, direction, amount_job_tokens AS amountJobTokens, balance_after AS balanceAfter,
             wallet_owner_type AS walletOwnerType, wallet_owner_id AS walletOwnerId, created_at AS createdAt
      FROM st_agent_wage_ledger WHERE owner_user_id=${uid} AND direction='credit' ORDER BY id DESC LIMIT 100 OFFSET ${offset}`),
      db.execute(sql`SELECT COUNT(*) AS total FROM st_agent_job_applications WHERE owner_user_id=${uid}`),
      db.execute(sql`SELECT COUNT(*) AS total FROM st_agent_task_claims WHERE owner_user_id=${uid}`),
      db.execute(sql`SELECT COUNT(*) AS total FROM st_agent_wage_ledger WHERE owner_user_id=${uid} AND direction='credit'`),
    ]);
    const totals = {
      applications: asNumber(rawRows(applicationTotalRows)[0]?.total),
      claims: asNumber(rawRows(claimTotalRows)[0]?.total),
      wages: asNumber(rawRows(wageTotalRows)[0]?.total),
    };
    return {
      applications: rawRows(applications), claims: rawRows(claims), wages: rawRows(wages), totals,
      truncated: { applications: offset + 100 < totals.applications, claims: offset + 100 < totals.claims, wages: offset + 100 < totals.wages },
      offset, limit: 100, awaitingReviewNotDelivered: true,
    };
  }),

  factory: agentEmploymentProcedure.input(z.object(tokenInput)).query(async ({ input }) => {
    const session = await requireWbRole(input.token, ["admin", "manager"], "仅企业负责人或部门负责人可查看工作管理");
    const db = getDb();
    const organizationScope = await resolveOrganizationScope(session);
    const jobs = rows(await db.execute(sql`
      SELECT j.id, j.job_no AS jobNo, j.department_id AS departmentId, j.title, j.requirements,
             j.headcount, j.filled_count AS filledCount, j.budget_job_tokens AS budgetJobTokens,
             j.status, j.created_at AS createdAt
      FROM st_agent_jobs j
      WHERE j.factory_id=${session.factory.id}
        AND ${departmentScope(organizationScope, sql`j.department_id`)}
      ORDER BY j.id DESC LIMIT ${FACTORY_LIST_LIMIT}`));
    const applications = rows(await db.execute(sql`
      SELECT a.id, a.job_id AS jobId, j.job_no AS jobNo, j.title, a.registration_id AS registrationId,
             r.agent_name AS agentName, a.owner_user_id AS ownerUserId, a.cover_note AS coverNote,
             a.status, a.created_at AS createdAt
      FROM st_agent_job_applications a JOIN st_agent_jobs j ON j.id=a.job_id
      JOIN st_agent_registrations r ON r.id=a.registration_id
      WHERE j.factory_id=${session.factory.id}
        AND ${departmentScope(organizationScope, sql`j.department_id`)}
      ORDER BY a.id DESC LIMIT ${FACTORY_LIST_LIMIT}`));
    const employments = rows(await db.execute(sql`
      SELECT e.id, e.job_id AS jobId, e.registration_id AS registrationId, r.agent_name AS agentName,
             j.title, e.status, e.started_at AS startedAt, e.ended_at AS endedAt, e.end_reason AS endReason
      FROM st_agent_employments e JOIN st_agent_jobs j ON j.id=e.job_id
      JOIN st_agent_registrations r ON r.id=e.registration_id
      WHERE e.factory_id=${session.factory.id}
        AND ${departmentScope(organizationScope, sql`j.department_id`)}
      ORDER BY e.id DESC LIMIT ${FACTORY_LIST_LIMIT}`));
    const tasks = rows(await db.execute(sql`
      SELECT t.id, t.task_no AS taskNo, t.job_id AS jobId, t.title, t.reward_job_tokens AS rewardJobTokens,
             t.escrow_job_tokens AS escrowJobTokens,
             t.status, t.deadline_at AS deadlineAt, t.public_feed AS publicFeed, t.public_actor_name AS publicActorName,
             (SELECT a.created_at FROM st_agent_task_visibility_audit a WHERE a.task_id=t.id ORDER BY a.id DESC LIMIT 1) AS visibilityChangedAt,
             (SELECT a.actor_user_id FROM st_agent_task_visibility_audit a WHERE a.task_id=t.id ORDER BY a.id DESC LIMIT 1) AS visibilityChangedBy,
             c.id AS claimId, c.registration_id AS registrationId,
             r.agent_name AS agentName, CHAR_LENGTH(TRIM(COALESCE(c.deliverable,'')))>0 AS hasDeliverable,
             c.evidence_sha256 AS evidenceSha256, c.review_note AS reviewNote
      FROM st_agent_work_tasks t
      LEFT JOIN st_agent_task_claims c ON c.task_id=t.id AND c.is_active=1
      LEFT JOIN st_agent_registrations r ON r.id=c.registration_id
      WHERE t.factory_id=${session.factory.id}
        AND ${departmentScope(organizationScope, sql`t.department_id`)}
      ORDER BY t.id DESC LIMIT ${FACTORY_LIST_LIMIT}`));
    const totalRow = rows(await db.execute(sql`
      SELECT
        (SELECT COUNT(*) FROM st_agent_jobs j WHERE j.factory_id=${session.factory.id} AND ${departmentScope(organizationScope, sql`j.department_id`)}) AS jobs,
        (SELECT COUNT(*) FROM st_agent_job_applications a JOIN st_agent_jobs j ON j.id=a.job_id
          WHERE j.factory_id=${session.factory.id} AND ${departmentScope(organizationScope, sql`j.department_id`)}) AS applications,
        (SELECT COUNT(*) FROM st_agent_employments e JOIN st_agent_jobs j ON j.id=e.job_id
          WHERE e.factory_id=${session.factory.id} AND ${departmentScope(organizationScope, sql`j.department_id`)}) AS employments,
        (SELECT COUNT(*) FROM st_agent_work_tasks t WHERE t.factory_id=${session.factory.id} AND ${departmentScope(organizationScope, sql`t.department_id`)}) AS tasks`))[0];
    const totals = {
      jobs: asNumber(totalRow?.jobs),
      applications: asNumber(totalRow?.applications),
      employments: asNumber(totalRow?.employments),
      tasks: asNumber(totalRow?.tasks),
    };
    const truncated = {
      jobs: totals.jobs > FACTORY_LIST_LIMIT,
      applications: totals.applications > FACTORY_LIST_LIMIT,
      employments: totals.employments > FACTORY_LIST_LIMIT,
      tasks: totals.tasks > FACTORY_LIST_LIMIT,
    };
    const departmentRow = rows(await db.execute(sql`SELECT departments FROM wb_factories WHERE id=${session.factory.id} LIMIT 1`))[0];
    const allDepartments = departmentList(departmentRow?.departments);
    const departments = organizationScope.scope === "factory" ? allDepartments
      : allDepartments.filter((department) => organizationScope.scope === "dept" && department.id === organizationScope.deptId);
    return { jobs, applications, employments, tasks, totals, truncated, listLimit: FACTORY_LIST_LIMIT, departments, reviewGraceDays: WORK_REVIEW_GRACE_DAYS };
  }),
});
