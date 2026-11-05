/**
 * feedbackCollector —— 反馈采集接线（2026-08-26 彭总令 #4：运行图三条虚线进环）。
 *
 * snapshotNorthStar：从真实业务表计算北极星指标快照写回 st_northstar_metrics.current_value——
 * 环/驾驶舱读的不再是 NULL，是真实业务血流。
 * 数据源口径（全部既有事实表，零新增采集负担）：
 * - 技能调用反馈：st_skill_calls（voiceSkills.recordSkillCall 记账）
 * - 验收/交付：st_delivery_acceptances（用户确权）
 * - 雇佣/留存：agent_hire_records（trial/active/expired）
 * - 获客：wb_users.createdAt
 * - 一次通过率：st_harness_runs.ok 比率
 * 纪律：每指标独立 try/catch，单源缺席只缺该指标，绝不拖垮采集器（F4）。
 */
import { sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { rawRows } from "./terminal";

async function scalar(query: ReturnType<typeof sql>): Promise<number | null> {
  try {
    const rows = rawRows(await getDb().execute(query));
    const v = rows[0] ? Object.values(rows[0])[0] : null;
    return v == null ? null : Number(v);
  } catch {
    return null; // 源表缺席静默（F4）
  }
}

async function writeMetric(key: string, value: number | null): Promise<boolean> {
  if (value == null || Number.isNaN(value)) return false;
  try {
    await getDb().execute(
      sql`UPDATE st_northstar_metrics SET current_value=${value}, snapshot_at=NOW() WHERE metric_key=${key}`,
    );
    return true;
  } catch {
    return false;
  }
}

/** 北极星快照主入口（挂 proactiveJobs 环尾部，每 10 分钟刷新） */
export async function snapshotNorthStar(): Promise<{ updated: string[] }> {
  const updated: string[] = [];
  const jobs: [string, () => Promise<number | null>][] = [
    // B 主指标：周验收交付数（用户确权事实源）
    ["weekly_verified_deliveries", () =>
      scalar(sql`SELECT COUNT(*) FROM st_delivery_acceptances WHERE accepted_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`)],
    // C 校验：续费率（到期续留比例：active/(active+expired)）
    ["retention_renewal_rate", async () => {
      const active = await scalar(sql`SELECT COUNT(*) FROM agent_hire_records WHERE status='active'`);
      const expired = await scalar(sql`SELECT COUNT(*) FROM agent_hire_records WHERE status='expired'`);
      const total = (active ?? 0) + (expired ?? 0);
      return total > 0 ? Math.round(((active ?? 0) / total) * 1000) / 10 : null;
    }],
    // 输入-获客：7 日新注册→首次雇佣转化
    ["signup_to_hire_rate", async () => {
      const nu = await scalar(sql`SELECT COUNT(*) FROM wb_users WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`);
      const hires = await scalar(sql`SELECT COUNT(DISTINCT enterpriseId) FROM agent_hire_records WHERE createdAt >= DATE_SUB(NOW(), INTERVAL 7 DAY)`);
      return nu && nu > 0 ? Math.round(((hires ?? 0) / nu) * 1000) / 10 : null;
    }],
    // 输入-交付：一次通过率（重型链 ok 比率 7 日）
    ["first_pass_rate", async () => {
      const ok = await scalar(sql`SELECT COUNT(*) FROM st_harness_runs WHERE ok=1 AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`);
      const all = await scalar(sql`SELECT COUNT(*) FROM st_harness_runs WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`);
      return all && all > 0 ? Math.round(((ok ?? 0) / all) * 1000) / 10 : null;
    }],
    // 输入-体验：语音/技能调用成功率（7 日，st_skill_calls 反馈虚线）
    ["voice_completion_rate", async () => {
      const ok = await scalar(sql`SELECT COUNT(*) FROM st_skill_calls WHERE status='ok' AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`);
      const all = await scalar(sql`SELECT COUNT(*) FROM st_skill_calls WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`);
      return all && all > 0 ? Math.round(((ok ?? 0) / all) * 1000) / 10 : null;
    }],
    // 输入-留存：7 日活跃雇佣（有任务交付记录的合约比例）
    ["d7_active_hire_rate", async () => {
      const active = await scalar(sql`SELECT COUNT(*) FROM agent_hire_records WHERE status='active' AND tasksCompleted > 0`);
      const all = await scalar(sql`SELECT COUNT(*) FROM agent_hire_records WHERE status='active'`);
      return all && all > 0 ? Math.round(((active ?? 0) / all) * 1000) / 10 : null;
    }],
  ];
  for (const [key, fn] of jobs) {
    if (await writeMetric(key, await fn())) updated.push(key);
  }
  return { updated };
}
