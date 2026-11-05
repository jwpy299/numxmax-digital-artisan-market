/**
 * tokenLedger —— M34 站内 Token 支付闭环（购买即扣费）。
 *
 * 现状缺口（实测）：skillShop.purchase 只记三方分账台账，从不扣买家钱包——
 * Token 凭空产生。本模块补上闭环的扣费半边：
 * - 企业钱包单一事实源：enterprises.tokenBalance（与 wbBilling 充值入账同列）；
 * - 原子扣费：UPDATE ... SET tokenBalance = tokenBalance - X WHERE id AND tokenBalance >= X
 *   （影响行 0 = 余额不足/无钱包行，绝不负数、绝不透支）；
 * - 钱包行不存在 = 余额 0（无 UPSERT 造钱）；
 * - 失败文案人话化：余额不足引导充值入口，绝不抛技术码给老板。
 *
 * 分账入账半边（平台/企业/创作者 accrued）沿用 st_pack_purchases 三方台账，
 * 结算兑换通道开放时由结算环消费（iter46 设计稿口径）。
 */
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "../queries/connection";
import { rawRows, warnThrottled } from "../queries/rawRows";
import { affectedRowsOf } from "../lib/dbResult";
import { withAgentTokenWalletTx, type AgentTokenWalletApi } from "./agentTokenWallet";
import { isAgentTestEconomy } from "../lib/agentEconomy";
import { AGENT_TASK_ESCROW_REFUND_BIZ_TYPE, AGENT_TASK_ESCROW_RESERVE_BIZ_TYPE, AGENT_TASK_WAGE_BIZ_TYPE, WalletFlowContractError, agentTaskEscrowRefId, agentTaskWageRefId, insertWalletFlow } from "./walletFlow";

/** 读企业 Token 余额（无钱包行 → 0） */
export async function getFactoryTokenBalance(factoryId: number): Promise<number> {
  const rows = rawRows(
    await getDb().execute(sql`SELECT tokenBalance FROM enterprises WHERE id = ${factoryId} LIMIT 1`),
  );
  if (!rows[0]) return 0;
  const n = Number(rows[0].tokenBalance ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 购买扣费（原子，不透支）：
 * 余额不足 → PAYMENT_REQUIRED 语义（BAD_REQUEST + 人话文案）；
 * amount < 0 → 拒绝；amount = 0 → 免费包直接通过。
 */
export async function debitForPurchase(opts: {
  factoryId: number;
  amount: number;
  packKey: string;
}): Promise<{ balanceBefore: number; balanceAfter: number }> {
  if (!Number.isSafeInteger(opts.amount) || opts.amount < 0) throw new TRPCError({ code: "BAD_REQUEST", message: "扣费金额必须为非负安全整数" });
  if (opts.amount === 0) {
    const balance = await getFactoryTokenBalance(opts.factoryId);
    return { balanceBefore: balance, balanceAfter: balance };
  }
  return getDb().transaction(async (tx) => debitEnterpriseBalanceWith(tx as unknown as TokenLedgerDb, opts.factoryId, opts.amount));
}

async function debitEnterpriseBalanceWith(db: TokenLedgerDb, factoryId: number, amount: number): Promise<{ balanceBefore: number; balanceAfter: number }> {
  const walletRows = rawRows(await db.execute(sql`SELECT tokenBalance FROM enterprises WHERE id=${factoryId} FOR UPDATE`));
  const before = walletRows[0] ? ledgerNumber(walletRows[0].tokenBalance, "企业钱包数据异常，操作未结算") : 0;
  const insufficient = (current: number) => new TRPCError({ code: "BAD_REQUEST", message: `Token 余额不足（现有 ${current}，需 ${amount}）。请到「套餐用量 / Token 充值」充值后再买。` });
  if (before < amount) throw insufficient(before);
  const changed = affectedRowsOf(await db.execute(sql`
    UPDATE enterprises SET tokenBalance = tokenBalance - ${amount} WHERE id=${factoryId} AND tokenBalance >= ${amount}`));
  if (changed !== 1) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "企业钱包扣费结果异常，操作未结算" });
  const balanceAfter = before - amount;
  return { balanceBefore: before, balanceAfter };
}

function callerAmount(value: unknown, message: string): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) throw new TRPCError({ code: "BAD_REQUEST", message });
  return amount;
}

