/**
 * 管理台扫码共享面：与 wb 同库同表，DDL 对齐 canonical st_qr_sessions；
 * wb_token_enc 是共享表历史列名，target='admin_console' 时内容明确为管理 token，不另造同义列。
 */
import { rateIpDigest } from "../lib/clientIp";
import { sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { rawRows, logQueryErrorThrottled } from "../queries/rawRows";
import { isDupColumn, hasCauseChainMatch } from "../lib/dupEntry";

let qrReady: Promise<void> | null = null;
export const QR_TTL_MIN = 5;

export function ensureQrSessions(): Promise<void> {
  if (!qrReady) {
    qrReady = getDb()
      .execute(sql`CREATE TABLE IF NOT EXISTS st_qr_sessions (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        session VARCHAR(32) NOT NULL,
        target VARCHAR(16) NOT NULL,
        state VARCHAR(16) NOT NULL DEFAULT 'pending',
        user_id BIGINT NULL,
        wb_token_hash VARCHAR(64) NULL,
        wb_token_enc TEXT NULL,
        wb_expires_at DATETIME NULL,
        client_ip VARCHAR(64) NULL,
        poll_secret_hash VARCHAR(64) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        confirmed_at DATETIME NULL,
        UNIQUE KEY uq_session (session),
        KEY idx_state_created (state, created_at),
        KEY idx_wb_hash (wb_token_hash),
        KEY idx_ip_created (client_ip, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      .then(async () => {
        await getDb().execute(sql`ALTER TABLE st_qr_sessions ADD COLUMN user_id BIGINT NULL`).catch((e: unknown) => { if (!isDupColumn(e)) throw e; });
        await getDb().execute(sql`ALTER TABLE st_qr_sessions ADD COLUMN wb_expires_at DATETIME NULL`).catch((e: unknown) => { if (!isDupColumn(e)) throw e; });
        await getDb().execute(sql`ALTER TABLE st_qr_sessions ADD COLUMN wb_token_enc TEXT NULL`).catch((e: unknown) => { if (!isDupColumn(e)) throw e; });
        await getDb().execute(sql`ALTER TABLE st_qr_sessions ADD COLUMN poll_secret_hash VARCHAR(64) NULL`).catch((e: unknown) => { if (!isDupColumn(e)) throw e; });
        await getDb().execute(sql`ALTER TABLE st_qr_sessions ADD COLUMN client_ip VARCHAR(64) NULL`).catch((e: unknown) => { if (!isDupColumn(e)) throw e; });
        await getDb().execute(sql`ALTER TABLE st_qr_sessions ADD COLUMN confirmed_at DATETIME NULL`).catch((e: unknown) => { if (!isDupColumn(e)) throw e; });
        await getDb().execute(sql`ALTER TABLE st_qr_sessions ADD COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP`).catch((e: unknown) => { if (!isDupColumn(e)) throw e; });
        await getDb().execute(sql`CREATE TABLE IF NOT EXISTS st_qr_rate (
          ip VARCHAR(64) NOT NULL, bucket_min VARCHAR(16) NOT NULL, n INT NOT NULL DEFAULT 0,
          PRIMARY KEY (ip, bucket_min),
          KEY idx_bucket_min (bucket_min)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
        const rateIndexRows = rawRows(await getDb().execute(sql`SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'st_qr_rate' AND INDEX_NAME = 'idx_bucket_min'`));
        if (rateIndexRows.length === 0) {
          await getDb().execute(sql`ALTER TABLE st_qr_rate ADD INDEX idx_bucket_min (bucket_min)`)
            .catch((e: unknown) => { if (!hasCauseChainMatch(e, { errno: 1061 })) throw e; });
        }
      })
      .then(() => undefined)
      .catch((e) => { qrReady = null; throw e; });
  }
  return qrReady;
}

export function adminQrExpiresAt(createdAt: Date | string | number): number {
  const ms = createdAt instanceof Date ? createdAt.getTime() : new Date(createdAt).getTime();
  if (!Number.isFinite(ms)) throw new Error("QR created_at 无效");
  return ms + QR_TTL_MIN * 60_000;
}

export function qrMinuteBucket(offsetMin = 0): string {
  return new Date(Date.now() + offsetMin * 60_000).toISOString().slice(0, 16);
}

/** 事务内自增并读回，避免连接池跨连接读到他人计数。 */
export async function bumpQrRate(db: ReturnType<typeof getDb>, key: string, bucket: string): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`INSERT INTO st_qr_rate (ip, bucket_min, n) VALUES (${key}, ${bucket}, 1) ON DUPLICATE KEY UPDATE n = n + 1`);
    const rows = rawRows(await tx.execute(sql`SELECT n FROM st_qr_rate WHERE ip=${key} AND bucket_min=${bucket} LIMIT 1`));
    const n = Number(rows[0]?.n);
    if (rows.length !== 1 || !Number.isSafeInteger(n) || n < 1) throw new Error("QR 限流计数读回异常——按不可用拒绝放行");
    return n;
  });
}

