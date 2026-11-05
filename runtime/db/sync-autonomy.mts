/**
 * sync-autonomy：自治四口落库（2026-08-26）。
 * st_authorization_tiers：G1 授权分级字典（与 api/harness/autonomy.ts ACTION_TIERS 同源镜像，
 * 供驾驶舱/审计查询；执行侧以代码常量为准，此表是台账不是开关）。
 */
import mysql from "mysql2/promise";

const url = process.argv[2] ?? (() => { throw new Error("必须显式传库 URL"); })();
const conn = await mysql.createConnection(url);

await conn.query(`CREATE TABLE IF NOT EXISTS st_authorization_tiers (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  action_key VARCHAR(64) NOT NULL UNIQUE COMMENT '动作（支持前缀通配 *）',
  tier VARCHAR(4) NOT NULL COMMENT 'L0只读自动/L1低风险自动+报备/L2双签/L3永远人工',
  note VARCHAR(255) NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='授权分级表（自治边界台账）'`);

const SEED: [string, string, string][] = [
  ["probe:read", "L0", "探针读环相位"],
  ["report:emit", "L1", "汇报总线发报"],
  ["memory:capture", "L1", "记忆回写"],
  ["queue_construct", "L2", "输送带立项（双签）"],
  ["auto_verify", "L2", "自动验证"],
  ["eligible_deploy", "L3", "发布永远人工"],
  ["auto_rollback", "L3", "回滚永远人工拍板"],
  ["billing:*", "L3", "资金类永远人工"],
  ["data:export", "L3", "数据导出永远人工"],
  ["comms:external", "L3", "对外发声永远人工"],
];
for (const [k, t, n] of SEED) {
  await conn.query(
    `INSERT INTO st_authorization_tiers (action_key, tier, note) VALUES (?,?,?) ON DUPLICATE KEY UPDATE tier=VALUES(tier), note=VALUES(note)`,
    [k, t, n],
  );
}
console.log("st_authorization_tiers: ready,", SEED.length, "tiers");
await conn.end();
console.log("sync-autonomy: done");
