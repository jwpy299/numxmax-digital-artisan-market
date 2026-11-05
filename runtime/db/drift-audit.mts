// 生产 TiDB schema 漂移审计（只读）+ 增量 ALTER 生成（APPLY=1 才执行）
// 用法: tsx drift-audit.mts <env文件路径> [APPLY=1]
// 口径: 只增不删不改 —— 缺表 CREATE、缺列 ADD；已存在列绝不 DROP/MODIFY（原来系统的功能不变）
import mysql from "mysql2/promise";
import { getTableConfig, type MySqlTable } from "drizzle-orm/mysql-core";
import { readFileSync } from "node:fs";
import * as schema from "./schema";

const envPath = process.argv[2];
if (!envPath) throw new Error("usage: tsx drift-audit.mts <envFile> [APPLY=1]");
const APPLY = process.argv[3] === "APPLY=1" || process.env.APPLY === "1";

const url = readFileSync(envPath, "utf8")
  .split(/\r?\n/)
  .find((l) => l.startsWith("DATABASE_URL="))
  ?.slice("DATABASE_URL=".length)
  .trim()
  .replace(/^"|"$/g, "");
if (!url) throw new Error("DATABASE_URL not found in " + envPath);

// drizzle 列 → DDL 片段
function colDdl(col: any, forCreate = false): string {
  let t = col.getSQLType();
  // drizzle boolean → tinyint(1)；TiDB 侧 boolean 是别名，统一落成 tinyint(1)
  if (t === "boolean") t = "tinyint(1)";
  let ddl = `\`${col.name}\` ${t}`;
  if (col.autoIncrement) {
    ddl += " NOT NULL AUTO_INCREMENT";
  } else if (col.notNull) {
    ddl += " NOT NULL";
    if (col.default !== undefined) {
      const d = col.default;
      ddl += typeof d === "number" || typeof d === "boolean" ? ` DEFAULT ${Number(d)}` : ` DEFAULT '${String(d).replace(/'/g, "''")}'`;
    } else if (col.hasDefault) {
      // defaultNow() 等运行时默认
      if (/^(timestamp|datetime)/i.test(t)) ddl += " DEFAULT CURRENT_TIMESTAMP";
      else if (!forCreate) throw new Error(`NOT NULL 列 ${col.name}(${t}) 无静态默认值，需人工评审`);
    } else if (!forCreate) {
      // 存量表加列必须有默认值（老行要回填）；建新表则应用层必传，可裸 NOT NULL
      throw new Error(`NOT NULL 列 ${col.name}(${t}) 无默认值，需人工评审`);
    }
  } else if (col.hasDefault && /^(timestamp|datetime)/i.test(t)) {
    ddl += " DEFAULT CURRENT_TIMESTAMP";
  }
  return ddl;
}

const conn = await mysql.createConnection(url);
const [dbRow] = await conn.query<any[]>("SELECT DATABASE() AS db");
console.log("target db:", dbRow[0].db, "| APPLY:", APPLY);

const [existingTables] = await conn.query<any[]>("SHOW TABLES");
const tableSet = new Set(existingTables.map((r) => Object.values(r)[0] as string));

const alters: string[] = [];
let missingTables = 0;
let missingCols = 0;

for (const [exportName, val] of Object.entries(schema)) {
  if (!val || typeof val !== "object" || !(val as any)[Symbol.for("drizzle:IsDrizzleTable")]) continue;
  const cfg = getTableConfig(val as MySqlTable);
  if (!tableSet.has(cfg.name)) {
    missingTables++;
    console.log(`MISSING_TABLE ${cfg.name} (export ${exportName}, ${cfg.columns.length} cols)`);
    const body = cfg.columns.map((c) => colDdl(c, true));
    const pkCols = cfg.columns.filter((c: any) => c.primary).map((c) => `\`${c.name}\``);
    if (pkCols.length) body.push(`PRIMARY KEY (${pkCols.join(",")})`);
    alters.push(`CREATE TABLE \`${cfg.name}\` (\n  ${body.join(",\n  ")}\n)`);
    continue;
  }
  const [cols] = await conn.query<any[]>(`SHOW COLUMNS FROM \`${cfg.name}\``);
  const have = new Set(cols.map((c) => c.Field as string));
  for (const c of cfg.columns) {
    if (!have.has(c.name)) {
      missingCols++;
      const ddl = colDdl(c);
      console.log(`MISSING_COL ${cfg.name}.${c.name} -> ${ddl}`);
      alters.push(`ALTER TABLE \`${cfg.name}\` ADD COLUMN ${ddl}`);
    }
  }
}

console.log(`\nSUMMARY missingTables=${missingTables} missingCols=${missingCols} stmts=${alters.length}`);

if (APPLY && alters.length) {
  for (const s of alters) {
    console.log("APPLY>", s.replace(/\n/g, " "));
    await conn.query(s);
  }
  console.log("APPLY_DONE");
  // 复核: 再扫一遍必须全 0
  const [[wb]] = await conn.query<any[]>("SHOW COLUMNS FROM wb_users");
  const names = new Set(wb.map((c: any) => c.Field));
  console.log("VERIFY wb_users invitedBy:", names.has("invitedBy"), "activatedAt:", names.has("activatedAt"));
}
await conn.end();
