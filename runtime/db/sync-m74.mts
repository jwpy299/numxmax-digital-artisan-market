// M77b 迁移：st_evo_proposals 枚举扩值 —— 修复 M71 潜伏雷。
// 实锤经过：M71/M77 点火器立项写 target_type='signal' + proposal_type='investigate'，
// 但生产表 enum 不含这两个值（target_type: skill/agent/knowledge/ops；
// proposal_type: optimize/new_skill/retire）——上线以来 clusters 从未真达阈，
// 首火 created:0 没踩到；M77 共鸣验证首次真 INSERT 即报错。
// 本迁移 additive 扩枚举（存量行零影响，NOT NULL/Default 保持原样）：
//   target_type  += 'signal'
//   proposal_type += 'investigate'
// 幂等：SHOW COLUMNS 检测现值，含目标值则跳过。
// 运行（在 /opt/nebula/app）：set -a && . ./.env && set +a && npx tsx db/sync-m74.mts
// 语法自检：DRY_RUN=1 npx tsx db/sync-m74.mts（不连库，直接退出）
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

/** enum 扩值（additive，幂等）：已含目标值则跳过 */
async function ensureEnumValue(column: string, value: string, ddl: string) {
  const [rows] = await conn.query(
    `SHOW COLUMNS FROM st_evo_proposals LIKE ?`,
    [column],
  );
  const type = String((rows as Array<{ Type: string }>)[0]?.Type ?? "");
  if (type.includes(`'${value}'`)) {
    console.log(`st_evo_proposals.${column} '${value}': exists`);
    return;
  }
  await conn.query(ddl);
  console.log(`st_evo_proposals.${column} '${value}': added`);
}

await ensureEnumValue(
  "target_type",
  "signal",
  "ALTER TABLE st_evo_proposals MODIFY COLUMN target_type ENUM('skill','agent','knowledge','ops','signal') NOT NULL",
);
await ensureEnumValue(
  "proposal_type",
  "investigate",
  "ALTER TABLE st_evo_proposals MODIFY COLUMN proposal_type ENUM('optimize','new_skill','retire','investigate') NOT NULL DEFAULT 'optimize'",
);
await ensureEnumValue(
  "source",
  "auto-event",
  "ALTER TABLE st_evo_proposals MODIFY COLUMN \`source\` ENUM('auto','llm','auto-event') NOT NULL DEFAULT 'auto'",
);

await conn.end();
console.log("sync-m74 done");
