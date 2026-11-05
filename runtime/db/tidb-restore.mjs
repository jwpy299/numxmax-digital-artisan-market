// TiDB 分表恢复器：按表切片 dump，逐表独立连接灌入，断线重试，幂等可续跑
// 用法: node tidb-restore.mjs <dump.sql.gz> <env文件> [只恢复这些表,逗号分隔]
import mysql from "mysql2/promise";
import { createReadStream, readFileSync, existsSync, writeFileSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";

const [dumpPath, envPath, onlyArg] = process.argv.slice(2);
if (!dumpPath || !envPath) throw new Error("usage: node tidb-restore.mjs <dump.gz> <envFile> [tablesCSV]");
const only = onlyArg ? new Set(onlyArg.split(",")) : null;
const PROGRESS = "/mnt/agents/output/migration/tidb-restore-progress.json";

const url = readFileSync(envPath, "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="))?.slice(13).trim().replace(/^"|"$/g, "");
if (!url) throw new Error("DATABASE_URL not found");

// ── 1) 按表切片（mysqldump 顺序结构：DROP TABLE IF EXISTS `t` ... 到下一个 DROP 前）
console.log("== 切片 dump ==");
const chunks = new Map(); // table -> string[]
let cur = null;
const rl = createInterface({ input: createReadStream(dumpPath).pipe(createGunzip()), crlfDelay: Infinity });
for await (const line of rl) {
  const m = line.match(/^DROP TABLE IF EXISTS `([^`]+)`;/) || line.match(/^CREATE TABLE `([^`]+)`/) || line.match(/^LOCK TABLES `([^`]+)` WRITE/);
  if (m) cur = m[1];
  if (cur) {
    if (!chunks.has(cur)) chunks.set(cur, []);
    chunks.get(cur).push(line);
  }
}
console.log(`切片完成: ${chunks.size} 表`);

// ── 2) 逐表恢复
const done = new Set(existsSync(PROGRESS) ? JSON.parse(readFileSync(PROGRESS, "utf8")) : []);
const save = () => writeFileSync(PROGRESS, JSON.stringify([...done]));
let ok = 0, skip = 0, fail = 0;

for (const [table, lines] of chunks) {
  if (only && !only.has(table)) { skip++; continue; }
  if (done.has(table)) { skip++; continue; }
  const sqlText = lines.join("\n")
    // TiDB serverless: 去掉 LOCK/UNLOCK（serverless 对 LOCK TABLES 支持受限且单连接无意义）
    .replace(/^LOCK TABLES .* WRITE;$/gm, "").replace(/^UNLOCK TABLES;$/gm, "")
    // 去掉 ALTER ... DISABLE/ENABLE KEYS（MyISAM 遗留语法）
    .replace(/^ALTER TABLE `[^`]+` (DISABLE|ENABLE) KEYS;$/gm, "")
    // dump 尾部的 SET 还原语句在单表连接里没有 @OLD 上下文，必须剥掉
    .replace(/^\/\*!\d+ SET (FOREIGN_KEY_CHECKS|UNIQUE_CHECKS|SQL_MODE|TIME_ZONE|CHARACTER_SET_CLIENT|COLLATION_CONNECTION|SQL_NOTES)=.*\*\/;?$/gm, "");
  let attempt = 0;
  for (;;) {
    attempt++;
    let conn;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await conn.query("SET SESSION foreign_key_checks = 0");
      await conn.query(sqlText);
      await conn.end();
      done.add(table); save(); ok++;
      console.log(`OK ${table} (${lines.length} lines, attempt ${attempt})`);
      break;
    } catch (e) {
      try { await conn?.end(); } catch {}
      if (attempt >= 5) { fail++; console.log(`FAIL ${table} after ${attempt}: ${e.code} ${String(e.message).slice(0, 160)}`); break; }
      console.log(`RETRY ${table} attempt ${attempt}: ${e.code} ${String(e.message).slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}
console.log(`== DONE ok=${ok} skip=${skip} fail=${fail} ==`);
process.exit(fail ? 1 : 0);
