/**
 * M33 迁移「Agent DAG 任务编排」：st_dag_runs（幂等）。
 *
 * 任务图运行时（Harness 运行装配线 P0-① 落地）：
 * - 一张任务图 = 目标 + 有序步骤组（每步绑定驻部智能体）；
 * - steps JSON 列（v1 简洁口径）：[{key,title,agentCode,status,result,artifactIds}]，
 *   status ∈ pending/running/done/failed/skipped；
 * - 执行模型：立即返回 + 轮询终态（iter47 龙虾长任务同款纪律），
 *   进程内异步执行器逐步跑 agentBridge 管线，每步落库；
 * - 惰性恢复：run.status=running 且 updatedAt 超 5 分钟（进程重启）→ 读侧标 failed，
 *   可从断点 retry 续跑。
 *
 * 幂等：CREATE TABLE IF NOT EXISTS。
 * 用法：set -a && . ./.env && set +a && npx tsx db/sync-m33.mts
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Conn = { query: (q: string, params?: unknown[]) => Promise<unknown>; end?: () => Promise<void> };

const DDL = `CREATE TABLE IF NOT EXISTS st_dag_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  factoryId BIGINT UNSIGNED NOT NULL,
  goal VARCHAR(500) NOT NULL,
  steps JSON NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ready',
  createdBy BIGINT UNSIGNED NOT NULL,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  finishedAt TIMESTAMP NULL,
  INDEX idx_factory (factoryId, id),
  INDEX idx_status (status)
)`;

const isDirectRun =
  process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (isDirectRun) {
  if (process.env.DRY_RUN === "1") {
    console.log("DRY_RUN ok: syntax parsed");
    process.exit(0);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL 未配置");
    process.exit(1);
  }
  const { createConnection } = await import("mysql2/promise");
  const u = new URL(url);
  const conn = await createConnection({
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.slice(1),
  });
  try {
    await conn.query(DDL);
    console.log("st_dag_runs Agent DAG 任务图: ensured");
  } finally {
    await conn.end();
  }
}
