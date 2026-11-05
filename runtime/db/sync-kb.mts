/**
 * 幂等同步迭代 20「企业知识库 + 对外智能客服（微信公众号）」所需的新表：
 *   st_kb_docs / st_wechat_config
 * 全部为 st_ 前缀新表（additive），不改 drizzle schema.ts，由 api/routers/kb.ts、
 * api/routers/wechat.ts、api/wechat/callback.ts 用 raw SQL 访问。
 *
 * 不加任何种子数据：知识库文档全部由管理员在超级终端上传；
 * 微信配置为单行（id=1）惰性 upsert，首次保存配置时创建。
 *
 * 风格仿 db/sync-staff.mts：raw mysql2 直连、information_schema 检测、DRY_RUN 早退。
 * 用法：set -a && . ./.env && set +a && npx tsx db/sync-kb.mts
 * 语法自检：DRY_RUN=1 npx tsx db/sync-kb.mts（不连库，直接退出）
 */
if (process.env.DRY_RUN) {
  console.log("dry run ok");
  process.exit(0);
}

import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const conn = await mysql.createConnection(url);

/** information_schema 检测后 CREATE TABLE（幂等，additive，禁 drop） */
async function ensureTable(name: string, ddl: string) {
  const [rows] = await conn.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [name],
  );
  if ((rows as unknown[]).length > 0) {
    console.log(`${name}: table exists, skip`);
  } else {
    await conn.query(ddl);
    console.log(`${name}: table created`);
  }
}

// ── 1. 企业知识库文档表（可解析文本入 textContent，供客服/驻部智能体 RAG 引用）────
await ensureTable(
  "st_kb_docs",
  `CREATE TABLE st_kb_docs (
     id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     title VARCHAR(200) NOT NULL,
     fileName VARCHAR(255) NOT NULL,
     mimeType VARCHAR(128) NOT NULL DEFAULT 'application/octet-stream',
     sizeBytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
     textContent LONGTEXT NULL,
     status VARCHAR(16) NOT NULL DEFAULT 'ready',
     failReason VARCHAR(255) NULL,
     uploadedBy VARCHAR(64) NOT NULL DEFAULT 'admin',
     createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
     INDEX idx_st_kb_docs_status (status),
     INDEX idx_st_kb_docs_created (createdAt)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
);

// ── 2. 微信公众号客服配置表（单行 id=1；密钥存明文但接口返回一律掩码）────────────
await ensureTable(
  "st_wechat_config",
  `CREATE TABLE st_wechat_config (
     id INT UNSIGNED NOT NULL PRIMARY KEY,
     token VARCHAR(128) NULL,
     appId VARCHAR(64) NULL,
     encodingAesKey VARCHAR(64) NULL,
     welcome VARCHAR(500) NULL,
     updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
);

await conn.end();
console.log("sync-kb done");
