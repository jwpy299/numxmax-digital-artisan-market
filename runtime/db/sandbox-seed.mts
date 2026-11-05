/**
 * 沙箱测试环境种子（iter86）：创建 TEST_ 前缀测试企业与账号。
 * 幂等：已存在则跳过。密码统一 Test@2026（仅沙箱，上线前由 sandbox-cleanup 清除）。
 */
import mysql from "mysql2/promise";
import { scryptSync, randomBytes } from "node:crypto";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL missing");

function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(pw, salt, 32).toString("hex")}`;
}

const conn = await mysql.createConnection(url);

const SANDBOX_ORGS = [
  {
    name: "TEST_云测智造有限公司",
    industry: "equipment",
    industryText: "装备制造",
    headcount: "100-499",
    departments: [
      { id: "prod", name: "生产部", headcount: "60", duty: "生产运营" },
      { id: "mkt", name: "市场部", headcount: "15", duty: "市场营销" },
    ],
    users: [
      { username: "TEST_bossA", displayName: "测试老板A", role: "owner" },
      { username: "TEST_staffA", displayName: "测试员工A", role: "member" },
    ],
  },
  {
    name: "TEST_星桥零部件集团",
    industry: "auto",
    industryText: "汽车零部件",
    headcount: "500-999",
    departments: [{ id: "qa", name: "质量部", headcount: "30", duty: "质量检测" }],
    users: [
      { username: "TEST_bossB", displayName: "测试老板B", role: "owner" },
      { username: "TEST_staffB", displayName: "测试员工B", role: "member" },
    ],
  },
] as const;

let createdF = 0, createdU = 0, skipped = 0;
for (const org of SANDBOX_ORGS) {
  const [exist] = await conn.query("SELECT id FROM wb_factories WHERE enterpriseName=?", [org.name]);
  let factoryId: number;
  if ((exist as any[]).length > 0) {
    factoryId = (exist as any[])[0].id;
    skipped++;
  } else {
    const [r] = await conn.query(
      "INSERT INTO wb_factories (enterpriseName, industry, industryText, headcount, departments, painPoints, industryGroup) VALUES (?,?,?,?,?,?,?)",
      [org.name, org.industry, org.industryText, org.headcount, JSON.stringify(org.departments), "沙箱测试企业", "工业制造"],
    );
    factoryId = Number((r as any).insertId);
    createdF++;
  }
  for (const u of org.users) {
    const [ue] = await conn.query("SELECT id FROM wb_users WHERE username=?", [u.username]);
    if ((ue as any[]).length > 0) { skipped++; continue; }
    await conn.query(
      "INSERT INTO wb_users (username, passwordHash, displayName, role, factoryId, kind) VALUES (?,?,?,?,?, 'enterprise')",
      [u.username, hashPassword("Test@2026"), u.displayName, u.role, factoryId],
    );
    createdU++;
  }
}
console.log(`sandbox-seed: 企业+${createdF} 账号+${createdU} 跳过${skipped}`);
console.log("SANDBOX-SEED-PASS");
await conn.end();
