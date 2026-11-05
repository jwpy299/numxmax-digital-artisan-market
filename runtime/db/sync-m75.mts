/**
 * sync-m75：st_dept_consoles 补 allowed_models（部门适配模型集合，JSON 数组存模型 id）。
 * 彭总指令 2026-08-24：超终六部门+总经理驾驶舱按部门指定海禛云 41 模型适配集。
 * additive 幂等；失败如实报错（不静默）。
 */
import mysql from "mysql2/promise";
import { readFileSync } from "node:fs";

const url = process.argv[2] ?? readFileSync("/mnt/agents/output/migration/env.production.机密-用后删除", "utf8")
  .match(/^DATABASE_URL=(.+)$/m)![1].trim();
const conn = await mysql.createConnection(url);

const [cols] = await conn.query("SHOW COLUMNS FROM st_dept_consoles LIKE 'allowed_models'");
if ((cols as unknown[]).length > 0) {
  console.log("allowed_models: already");
} else {
  await conn.query(
    "ALTER TABLE st_dept_consoles ADD COLUMN allowed_models JSON NULL DEFAULT NULL COMMENT '部门适配模型集合（海禛云目录 id 数组；NULL=不限/走槽位默认）' AFTER model_slot",
  );
  console.log("allowed_models: added");
}
await conn.end();