async function reserveEnterpriseEscrowWith(db: TokenLedgerDb, factoryId: number, amount: number, taskNo: string): Promise<void> {
  if (!isAgentTestEconomy()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "生产工资通道未接入，不能冻结 Agent 任务报酬" });
  const escrowAmount = callerAmount(amount, "冻结报酬数量无效，发布未执行");
  if (escrowAmount <= 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "冻结报酬必须大于零，发布未执行" });
  }
  const walletRows = rawRows(await db.execute(sql`SELECT tokenBalance FROM enterprises WHERE id=${factoryId} FOR UPDATE`));
  const before = walletRows[0] ? ledgerNumber(walletRows[0].tokenBalance, "企业钱包数据异常，发布未执行") : 0;
  if (before < escrowAmount) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `企业 job_token 可用余额不足（现有 ${before}，需冻结 ${escrowAmount}），不能发布该报酬任务` });
  const changed = affectedRowsOf(await db.execute(sql`
    UPDATE enterprises SET tokenBalance=tokenBalance-${escrowAmount}, reserved_job_tokens=reserved_job_tokens+${escrowAmount}
    WHERE id=${factoryId} AND tokenBalance>=${escrowAmount}`));
  if (changed !== 1) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "企业 job_token 可用余额不足，发布未执行" });
  await insertWalletFlow(db, {
    ownerType: "enterprise", ownerId: factoryId, direction: "out", amount: escrowAmount,
    balanceAfter: before - escrowAmount, bizType: AGENT_TASK_ESCROW_RESERVE_BIZ_TYPE,
    refId: agentTaskEscrowRefId(taskNo), note: "企业任务报酬转入冻结",
  });
}

async function releaseEnterpriseEscrowWithInternal(db: TokenLedgerDb, factoryId: number, taskId: number, amount: number, mode: "settle" | "refund"): Promise<{ availableAfter: number; releasedJobTokens: number }> {
  const action = mode === "settle" ? "验收未结算" : "取消/退款未结算";
  const releaseAmount = callerAmount(amount, `释放冻结报酬数量无效，${action}`);
  if (releaseAmount === 0 && mode === "settle") {
    throw new TRPCError({ code: "BAD_REQUEST", message: `释放冻结报酬数量无效，${action}` });
  }
  const taskRows = rawRows(await db.execute(sql`
    SELECT escrow_job_tokens, task_no AS taskNo FROM st_agent_work_tasks WHERE id=${taskId} AND factory_id=${factoryId} FOR UPDATE`));
  if (!taskRows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "任务记录不存在或不属于本企业" });
  const escrow = ledgerNumber(taskRows[0].escrow_job_tokens, `任务冻结份额数据异常，${action}`);
  const walletBeforeRows = releaseAmount === 0
    ? rawRows(await db.execute(sql`SELECT tokenBalance FROM enterprises WHERE id=${factoryId}`))
    : rawRows(await db.execute(sql`SELECT tokenBalance FROM enterprises WHERE id=${factoryId} FOR UPDATE`));
  const availableBefore = walletBeforeRows[0] ? ledgerNumber(walletBeforeRows[0].tokenBalance, `企业钱包数据异常，${action}`) : 0;
  if (releaseAmount === 0) return { availableAfter: availableBefore, releasedJobTokens: 0 };
  if (escrow === 0) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "任务冻结份额为零，不能按正数释放或验收" });
  }
  if (escrow < releaseAmount) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `任务冻结报酬不足，${action}` });
  const taskChanged = affectedRowsOf(await db.execute(sql`
    UPDATE st_agent_work_tasks SET escrow_job_tokens = escrow_job_tokens - ${releaseAmount}
    WHERE id=${taskId} AND escrow_job_tokens >= ${releaseAmount}`));
  if (taskChanged !== 1) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `任务冻结报酬不足，${action}` });
  const creditAvailable = mode === "refund" ? releaseAmount : 0;
  const walletChanged = affectedRowsOf(await db.execute(sql`
    UPDATE enterprises
    SET reserved_job_tokens = reserved_job_tokens - ${releaseAmount}, tokenBalance = tokenBalance + ${creditAvailable}
    WHERE id=${factoryId} AND reserved_job_tokens >= ${releaseAmount}`));
  if (walletChanged !== 1) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `企业冻结余额不足，${action}` });
  const availableAfter = availableBefore + creditAvailable;
  if (mode === "refund") {
    await insertWalletFlow(db, {
      ownerType: "enterprise", ownerId: factoryId, direction: "in", amount: releaseAmount,
      balanceAfter: availableAfter, bizType: AGENT_TASK_ESCROW_REFUND_BIZ_TYPE, refId: agentTaskEscrowRefId(String(taskRows[0].taskNo)),
      note: "企业任务冻结报酬退回可用余额",
    });
  }
  return { availableAfter, releasedJobTokens: releaseAmount };
}

