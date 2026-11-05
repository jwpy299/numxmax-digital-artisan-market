/**
 * patchDoctor —— 超终自治修复 L2：补丁生成器（六刀第六刀前半，2026-08-30）。
 *
 * 定位：探针红/信号 → 修复提案包（根因聚合 + diff 草案 + 测试计划）。
 * 纪律（方案 L2）：只出诊断书和处方，绝不动刀——diff 草案只写审计（sdlc:patch），
 * 永不自动应用；应用必须走 L3 受控自修（沙箱 979 全绿 + 双签）或人工。
 * 代码槽：kimi-k3（彭总拍板）。
 */
import { sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { callSlotChatFast } from "../routers/modelGateway";
import { rawRows } from "../routers/terminal";

export interface PatchDraft {
  diagnosis: string;
  diffDraft: string;
  risks: string[];
  unreviewed: boolean;
}

/** diff 草案校验（纯函数可测）：必须像 unified diff，且不含危险动作 */
export function isValidDiffDraft(text: string): { ok: boolean; reason: string } {
  const hasDiffShape = /^(---|\+\+\+|@@|diff )/m.test(text);
  if (!hasDiffShape) return { ok: false, reason: "不含 diff 结构" };
  const danger = /DROP TABLE|DELETE FROM|rm -rf|process\.env\.[A-Z_]*KEY|authToken/i;
  if (danger.test(text)) return { ok: false, reason: "草案含高危动作（删表/删库/密钥）" };
  return { ok: true, reason: "结构合法" };
}

/** 从模型输出提取 diff 段（纯函数） */
export function extractDiff(text: string): string {
  const m = /```(?:diff)?\n([\s\S]*?)```/.exec(text);
  return (m ? m[1]! : text).trim().slice(0, 8000);
}

/** 生成修复提案包（code 槽=kimi-k3；故障诚实降级 unreviewed） */
export async function draftPatch(signalSummary: string, auditTrail: string): Promise<PatchDraft> {
  const r = await callSlotChatFast("brain", {
    messages: [
      {
        role: "system",
        content:
          "你是 Nebula Harness 的修复医师。给出三段：①「诊断」根因一段话；②「处方」unified diff 草案（```diff 代码块，最小改动）；③「风险」逐条。不超过 600 字。不确定就说不确定，绝不编造。",
      },
      { role: "user", content: `信号：${signalSummary}\n\n审计链：\n${auditTrail}` },
    ],
    maxTokens: 900,
    timeoutMs: 45_000,
    context: "patch_doctor",
  }).catch(() => null);
  if (!r || !r.ok || !r.content) {
    return { diagnosis: "模型未诊（故障降级）", diffDraft: "", risks: [], unreviewed: true };
  }
  const text = r.content;
  const diffDraft = extractDiff(text);
  const risks = text.split("\n").filter((l) => /风险|注意|隐患/.test(l)).map((l) => l.trim().slice(0, 120)).slice(0, 5);
  const diag = (/诊断[：:](.+)/.exec(text)?.[1] ?? text.split("\n")[0] ?? "").trim().slice(0, 300);
  return { diagnosis: diag, diffDraft, risks, unreviewed: false };
}

/** 落审计（L2 报备制；永远只是草案） */
export async function filePatchDraft(proposalId: number, draft: PatchDraft): Promise<void> {
  const v = isValidDiffDraft(draft.diffDraft);
  await getDb().execute(
    sql`INSERT INTO st_release_audit (release_id, channel, actor, action, detail)
        VALUES (0, 'server', 'patch-doctor', 'sdlc:patch',
          ${`proposal:${proposalId} unreviewed:${draft.unreviewed} diffOk:${v.ok} 诊断:${draft.diagnosis}`.slice(0, 300)})`,
  );
}
