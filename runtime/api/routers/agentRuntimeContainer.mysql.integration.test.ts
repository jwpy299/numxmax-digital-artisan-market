/** 真实 MySQL 隔离库：事件驱动竞岗、单 claim 委派提交、独立验收工资与撤销竞态。默认跳过。 */
import { beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { getDb } from '../queries/connection'
import { rawRows } from '../queries/rawRows'
import { authTokenHash } from '../auth/revocation'
import { AGENT_TEST_DATABASE_PREFIX } from '../lib/agentEconomy'
import { agentWorkRouter } from './agentEmployment'
import { bindRuntimeIdentity, cancelRuntimePlan, createRuntimePlan, dispatchRuntimePlan, getRuntimePlan, openRuntimeCompetition, pumpRuntimeEvents, reviewRuntimeRole, selectRuntimeCandidate } from '../runtimeContainer/service'
import { readSubmitDelegation } from '../runtimeContainer/delegation'
import type { RuntimeExecutor } from '../runtimeContainer/adapters'
import type { AgentRuntimeId } from '../../contracts/agentRuntimeContainer'

const enabled = process.env.AGENT_EMPLOYMENT_MYSQL_TEST === '1'
const db = enabled ? getDb() : (undefined as unknown as ReturnType<typeof getDb>)
const work = agentWorkRouter.createCaller({ clientIp: '127.0.0.1' } as never)
const creatorToken = `nt_runtime_creator_${randomBytes(12).toString('hex')}`
const reviewerToken = `nt_runtime_reviewer_${randomBytes(12).toString('hex')}`
const staffToken = `nt_runtime_staff_${randomBytes(12).toString('hex')}`
const otherToken = `nt_runtime_other_${randomBytes(12).toString('hex')}`
let factoryId = 0
let creatorId = 0
let dshRegistrationId = 0
let kimiRegistrationId = 0
let fullPlanId = 0
const idem = (value: string) => `runtime-mysql-${value}-${randomBytes(5).toString('hex')}`
function rows<T = Record<string, unknown>>(result: unknown): T[] { return rawRows(result) as T[] }
async function makeUser(token: string, role: 'admin' | 'member', factory: number) {
  const username = `${role}_${randomBytes(6).toString('hex')}`
  const result = await db.execute(sql`INSERT INTO wb_users (username, passwordHash, displayName, role, factoryId, departmentId, authToken, tokenBalance) VALUES (${username}, ${`test:${randomBytes(12).toString('hex')}`}, ${username}, ${role}, ${factory}, 'dept-a', ${authTokenHash(token)}, 0)`)
  return Number((Array.isArray(result) ? result[0] : result as { insertId?: number })?.insertId ?? 0)
}
async function makeFactory(name: string, tokens: number) {
  const enterprise = await db.execute(sql`INSERT INTO enterprises (name, industry, tokenBalance) VALUES (${name}, 'test', ${tokens})`)
  const id = Number((Array.isArray(enterprise) ? enterprise[0] : enterprise as { insertId?: number })?.insertId ?? 0)
  await db.execute(sql`INSERT INTO wb_factories (id, enterpriseName, industry, headcount, departments, verifyStatus, industryGroup) VALUES (${id}, ${name}, 'test', '1-10', ${JSON.stringify([{ id: 'dept-a', name: '测试部' }, { id: 'dept-b', name: '另一部门' }])}, 'unverified', '工业制造')`)
  return id
}
async function qualifiedRegistration(agentName: string) {
  const result = await db.execute(sql`INSERT INTO st_agent_registrations (registration_no, agent_key, owner_user_id, agent_name, status, fee_status, current_attempt_no, idempotency_key, qualified_at) VALUES (${`AR_${randomBytes(8).toString('hex')}`}, ${`agent_${randomBytes(10).toString('hex')}`}, ${creatorId}, ${agentName}, 'qualified', 'refunded', 1, ${idem('registration')}, NOW())`)
  const registrationId = Number((Array.isArray(result) ? result[0] : result as { insertId?: number })?.insertId ?? 0)
  await db.execute(sql`INSERT INTO st_agent_payment_orders (order_no, registration_id, owner_user_id, kind, attempt_no, amount_cents, amount_job_tokens, environment, status, idempotency_key, paid_at) VALUES (${`AO_${randomBytes(8).toString('hex')}`}, ${registrationId}, ${creatorId}, 'registration', 1, 9900, 990, 'sandbox', 'refunded', ${idem('order')}, NOW())`)
  return registrationId
}
function successfulExecutor(content: string): RuntimeExecutor {
  return async (runtime: AgentRuntimeId, task) => ({
    ok: true, runtime, content: `${content}：${task.title}`, resultSha256: randomBytes(32).toString('hex'), provider: runtime,
    model: runtime === 'dsh' ? null : 'contract-fixture', usageTokens: 0, latencyMs: 1,
    requestSha256: randomBytes(32).toString('hex'), responseSha256: randomBytes(32).toString('hex'), agentSession: { stationKey: 'contract-fixture', modelProfile: runtime === 'dsh' ? null : 'contract-model' },
  })
}
async function planToCompetition(reward = 5, planKey = idem('plan')) {
  const created = await createRuntimePlan({ token: creatorToken, departmentId: 'dept-a', idempotencyKey: planKey, rewardJobTokens: reward, tasks: [
    { role: '巡检岗位', title: '产线巡检', brief: '完成产线巡检并提交证据与已知边界。', runtime: 'auto' },
    { role: '报告岗位', title: '巡检报告', brief: '独立整理巡检报告并列出未验证事项。', runtime: 'kimi' },
  ] })
  return { ...created, idempotencyKey: planKey }
}
async function selectForRoles(planId: number) {
  const plan = await getRuntimePlan(creatorToken, planId)
  for (const role of plan.roles) {
    const candidate = plan.candidates.find((item) => item.roleId === role.id && item.status === 'applied' && (role.runtimePreference === 'auto' ? item.runtime === 'dsh' : item.runtime === 'kimi'))
    expect(candidate).toBeDefined()
    await selectRuntimeCandidate(reviewerToken, candidate!.id)
  }
}

beforeAll(async () => {
  if (!enabled) return
  const database = rows(await db.execute(sql`SELECT DATABASE() AS name`))[0]
  if (!String(database?.name ?? '').startsWith(AGENT_TEST_DATABASE_PREFIX)) throw new Error('AGENT_RUNTIME_CONTAINER_TEST_DATABASE_REQUIRED')
  process.env.ECONOMY_MODE = 'test'
  process.env.AGENT_EMPLOYMENT_TEST_DATABASE = '1'
  process.env.PAYMENT_SANDBOX_ENABLED = 'true'
  process.env.AGENT_EMPLOYMENT_SANDBOX_QUALIFICATION_OK = 'true'
  process.env.AGENT_EMPLOYMENT_ALLOW_PRODUCTION_SANDBOX = 'true'
  process.env.PAYMENT_SANDBOX_SECRET = `test-only-${randomBytes(24).toString('hex')}`
  process.env.DSH_SERVICE_TOKEN = `test-only-${randomBytes(24).toString('hex')}`
  process.env.KIMI_API_KEY = `test-only-${randomBytes(24).toString('hex')}`
  process.env.AGENT_RUNTIME_KIMI_ENABLED = '1'
  process.env.AGENT_RUNTIME_DELEGATION_KEY = randomBytes(32).toString('hex')
  delete process.env.QWEN_API_KEY
  delete process.env.DASHSCOPE_API_KEY
  delete process.env.WORKBUDDY_API_KEY
  await db.execute(sql`CREATE TABLE IF NOT EXISTS enterprises (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, name VARCHAR(128) NOT NULL, industry VARCHAR(64) NOT NULL, tokenBalance INT NOT NULL DEFAULT 0)`)
  await db.execute(sql`CREATE TABLE IF NOT EXISTS wb_factories (id BIGINT UNSIGNED NOT NULL PRIMARY KEY, enterpriseName VARCHAR(128) NOT NULL, industry VARCHAR(64) NOT NULL, industryText VARCHAR(128) NULL, headcount VARCHAR(32) NOT NULL, departments JSON NOT NULL, painPoints TEXT NULL, profile JSON NULL, creditCode VARCHAR(32) NULL, verifyStatus VARCHAR(24) NOT NULL DEFAULT 'unverified', verifiedAt DATETIME NULL, verifyPayload JSON NULL, industryGroup VARCHAR(64) NOT NULL DEFAULT '工业制造', createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`)
  await db.execute(sql`CREATE TABLE IF NOT EXISTS wb_users (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, username VARCHAR(64) NOT NULL UNIQUE, passwordHash VARCHAR(255) NOT NULL, displayName VARCHAR(64) NOT NULL, role VARCHAR(16) NOT NULL DEFAULT 'member', factoryId BIGINT UNSIGNED NOT NULL, departmentId VARCHAR(64) NULL, authToken VARCHAR(80) NULL, phone VARCHAR(20) NULL, realName VARCHAR(64) NULL, idCardMasked VARCHAR(32) NULL, idCardHash VARCHAR(64) NULL, kind VARCHAR(16) NOT NULL DEFAULT 'enterprise', gender VARCHAR(8) NULL, city VARCHAR(16) NULL, voice_pref VARCHAR(24) NULL, invitedBy BIGINT UNSIGNED NULL, activatedAt TIMESTAMP NULL, disabled TINYINT(1) NOT NULL DEFAULT 0, createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, tokenBalance INT NOT NULL DEFAULT 0)`)
  await db.execute(sql`CREATE TABLE IF NOT EXISTS wb_dept_heads (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, factoryId BIGINT UNSIGNED NOT NULL, deptId VARCHAR(64) NOT NULL, userId BIGINT UNSIGNED NOT NULL, routineLimit INT NULL)`)
  await db.execute(sql`CREATE TABLE IF NOT EXISTS st_wallet_flows (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, owner_type VARCHAR(16) NOT NULL, owner_id BIGINT UNSIGNED NOT NULL, direction VARCHAR(8) NOT NULL, amount INT NOT NULL, balance_after INT NOT NULL, biz_type VARCHAR(64) NOT NULL, ref_id VARCHAR(96) NULL, note VARCHAR(255) NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`)
  factoryId = await makeFactory('运行时编排隔离企业', 10000)
  creatorId = await makeUser(creatorToken, 'admin', factoryId)
  await makeUser(reviewerToken, 'admin', factoryId)
  await makeUser(staffToken, 'member', factoryId)
  const otherFactory = await makeFactory('跨企业隔离企业', 1000)
  await makeUser(otherToken, 'admin', otherFactory)
  dshRegistrationId = await qualifiedRegistration('DSH竞岗Agent')
  kimiRegistrationId = await qualifiedRegistration('Kimi竞岗Agent')
  await bindRuntimeIdentity({ token: creatorToken, departmentId: 'dept-a', runtime: 'dsh', registrationId: dshRegistrationId })
  await bindRuntimeIdentity({ token: creatorToken, departmentId: 'dept-a', runtime: 'kimi', registrationId: kimiRegistrationId })
})

describe.skipIf(!enabled).sequential('事件驱动多 runtime 竞岗真实 MySQL 闭环', () => {
  it('双岗位并行竞岗、独立录用、事件提交、独立验收和实际双边工资', async () => {
    const created = await planToCompetition(5)
    fullPlanId = created.plan.id
    const tasks = [
      { role: '巡检岗位', title: '产线巡检', brief: '完成产线巡检并提交证据与已知边界。', runtime: 'auto' as const },
      { role: '报告岗位', title: '巡检报告', brief: '独立整理巡检报告并列出未验证事项。', runtime: 'kimi' as const },
    ]
    const replay = await createRuntimePlan({ token: creatorToken, departmentId: 'dept-a', idempotencyKey: created.idempotencyKey, rewardJobTokens: 5, tasks })
    expect(replay.already).toBe(true)
    expect(replay.roles).toHaveLength(2)
    await expect(createRuntimePlan({ token: creatorToken, departmentId: 'dept-a', idempotencyKey: created.idempotencyKey, rewardJobTokens: 6, tasks })).rejects.toThrow('不同编排请求')
    await expect(getRuntimePlan(otherToken, fullPlanId)).rejects.toThrow('不属于本企业')
    await expect(createRuntimePlan({ token: staffToken, departmentId: 'dept-a', idempotencyKey: idem('staff'), rewardJobTokens: 5, tasks })).rejects.toThrow('仅企业负责人')

    await openRuntimeCompetition(creatorToken, fullPlanId)
    let plan = await getRuntimePlan(creatorToken, fullPlanId)
    expect(plan.roles.every((role) => role.jobId !== null)).toBe(true)
    expect(plan.candidates.filter((candidate) => candidate.status === 'applied')).toHaveLength(3)
    const firstCandidate = plan.candidates.find((candidate) => candidate.status === 'applied')!
    await expect(selectRuntimeCandidate(creatorToken, firstCandidate.id)).rejects.toThrow('不得录用自己')
    await selectForRoles(fullPlanId)
    plan = await getRuntimePlan(creatorToken, fullPlanId)
    expect(plan.plan.status).toBe('ready_to_dispatch')
    expect(plan.roles.every((role) => role.employmentId !== null && role.status === 'selected')).toBe(true)

    await dispatchRuntimePlan(creatorToken, fullPlanId)
    plan = await getRuntimePlan(creatorToken, fullPlanId)
    expect(plan.roles.every((role) => role.claimId !== null && role.status === 'claimed')).toBe(true)
    expect(plan.outbox.filter((event) => event.status === 'pending')).toHaveLength(2)
    expect(rows(await db.execute(sql`SELECT COUNT(*) AS count FROM st_agent_runtime_delegations d JOIN st_agent_runtime_roles r ON r.id=d.role_id WHERE r.plan_id=${fullPlanId} AND d.revoked_at IS NULL`))[0].count).toBe(2)
    expect(Number(rows(await db.execute(sql`SELECT COUNT(*) AS count FROM st_agent_wage_ledger`))[0].count)).toBe(0)

    let active = 0
    let maxActive = 0
    const baseExecutor = successfulExecutor('隔离库执行器合同交付')
    const concurrentExecutor: RuntimeExecutor = async (runtime, task) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 30))
      active -= 1
      return baseExecutor(runtime, task)
    }
    const pumped = await pumpRuntimeEvents({ workerId: 'mysql-full-flow', limit: 2, executor: concurrentExecutor })
    expect(pumped).toMatchObject({ claimed: 2, submitted: 2, failed: 0, outcomeUnknown: 0 })
    expect(maxActive).toBe(2)
    plan = await getRuntimePlan(creatorToken, fullPlanId)
    expect(plan.plan.status).toBe('awaiting_review')
    expect(plan.roles.every((role) => role.status === 'awaiting_review' && role.executed && !role.done && !role.wageSettled)).toBe(true)
    expect(Number(rows(await db.execute(sql`SELECT COUNT(*) AS count FROM st_agent_wage_ledger`))[0].count)).toBe(0)

    const firstRole = plan.roles[0]
    await expect(reviewRuntimeRole({ token: creatorToken, roleId: firstRole.id, verdict: 'accept', note: '创建人不得自行验收。' })).rejects.toThrow()
    for (const role of plan.roles) {
      const reviewed = await reviewRuntimeRole({ token: reviewerToken, roleId: role.id, verdict: 'accept', note: '独立复核：交付、证据哈希与岗位要求一致。' })
      expect(reviewed.roles.find((item) => item.id === role.id)).toMatchObject({ status: 'accepted', done: true, wageSettled: true })
    }
    plan = await getRuntimePlan(creatorToken, fullPlanId)
    expect(plan.plan.status).toBe('completed')
    const wages = rows(await db.execute(sql`SELECT direction, amount_job_tokens AS amount, registration_id AS registrationId FROM st_agent_wage_ledger WHERE claim_id IN (${sql.join(plan.roles.map((role) => sql`${role.claimId}`), sql`,`)})`))
    expect(wages).toHaveLength(4)
    expect(wages.filter((wage) => wage.direction === 'credit')).toHaveLength(2)
    expect(wages.filter((wage) => wage.direction === 'credit').every((wage) => Number(wage.amount) === 5)).toBe(true)
    expect(plan.outbox.every((event) => event.status === 'done')).toBe(true)
  }, 120_000)

  it('单 claim 委派不可越权；执行中撤销后迟到结果零交付零工资并留 outcome_unknown', async () => {
    const created = await createRuntimePlan({ token: creatorToken, departmentId: 'dept-a', idempotencyKey: idem('cancel-plan'), rewardJobTokens: 3, tasks: [
      { role: '撤销测试岗位', title: '执行中撤销', brief: '验证撤销后迟到结果不得提交或结算。', runtime: 'dsh' },
    ] })
    const planId = created.plan.id
    await openRuntimeCompetition(creatorToken, planId)
    let plan = await getRuntimePlan(creatorToken, planId)
    const candidate = plan.candidates.find((item) => item.status === 'applied')!
    await selectRuntimeCandidate(reviewerToken, candidate.id)
    await dispatchRuntimePlan(creatorToken, planId)
    plan = await getRuntimePlan(creatorToken, planId)
    const role = plan.roles[0]
    const delegation = await readSubmitDelegation(role.id)
    expect(delegation).not.toBeNull()
    await expect(work.publishJob({ token: delegation!.token, idempotencyKey: idem('delegation-abuse'), departmentId: 'dept-a', title: '委派越权岗位', description: '委派 token 不得用于发布岗位。', headcount: 1, budgetJobTokens: 1 })).rejects.toThrow()
    await expect(work.applyJob({ token: delegation!.token, registrationId: dshRegistrationId, jobId: role.jobId!, idempotencyKey: idem('delegation-apply-abuse') })).rejects.toThrow()
    await expect(work.submitTask({ token: delegation!.token, claimId: 99999999, deliverable: '委派 token 不得用于其它 claim 的交付提交。' })).rejects.toThrow()

    let release = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const baseExecutor = successfulExecutor('撤销后的迟到交付')
    const delayedExecutor: RuntimeExecutor = async (runtime, task) => {
      await gate
      return baseExecutor(runtime, task)
    }
    const pumping = pumpRuntimeEvents({ workerId: 'mysql-cancel-race', limit: 1, executor: delayedExecutor })
    let outboxStatus = ''
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      outboxStatus = String(rows(await db.execute(sql`SELECT status FROM st_agent_runtime_outbox WHERE plan_id=${planId} LIMIT 1`))[0]?.status ?? '')
      if (outboxStatus === 'claimed') break
    }
    expect(outboxStatus).toBe('claimed')
    await cancelRuntimePlan(creatorToken, planId, '独立撤销竞态验证')
    expect(await readSubmitDelegation(role.id)).toBeNull()
    release()
    const outcome = await pumping
    expect(outcome.outcomeUnknown).toBe(1)
    plan = await getRuntimePlan(creatorToken, planId)
    expect(plan.plan.status).toBe('cancelled')
    expect(plan.roles[0]).toMatchObject({ status: 'cancelled', result: null, wageSettled: false, done: false })
    expect(plan.outbox[0].status).toBe('cancelled')
    expect(plan.events.some((event) => event.eventType === 'runtime.outcome_unknown')).toBe(true)
    const claim = rows(await db.execute(sql`SELECT status, deliverable, is_active AS isActive FROM st_agent_task_claims WHERE id=${role.claimId} LIMIT 1`))[0]
    expect(claim.status).toBe('revoked')
    expect(claim.deliverable).toBeNull()
    expect(Number(claim.isActive)).toBe(0)
    expect(Number(rows(await db.execute(sql`SELECT COUNT(*) AS count FROM st_agent_wage_ledger WHERE claim_id=${role.claimId}`))[0].count)).toBe(0)
  }, 120_000)
})
