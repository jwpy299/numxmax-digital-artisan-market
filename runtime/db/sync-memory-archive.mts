/**
 * 幂等同步 M49「记忆自动归档」新表：st_memory_archives
 *
 * 背景（彭总口径）：灵枢和星云的工作记忆达到一定程度后，自动归档到企业知识库/数据库。
 * 设计：st_kb_docs 无 factory_id 隔离列（本厂管理端表），多厂记忆归档绝不混入——
 * 归档落 st_memory_archives（factory_id 强隔离），各厂只能读本厂归档。
 *
 * 归档源：
 * - auto_lru：个人记忆超帽 LRU 淘汰前的抢救性归档（记忆不丢）；
 * - auto_threshold：厂级记忆达阈值后的周期性知识沉淀（源记忆保留，仍参与召回）。
 *
 * 幂等：CREATE TABLE IF NOT EXISTS；重复执行无副作用。
 * 用法：set -a && . ./.env && set +a && npx tsx db/sync-memory-archive.mts
 * 语法自检：DRY_RUN=1 npx tsx db/sync-memory-archive.mts（不连库，直接退出）
 */
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

await conn.query(`CREATE TABLE IF NOT EXISTS st_memory_archives (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  factory_id BIGINT NOT NULL COMMENT '所属企业（跨厂强隔离键）',
  persona VARCHAR(16) NOT NULL COMMENT '记忆人格（lingshu/xingyun/xingxing）',
  title VARCHAR(200) NOT NULL COMMENT '归档文档标题',
  content LONGTEXT NOT NULL COMMENT '归档正文（LLM 提炼；失败时纯文本拼接兜底；已过 stripSecrets）',
  source_count INT NOT NULL DEFAULT 0 COMMENT '本批归档的记忆条数',
  source VARCHAR(20) NOT NULL COMMENT '归档触发源（auto_lru/auto_threshold/manual）',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_st_mem_arch_factory (factory_id, created_at),
  INDEX idx_st_mem_arch_cooldown (factory_id, persona, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
console.log("st_memory_archives: ok");

await conn.end();
console.log("SYNC-MEMORY-ARCHIVE-PASS");