async function releaseEnterpriseEscrowWith(db: TokenLedgerDb, factoryId: number, taskId: number, amount: number): Promise<{ availableAfter: number; releasedJobTokens: number }> {
  return releaseEnterpriseEscrowWithInternal(db, factoryId, taskId, amount, "refund");
}
async function settleEnterpriseEscrowWith(db: TokenLedgerDb, factoryId: number, taskId: number, amount: number): Promise<{ availableAfter: number; releasedJobTokens: number }> {
  return releaseEnterpriseEscrowWithInternal(db, factoryId, taskId, amount, "settle");
}

interface EnterpriseEscrowApi {
  reserveEnterpriseEscrowWith: (factoryId: number, amount: number, taskNo: string) => Promise<void>;
  releaseEnterpriseEscrowWith: (factoryId: number, taskId: number, amount: number) => Promise<{ availableAfter: number; releasedJobTokens: number }>;
}

function enterpriseEscrowApiOf(tx: TokenLedgerDb): EnterpriseEscrowApi {
  return {
    reserveEnterpriseEscrowWith: (factoryId, amount, taskNo) => reserveEnterpriseEscrowWith(tx, factoryId, amount, taskNo),
    releaseEnterpriseEscrowWith: (factoryId, taskId, amount) => releaseEnterpriseEscrowWith(tx, factoryId, taskId, amount),
  };
}

export async function withEnterpriseEscrowTx<T>(
  db: TokenLedgerRootDb,
  callback: (tx: TokenLedgerDb, escrow: EnterpriseEscrowApi) => Promise<T>,
): Promise<T> {
  return withAgentTokenWalletTx(db, async (tx, _wallet) => callback(tx, enterpriseEscrowApiOf(tx)));
}

// ─── M45 供给侧钱包 + 流水台账（Agent 支付闭环的另一半） ──────────────────────

/** 写一条钱包流水（台账留痕，绝不阻塞主链；同类故障每分钟最多一条日志） */
export async function writeFlow(opts: {
  ownerType: "enterprise" | "master" | "persona" | "user";
  ownerId: number;
  direction: "in" | "out";
  amount: number;
  balanceAfter: number;
  bizType: string;
  refId?: string | null;
  note?: string;
}): Promise<void> {
  try {
    await insertWalletFlow(getDb(), opts);
  } catch (err) {
    // 主链不因流水失败回滚，但契约违规和基础设施异常都必须可发现。
    const contractReason = err instanceof WalletFlowContractError ? err.message : undefined;
    const reason = contractReason ?? (err as { code?: string })?.code ?? "unknown_error";
    warnThrottled(`tokenLedger:wallet-flow:${reason}`, `[tokenLedger] wallet flow write skipped: ${reason} (${opts.bizType})`);
  }
}

