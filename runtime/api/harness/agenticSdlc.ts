/**
 * agenticSdlc —— AI-Native SDLC 第一层（2026-08-29 彭总拍板：加上它 Harness 才算完整版）。
 *
 * 定位：输送带是组织级 SDLC（提案→施工→验证→发布），本模块补代码级 SDLC——
 * 立项前 AI 预审（需求合规/风险/接口影响）+ 施工后自动测试计划。
 * 纪律：预审是 L1（自动+报备），不替代 C 级双签；审不过去只是如实标注，不静默拦截；
 * 失败诚实降级（模型故障时标注「未审」而不是装审过）。
 */
import { sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { callSlotChatFast } from "../routers/modelGateway";
import { rawRows } from "../routers/terminal";
import { loadJudgeMisses } from "./sdlcLearning";

export interface ReviewVerdict {
  verdict: "pass" | "warn" | "reject" | "unreviewed";
  risks: string[];
  summary: string;
}

/** 预审判定解析（纯函数可测）：模型输出 → 结构化判定 */
export function parseReviewVerdict(text: string): ReviewVerdict {
  const lower = text.toLowerCase();
  const risks: string[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim().replace(/^[-*•\d.、\s]+/, "");
    if (/风险|注意|隐患|建议/.test(t) && t.length > 4) risks.push(t.slice(0, 80));
  }
  let verdict: ReviewVerdict["verdict"] = "warn";
  if (/不可行|拒绝|阻止|高危|严禁/.test(lower)) verdict = "reject";
  else if (/可行|通过|风险可控|无.{0,4}风险/.test(lower)) verdict = "pass";
  return { verdict, risks: risks.slice(0, 5), summary: text.slice(0, 200) };
}

/** 立项预审：提案文本 → flash 槽快审（成本纪律：预审不走脑槽） */
export async function reviewProposal(proposalId: number): Promise<ReviewVerdict> {
  const db = getDb();
  const p = rawRows(
    await db.execute(sql`SELECT id, proposal_type, skill_key FROM st_evo_proposals WHERE id=${proposalId} LIMIT 1`),
  )[0];
  if (!p) return { verdict: "unreviewed", risks: [], summary: "提案不存在" };
  // v165 学习环第三步：历史判错案例回灌——AI 看着自己的黑历史审新案（故障静默不挡审）
  const misses = await loadJudgeMisses(3).catch(() => []);
  const historyBlock = misses.length > 0
    ? `\n以下是你过去的判错案例，审新案时对照警示：${misses.map((m) => `${m.kind}（${m.proposalType}/${m.skillKey}：判${m.verdict}实际${m.outcome === "incident" ? "出事" : "平安"}）`).join("；")}。`
    : "";
  const r = await callSlotChatFast("flash", {
    messages: [
      { role: "system", content: `你是代码级 SDLC 预审员。审一份施工提案，输出：第一行「判定：可行/有险/不可行」，随后逐条列风险（每条一行，以「风险：」开头）。不超过 150 字。${historyBlock}` },
      { role: "user", content: `提案类型：${String(p.proposal_type)}，对象：${String(p.skill_key)}。请预审。` },
    ],
    maxTokens: 220,
    timeoutMs: 20_000,
    context: "sdlc_review",
  }).catch(() => null);
  if (!r || !r.ok || !r.content) return { verdict: "unreviewed", risks: [], summary: "模型未审（故障降级）" };
  return parseReviewVerdict(r.content);
}

/** 施工后自动测试计划（验收依据） */
export async function genTestPlan(proposalId: number): Promise<string[]> {
  const db = getDb();
  const p = rawRows(
    await db.execute(sql`SELECT proposal_type, skill_key FROM st_evo_proposals WHERE id=${proposalId} LIMIT 1`),
  )[0];
  if (!p) return [];
  const r = await callSlotChatFast("flash", {
    messages: [
      { role: "system", content: "你是测试工程师。给施工提案列 3-5 条验收测试点，每行一条，以「- 」开头。不超过 150 字。" },
      { role: "user", content: `提案：${String(p.proposal_type)} ${String(p.skill_key)}` },
    ],
    maxTokens: 200,
    timeoutMs: 20_000,
    context: "sdlc_testplan",
  }).catch(() => null);
  if (!r || !r.ok || !r.content) return [];
  return r.content.split("\n").map((l) => l.trim().replace(/^[-*•\s]+/, "")).filter((l) => l.length > 4).slice(0, 5);
}
