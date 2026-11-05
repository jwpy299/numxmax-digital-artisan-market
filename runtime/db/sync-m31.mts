/**
 * M31 迁移「工作台附件中心」：st_attachments（幂等）。
 *
 * 工作台通用文件/图片/附件入口（与 kb 知识库 2MB 文档解析定位区分）：
 * - 图片/办公文档/文本类附件统一台账，factoryId 企业隔离；
 * - 文件落盘 ST_UPLOAD_DIR（默认 <cwd>/data/uploads），台账记录路径与大小；
 * - uploaderId 上传者归属；remove 仅上传者本人或 admin。
 *
 * 幂等：CREATE TABLE IF NOT EXISTS。
 * 用法：set -a && . ./.env && set +a && npx tsx db/sync-m31.mts
 * 语法自检：DRY_RUN=1 npx tsx db/sync-m31.mts
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Conn = { query: (q: string, params?: unknown[]) => Promise<unknown>; end?: () => Promise<void> };

const DDL = `CREATE TABLE IF NOT EXISTS st_attachments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  factoryId BIGINT UNSIGNED NOT NULL,
  uploaderId BIGINT UNSIGNED NOT NULL,
  title VARCHAR(128) NOT NULL,
  fileName VARCHAR(128) NOT NULL,
  mimeType VARCHAR(64) NOT NULL,
  kind VARCHAR(16) NOT NULL,
  filePath VARCHAR(255) NOT NULL,
  sizeBytes INT NOT NULL DEFAULT 0,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_factory (factoryId, id),
  INDEX idx_uploader (uploaderId)
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
    console.log("st_attachments 工作台附件台账: ensured");
  } finally {
    await conn.end();
  }
}
