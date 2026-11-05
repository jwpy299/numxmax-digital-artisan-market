import mysql from 'mysql2/promise'
import { AGENT_TEST_DATABASE_PREFIX } from '../api/lib/agentEconomy'
const url = process.argv[2] ?? process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL required')
const conn = await mysql.createConnection(url)
const [rows] = await conn.query<mysql.RowDataPacket[]>('SELECT DATABASE() AS name')
if (!String(rows[0]?.name ?? '').startsWith(AGENT_TEST_DATABASE_PREFIX)) throw new Error('AGENT_PLUGIN_PAYMENTS_TEST_DATABASE_REQUIRED')
const ensureColumn = async (table: string, column: string, definition: string) => {
  const [columns] = await conn.query<mysql.RowDataPacket[]>('SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND column_name=?', [table, column])
  if (columns.length === 0) await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`)
}
await ensureColumn('st_agent_plugin_packages', 'price_cents', "INT NOT NULL DEFAULT 0 COMMENT '订阅价格（分），服务端定价，不接受客户端金额' AFTER description")
await ensureColumn('st_agent_plugin_packages', 'duration_days', "INT NOT NULL DEFAULT 30 COMMENT '订阅有效天数' AFTER price_cents")
await ensureColumn('st_agent_plugin_entitlements', 'payment_order_no', 'VARCHAR(64) NULL AFTER factory_id')
await conn.query(`CREATE TABLE IF NOT EXISTS st_agent_plugin_payment_orders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_no VARCHAR(64) NOT NULL,
  registration_id BIGINT UNSIGNED NOT NULL,
  package_id BIGINT UNSIGNED NOT NULL,
  factory_id BIGINT UNSIGNED NOT NULL,
  amount_cents INT NOT NULL,
  duration_days INT NOT NULL,
  channel VARCHAR(16) NOT NULL DEFAULT 'wechat',
  status VARCHAR(24) NOT NULL DEFAULT 'pending',
  out_trade_no VARCHAR(64) NOT NULL,
  prepay_id VARCHAR(64) NULL,
  code_url TEXT NULL,
  transaction_id VARCHAR(64) NULL,
  paid_at DATETIME NULL,
  refunded_at DATETIME NULL,
  expires_at DATETIME NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_agent_plugin_payment_order_no (order_no),
  UNIQUE KEY uk_agent_plugin_payment_trade_no (out_trade_no),
  UNIQUE KEY uk_agent_plugin_payment_idem (idempotency_key),
  KEY idx_agent_plugin_payment_owner (registration_id, factory_id, status),
  KEY idx_agent_plugin_payment_transaction (transaction_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='插件订阅支付订单，绑定Agent/插件/企业/金额/期限'`)
await conn.query(`CREATE TABLE IF NOT EXISTS st_agent_plugin_payment_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  event_id VARCHAR(128) NOT NULL,
  order_id BIGINT UNSIGNED NOT NULL,
  event_type VARCHAR(32) NOT NULL,
  transaction_id VARCHAR(64) NULL,
  payload_sha256 CHAR(64) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_agent_plugin_payment_event (event_id),
  KEY idx_agent_plugin_payment_event_order (order_id, event_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='插件支付回调与对账幂等事件'`)
console.log('agent plugin payment schema ready (additive test-only)')
await conn.end()
