// iter100 M2 迁移：组织中枢·织网 —— 协议评审记录/授权链级联/设备预演工单
// 运行（在 /opt/nebula/app）：set -a && . ./.env && set +a && npx tsx db/sync-iter100-m2.mts
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL missing");
const conn = await mysql.createConnection(url);

// 1. 协议评审记录（draft→reviewing→active/rejected 全程留痕）
await conn.query(`CREATE TABLE IF NOT EXISTS st_protocol_reviews (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  protocol_code VARCHAR(48) NOT NULL,
  action VARCHAR(16) NOT NULL COMMENT 'draft/submit/approve/reject/deprecate',
  reviewer VARCHAR(64) NOT NULL,
  comment VARCHAR(512) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_protocol (protocol_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
console.log("st_protocol_reviews: ok");

// 2. 授权链级联：parent_id + depth（幂等加列）
async function ensureColumn(table: string, column: string, ddl: string) {
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  if ((rows as unknown[]).length === 0) {
    await conn.query(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    console.log(`${table}.${column}: added`);
  } else {
    console.log(`${table}.${column}: exists`);
  }
}
await ensureColumn("st_auth_chains", "parent_id", "parent_id BIGINT NULL COMMENT '上级链 id（级联吊销）' AFTER factory_id");
await ensureColumn("st_auth_chains", "depth", "depth INT NOT NULL DEFAULT 0 COMMENT '0=owner直签' AFTER parent_id");
await conn.query(`ALTER TABLE st_auth_chains ADD KEY idx_parent (parent_id)`).catch(() => console.log("idx_parent: exists"));

// 3. 设备预演工单（device_rehearsal 协议落点）
await conn.query(`CREATE TABLE IF NOT EXISTS st_device_rehearsals (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  factory_id BIGINT NOT NULL,
  intent_id BIGINT NOT NULL,
  ticket_id BIGINT NOT NULL,
  device_name VARCHAR(128) NOT NULL,
  script TEXT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'done' COMMENT 'done/cancelled(undo作废)',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cancelled_at DATETIME NULL,
  KEY idx_factory (factory_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
console.log("st_device_rehearsals: ok");

// 4. device_rehearsal 以 draft 播种——必须走 M2-1 评审流上线（自证评审流）
await conn.query(
  `INSERT INTO st_protocols (code, name, level, script, status, reviewed_by)
   VALUES ('device_rehearsal', '设备预演工单', 'B',
           '步骤：校验设备与剧本→生成预演工单；逆操作：作废工单',
           'draft', NULL)
   ON DUPLICATE KEY UPDATE code=code`,
);
console.log("protocol: device_rehearsal (B, draft 待评审)");

console.log("SYNC-ITER100-M2-PASS");
await conn.end();
