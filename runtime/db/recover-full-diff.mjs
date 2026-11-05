// 全表对账：旧库(3307) vs TiDB —— 行数 + 最新行时间，判定 TiDB 是否有割接后新写入
import mysql from "mysql2/promise";
const NEW_URL = process.env.DATABASE_URL;
const OLD_URL = process.env.OLD_DATABASE_URL;
const oldC = await mysql.createConnection(OLD_URL);
const newC = await mysql.createConnection(NEW_URL);

const [ot] = await oldC.query("SHOW TABLES");
const [nt] = await newC.query("SHOW TABLES");
const oldTables = new Set(ot.map((r) => Object.values(r)[0]));
const newTables = new Set(nt.map((r) => Object.values(r)[0]));
const all = [...new Set([...oldTables, ...newTables])].sort();

console.log("table\told_rows\tnew_rows\told_latest\tnew_latest");
for (const t of all) {
  const inOld = oldTables.has(t), inNew = newTables.has(t);
  let oldN = "-", newN = "-", oldMax = "-", newMax = "-";
  if (inOld) {
    const [r] = await oldC.query(`SELECT COUNT(*) n FROM \`${t}\``);
    oldN = r[0].n;
    const [c] = await oldC.query(`SHOW COLUMNS FROM \`${t}\` LIKE 'createdAt'`);
    if (c.length && oldN > 0) {
      const [m] = await oldC.query(`SELECT MAX(createdAt) mx FROM \`${t}\``);
      oldMax = m[0].mx ? new Date(m[0].mx).toISOString().slice(0, 16) : "-";
    }
  }
  if (inNew) {
    const [r] = await newC.query(`SELECT COUNT(*) n FROM \`${t}\``);
    newN = r[0].n;
    const [c] = await newC.query(`SHOW COLUMNS FROM \`${t}\` LIKE 'createdAt'`);
    if (c.length && newN > 0) {
      const [m] = await newC.query(`SELECT MAX(createdAt) mx FROM \`${t}\``);
      newMax = m[0].mx ? new Date(m[0].mx).toISOString().slice(0, 16) : "-";
    }
  }
  const flag = !inNew ? "  <== MISSING_IN_TIDB" : !inOld ? "  <== ONLY_IN_TIDB" : (oldN !== newN ? "  <== COUNT_DIFF" : "");
  console.log(`${t}\t${oldN}\t${newN}\t${oldMax}\t${newMax}${flag}`);
}
await oldC.end(); await newC.end();
