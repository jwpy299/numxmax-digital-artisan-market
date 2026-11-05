/**
 * sdlcLearning —— 学习环第二步：结果对账（2026-08-29 彭总令）。
 *
 * 定位：预审留底（st_sdlc_verdicts）是「判决书」，本模块回写「事后真相」（st_sdlc_outcomes）——
 * 每个施工提案后来到底出事没有。判定口径全确定性（纯函数），不靠感觉：
 * - 关联发布 rolled_back / 有 rollback 审计 → incident（出事）；
 * - 发布 verified/published 且观察期满（7 天）无事故 → clean（平安）；
 * - 观察期内无事故 → 不结案（下次再对）。
 * 纪律：对账失败静默（挂 proactiveJobs 尾部独立 try/catch），绝不挡主链。
 */
import { AUDIT_ACTION } from "../releaseActions";
import { sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { rawRows } from "../routers/terminal";

/** 观察期（天）：发布后满观察期无事故才结「平安」 */
export const OBSERVE_DAYS = 7;

/** 对账判定（纯函数可测） */
export function outcomeOf(input: { releaseStatus: string | null; hasRollbackAudit: boolean; ageDays: number }): { outcome: "incident" | "clean"; evidence: string } | null {
  if (input.hasRollbackAudit || input.releaseStatus === "rolled_back") {
    return { outcome: "incident", evidence: "发布回滚/rollback 审计在案" };
  }
  if ((input.releaseStatus === "verified" || input.releaseStatus === "published") && input.ageDays >= OBSERVE_DAYS) {
    return { outcome: "clean", evidence: `${input.releaseStatus} + 观察期 ${OBSERVE_DAYS} 天满无事故` };
  }
  return null; // 观察期内：不结案
}

/** 对账主流程：找出有判决书但未结案的提案，逐个对账 */
export async function reconcileOutcomes(): Promise<{ resolved: number }> {
  const db = getDb();
  // 有判决、未结案的提案 + 其关联发布（construct:queued 审计行 detail 契约含 proposal:<id>）
  const rows = rawRows(
    await db.execute(
      sql`SELECT v.proposal_id, a.release_id, r.status AS release_status,
                 TIMESTAMPDIFF(DAY, r.created_at, NOW()) AS age_days,
                 EXISTS(SELECT 1 FROM st_release_audit ra WHERE ra.release_id = a.release_id AND ra.action IN (${AUDIT_ACTION.rollback}, ${AUDIT_ACTION.confirmRollback})) AS has_rollback
          FROM st_sdlc_verdicts v
          JOIN st_release_audit a ON a.action = 'construct:queued' AND a.detail LIKE CONCAT('%proposal:', v.proposal_id, ' %')
          LEFT JOIN st_releases r ON r.id = a.release_id
          LEFT JOIN st_sdlc_outcomes o ON o.proposal_id = v.proposal_id
          WHERE o.proposal_id IS NULL
          LIMIT 50`,
    ),
  ) as { proposal_id: number; release_id: number | null; release_status: string | null; age_days: number | null; has_rollback: number }[];

  let resolved = 0;
  for (const row of rows) {
    const verdictRow = outcomeOf({
      releaseStatus: row.release_status,
      hasRollbackAudit: Number(row.has_rollback) === 1,
      ageDays: Number(row.age_days ?? 0),
    });
    if (!verdictRow) continue; // 观察期内不结案
    await db.execute(
      sql`INSERT INTO st_sdlc_outcomes (proposal_id, release_id, outcome, evidence)
          VALUES (${row.proposal_id}, ${row.release_id ?? null}, ${verdictRow.outcome}, ${verdictRow.evidence.slice(0, 300)})
          ON DUPLICATE KEY UPDATE outcome=VALUES(outcome), evidence=VALUES(evidence)`,
    );
    resolved += 1;
  }
  return { resolved };
}

/** 判错案例（供预审提示词回灌）：漏判=审 pass 实际出事；误判=审 reject 实际平安 */
export interface JudgeMiss {
  kind: "漏判" | "误判";
  proposalType: string;
  skillKey: string;
  verdict: string;
  outcome: string;
}

export async function loadJudgeMisses(limit = 3): Promise<JudgeMiss[]> {
  const db = getDb();
  const rows = rawRows(
    await db.execute(
      sql`SELECT p.proposal_type, p.skill_key, v.verdict, o.outcome
          FROM st_sdlc_verdicts v
          JOIN st_sdlc_outcomes o ON o.proposal_id = v.proposal_id
          JOIN st_evo_proposals p ON p.id = v.proposal_id
          WHERE (v.verdict = 'pass' AND o.outcome = 'incident')
             OR (v.verdict = 'reject' AND o.outcome = 'clean')
          ORDER BY o.resolved_at DESC LIMIT ${limit}`,
    ).catch(() => [[]]),
  );
  return (rows as { proposal_type: string; skill_key: string; verdict: string; outcome: string }[]).map((r) => ({
    kind: r.verdict === "pass" ? "漏判" : "误判",
    proposalType: String(r.proposal_type),
    skillKey: String(r.skill_key),
    verdict: r.verdict,
    outcome: r.outcome,
  }));
}

/** 预审准星（纯函数可测）：准确率/漏判率/误判率 */
export function accuracyOf(rows: { verdict: string; outcome: string }[]): { total: number; accuracy: number; missRate: number; falseRate: number } {
  const total = rows.length;
  if (total === 0) return { total: 0, accuracy: 0, missRate: 0, falseRate: 0 };
  const miss = rows.filter((r) => r.verdict === "pass" && r.outcome === "incident").length;
  const falseAlarm = rows.filter((r) => r.verdict === "reject" && r.outcome === "clean").length;
  const correct = total - miss - falseAlarm;
  const pct = (n: number) => Math.round((n / total) * 1000) / 10;
  return { total, accuracy: pct(correct), missRate: pct(miss), falseRate: pct(falseAlarm) };
}

/** 准星实况（供超终驾驶舱） */
export async function sdlcAccuracy(): Promise<ReturnType<typeof accuracyOf>> {
  const db = getDb();
  const rows = rawRows(
    await db.execute(
      sql`SELECT v.verdict, o.outcome FROM st_sdlc_verdicts v JOIN st_sdlc_outcomes o ON o.proposal_id = v.proposal_id`,
    ).catch(() => [[]]),
  );
  return accuracyOf(rows as { verdict: string; outcome: string }[]);
}
