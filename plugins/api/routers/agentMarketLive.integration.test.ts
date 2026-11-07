/** 真实 MySQL 公开 Feed 与成绩可见范围验证；默认跳过，只在显式隔离库运行。 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { getDb } from '../queries/connection'
import { rawRows } from '../queries/rawRows'
import { authTokenHash } from '../auth/revocation'
import { agentMarketLiveRouter, readAgentMarketLiveFeed } from './agentMarketLive'
import { agentWorkRouter } from './agentEmployment'
import { AGENT_TEST_DATABASE_PREFIX } from '../lib/agentEconomy'

const enabled = process.env.AGENT_EMPLOYMENT_MYSQL_TEST === '1'
const db = enabled ? getDb() : (undefined as unknown as ReturnType<typeof getDb>)
const workCaller = agentWorkRouter.createCaller({ clientIp: '127.0.0.1' } as never)
const caller = agentMarketLiveRouter.createCaller({ clientIp: '127.0.0.1' } as never)
const ownerToken = `nt_market_owner_${randomBytes(12).toString('hex')}`
const otherToken = `nt_market_other_${randomBytes(12).toString('hex')}`
let registrationId = 0
let cycleId = 0
let publicTaskId = 0
let invalidCycleId = 0
let piiCycleId = 0
let privateTaskId = 0
let nullDepartmentTaskId = 0
const runPrefix = `市场-${randomBytes(4).toString("hex")}`

beforeAll(async () => {
  if (!enabled) return
  const database = rawRows(await db.execute(sql`SELECT DATABASE() AS name`))[0]
  if (!String(database?.name ?? '').startsWith(AGENT_TEST_DATABASE_PREFIX)) throw new Error('AGENT_MARKET_LIVE_TEST_DATABASE_REQUIRED')
  console.log(`[test-db] ${AGENT_TEST_DATABASE_PREFIX} prefix verified`)
  const owner = rawRows(await db.execute(sql`SELECT id FROM wb_users WHERE role IN ('member','owner') ORDER BY id LIMIT 1`))[0]
  if (!owner) throw new Error('owner fixture missing')
  await db.execute(sql`UPDATE wb_users SET authToken=${authTokenHash(ownerToken)}, role='owner', departmentId='dept-a' WHERE id=${Number(owner.id)}`)
  const other = rawRows(await db.execute(sql`SELECT id FROM wb_users WHERE role IN ('member','owner') ORDER BY id DESC LIMIT 1`))[0]
  if (!other) throw new Error('other fixture missing')
  await db.execute(sql`UPDATE wb_users SET authToken=${authTokenHash(otherToken)} WHERE id=${Number(other.id)}`)
  const taskFixtures = [
    { suffix: 'open', factoryId: 1, status: 'open', publicFeed: 1, actor: '公开展示企业', deadlineAt: null },
    { suffix: 'claimed', factoryId: 1, status: 'claimed', publicFeed: 1, actor: '公开展示企业', deadlineAt: null },
    { suffix: 'submitted', factoryId: 2, status: 'submitted', publicFeed: 1, actor: '公开展示企业', deadlineAt: null },
    { suffix: 'invalid-actor', factoryId: 1, status: 'open', publicFeed: 1, actor: '13800138000', deadlineAt: null },
    { suffix: 'reserved-actor', factoryId: 1, status: 'open', publicFeed: 1, actor: 'Numx Max.', deadlineAt: null },
    { suffix: 'expired', factoryId: 1, status: 'open', publicFeed: 1, actor: '公开展示企业', deadlineAt: new Date(Date.now() - 60_000) },
    { suffix: 'private', factoryId: 1, status: 'open', publicFeed: 0, actor: '不应出现企业', deadlineAt: null },
    { suffix: 'private-other', factoryId: 2, status: 'open', publicFeed: 0, actor: '跨租户私有企业', deadlineAt: null },
  ]
  for (const fixture of taskFixtures) {
    const insertedTask = await db.execute(sql`INSERT INTO st_agent_work_tasks
      (task_no, factory_id, department_id, publisher_user_id, title, brief, requirements, reward_job_tokens, escrow_job_tokens, status, public_feed, public_actor_name, deadline_at, idempotency_key)
      VALUES (${`AT_market_${randomBytes(6).toString('hex')}`}, ${fixture.factoryId}, 'dept-a', ${Number(owner.id)}, ${`${runPrefix}-${fixture.suffix}`}, '公开任务说明', '独立验收', 5, 5, ${fixture.status}, ${fixture.publicFeed}, ${fixture.actor}, ${fixture.deadlineAt}, ${`market-${randomBytes(6).toString('hex')}`})`)
    const taskId = Number((Array.isArray(insertedTask) ? insertedTask[0] : insertedTask as { insertId?: number })?.insertId ?? 0)
    if (fixture.suffix === 'open') publicTaskId = taskId
    if (fixture.suffix === 'private') privateTaskId = taskId
  }
  const nullDepartmentTask = await db.execute(sql`INSERT INTO st_agent_work_tasks
    (task_no, factory_id, department_id, publisher_user_id, title, brief, requirements, reward_job_tokens, escrow_job_tokens, status, public_feed, public_actor_name, idempotency_key)
    VALUES (${`AT_null_dept_${randomBytes(6).toString('hex')}`}, 1, NULL, ${Number(owner.id)}, '历史未分配部门任务', '历史任务说明', '独立验收', 5, 5, 'open', 0, '历史任务公开名', ${`null-dept-${randomBytes(6).toString('hex')}`})`)
  nullDepartmentTaskId = Number((Array.isArray(nullDepartmentTask) ? nullDepartmentTask[0] : nullDepartmentTask as { insertId?: number })?.insertId ?? 0)
  const registrationNo = `AR_market_${randomBytes(6).toString('hex')}`
  const inserted = await db.execute(sql`INSERT INTO st_agent_registrations
    (registration_no, agent_key, owner_user_id, agent_name, status, fee_status, current_attempt_no, idempotency_key, qualified_at)
    VALUES (${registrationNo}, ${`agent_market_${randomBytes(6).toString('hex')}`}, ${Number(owner.id)}, '公开训练Agent', 'qualified', 'refunded', 1, ${`reg-${randomBytes(6).toString('hex')}`}, NOW())`)
  registrationId = Number((Array.isArray(inserted) ? inserted[0] : inserted as { insertId?: number })?.insertId ?? 0)
  const cycle = await db.execute(sql`INSERT INTO st_agent_training_cycles
    (registration_id, attempt_no, status, starts_at, ends_at, score, reviewed_at)
    VALUES (${registrationId}, 1, 'passed', DATE_SUB(NOW(), INTERVAL 7 DAY), NOW(), 88, NOW())`)
  cycleId = Number((Array.isArray(cycle) ? cycle[0] : cycle as { insertId?: number })?.insertId ?? 0)
  const evidence = 'a'.repeat(64)
  await db.execute(sql`INSERT INTO st_agent_training_tasks
    (cycle_id, day_no, task_key, title, brief, rubric_json, status, available_at, deliverable, evidence_sha256, submitted_at)
    VALUES (${cycleId}, 1, ${`task-${randomBytes(6).toString('hex')}`}, '公开成绩证据', '独立复核交付', JSON_ARRAY('证据完整'), 'reviewed', NOW(), '真实交付', ${evidence}, NOW())`)
  const piiRegistration = await db.execute(sql`INSERT INTO st_agent_registrations (registration_no, agent_key, owner_user_id, agent_name, status, fee_status, current_attempt_no, idempotency_key, qualified_at, showcase_opt_in, public_display_name) VALUES (${`AR_pii_${randomBytes(5).toString('hex')}`}, ${`agent_pii_${randomBytes(5).toString('hex')}`}, ${Number(owner.id)}, '13800138000', 'qualified', 'refunded', 1, ${`reg-${randomBytes(5).toString('hex')}`}, NOW(), 1, '13800138000')`)
  const piiRegistrationId = Number((Array.isArray(piiRegistration) ? piiRegistration[0] : piiRegistration as { insertId?: number })?.insertId ?? 0)
  const piiCycle = await db.execute(sql`INSERT INTO st_agent_training_cycles (registration_id, attempt_no, status, starts_at, ends_at, score, reviewed_at) VALUES (${piiRegistrationId}, 1, 'passed', DATE_SUB(NOW(), INTERVAL 7 DAY), NOW(), 99, NOW())`)
  piiCycleId = Number((Array.isArray(piiCycle) ? piiCycle[0] : piiCycle as { insertId?: number })?.insertId ?? 0)
  await db.execute(sql`INSERT INTO st_agent_training_tasks (cycle_id, day_no, task_key, title, brief, rubric_json, status, available_at, deliverable, evidence_sha256, submitted_at) VALUES (${piiCycleId}, 1, ${`task-${randomBytes(6).toString('hex')}`}, '非法公开名证据', '不得公开手机号', JSON_ARRAY('证据完整'), 'reviewed', NOW(), '敏感原文不公开', ${'b'.repeat(64)}, NOW())`)
  const invalidCycle = await db.execute(sql`INSERT INTO st_agent_training_cycles (registration_id, attempt_no, status, starts_at, ends_at, score, reviewed_at) VALUES (${registrationId}, 2, 'passed', DATE_SUB(NOW(), INTERVAL 7 DAY), NOW(), 99, NOW())`)
  invalidCycleId = Number((Array.isArray(invalidCycle) ? invalidCycle[0] : invalidCycle as { insertId?: number })?.insertId ?? 0)
})

describe('Agent 市场实时 Feed', () => {
  it('公开任务来自 MySQL，成绩默认隐藏，主动授权后可见且不泄露交付原文', async () => {
    if (!enabled) return
    const initial = await readAgentMarketLiveFeed(db)
    expect(initial.source).toBe('mysql')
    const ownJobs = initial.items.filter((item) => item.kind === 'job' && item.title.startsWith(runPrefix))
    expect(ownJobs.map((item) => item.title.slice(runPrefix.length + 1)).sort()).toEqual(['claimed', 'open', 'submitted'])
    expect(ownJobs.every((item) => item.actor === '公开展示企业')).toBe(true)
    expect(initial.skippedInvalidJobs).toBeGreaterThanOrEqual(2)
    expect(initial.items.some((item) => item.title.endsWith('invalid-actor') || item.title.endsWith('reserved-actor'))).toBe(false)
    expect(JSON.stringify(ownJobs)).not.toContain('不应出现企业')
    expect(JSON.stringify(ownJobs)).not.toContain('跨租户私有企业')
    expect(initial.items.some((item) => item.id === `training-${cycleId}`)).toBe(false)
    await expect(workCaller.setTaskVisibility({ token: ownerToken, taskId: publicTaskId, publish: true, publicDisplayName: '官方 13800138000' })).rejects.toThrow()
    const publishedHistory = await workCaller.setTaskVisibility({ token: ownerToken, taskId: privateTaskId, publish: true, publicDisplayName: '历史任务公开名' })
    expect(publishedHistory.publicFeed).toBe(true)
    const withHistory = await readAgentMarketLiveFeed(db)
    expect(withHistory.items.some((item) => item.id === `job-${privateTaskId}` && item.actor === '历史任务公开名')).toBe(true)
    const withdrawn = await workCaller.setTaskVisibility({ token: ownerToken, taskId: publicTaskId, publish: false })
    expect(withdrawn.publicFeed).toBe(false)
    const afterWithdraw = await readAgentMarketLiveFeed(db)
    expect(afterWithdraw.items.some((item) => item.id === `job-${publicTaskId}`)).toBe(false)
    await workCaller.setTaskVisibility({ token: ownerToken, taskId: publicTaskId, publish: true, publicDisplayName: '公开展示企业' })
    const audit = rawRows(await db.execute(sql`SELECT from_feed AS fromFeed, to_feed AS toFeed FROM st_agent_task_visibility_audit WHERE task_id=${publicTaskId} ORDER BY id`))
    expect(audit.map((row) => [Number(row.fromFeed), Number(row.toFeed)])).toEqual([[1, 0], [0, 1]])
    await db.execute(sql`UPDATE st_agent_work_tasks SET status='cancelled' WHERE id=${publicTaskId}`)
    await expect(workCaller.setTaskVisibility({ token: ownerToken, taskId: publicTaskId, publish: true, publicDisplayName: '公开展示企业' })).rejects.toThrow()
    await db.execute(sql`UPDATE st_agent_work_tasks SET status='open' WHERE id=${publicTaskId}`)

    const nullPublished = await workCaller.setTaskVisibility({ token: ownerToken, taskId: nullDepartmentTaskId, publish: true, publicDisplayName: '历史任务公开名' })
    expect(nullPublished.publicFeed).toBe(true)
    const otherUser = rawRows(await db.execute(sql`SELECT id FROM wb_users WHERE authToken=${authTokenHash(otherToken)} LIMIT 1`))[0]
    await db.execute(sql`UPDATE wb_users SET role='manager', departmentId='dept-a' WHERE id=${Number(otherUser.id)}`)
    await expect(workCaller.setTaskVisibility({ token: otherToken, taskId: nullDepartmentTaskId, publish: true, publicDisplayName: '越权公开名' })).rejects.toThrow()
    await db.execute(sql`UPDATE wb_users SET role='member' WHERE id=${Number(otherUser.id)}`)
    const updated = await caller.setShowcase({ token: ownerToken, registrationId, enabled: true, publicDisplayName: '公开实习Agent' })
    expect(updated.showcaseOptIn).toBe(true)
    const showcaseAudit = rawRows(await db.execute(sql`SELECT from_opt_in AS fromOptIn, to_opt_in AS toOptIn, public_display_name AS publicDisplayName FROM st_agent_showcase_visibility_audit WHERE registration_id=${registrationId} ORDER BY id DESC LIMIT 1`))[0]
    expect(showcaseAudit).toMatchObject({ fromOptIn: 0, toOptIn: 1, publicDisplayName: '公开实习Agent' })
    const visible = await readAgentMarketLiveFeed(db)
    const training = visible.items.find((item) => item.kind === 'training' && item.id === `training-${cycleId}`)
    expect(training).toBeTruthy()
    expect(training?.title).toContain('88 分')
    expect(training?.actor).toBe('公开实习Agent')
    expect(training?.actor).not.toBe('公开训练Agent')
    expect(training?.evidenceSha256).toBe('a'.repeat(64))
    expect(visible.items.some((item) => item.id === `training-${invalidCycleId}`)).toBe(false)
    expect(visible.skippedInvalidTraining).toBeGreaterThanOrEqual(2)
    expect(visible.items.some((item) => item.id === `training-${piiCycleId}`)).toBe(false)
    expect(JSON.stringify(visible.items)).not.toContain('13800138000')
    expect(visible.items.some((item) => item.kind === 'job')).toBe(true)
    expect(JSON.stringify(training)).not.toContain('真实交付')
    expect(visible.feedVersion).not.toBe(initial.feedVersion)
    await expect(caller.setShowcase({ token: otherToken, registrationId, enabled: true })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('训练资格失效后仍允许撤回公开授权', async () => {
    if (!enabled) return
    await db.execute(sql`UPDATE st_agent_registrations SET status='disqualified' WHERE id=${registrationId}`)
    await expect(caller.setShowcase({ token: ownerToken, registrationId, enabled: true, publicDisplayName: '不应公开' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const withdrawn = await caller.setShowcase({ token: ownerToken, registrationId, enabled: false })
    expect(withdrawn.showcaseOptIn).toBe(false)
    await db.execute(sql`UPDATE st_agent_registrations SET status='qualified' WHERE id=${registrationId}`)
  })

  it('并发 Feed 共享 5 秒单飞快照，TTL、limit 与 db 身份分别隔离', async () => {
    if (!enabled) return
    const calls: unknown[] = []
    const trackingDb = { execute: vi.fn(async (query: unknown) => { calls.push(query); return db.execute(query as never) }) }
    const [first, second] = await Promise.all([readAgentMarketLiveFeed(trackingDb as never, 29), readAgentMarketLiveFeed(trackingDb as never, 29)])
    expect(first.feedVersion).toBe(second.feedVersion)
    const firstRound = calls.length
    expect(firstRound).toBeGreaterThan(0)
    await new Promise((resolve) => setTimeout(resolve, 5_100))
    await readAgentMarketLiveFeed(trackingDb as never, 29)
    expect(calls.length).toBe(firstRound * 2)
    await readAgentMarketLiveFeed(trackingDb as never, 30)
    expect(calls.length).toBe(firstRound * 3)
    const otherDb = { execute: vi.fn(async (query: unknown) => { calls.push(query); return db.execute(query as never) }) }
    await readAgentMarketLiveFeed(otherDb as never, 29)
    expect(calls.length).toBe(firstRound * 4)
  })

})
