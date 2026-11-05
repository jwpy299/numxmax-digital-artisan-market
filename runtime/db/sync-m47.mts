/**
 * M47 迁移「部门工作台」：st_dept_consoles 表（幂等）。
 * 平台侧三个业务部门（运营/品牌/市场）的独立管理工作台配置：
 * 每部门一行——驻部智能体组（agentCodes JSON）+ 部门主官（chiefAgentCode）+
 * DSH 内嵌开关 + 海禛云模型档位。与企业侧 wb_dept_heads（客户组织）互不混用。
 * 用法：set -a && . ./.env && set +a && npx tsx db/sync-m47.mts
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Conn = { query: (q: string, params?: unknown[]) => Promise<unknown>; end?: () => Promise<void> };

async function main(conn: Conn): Promise<void> {
  const rows = (await conn.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'st_dept_consoles'`,
  )) as unknown;
  const found = (Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : rows) as Array<Record<string, unknown>>;
  if (found.length > 0) {
    console.log("st_dept_consoles: already exists, skip");
    return;
  }
  await conn.query(`
    CREATE TABLE st_dept_consoles (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      dept_code VARCHAR(16) NOT NULL,
      dept_name VARCHAR(32) NOT NULL,
      chief_agent_code VARCHAR(64) NULL,
      agent_codes JSON NOT NULL,
      dsh_enabled TINYINT NOT NULL DEFAULT 1,
      model_slot VARCHAR(16) NOT NULL DEFAULT 'chat',
      config JSON NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_dept_consoles_code (dept_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await conn.query(
    `INSERT INTO st_dept_consoles (dept_code, dept_name, chief_agent_code, agent_codes, dsh_enabled, model_slot)
     VALUES
       ('ops', '运营部', NULL, JSON_ARRAY(), 1, 'chat'),
       ('brand', '品牌部', NULL, JSON_ARRAY(), 1, 'chat'),
       ('marketing', '市场部', NULL, JSON_ARRAY(), 1, 'chat')`,
  );
  console.log("st_dept_consoles: created + seeded (ops/brand/marketing)");
}

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
  await main(conn);
  await conn.end();
}
