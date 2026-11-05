// iter78 Panda 组织底座：四角色席位 + 操作单分级审批。幂等。
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL missing");
const conn = await mysql.createConnection(url);

async function hasColumn(table: string, col: string): Promise<boolean> {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS c FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, col],
  );
  return Number((rows as { c: number }[])[0]?.c ?? 0) > 0;
}

// 1) 四角色席位
await conn.query(`CREATE TABLE IF NOT EXISTS st_panda_members (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  factory_id BIGINT UNSIGNED NULL COMMENT 'NULL=平台级席位',
  role VARCHAR(8) NOT NULL COMMENT 'co指挥官/ex执行者/va监察者/ev学习者',
  ref_type VARCHAR(16) NOT NULL COMMENT 'agent/staff/admin/model/kernel',
  ref_key VARCHAR(64) NOT NULL,
  dept_key VARCHAR(32) NULL,
  duty VARCHAR(200) NOT NULL DEFAULT '',
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_seat (factory_id, role, ref_key),
  KEY idx_role (role),
  KEY idx_factory (factory_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
console.log("st_panda_members ensured");

// 2) 操作单分级审批列
for (const [col, ddl] of [
  ["approval_level", `ALTER TABLE st_claw_operations ADD COLUMN approval_level VARCHAR(16) NOT NULL DEFAULT 'l2_tenant' AFTER risk`],
  ["approved_by", `ALTER TABLE st_claw_operations ADD COLUMN approved_by VARCHAR(64) NULL AFTER approval_level`],
  ["approved_at", `ALTER TABLE st_claw_operations ADD COLUMN approved_at DATETIME NULL AFTER approved_by`],
  ["factory_id", `ALTER TABLE st_claw_operations ADD COLUMN factory_id BIGINT UNSIGNED NULL AFTER approved_at`],
] as const) {
  if (!(await hasColumn("st_claw_operations", col))) {
    await conn.query(ddl);
    console.log(`st_claw_operations.${col} added`);
  } else console.log(`st_claw_operations.${col} exists`);
}

// 3) 平台级默认四席位（幂等）
const seats = [
  ["co", "model", "kimi-k3", "平台指挥官：任务分解、派单与仲裁"],
  ["ex", "kernel", "lobster-main", "平台执行者：龙虾内核浏览器/工具执行"],
  ["va", "model", "glm-5v-turbo", "平台监察者：过程巡检与证据核验"],
  ["ev", "kernel", "evo-engine", "平台学习者：每周进化报告与自愈"],
] as const;
for (const [role, refType, refKey, duty] of seats) {
  await conn.query(
    `INSERT IGNORE INTO st_panda_members (factory_id, role, ref_type, ref_key, duty) VALUES (NULL, ?, ?, ?, ?)`,
    [role, refType, refKey, duty],
  );
}
console.log("platform seats ensured");

await conn.end();
