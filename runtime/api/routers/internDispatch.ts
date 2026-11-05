/**
 * internDispatch —— 实习派单调度 + 在职月数累计（挂 proactiveJobs 10 分钟环）。
 *
 * 派单纪律：每轮每分身最多 1 单、每轮全平台上限 5 单（成本帽）；
 * 只派 dressed/intern 状态且今日未满额的分身（确定性轮转）；
 * 在职月数：hired/listed 分身按月差重算（确定性推导，永不错账）。
 */
import { sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { runInternTask } from "./internJobs";
import { rawRows } from "../queries/rawRows"; // 战区④批A-lite：私有副本退役→canonical 叶单源


const ROUND_CAP = 5;

/** 在职月数重算：listed/hired 分身按 listed_at 月差（确定性） */
export async function refreshHireMonths(): Promise<number> {
  const r = await getDb().execute(
    sql`UPDATE st_personal_agents
        SET hire_months = GREATEST(0, TIMESTAMPDIFF(MONTH, COALESCE(listed_at, created_at), NOW()))
        WHERE status IN ('listed', 'hired') AND listed_at IS NOT NULL`,
  );
  const header = Array.isArray(r) ? (r[0] as { affectedRows?: number }) : {};
  return Number(header?.affectedRows ?? 0);
}

/** 实习派单（每轮全平台 ≤5 单） */
export async function runInternDispatch(now: Date = new Date()): Promise<{ dispatched: number; results: string[] }> {
  const db = getDb();
  const candidates = rawRows(
    await db.execute(
      sql`SELECT a.id, a.owner_user_id AS ownerId, u.factoryId AS factoryId
          FROM st_personal_agents a JOIN wb_users u ON u.id = a.owner_user_id
          WHERE a.status IN ('dressed', 'intern')
            AND (SELECT COUNT(*) FROM st_delivery_acceptances d
                 WHERE d.task_ref LIKE CONCAT('pa:', a.id, ':%') AND d.accepted_at >= CURDATE()) < 3
          ORDER BY a.id ASC LIMIT 10`,
    ),
  );
  const results: string[] = [];
  let dispatched = 0;
  for (const c of candidates) {
    if (dispatched >= ROUND_CAP) break;
    const r = await runInternTask(Number(c.id), Number(c.ownerId), Number(c.factoryId));
    results.push(`agent:${c.id} ${r.detail}`);
    if (r.ok) dispatched++;
  }
  return { dispatched, results };
}
