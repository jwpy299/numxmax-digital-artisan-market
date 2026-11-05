/** 内测资格码表 DDL/ensure 单源：sha256 不落明文；kind 迁移纪律不变；企业名与吊销状态独立留痕。 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb, createDbFromConnection } from "../queries/connection";
import { isDupColumn, hasCauseChainMatch } from "../lib/dupEntry";
import { BETA_KINDS } from "@contracts/betaKinds";
import { rawRows } from "./terminalShared";
import { withNamedDbConnection } from "../lib/dbLock";

export const KIND_COL_DEF = "kind VARCHAR(16) NULL";
export const ENTERPRISE_NAME_COL_DEF = "enterprise_name VARCHAR(128) NOT NULL DEFAULT ''";
export const REVOKED_AT_COL_DEF = "revoked_at DATETIME NULL";
type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

let ready: Promise<void> | null = null;
export function ensureBetaInvites(): Promise<void> {
  if (!ready) {
    ready = getDb()
      .execute(sql`CREATE TABLE IF NOT EXISTS st_beta_invites (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        phone VARCHAR(32) NOT NULL, codeHash CHAR(64) NOT NULL,
        ${sql.raw(KIND_COL_DEF)},
        ${sql.raw(ENTERPRISE_NAME_COL_DEF)},
        expires_at DATETIME NOT NULL, consumed_at DATETIME NULL,
        ${sql.raw(REVOKED_AT_COL_DEF)},
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_codehash (codeHash), KEY idx_phone (phone), KEY idx_phone_created (phone, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      .then(async () => {
        const columnRows = rawRows(await getDb().execute(sql`SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'st_beta_invites' AND COLUMN_NAME IN ('kind', 'enterprise_name', 'revoked_at')`)) as Array<{ COLUMN_NAME?: string }>;
        const columns = new Set(columnRows.map((r) => r.COLUMN_NAME));
        for (const [columnName, definition, after] of [
          ["kind", KIND_COL_DEF, "codeHash"],
          ["enterprise_name", ENTERPRISE_NAME_COL_DEF, "kind"],
          ["revoked_at", REVOKED_AT_COL_DEF, "consumed_at"],
        ] as const) {
          if (!columns.has(columnName)) {
            await getDb().execute(sql`ALTER TABLE st_beta_invites ADD COLUMN ${sql.raw(definition)} AFTER ${sql.raw(after)}`)
              .catch((e: unknown) => { if (!isDupColumn(e)) throw e; });
          }
        }
        const indexRows = rawRows(await getDb().execute(sql`SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'st_beta_invites' AND INDEX_NAME = 'idx_phone_created'`));
        if (indexRows.length === 0) {
          await getDb().execute(sql`ALTER TABLE st_beta_invites ADD INDEX idx_phone_created (phone, created_at)`)
            .catch((e: unknown) => { if (!hasCauseChainMatch(e, { errno: 1061 })) throw e; });
        }
        await getDb().execute(sql`UPDATE st_beta_invites SET kind = ${BETA_KINDS[0]} WHERE kind IS NULL`);
      })
      .then(() => undefined)
      .catch((e) => { ready = null; throw e; });
  }
  return ready;
}

/** 每日口令兑换与管理台定向签发共用一把数据库命名锁；专用连接持锁并跑事务（每进程每锁4/全局16，须计入 max_connections 预算），COMMIT/ROLLBACK 后才释放。 */
export async function withBetaInvitePhoneLock<T>(phone: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  await ensureBetaInvites();
  const lockName = `beta-invite:${createHash("sha256").update(phone).digest("hex").slice(0, 40)}`;
  return withNamedDbConnection(
    lockName,
    (conn) => createDbFromConnection(conn).transaction(fn),
    { busyMessage: "该手机号正在签发邀测码——请稍后重试", unavailableMessage: "签发锁暂不可用——稍后重试" },
  );
}