/** 供给侧（大师/平台官方）Token 余额（无钱包行 → 0） */
export async function getMasterTokenBalance(masterId: number): Promise<number> {
  const rows = rawRows(
    await getDb().execute(sql`SELECT tokenBalance FROM masters WHERE id = ${masterId} LIMIT 1`),
  );
  const n = Number(rows[0]?.tokenBalance ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** 供给侧入账（原子增量 + 流水）：分账 85% 真实到大师钱包 */
export async function creditMaster(opts: {
  masterId: number;
  amount: number;
  bizType: string;
  refId?: string | null;
  note?: string;
}): Promise<{ balanceAfter: number }> {
  if (opts.amount <= 0) return { balanceAfter: await getMasterTokenBalance(opts.masterId) };
  await getDb().execute(
    sql`UPDATE masters SET tokenBalance = tokenBalance + ${opts.amount} WHERE id = ${opts.masterId}`,
  );
  const after = await getMasterTokenBalance(opts.masterId);
  await writeFlow({
    ownerType: "master",
    ownerId: opts.masterId,
    direction: "in",
    amount: opts.amount,
    balanceAfter: after,
    bizType: opts.bizType,
    refId: opts.refId ?? null,
    note: opts.note,
  });
  return { balanceAfter: after };
}

/** 数字人钱包读数（st_persona_wallets，M55） */
export async function getPersonaTokenBalance(persona: string): Promise<number> {
  const rows = rawRows(
    await getDb().execute(
      sql`SELECT tokenBalance FROM st_persona_wallets WHERE persona = ${persona} LIMIT 1`,
    ),
  );
  const n = Number(rows[0]?.tokenBalance ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** 数字人入账（原子增量 + 流水）：人充值词元的 5% 分润（灵枢/星云各半）回馈通路 */
export async function creditPersona(opts: {
  persona: "lingshu" | "xingyun";
  amount: number;
  bizType: string;
  refId?: string | null;
  note?: string;
}): Promise<{ balanceAfter: number }> {
  if (opts.amount <= 0) return { balanceAfter: await getPersonaTokenBalance(opts.persona) };
  await getDb().execute(
    sql`UPDATE st_persona_wallets SET tokenBalance = tokenBalance + ${opts.amount} WHERE persona = ${opts.persona}`,
  );
  const after = await getPersonaTokenBalance(opts.persona);
  await writeFlow({
    ownerType: "persona",
    ownerId: opts.persona === "lingshu" ? 1 : 2,
    direction: "in",
    amount: opts.amount,
    balanceAfter: after,
    bizType: opts.bizType,
    refId: opts.refId ?? null,
    note: opts.note,
  });
  return { balanceAfter: after };
}

/** 个人词元钱包读数（wb_users.tokenBalance，M55） */
/** v177 双栏钱包（六刀第五刀）：老板同一人——企业花多少 ⇄ 个人收多少，一卡合并（只读） */
export interface DualWallet {
  factoryBalance: number;
  factoryMonthSpend: number;
  userBalance: number;
  userMonthIncome: number;
}

export async function getUserTokenBalance(userId: number): Promise<number> {
  const rows = rawRows(
    await getDb().execute(sql`SELECT tokenBalance FROM wb_users WHERE id = ${userId} LIMIT 1`),
  );
  const n = Number(rows[0]?.tokenBalance ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** 个人入账（原子增量 + 流水）：数字人回馈/平台奖励落入个人钱包 */
export async function creditUser(opts: {
  userId: number;
  amount: number;
  bizType: string;
  refId?: string | null;
  note?: string;
}): Promise<{ balanceAfter: number }> {
  if (opts.amount <= 0) return { balanceAfter: await getUserTokenBalance(opts.userId) };
  await getDb().execute(
    sql`UPDATE wb_users SET tokenBalance = tokenBalance + ${opts.amount} WHERE id = ${opts.userId}`,
  );
  const after = await getUserTokenBalance(opts.userId);
  await writeFlow({
    ownerType: "user",
    ownerId: opts.userId,
    direction: "in",
    amount: opts.amount,
    balanceAfter: after,
    bizType: opts.bizType,
    refId: opts.refId ?? null,
    note: opts.note,
  });
  return { balanceAfter: after };
}

/** 个人出账（原子防透支：UPDATE...WHERE tokenBalance>=X，0 行=余额不足）+ 流水 */
export async function debitUser(opts: {
  userId: number;
  amount: number;
  bizType: string;
  refId?: string | null;
  note?: string;
}): Promise<{ ok: boolean; balanceAfter: number }> {
  if (opts.amount <= 0) return { ok: true, balanceAfter: await getUserTokenBalance(opts.userId) };
  const res = (await getDb().execute(
    sql`UPDATE wb_users SET tokenBalance = tokenBalance - ${opts.amount}
        WHERE id = ${opts.userId} AND tokenBalance >= ${opts.amount}`,
  )) as unknown;
  const affected = Number((Array.isArray(res) ? res[0] : res)?.affectedRows ?? 0);
  if (affected === 0) return { ok: false, balanceAfter: await getUserTokenBalance(opts.userId) };
  const after = await getUserTokenBalance(opts.userId);
  await writeFlow({
    ownerType: "user",
    ownerId: opts.userId,
    direction: "out",
    amount: opts.amount,
    balanceAfter: after,
    bizType: opts.bizType,
    refId: opts.refId ?? null,
    note: opts.note,
  });
  return { ok: true, balanceAfter: after };
}

/** 企业侧出账流水便捷封装（debit 之后跟一条 out 流水） */
export async function noteEnterpriseDebit(opts: {
  factoryId: number;
  amount: number;
  balanceAfter: number;
  bizType: string;
  refId?: string | null;
  note?: string;
}): Promise<void> {
  await writeFlow({
    ownerType: "enterprise",
    ownerId: opts.factoryId,
    direction: "out",
    amount: opts.amount,
    balanceAfter: opts.balanceAfter,
    bizType: opts.bizType,
    refId: opts.refId ?? null,
    note: opts.note,
  });
}

type TokenLedgerDb = Pick<ReturnType<typeof getDb>, "execute">;
type TokenLedgerRootDb = Pick<ReturnType<typeof getDb>, "execute" | "transaction">;

function ledgerNumber(value: unknown, message: string): number {
  if (value === null || value === undefined || value === "") {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message });
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message });
  return n;
}

async function creditAgentWith(wallet: AgentTokenWalletApi, registrationId: number, claimId: number, amount: number): Promise<number> {
  return wallet.creditSystemAgentTokenWallet(registrationId, {
    direction: "in",
    amount,
    bizType: AGENT_TASK_WAGE_BIZ_TYPE,
    refId: agentTaskWageRefId(claimId),
    note: "个人Agent任务验收工资入账",
  });
}

interface AgentWageSettlement {
  claimId: number;
  taskId: number;
  factoryId: number;
  registrationId: number;
  ownerUserId: number;
  amount: number;
  debitIdempotencyKey: string;
  creditIdempotencyKey: string;
}

async function settleAgentWageTx(tx: TokenLedgerDb, wallet: AgentTokenWalletApi, opts: AgentWageSettlement): Promise<{ enterpriseBalanceAfter: number; agentBalanceAfter: number }> {
  if (!isAgentTestEconomy()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "生产人民币工资通道未接入，验收不结算 Agent 钱包" });
  const claimRows = rawRows(await tx.execute(sql`
    SELECT c.id, t.reward_job_tokens AS rewardJobTokens FROM st_agent_task_claims c
    JOIN st_agent_work_tasks t ON t.id=c.task_id
    JOIN st_agent_registrations r ON r.id=c.registration_id
    WHERE c.id=${opts.claimId} AND t.id=${opts.taskId} AND t.factory_id=${opts.factoryId}
      AND c.registration_id=${opts.registrationId} AND c.owner_user_id=${opts.ownerUserId}
      AND r.owner_user_id=c.owner_user_id AND r.status='qualified'
      AND c.status='submitted' AND t.status='submitted' LIMIT 1 FOR UPDATE`));
  if (!claimRows[0]) throw new TRPCError({ code: "FORBIDDEN", message: "工资收款身份与任务领取记录不一致，验收未结算" });
  const reward = ledgerNumber(claimRows[0].rewardJobTokens, "任务报酬数据异常，验收未结算");
  const amount = callerAmount(opts.amount, "工资数量无效，验收未结算");
  if (amount !== reward) throw new TRPCError({ code: "BAD_REQUEST", message: "工资数量与任务报酬不一致，验收未结算" });
  if (amount <= 0) throw new TRPCError({ code: "BAD_REQUEST", message: "工资数量必须大于零，验收未结算" });
  const release = await settleEnterpriseEscrowWith(tx, opts.factoryId, opts.taskId, amount);
  const enterpriseBalanceAfter = release.availableAfter;
  const agentBalanceAfter = await creditAgentWith(wallet, opts.registrationId, opts.claimId, amount);
  await tx.execute(sql`
    INSERT INTO st_agent_wage_ledger
      (claim_id, factory_id, registration_id, owner_user_id, direction, amount_job_tokens, balance_after,
       wallet_owner_type, wallet_owner_id, idempotency_key)
    VALUES
      (${opts.claimId}, ${opts.factoryId}, ${opts.registrationId}, ${opts.ownerUserId},
       'debit', ${amount}, ${enterpriseBalanceAfter}, 'enterprise', ${opts.factoryId}, ${opts.debitIdempotencyKey})`);
  await tx.execute(sql`
    INSERT INTO st_agent_wage_ledger
      (claim_id, factory_id, registration_id, owner_user_id, direction, amount_job_tokens, balance_after,
       wallet_owner_type, wallet_owner_id, idempotency_key)
    VALUES
      (${opts.claimId}, ${opts.factoryId}, ${opts.registrationId}, ${opts.ownerUserId},
       'credit', ${amount}, ${agentBalanceAfter}, 'agent', ${opts.registrationId}, ${opts.creditIdempotencyKey})`);
  return { enterpriseBalanceAfter, agentBalanceAfter };
}

/** 唯一的工资结算入口：settle 只在真实事务回调内暴露，不能误传池化 getDb() 非原子扣款。 */
export async function withAgentWageTx<T>(
  db: TokenLedgerRootDb,
  callback: (tx: TokenLedgerDb, settle: (opts: AgentWageSettlement) => Promise<{ enterpriseBalanceAfter: number; agentBalanceAfter: number }>, escrow: EnterpriseEscrowApi) => Promise<T>,
): Promise<T> {
  return withAgentTokenWalletTx(db, async (ledgerTx, wallet) => {
    const escrow = enterpriseEscrowApiOf(ledgerTx);
    return callback(ledgerTx, (opts) => settleAgentWageTx(ledgerTx, wallet, opts), escrow);
  });
}
