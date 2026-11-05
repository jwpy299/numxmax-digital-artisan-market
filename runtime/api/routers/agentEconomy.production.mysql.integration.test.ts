/** production 人民币口径真实隔离库验证；默认跳过，显式 AGENT_EMPLOYMENT_MYSQL_TEST=1 才运行。 */
import { beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { getDb } from '../queries/connection'
import { authTokenHash } from '../auth/revocation'
import { agentTrainingRouter } from './agentEmployment'
import { rawRows } from '../queries/rawRows'

const enabled = process.env.AGENT_EMPLOYMENT_MYSQL_TEST === '1'
const db = enabled ? getDb() : (undefined as unknown as ReturnType<typeof getDb>)
const training = agentTrainingRouter.createCaller({ clientIp: '127.0.0.1' } as never)
const ownerToken = `nt_production_rules_${randomBytes(12).toString('hex')}`
let ownerId = 0

beforeAll(async () => {
  if (!enabled) return
  process.env.ECONOMY_MODE = 'production'
  await db.execute(sql`CREATE TABLE IF NOT EXISTS enterprises (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, name VARCHAR(128) NOT NULL,
    industry VARCHAR(64) NOT NULL, tokenBalance INT NOT NULL DEFAULT 0)`)
  await db.execute(sql`CREATE TABLE IF NOT EXISTS wb_factories (
    id BIGINT UNSIGNED NOT NULL PRIMARY KEY, enterpriseName VARCHAR(128) NOT NULL,
    industry VARCHAR(64) NOT NULL, industryText VARCHAR(128) NULL, headcount VARCHAR(32) NOT NULL,
    departments JSON NOT NULL, painPoints TEXT NULL, profile JSON NULL, creditCode VARCHAR(32) NULL,
    verifyStatus VARCHAR(24) NOT NULL DEFAULT 'unverified', verifiedAt DATETIME NULL, verifyPayload JSON NULL,
    industryGroup VARCHAR(64) NOT NULL DEFAULT '工业制造', createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`)
  await db.execute(sql`CREATE TABLE IF NOT EXISTS wb_users (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, username VARCHAR(64) NOT NULL UNIQUE,
    passwordHash VARCHAR(255) NOT NULL, displayName VARCHAR(64) NOT NULL,
    role VARCHAR(16) NOT NULL DEFAULT 'member', factoryId BIGINT UNSIGNED NOT NULL,
    departmentId VARCHAR(64) NULL, authToken VARCHAR(80) NULL, phone VARCHAR(20) NULL,
    realName VARCHAR(64) NULL, idCardMasked VARCHAR(32) NULL, idCardHash VARCHAR(64) NULL,
    kind VARCHAR(16) NOT NULL DEFAULT 'enterprise', gender VARCHAR(8) NULL, city VARCHAR(16) NULL,
    voice_pref VARCHAR(24) NULL, invitedBy BIGINT UNSIGNED NULL, activatedAt TIMESTAMP NULL,
    disabled TINYINT(1) NOT NULL DEFAULT 0, createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    tokenBalance INT NOT NULL DEFAULT 0)`)
  await db.execute(sql`INSERT INTO enterprises (id, name, industry, tokenBalance) VALUES (1, '生产规则隔离企业', 'test', 0)`)
  await db.execute(sql`INSERT INTO wb_factories (id, enterpriseName, industry, headcount, departments, verifyStatus, industryGroup)
    VALUES (1, '生产规则隔离企业', 'test', '1-10', ${JSON.stringify([{ id: 'dept-a', name: '测试部' }])}, 'unverified', '工业制造')`)
  const inserted = await db.execute(sql`
    INSERT INTO wb_users (username, passwordHash, displayName, role, factoryId, departmentId, authToken, tokenBalance)
    VALUES (${`production_rules_${randomBytes(4).toString('hex')}`}, ${`test:${randomBytes(16).toString('hex')}`}, '生产规则用户', 'member', 1, 'dept-a', ${authTokenHash(ownerToken)}, 0)`)
  ownerId = Number((Array.isArray(inserted) ? inserted[0] : inserted as { insertId?: number })?.insertId ?? 0)
})

describe('production 人民币经济边界', () => {
  it('不建测试钱包/兑换表，公开人民币规则且支付通道 fail-closed', async () => {
    if (!enabled) return
    expect(ownerId).toBeGreaterThan(0)
    const testTables = rawRows(await db.execute(sql`
      SELECT table_name AS name FROM information_schema.tables
      WHERE table_schema=DATABASE() AND table_name IN ('st_agent_token_wallets','st_agent_token_exchanges')`))
    expect(testTables).toHaveLength(0)
    const mine = await training.mine({ token: ownerToken })
    expect(mine.rules.economyMode).toBe('production')
    expect(mine.rules.registrationFeeCents).toBe(9900)
    expect(mine.rules.retakeFeeCents).toBe(100)
    expect(mine.rules.registrationFeeJobTokens).toBe(0)
    expect(mine.rules.retakeFeeJobTokens).toBe(0)
    expect(mine.rules.jobTokenCnyCents).toBe(0)
    expect(mine.rules.sandboxEnabled).toBe(false)
    expect(mine.rules.paymentMode).toBe('rmb_cents')
    expect(mine.qualifiedRegistrations).toEqual([])
    await expect(training.register({ token: ownerToken, agentName: '生产未接通道Agent', idempotencyKey: `production-register-${randomBytes(6).toString('hex')}` })).rejects.toThrow(/支付通道/)
    const registrations = rawRows(await db.execute(sql`SELECT id FROM st_agent_registrations WHERE owner_user_id=${ownerId}`))
    expect(registrations).toHaveLength(0)
  })
})
