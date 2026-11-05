import { sql } from "drizzle-orm";
import { getDb } from "../queries/connection";

export class WalletFlowContractError extends Error {}

export const AGENT_TASK_WAGE_BIZ_TYPE = "agent_task_wage";
export const AGENT_REGISTRATION_REFUND_BIZ_TYPE = "agent_registration_refund";
export const AGENT_REGISTRATION_FEE_BIZ_TYPE = "agent_registration_fee";
export const AGENT_RETAKE_FEE_BIZ_TYPE = "agent_retake_fee";
export const AGENT_EXCHANGE_SANDBOX_BIZ_TYPE = "agent_token_exchange_sandbox";
export const AGENT_TASK_ESCROW_RESERVE_BIZ_TYPE = "agent_task_escrow_reserve";
export const AGENT_TASK_ESCROW_REFUND_BIZ_TYPE = "agent_task_escrow_refund";
export const agentTaskWageRefId = (claimId: number): string => `atc:${claimId}`;
export const agentTaskEscrowRefId = (taskNo: string | number): string => `att:${taskNo}`;

/** canonical st_wallet_flows 写入：bizType/refId 失败关闭，自由文本 note 按 DDL 列宽截断。 */
const WALLET_FLOW_BIZ_TYPE_MAX = 32; // st_wallet_flows.biz_type VARCHAR(32)
const WALLET_FLOW_REF_ID_MAX = 64; // st_wallet_flows.ref_id VARCHAR(64)
const WALLET_FLOW_NOTE_MAX = 255; // st_wallet_flows.note VARCHAR(255)

export async function insertWalletFlow(db: Pick<ReturnType<typeof getDb>, "execute">, opts: {
  ownerType: "enterprise" | "master" | "persona" | "user" | "agent" | "platform";
  ownerId: number;
  direction: "in" | "out";
  amount: number;
  balanceAfter: number;
  bizType: string;
  refId?: string | null;
  note?: string;
}): Promise<void> {
  if (opts.direction !== 'in' && opts.direction !== 'out') throw new WalletFlowContractError('wallet_flow_direction_invalid');
  if (opts.bizType.trim().length === 0) throw new WalletFlowContractError("wallet_flow_biz_type_empty");
  if (opts.bizType.length > WALLET_FLOW_BIZ_TYPE_MAX) throw new WalletFlowContractError("wallet_flow_biz_type_too_long");
  if (opts.refId !== undefined && opts.refId !== null && opts.refId.trim().length === 0) throw new WalletFlowContractError("wallet_flow_ref_id_empty");

  if (!Number.isSafeInteger(opts.amount) || opts.amount <= 0) throw new WalletFlowContractError("wallet_flow_amount_invalid");
  if (!Number.isSafeInteger(opts.balanceAfter) || opts.balanceAfter < 0) throw new WalletFlowContractError("wallet_flow_balance_after_invalid");
  if ((opts.refId ?? "").length > WALLET_FLOW_REF_ID_MAX) throw new WalletFlowContractError("wallet_flow_ref_id_too_long");
  // bizType/refId 是程序契约，不能静默截断业务键；自由文本 note 按列宽截断。
  const refId = opts.refId ?? null;
  const note = (opts.note ?? "").slice(0, WALLET_FLOW_NOTE_MAX);
  await db.execute(sql`
    INSERT INTO st_wallet_flows (owner_type, owner_id, direction, amount, balance_after, biz_type, ref_id, note)
    VALUES (${opts.ownerType}, ${opts.ownerId}, ${opts.direction}, ${opts.amount}, ${opts.balanceAfter},
            ${opts.bizType}, ${refId}, ${note})`);
}
