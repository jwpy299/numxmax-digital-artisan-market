// 精灵工具授权表迁移：企业与用户隔离的技能启停配置。
// 幂等建表；生产执行需 Owner／C 级双签，禁止把授权表当公开插件市场。
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL missing");
const conn = await mysql.createConnection(url);
try {
  await conn.query(`CREATE TABLE IF NOT EXISTS st_spirit_tool_grants (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    factory_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    tool_key VARCHAR(40) NOT NULL,
    enabled TINYINT NOT NULL DEFAULT 1,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_spirit_tool_user (factory_id, user_id, tool_key),
    KEY idx_spirit_tool_user (factory_id, user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  console.log("SYNC-SPIRIT-TOOLS-PASS");
} finally {
  await conn.end();
}
