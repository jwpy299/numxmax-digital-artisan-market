// 旧库(3307) vs TiDB(4000/hosts回环) 漂移恢复审计 —— 在 S2 上跑，只读
// node recover-drift-audit.mjs  （.env 由调用方 source，OLD_DATABASE_URL 环境变量给旧库）
import mysql from "mysql2/promise";

const NEW_URL = process.env.DATABASE_URL;        // TiDB（域名→127.0.0.1:4000 隧道）
const OLD_URL = process.env.OLD_DATABASE_URL;    // 旧 MySQL 127.0.0.1:3307
if (!NEW_URL || !OLD_URL) throw new Error("need DATABASE_URL and OLD_DATABASE_URL");

const oldC = await mysql.createConnection(OLD_URL);
const newC = await mysql.createConnection(NEW_URL);

const tables = ["wb_assets","wb_calls","wb_career_entries","wb_career_shares","wb_devices","wb_invites","wb_memories","wb_pair_codes","wb_proactive_msgs","wb_skill_badges","wb_sms_codes"];
console.log("== 缺失表在旧库的行数 ==");
for (const t of tables) {
  try {
    const [r] = await oldC.query(`SELECT COUNT(*) n FROM \`${t}\``);
    console.log(`${t}: ${r[0].n}`);
  } catch (e) { console.log(`${t}: OLD_MISSING (${e.code})`); }
}

console.log("== 漂移列在旧库的数据量 ==");
const colChecks = [
  ["agents", "avatar_config"], ["agents", "intro_text"], ["agents", "industryGroup"],
  ["skills", "executorKind"],
  ["wb_factories", "creditCode"], ["wb_factories", "industryGroup"],
  ["wb_users", "invitedBy"], ["wb_users", "activatedAt"],
];
for (const [t, c] of colChecks) {
  try {
    const [r] = await oldC.query(`SELECT COUNT(*) total, COUNT(\`${c}\`) nonnull FROM \`${t}\``);
    const [d] = await oldC.query(`SELECT DISTINCT \`${c}\` v FROM \`${t}\` WHERE \`${c}\` IS NOT NULL LIMIT 5`);
    console.log(`${t}.${c}: total=${r[0].total} nonNull=${r[0].nonnull} sample=${JSON.stringify(d.map(x=>x.v)).slice(0,160)}`);
  } catch (e) { console.log(`${t}.${c}: OLD_MISSING (${e.code})`); }
}

console.log("== 新库对应表现状（对照） ==");
for (const t of ["agents","skills","wb_factories","wb_users"]) {
  const [r] = await newC.query(`SELECT COUNT(*) n FROM \`${t}\``);
  console.log(`TiDB ${t}: ${r[0].n}`);
}
const [r] = await oldC.query(`SELECT COUNT(*) n FROM wb_users`);
const [r2] = await oldC.query(`SELECT COUNT(*) n FROM agents`);
const [r3] = await oldC.query(`SELECT COUNT(*) n FROM skills`);
const [r4] = await oldC.query(`SELECT COUNT(*) n FROM wb_factories`);
console.log(`OLD wb_users=${r[0].n} agents=${r2[0].n} skills=${r3[0].n} wb_factories=${r4[0].n}`);
await oldC.end(); await newC.end();
