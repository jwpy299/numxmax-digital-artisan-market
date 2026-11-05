/**
 * sync-m76：超市四分类（彭总架构图 2026-08-25）——st_skills/st_skill_market 补 market_class。
 * 四类口径（图）：personal 个人助理类 / enterprise 企业职能类 / industry 行业方案类 / general 通用技能类。
 * additive 幂等；回填映射按既有 category 归并。
 */
import mysql from "mysql2/promise";
import { readFileSync } from "node:fs";

const url = process.argv[2] ?? readFileSync("/mnt/agents/output/migration/env.production.机密-用后删除", "utf8")
  .match(/^DATABASE_URL=(.+)$/m)![1].trim();
const conn = await mysql.createConnection(url);

for (const t of ["st_skills", "st_skill_market"]) {
  const [cols] = await conn.query(`SHOW COLUMNS FROM ${t} LIKE 'market_class'`);
  if ((cols as unknown[]).length > 0) console.log(`${t}.market_class: already`);
  else {
    await conn.query(
      `ALTER TABLE ${t} ADD COLUMN market_class VARCHAR(16) NULL DEFAULT NULL COMMENT '超市四类：personal/enterprise/industry/general'`,
    );
    console.log(`${t}.market_class: added`);
  }
}

// 回填映射（既有 category → 四类）
const MAP: Record<string, string> = {
  办公: "personal", 知识: "personal", 沟通: "personal", 协同: "personal",
  客服: "enterprise", 人事: "enterprise", 财税: "enterprise",
  市场: "industry", 跨境电商: "industry", 调研: "industry",
  数据: "general", automation: "general", evolution: "general",
  "plugin-store": "general", release: "general",
};
for (const [cat, cls] of Object.entries(MAP)) {
  await conn.query("UPDATE st_skills SET market_class=? WHERE category=? AND market_class IS NULL", [cls, cat]);
}
// 兜底：未命中映射的归 general
await conn.query("UPDATE st_skills SET market_class='general' WHERE market_class IS NULL");
await conn.query("UPDATE st_skill_market m JOIN st_skills s ON s.skill_key COLLATE utf8mb4_general_ci = m.skill_key SET m.market_class = s.market_class WHERE m.market_class IS NULL");
await conn.query("UPDATE st_skill_market SET market_class='general' WHERE market_class IS NULL");

const [stat] = await conn.query("SELECT market_class, COUNT(*) n FROM st_skills GROUP BY market_class");
console.log("st_skills 分布:", JSON.stringify(stat));
const [stat2] = await conn.query("SELECT market_class, COUNT(*) n FROM st_skill_market GROUP BY market_class");
console.log("st_skill_market 分布:", JSON.stringify(stat2));
await conn.end();
