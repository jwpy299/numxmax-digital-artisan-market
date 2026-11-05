/**
 * 沙箱测试数据清理（iter86）：删除所有 TEST_ 前缀企业及级联数据。
 * 安全：仅动 TEST_ 范围；先 SELECT 展示将删内容，需环境变量 CONFIRM_SANDBOX_CLEAN=YES 才真删。
 */
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL missing");
const confirm = process.env.CONFIRM_SANDBOX_CLEAN === "YES";
const conn = await mysql.createConnection(url);

const [factories] = await conn.query(
  "SELECT id, enterpriseName FROM wb_factories WHERE enterpriseName LIKE 'TEST\\_%'");
const fids = (factories as any[]).map((f) => f.id);
console.log("将清理企业:", JSON.stringify(factories));
if (fids.length === 0) { console.log("nothing-to-clean"); await conn.end(); process.exit(0); }

if (!confirm) {
  console.log("DRY-RUN：加 CONFIRM_SANDBOX_CLEAN=YES 才执行删除");
  await conn.end();
  process.exit(0);
}

const ph = fids.map(() => "?").join(",");
// 级联清理常见按 factoryId 作用域的运行表（存在的才删）
const [tables] = await conn.query(
  "SELECT TABLE_NAME t, COLUMN_NAME c FROM information_schema.columns WHERE table_schema=DATABASE() AND COLUMN_NAME IN ('factoryId','factory_id')");
let total = 0;
for (const row of tables as any[]) {
  const col = row.c;
  try {
    const [r] = await conn.query(`DELETE FROM \`${row.t}\` WHERE \`${col}\` IN (${ph})`, fids);
    const n = (r as any).affectedRows ?? 0;
    if (n > 0) { console.log(`  ${row.t}.${col}: -${n}`); total += n; }
  } catch { /* 列类型不匹配等跳过 */ }
}
const [ru] = await conn.query("DELETE FROM wb_users WHERE username LIKE 'TEST\\_%'");
console.log(`  wb_users: -${(ru as any).affectedRows}`);
const [rf] = await conn.query("DELETE FROM wb_factories WHERE enterpriseName LIKE 'TEST\\_%'");
console.log(`  wb_factories: -${(rf as any).affectedRows}`);
console.log(`SANDBOX-CLEAN-PASS total≈${total}`);
await conn.end();