function rateKey(action: string, ip: string): string {
  return `admin-qr:${action}:${rateIpDigest(ip).slice(0, 24)}`;
}

/** true=放行；IP 桶与动作全局桶都限频，键不保存原始 IP。 */
export async function adminQrRateOk(db: ReturnType<typeof getDb>, action: "open" | "confirm" | "status" | "image", ip: string, ipCap: number, globalCap: number): Promise<boolean> {
  const bucket = qrMinuteBucket();
  if (await bumpQrRate(db, rateKey(action, ip), bucket) > ipCap) return false;
  return (await bumpQrRate(db, `admin-qr:${action}:global`, bucket)) <= globalCap;
}

/** 只清理管理台自己的会话，绝不提前删除 wb 消费行（其 token 验真轨需活满 24h）。 */
export async function cleanupAdminQr(db: ReturnType<typeof getDb>): Promise<void> {
  // created_at 由 Node 写入， cutoff 也由 Node 计算；不再混用 MySQL NOW() 造成时区秒杀或延迟销密。
  const ttlCutoff = new Date(Date.now() - QR_TTL_MIN * 60_000);
  const dayCutoff = new Date(Date.now() - 24 * 3_600_000);
  await db.execute(sql`UPDATE st_qr_sessions SET state='expired', wb_token_enc=NULL WHERE target='admin_console' AND state IN ('pending','confirmed') AND created_at < ${ttlCutoff}`)
    .catch((e) => logQueryErrorThrottled("[adminQr] 过期会话密文清理失败", e));
  await db.execute(sql`DELETE FROM st_qr_sessions WHERE target='admin_console' AND created_at < ${dayCutoff} LIMIT 200`)
    .catch((e) => logQueryErrorThrottled("[adminQr] 历史会话清理失败", e));
  // 只收管理台自己的分钟桶；packages 的小时桶/其他业务桶即使字典序更小也不得被误删。
  await db.execute(sql`DELETE FROM st_qr_rate WHERE bucket_min < ${qrMinuteBucket(-10)} AND ip LIKE 'admin-qr:%' LIMIT 500`)
    .catch((e) => logQueryErrorThrottled("[adminQr] 限流桶清理失败", e));
}

let lastCleanupAt = 0;
export async function cleanupAdminQrThrottled(db: ReturnType<typeof getDb>): Promise<void> {
  const now = Date.now();
  if (now - lastCleanupAt < 60_000) return;
  lastCleanupAt = now;
  await cleanupAdminQr(db);
}

// 真正的后台清理：用户出码后关页，密文也会在 TTL 后被销毁；unref 不拖住进程退出。
const cleanupTimer = setInterval(() => {
  void cleanupAdminQr(getDb()).catch((e) => logQueryErrorThrottled("[adminQr] 后台清理失败", e));
}, 60_000);
cleanupTimer.unref();
