import mysql from 'mysql2/promise'
import { AGENT_TEST_DATABASE_PREFIX } from '../api/lib/agentEconomy'
const url=process.argv[2] ?? process.env.DATABASE_URL
if(!url) throw new Error('DATABASE_URL required')
const conn=await mysql.createConnection(url)
const [rows]=await conn.query<mysql.RowDataPacket[]>('SELECT DATABASE() AS name')
if(!String(rows[0]?.name??'').startsWith(AGENT_TEST_DATABASE_PREFIX)) throw new Error('MARKET_PREVIEW_TEST_DATABASE_REQUIRED')
await conn.query(`CREATE TABLE IF NOT EXISTS masters (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 name VARCHAR(64) NOT NULL, signature VARCHAR(128) NOT NULL, specialty VARCHAR(128) NOT NULL,
 yearsExperience INT NOT NULL, title VARCHAR(128) NULL, reputation INT NOT NULL DEFAULT 80,
 createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB`)
await conn.query(`CREATE TABLE IF NOT EXISTS agents (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 slug VARCHAR(64) NOT NULL UNIQUE, code VARCHAR(16) NOT NULL UNIQUE, name VARCHAR(64) NOT NULL,
 avatar VARCHAR(255) NOT NULL, avatar_config JSON NULL, intro_text TEXT NULL,
 industry VARCHAR(64) NOT NULL, industryGroup VARCHAR(32) NOT NULL DEFAULT '工业制造', capabilityTags JSON NOT NULL,
 masterId BIGINT UNSIGNED NOT NULL, status VARCHAR(16) NOT NULL DEFAULT 'active', delistRisk TINYINT(1) NOT NULL DEFAULT 0,
 monthlyPrice INT NOT NULL, suggestedPrice INT NOT NULL, tasksCompleted INT NOT NULL DEFAULT 0,
 successRate DOUBLE NOT NULL DEFAULT 98, avgRating DOUBLE NOT NULL DEFAULT 5, ratingCount INT NOT NULL DEFAULT 0,
 experienceMonths INT NOT NULL DEFAULT 0, skillCount INT NOT NULL DEFAULT 0, memoryCount INT NOT NULL DEFAULT 0,
 weeklyHires INT NOT NULL DEFAULT 0, weeklyHireTrend JSON NOT NULL, recommended TINYINT(1) NOT NULL DEFAULT 0,
 certified TINYINT(1) NOT NULL DEFAULT 1, listedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 reviewedAt TIMESTAMP NULL, reviewedBy VARCHAR(64) NULL, rejectReason VARCHAR(255) NULL,
 createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB`)
await conn.query(`CREATE TABLE IF NOT EXISTS skills (agentId BIGINT UNSIGNED NOT NULL, callCount INT NOT NULL DEFAULT 0) ENGINE=InnoDB`)
await conn.query(`CREATE TABLE IF NOT EXISTS agent_memories (agentId BIGINT UNSIGNED NOT NULL) ENGINE=InnoDB`)
await conn.query(`CREATE TABLE IF NOT EXISTS agent_hire_records (agentId BIGINT UNSIGNED NOT NULL, createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB`)
await conn.query("INSERT INTO masters (id,name,signature,specialty,yearsExperience,title,reputation) VALUES (1,'预览师傅','预览师傅 · 真实记录','工业测试',10,'隔离预览',80) ON DUPLICATE KEY UPDATE name=VALUES(name)")
await conn.query("INSERT INTO agents (id,slug,code,name,avatar,industry,capabilityTags,masterId,monthlyPrice,suggestedPrice,weeklyHireTrend) VALUES (1,'preview-agent','ART-PREVIEW','预览 Agent','/avatar-zhenheng.png','工业测试',JSON_ARRAY('任务执行'),1,500,500,JSON_ARRAY(0,0,0,0,0,0,0)) ON DUPLICATE KEY UPDATE name=VALUES(name)")
console.log('market preview schema ready (additive test-only)')
await conn.end()
