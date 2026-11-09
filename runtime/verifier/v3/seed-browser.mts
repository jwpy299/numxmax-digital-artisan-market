import { mkdirSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { getDb } from '../../api/queries/connection'
import { rawRows } from '../../api/queries/rawRows'
import { authTokenHash } from '../../api/auth/revocation'
import { bindRuntimeIdentity, createRuntimePlan } from '../../api/runtimeContainer/service'

const db = getDb()
const rows = (result: unknown) => rawRows(result) as Array<Record<string, unknown>>
const insertId = (result: unknown) => Number((Array.isArray(result) ? result[0] : result as { insertId?: number })?.insertId ?? 0)
const creatorToken = `nt_ui_creator_${randomBytes(16).toString('hex')}`
const reviewerToken = `nt_ui_reviewer_${randomBytes(16).toString('hex')}`
const creatorName = `ui_creator_${randomBytes(4).toString('hex')}`
const reviewerName = `ui_reviewer_${randomBytes(4).toString('hex')}`
const factoryId = 420001
await db.execute(sql`INSERT INTO enterprises (id, name, industry, tokenBalance) VALUES (${factoryId}, ${`Runtime UI 隔离企业-${factoryId}`}, 'test', 10000) ON DUPLICATE KEY UPDATE name=VALUES(name), tokenBalance=VALUES(tokenBalance)`)
await db.execute(sql`INSERT INTO wb_factories (id, enterpriseName, industry, headcount, departments, verifyStatus, industryGroup) VALUES (${factoryId}, ${`Runtime UI 隔离企业-${factoryId}`}, 'test', '1-10', ${JSON.stringify([{ id: 'dept-a', name: '制造部' }, { id: 'dept-b', name: '质量部' }])}, 'unverified', '工业制造')`)
async function user(token: string, username: string) {
  const inserted = await db.execute(sql`INSERT INTO wb_users (username, passwordHash, displayName, role, factoryId, departmentId, authToken, tokenBalance) VALUES (${username}, ${`test:${randomBytes(12).toString('hex')}`}, ${username}, 'admin', ${factoryId}, 'dept-a', ${authTokenHash(token)}, 0)`)
  return insertId(inserted)
}
const creatorId = await user(creatorToken, creatorName)
await user(reviewerToken, reviewerName)
async function registration(agentName: string) {
  const inserted = await db.execute(sql`INSERT INTO st_agent_registrations (registration_no, agent_key, owner_user_id, agent_name, status, fee_status, current_attempt_no, idempotency_key, qualified_at) VALUES (${`AR_${randomBytes(8).toString('hex')}`}, ${`agent_${randomBytes(10).toString('hex')}`}, ${creatorId}, ${agentName}, 'qualified', 'refunded', 1, ${`ui-${randomBytes(8).toString('hex')}`}, NOW())`)
  const registrationId = insertId(inserted)
  await db.execute(sql`INSERT INTO st_agent_payment_orders (order_no, registration_id, owner_user_id, kind, attempt_no, amount_cents, amount_job_tokens, environment, status, idempotency_key, paid_at) VALUES (${`AO_${randomBytes(8).toString('hex')}`}, ${registrationId}, ${creatorId}, 'registration', 1, 9900, 990, 'sandbox', 'refunded', ${`ui-order-${randomBytes(8).toString('hex')}`}, NOW())`)
  return registrationId
}
const kimiRegistrationId = await registration('UI Kimi 竞岗 Agent')
const glmRegistrationId = await registration('UI GLM 竞岗 Agent')
await bindRuntimeIdentity({ token: creatorToken, departmentId: 'dept-a', runtime: 'kimi', registrationId: kimiRegistrationId })
await bindRuntimeIdentity({ token: creatorToken, departmentId: 'dept-a', runtime: 'glm', registrationId: glmRegistrationId })
const plan = await createRuntimePlan({ token: creatorToken, departmentId: 'dept-a', idempotencyKey: `ui-plan-${randomBytes(8).toString('hex')}`, rewardJobTokens: 2, tasks: [
  { role: '巡检分析岗', title: '分析设备巡检摘要', brief: '根据给定设备温度 72℃、振动阈值 4.5mm/s 的巡检摘要，输出两条观察、一条风险提示和需要现场复核的边界；不得声称已经访问真实设备。', runtime: 'kimi' },
  { role: '独立复核岗', title: '复核巡检风险表述', brief: '独立复核一份巡检结论：温度 72℃、振动阈值 4.5mm/s。给出两条复核意见和一条不能远程确认的事项；不得声称已经访问真实设备。', runtime: 'glm' },
] })
const evidenceDir = '/opt/rebuild/verification-evidence/runtime-container'
mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
writeFileSync(`${evidenceDir}/browser-fixture.json`, JSON.stringify({ schema: 'numx.runtime-ui.fixture.v1', createdAt: new Date().toISOString(), factoryId, planId: plan.plan.id, creatorToken, reviewerToken, kimiRegistrationId, glmRegistrationId }, null, 2), { mode: 0o600 })
console.log(JSON.stringify({ ok: true, factoryId, planId: plan.plan.id, roles: plan.roles.length, economy: 'isolated-test', credentialsFile: `${evidenceDir}/browser-fixture.json` }))

process.exit(0)
