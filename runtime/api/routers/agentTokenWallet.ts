/** AI Agent 自有 job_token 钱包与平台准备金钱包；所有变动同时写 canonical st_wallet_flows。 */
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "../queries/connection";
import { affectedRowsOf } from "../lib/dbResult";
import { rawRows } from "../queries/rawRows";
import { insertWalletFlow } from "./walletFlow";
import { AGENT_TOKEN_BALANCE_MAX } from "../../contracts/agentEmploymentRules";

export type AgentTokenWalletDb = Pick<ReturnType<typeof getDb>, "execute" | "transaction">;
type AgentTokenWalletTx = Pick<ReturnType<typeof getDb>, "execute">;
interface WalletChange {
  amount: number;
  direction: "in" | "out";
  bizType: string;
  refId: string;
  note: string;
  /** direction="out" 余额不足时返回给用户的文案。 */
  insufficientMessage?: string;
}
type SystemWalletCredit = Omit<WalletChange, "direction"> & { direction: "in" };
export interface AgentTokenWalletApi {
  creditSystemAgentTokenWallet: (registrationId: number, change: SystemWalletCredit) => Promise<number>;
  ensureAgentTokenWallet(registrationId: number): Promise<void>;
  changeAgentTokenWallet(registrationId: number, change: WalletChange): Promise<number>;
  changePlatformTokenWallet(change: WalletChange): Promise<number>;
}

function positiveAmount(value: unknown): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "job_token 数量必须为大于零的整数" });
  }
  return amount;
}

function walletKeyOf(kind: "agent" | "platform", registrationId: number): string {
  return kind === "agent" ? `agent:${registrationId}` : "platform";
}

async function ensureTokenWallet(db: AgentTokenWalletTx, kind: "agent" | "platform", registrationId: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO st_agent_token_wallets (wallet_key, registration_id, owner_type, balance_job_tokens)
    VALUES (${walletKeyOf(kind, registrationId)}, ${kind === "agent" ? registrationId : null}, ${kind}, 0)
    ON DUPLICATE KEY UPDATE id=st_agent_token_wallets.id`);
}

async function ensureAgentTokenWallet(db: AgentTokenWalletTx, registrationId: number): Promise<void> {
  return ensureTokenWallet(db, "agent", registrationId);
}

async function readAgentTokenBalanceWithLock(db: AgentTokenWalletTx, registrationId: number, lock: boolean): Promise<number> {
  const wallet = rawRows(await db.execute(sql`
    SELECT balance_job_tokens AS balance FROM st_agent_token_wallets
    WHERE wallet_key=${walletKeyOf("agent", registrationId)} LIMIT 1 ${lock ? sql`FOR UPDATE` : sql``}`))[0];
  if (!wallet) return 0;
  const balance = Number(wallet.balance);
  if (!Number.isSafeInteger(balance) || balance < 0) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Agent 钱包数据异常，操作未结算" });
  return balance;
}

/** 只读余额；需要 FOR UPDATE 的写链必须通过 withAgentTokenWalletTx。 */
export async function readAgentTokenBalance(db: Pick<ReturnType<typeof getDb>, "execute">, registrationId: number): Promise<number> {
  return readAgentTokenBalanceWithLock(db, registrationId, false);
}

async function readPlatformTokenBalanceWithLock(db: AgentTokenWalletTx): Promise<number> {
  const wallet = rawRows(await db.execute(sql`SELECT balance_job_tokens AS balance FROM st_agent_token_wallets WHERE wallet_key=${walletKeyOf("platform", 0)} FOR UPDATE`))[0];
  if (!wallet) return 0;
  const balance = Number(wallet.balance);
  if (!Number.isSafeInteger(balance) || balance < 0) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "平台钱包数据异常，操作未结算" });
  return balance;
}

async function applyWalletChange(db: AgentTokenWalletTx, kind: "agent" | "platform", registrationId: number, change: WalletChange, systemCredit = false): Promise<number> {
  if (change.direction !== "in" && change.direction !== "out") throw new TRPCError({ code: "BAD_REQUEST", message: "钱包方向无效" });
  if (systemCredit && change.direction !== "in") throw new TRPCError({ code: "FORBIDDEN", message: "系统应付入账只允许 credit" });
  const amount = positiveAmount(change.amount);
  const walletKey = walletKeyOf(kind, registrationId);
  await ensureTokenWallet(db, kind, registrationId);
  if (change.direction === "out") {
    const changed = affectedRowsOf(await db.execute(sql`
      UPDATE st_agent_token_wallets SET balance_job_tokens=balance_job_tokens-${amount}, version=version+1
      WHERE wallet_key=${walletKey} AND balance_job_tokens>=${amount}`));
    if (changed !== 1) {
      if (kind === "agent") throw new TRPCError({ code: "PRECONDITION_FAILED", message: change.insufficientMessage ?? "Agent job_token 余额不足，请先兑换或完成任务获取" });
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: change.insufficientMessage ?? "平台 job_token 余额不足" });
    }
  } else {
    if (kind === "agent" && !systemCredit) {
      const current = await readAgentTokenBalanceWithLock(db, registrationId, true);
      if (current + amount > AGENT_TOKEN_BALANCE_MAX) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Agent job_token 钱包余额将达上限，请先使用后再兑换" });
      }
    }
    const credited = affectedRowsOf(await db.execute(sql`
      UPDATE st_agent_token_wallets SET balance_job_tokens=balance_job_tokens+${amount}, version=version+1
      WHERE wallet_key=${walletKey}`));
    if (credited !== 1) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `${kind === "agent" ? "Agent" : "平台"}钱包入账结果异常，操作未结算` });
  }
  const balance = kind === "agent" ? await readAgentTokenBalanceWithLock(db, registrationId, true) : await readPlatformTokenBalanceWithLock(db);
  await insertWalletFlow(db, {
    ownerType: kind, ownerId: kind === "agent" ? registrationId : 0, direction: change.direction, amount,
    balanceAfter: balance, bizType: change.bizType, refId: change.refId, note: change.note,
  });
  return balance;
}

/** 唯一的 token 钱包写入口：事务回调内才暴露扣款、入账和锁余额能力。 */
export async function withAgentTokenWalletTx<T>(
  db: AgentTokenWalletDb,
  callback: (tx: AgentTokenWalletTx, wallet: AgentTokenWalletApi) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const walletTx = tx as unknown as AgentTokenWalletTx;
    const api: AgentTokenWalletApi = {
      ensureAgentTokenWallet: (registrationId) => ensureAgentTokenWallet(walletTx, registrationId),
      changeAgentTokenWallet: (registrationId, change) => applyWalletChange(walletTx, "agent", registrationId, change, false),
      changePlatformTokenWallet: (change) => applyWalletChange(walletTx, "platform", 0, change),
      creditSystemAgentTokenWallet: (registrationId, change) => applyWalletChange(walletTx, "agent", registrationId, change, true),
    };
    return callback(walletTx, api);
  });
}
