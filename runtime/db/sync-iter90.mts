// iter90 迁移：企业注册接入国家企业信用信息公示系统核验 —— wb_factories 加核验列
//   verifyStatus VARCHAR(24) NOT NULL DEFAULT 'unverified'  （unverified/verified/pending_manual/mismatch）
//   verifiedAt   DATETIME NULL
//   verifyPayload JSON NULL
// 幂等：逐列检查 information_schema，存在则跳过，可连跑多次。
// 运行：set -a && . ./.env && set +a && npx tsx db/sync-iter90.mts
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL missing");
const conn = await mysql.createConnection(url);

async function hasColumn(name: string): Promise<boolean> {
  const [rows] = await conn.query(
    `SELECT column_name AS c FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'wb_factories' AND column_name = ?`,
    [name],
  );
  return (rows as { c: string }[]).length > 0;
}

const alters: [string, string][] = [
  ["verifyStatus", "ADD COLUMN verifyStatus VARCHAR(24) NOT NULL DEFAULT 'unverified'"],
  ["verifiedAt", "ADD COLUMN verifiedAt DATETIME NULL"],
  ["verifyPayload", "ADD COLUMN verifyPayload JSON NULL"],
];

for (const [col, ddl] of alters) {
  if (await hasColumn(col)) {
    console.log(`wb_factories.${col} exists, skip`);
  } else {
    await conn.query(`ALTER TABLE wb_factories ${ddl}`);
    console.log(`wb_factories.${col} added`);
  }
}

// 自检：三列就绪
const [cols] = await conn.query(
  `SELECT column_name AS c FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'wb_factories'`,
);
const names = (cols as { c: string }[]).map((r) => r.c);
const need = ["verifyStatus", "verifiedAt", "verifyPayload"];
if (!need.every((n) => names.includes(n))) {
  throw new Error(`wb_factories verify columns mismatch: ${names.join(",")}`);
}

await conn.end();
console.log("SYNC-ITER90-PASS");
