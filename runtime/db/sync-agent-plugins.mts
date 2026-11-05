import mysql from 'mysql2/promise'
import { AGENT_TEST_DATABASE_PREFIX } from '../api/lib/agentEconomy'
const url=process.argv[2] ?? process.env.DATABASE_URL
if(!url) throw new Error('DATABASE_URL required')
const conn=await mysql.createConnection(url)
const [rows]=await conn.query<mysql.RowDataPacket[]>('SELECT DATABASE() AS name')
if(!String(rows[0]?.name??'').startsWith(AGENT_TEST_DATABASE_PREFIX)) throw new Error('AGENT_PLUGINS_TEST_DATABASE_REQUIRED')
await conn.query(`CREATE TABLE IF NOT EXISTS st_agent_plugin_packages (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 package_key VARCHAR(64) NOT NULL, name VARCHAR(80) NOT NULL, version VARCHAR(32) NOT NULL,
 description VARCHAR(500) NULL, manifest_json JSON NOT NULL, artifact_sha256 CHAR(64) NOT NULL,
 signature TEXT NOT NULL, signer_public_key TEXT NOT NULL, artifact_blob LONGBLOB NOT NULL,
 status VARCHAR(16) NOT NULL DEFAULT 'active', created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE KEY uk_agent_plugin_package_version (package_key, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
await conn.query(`CREATE TABLE IF NOT EXISTS st_agent_plugin_entitlements (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 registration_id BIGINT UNSIGNED NOT NULL, package_id BIGINT UNSIGNED NOT NULL,
 factory_id BIGINT UNSIGNED NULL,
 status VARCHAR(16) NOT NULL DEFAULT 'active', expires_at DATETIME NULL,
 created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE KEY uk_agent_plugin_entitlement (registration_id, package_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
await conn.query(`CREATE TABLE IF NOT EXISTS st_agent_plugin_installs (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 registration_id BIGINT UNSIGNED NOT NULL, package_id BIGINT UNSIGNED NOT NULL, version VARCHAR(32) NOT NULL,
 factory_id BIGINT UNSIGNED NULL,
 status VARCHAR(16) NOT NULL, install_ticket VARCHAR(80) NOT NULL UNIQUE,
 rollback_of BIGINT UNSIGNED NULL, installed_at DATETIME NULL, uninstalled_at DATETIME NULL,
 last_readback_at DATETIME NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 KEY idx_agent_plugin_install_owner (registration_id, package_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
const ensureColumn = async (table: string, column: string, definition: string) => {
  const [columns] = await conn.query<mysql.RowDataPacket[]>('SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND column_name=?', [table, column])
  if (columns.length === 0) await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`)
}
await ensureColumn('st_agent_plugin_entitlements', 'factory_id', 'BIGINT UNSIGNED NULL AFTER package_id')
await ensureColumn('st_agent_plugin_installs', 'factory_id', 'BIGINT UNSIGNED NULL AFTER package_id')
console.log('agent plugin schema ready (additive test-only)')
await conn.end()
