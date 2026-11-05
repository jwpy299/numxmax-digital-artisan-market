/**
 * controlledRepair —— 超终自治修复 L3 闸（六刀第六刀后半，2026-08-30）。
 *
 * 受控自修的「收票口」：一个低风险补丁要进部署，必须双证齐全——
 * ① 双签票据已消费（人拍板在先）；② 沙箱全量测试证明（sandbox:test979 审计在案）。
 * 缺一拒收（fail-closed）。本模块只做闸，不做部署——部署由执行官管线在票据消费后执行。
 */
import { sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { rawRows } from "../routers/terminal";
import { TICKET_ACTION } from "../releaseActions"; // 票据动作词表同源（OCR R18/R19：裸字面值/下标取用都会静默漏命中，按名锚定）

/** 沙箱全绿证明的审计动作键（沙箱跑完 979 测试由执行官写入） */
export const SANDBOX_PROOF_ACTION = "sandbox:test979";

export interface RepairGate {
  pass: boolean;
  missing: string[];
}

/** 受控自修闸（纯判定可测）：双证缺一不开 */
export function gateOf(hasTicket: boolean, hasSandboxProof: boolean, diffOk: boolean): RepairGate {
  const missing: string[] = [];
  if (!hasTicket) missing.push("双签票据未消费");
  if (!hasSandboxProof) missing.push("沙箱全绿证明缺失");
  if (!diffOk) missing.push("补丁草案未过校验");
  return { pass: missing.length === 0, missing };
}

/** 实况复查（执行时重钉：票据/证明必须在案） */
export async function checkRepairGate(releaseId: number): Promise<RepairGate> {
  const db = getDb();
  const ticket = rawRows(
    await db.execute(
      sql`SELECT id FROM st_release_tickets WHERE release_id=${releaseId} AND action=${TICKET_ACTION.publish} AND status='consumed' LIMIT 1`,
    ),
  );
  const proof = rawRows(
    await db.execute(
      sql`SELECT id FROM st_release_audit WHERE action=${SANDBOX_PROOF_ACTION} AND detail LIKE ${`%release:${releaseId}%`} LIMIT 1`,
    ),
  );
  const patch = rawRows(
    await db.execute(
      sql`SELECT detail FROM st_release_audit WHERE action='sdlc:patch' AND detail LIKE ${`%release:${releaseId}%`} ORDER BY id DESC LIMIT 1`,
    ),
  );
  const diffOk = patch.length > 0 && /diffOk:true/.test(String(patch[0]!.detail));
  return gateOf(ticket.length > 0, proof.length > 0, diffOk);
}
