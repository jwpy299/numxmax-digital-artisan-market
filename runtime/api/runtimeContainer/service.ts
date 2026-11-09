import { createHash, randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { TRPCError } from '@trpc/server'
import { getDb } from '../queries/connection'
import { rawRows } from '../queries/rawRows'
import { isDupEntry } from '../queries/dupEntry'
import { effectiveRoleOf, requireDeptScope, requireWbRole } from '../routers/wbSession'
import { agentWorkRouter } from '../routers/agentEmployment'
import { AGENT_RUNTIME_CONTAINER_CONTRACT, AGENT_RUNTIME_IDS, type AgentRuntimeId, type AgentRuntimePreference, type AgentRuntimeTaskInput } from '../../contracts/agentRuntimeContainer'
import { planNaturalLanguage } from './planner'
import { runtimeReady, runtimeRegistry } from './registry'
import { executeRuntimeTask, type RuntimeExecutor } from './adapters'
import { assertRuntimeDelegationConfigured, issueSubmitDelegation, readSubmitDelegation, revokeSubmitDelegation } from './delegation'

const work = agentWorkRouter.createCaller({ clientIp: '127.0.0.1' } as never)
const db = () => getDb()
type Db = ReturnType<typeof getDb>
type Executor = Pick<Db, 'execute'>
type Row = Record<string, unknown>
export type RuntimePlanInput = {
  token: string
  departmentId: string
  idempotencyKey: string
  rewardJobTokens: number
  instruction?: string
  tasks?: AgentRuntimeTaskInput[]
}
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const numberId = (prefix: string) => `${prefix}${Date.now().toString(36).toUpperCase()}${randomBytes(5).toString('hex').toUpperCase()}`
function rows<T = Row>(result: unknown): T[] { return rawRows(result) as T[] }
function insertId(result: unknown): number {
  const first = Array.isArray(result) ? result[0] : result
  return Number((first as { insertId?: unknown })?.insertId ?? 0)
}
function affectedRows(result: unknown): number {
  const first = Array.isArray(result) ? result[0] : result
  return Number((first as { affectedRows?: unknown })?.affectedRows ?? 0)
}
function jsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return null }
}
function departmentsOf(value: unknown): Array<{ id: string; name: string }> {
  const parsed = jsonValue(value)
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const row = item as Row
    const id = String(row.id ?? '').trim()
    return id ? [{ id, name: String(row.name ?? id).trim() }] : []
  })
}
function errorCode(error: unknown): string { return (error instanceof Error ? error.message : 'runtime_unknown_error').slice(0, 96) }
async function audit(tx: Executor, planId: number, roleId: number | null, type: string, actorUserId: number | null, payload: Row = {}) {
  await tx.execute(sql`INSERT INTO st_agent_runtime_events (plan_id, role_id, event_type, actor_user_id, payload_json) VALUES (${planId}, ${roleId}, ${type}, ${actorUserId}, ${JSON.stringify(payload)})`)
}
export function deriveRuntimePlanStatus(input: Array<{ status: string }>): string {
  const statuses = new Set(input.map((item) => item.status))
  if (input.length === 0) return 'failed'
  if (statuses.size === 1 && statuses.has('accepted')) return 'completed'
  if (statuses.size === 1 && statuses.has('cancelled')) return 'cancelled'
  if (statuses.has('executing') || statuses.has('claimed')) return 'running'
  if (statuses.has('awaiting_review')) return 'awaiting_review'
  if (statuses.has('awaiting_selection')) return 'awaiting_selection'
  if (statuses.has('selected')) return 'ready_to_dispatch'
  if (statuses.has('failed') || statuses.has('blocked') || statuses.has('rejected')) return 'attention_required'
  if (statuses.has('planned')) return 'planned'
  return 'attention_required'
}
async function refreshPlanStatus(tx: Executor, planId: number): Promise<void> {
  const roles = rows(await tx.execute(sql`SELECT status FROM st_agent_runtime_roles WHERE plan_id=${planId}`))
  const status = deriveRuntimePlanStatus(roles.map((row) => ({ status: String(row.status) })))
  await tx.execute(sql`UPDATE st_agent_runtime_plans SET status=${status}, version=version+1 WHERE id=${planId}`)
}
async function planRow(executor: Executor, planId: number, lock = false): Promise<Row | undefined> {
  return rows(await executor.execute(sql`SELECT * FROM st_agent_runtime_plans WHERE id=${planId} ${lock ? sql`FOR UPDATE` : sql``} LIMIT 1`))[0]
}
async function scopedPlan(token: string, planId: number) {
  const plan = await planRow(db(), planId)
  if (!plan) throw new TRPCError({ code: 'NOT_FOUND', message: '编排计划不存在' })
  const session = await requireWbRole(token, ['admin', 'manager'], '仅企业负责人或部门负责人可访问编排计划')
  if (Number(session.factory.id) !== Number(plan.factory_id)) throw new TRPCError({ code: 'NOT_FOUND', message: '编排计划不存在或不属于本企业' })
  await requireDeptScope(token, String(plan.department_id))
  return { plan, session }
}
function requireCreator(plan: Row, userId: number): void {
  if (Number(plan.creator_user_id) !== userId) throw new TRPCError({ code: 'FORBIDDEN', message: '仅计划创建人可使用其绑定的 Agent 身份执行此步骤' })
}
async function readPlan(planId: number) {
  const plan = await planRow(db(), planId)
  if (!plan) throw new TRPCError({ code: 'NOT_FOUND', message: '编排计划不存在' })
  const roleRows = rows(await db().execute(sql`SELECT * FROM st_agent_runtime_roles WHERE plan_id=${planId} ORDER BY id ASC`))
  const roleIds = roleRows.map((role) => Number(role.id))
  const candidates = roleIds.length ? rows(await db().execute(sql`SELECT * FROM st_agent_runtime_candidates WHERE role_id IN (${sql.join(roleIds.map((id) => sql`${id}`), sql`,`)}) ORDER BY id ASC`)) : []
  const outbox = rows(await db().execute(sql`SELECT id, plan_id AS planId, role_id AS roleId, event_type AS eventType, dedupe_key AS dedupeKey, payload_json AS payloadJson, status, attempt_count AS attemptCount, max_attempts AS maxAttempts, available_at AS availableAt, last_error AS lastError, processed_at AS processedAt, created_at AS createdAt FROM st_agent_runtime_outbox WHERE plan_id=${planId} ORDER BY id ASC`))
  const events = rows(await db().execute(sql`SELECT id, plan_id AS planId, role_id AS roleId, event_type AS eventType, actor_user_id AS actorUserId, payload_json AS payloadJson, created_at AS createdAt FROM (SELECT * FROM st_agent_runtime_events WHERE plan_id=${planId} ORDER BY id DESC LIMIT 100) e ORDER BY id ASC`))
  return {
    plan: {
      id: Number(plan.id), planNo: String(plan.plan_no), factoryId: Number(plan.factory_id), departmentId: String(plan.department_id), creatorUserId: Number(plan.creator_user_id),
      naturalLanguage: String(plan.natural_language), requestSha256: String(plan.request_sha256), status: String(plan.status),
      planner: plan.planner_provider ? { provider: String(plan.planner_provider), model: String(plan.planner_model), requestSha256: String(plan.planner_request_sha256), responseSha256: String(plan.planner_response_sha256), usageTokens: Number(plan.planner_usage_tokens), latencyMs: Number(plan.planner_latency_ms) } : null,
      plannerError: plan.planner_error ? String(plan.planner_error) : null, version: Number(plan.version), createdAt: plan.created_at, updatedAt: plan.updated_at,
    },
    roles: roleRows.map((role) => ({
      id: Number(role.id), roleNo: String(role.role_no), planId: Number(role.plan_id), role: String(role.role_name), title: String(role.title), brief: String(role.brief),
      rewardJobTokens: Number(role.reward_job_tokens), runtimePreference: String(role.runtime_preference), jobId: role.job_id ? Number(role.job_id) : null,
      selectedApplicationId: role.selected_application_id ? Number(role.selected_application_id) : null, employmentId: role.employment_id ? Number(role.employment_id) : null,
      workTaskId: role.work_task_id ? Number(role.work_task_id) : null, claimId: role.claim_id ? Number(role.claim_id) : null, assignedRuntime: role.assigned_runtime ? String(role.assigned_runtime) : null,
      status: String(role.status), result: role.result_text ? String(role.result_text) : null, resultSha256: role.result_sha256 ? String(role.result_sha256) : null,
      resultProvider: role.result_provider ? String(role.result_provider) : null, resultModel: role.result_model ? String(role.result_model) : null,
      resultUsageTokens: Number(role.result_usage_tokens), resultLatencyMs: Number(role.result_latency_ms), errorCode: role.error_code ? String(role.error_code) : null,
      wageSettled: Number(role.wage_settled) === 1, version: Number(role.version), createdAt: role.created_at, updatedAt: role.updated_at,
      executed: ['executing', 'awaiting_review', 'accepted'].includes(String(role.status)), done: String(role.status) === 'accepted', awaitingReview: String(role.status) === 'awaiting_review',
    })),
    candidates: candidates.map((candidate) => ({ id: Number(candidate.id), roleId: Number(candidate.role_id), runtime: String(candidate.runtime), registrationId: Number(candidate.registration_id), applicationId: candidate.application_id ? Number(candidate.application_id) : null, status: String(candidate.status), errorCode: candidate.error_code ? String(candidate.error_code) : null, createdAt: candidate.created_at, updatedAt: candidate.updated_at })),
    outbox: outbox.map((item) => ({ ...item, id: Number(item.id), planId: Number(item.planId), roleId: Number(item.roleId), eventType: String(item.eventType), status: String(item.status), attemptCount: Number(item.attemptCount), maxAttempts: Number(item.maxAttempts), payload: jsonValue(item.payloadJson), payloadJson: undefined })),
    events: events.map((item) => ({ ...item, id: Number(item.id), planId: Number(item.planId), roleId: item.roleId ? Number(item.roleId) : null, eventType: String(item.eventType), actorUserId: item.actorUserId ? Number(item.actorUserId) : null, payload: jsonValue(item.payloadJson), payloadJson: undefined })),
    contract: AGENT_RUNTIME_CONTAINER_CONTRACT,
  }
}
export async function getRuntimePlan(token: string, planId: number) { await scopedPlan(token, planId); return readPlan(planId) }

export async function bindRuntimeIdentity(args: { token: string; departmentId: string; runtime: AgentRuntimeId; registrationId: number }) {
  const session = await requireWbRole(args.token, ['admin', 'manager'], '仅企业负责人或部门负责人可绑定 runtime 身份')
  await requireDeptScope(args.token, args.departmentId)
  if (!departmentsOf((session.factory as unknown as Row).departments).some((item) => item.id === args.departmentId)) throw new TRPCError({ code: 'FORBIDDEN', message: '部门不存在或不属于本企业' })
  if (!AGENT_RUNTIME_IDS.includes(args.runtime)) throw new TRPCError({ code: 'BAD_REQUEST', message: '未知 runtime' })
  const registration = rows(await db().execute(sql`SELECT id, status FROM st_agent_registrations WHERE id=${args.registrationId} AND owner_user_id=${Number(session.user.id)} LIMIT 1`))[0]
  if (!registration) throw new TRPCError({ code: 'FORBIDDEN', message: '只能绑定本人拥有的 Agent；就业资格将在竞岗时再次核验' })
  await db().execute(sql`INSERT INTO st_agent_runtime_identities (factory_id, department_id, owner_user_id, runtime, registration_id, enabled) VALUES (${session.factory.id}, ${args.departmentId}, ${session.user.id}, ${args.runtime}, ${args.registrationId}, 1) ON DUPLICATE KEY UPDATE registration_id=VALUES(registration_id), enabled=1`)
  return { ok: true as const, runtime: args.runtime, registrationId: args.registrationId, registrationStatus: String(registration.status) }
}
export async function runtimeStatus(token: string, departmentId: string) {
  const session = await requireWbRole(token, ['admin', 'manager'], '仅企业负责人或部门负责人可查看 runtime 控制面')
  await requireDeptScope(token, departmentId)
  const identities = rows(await db().execute(sql`SELECT i.runtime, i.registration_id AS registrationId, r.status AS registrationStatus FROM st_agent_runtime_identities i JOIN st_agent_registrations r ON r.id=i.registration_id WHERE i.factory_id=${session.factory.id} AND i.owner_user_id=${session.user.id} AND BINARY i.department_id=BINARY ${departmentId} AND i.enabled=1`))
  return { runtimes: runtimeRegistry().map((runtime) => ({ ...runtime, identity: identities.find((identity) => String(identity.runtime) === runtime.id) ?? null })), contract: AGENT_RUNTIME_CONTAINER_CONTRACT }
}

export async function createRuntimePlan(input: RuntimePlanInput, planner = planNaturalLanguage) {
  const session = await requireWbRole(input.token, ['admin', 'manager'], '仅企业负责人或部门负责人可创建编排计划')
  await requireDeptScope(input.token, input.departmentId)
  const departments = departmentsOf((session.factory as unknown as Row).departments)
  if (!departments.some((item) => item.id === input.departmentId)) throw new TRPCError({ code: 'FORBIDDEN', message: '部门不存在或不属于本企业' })
  if (Boolean(input.instruction) === Boolean(input.tasks?.length)) throw new TRPCError({ code: 'BAD_REQUEST', message: '自然语言与结构化任务必须二选一' })
  const request = input.instruction ? { mode: 'natural_language', departmentId: input.departmentId, rewardJobTokens: input.rewardJobTokens, instruction: input.instruction } : { mode: 'structured', departmentId: input.departmentId, rewardJobTokens: input.rewardJobTokens, tasks: input.tasks }
  const requestSha256 = sha256(JSON.stringify(request))
  const key = sha256(`agent-runtime-plan:${session.factory.id}:${session.user.id}:${input.idempotencyKey}`)
  const existing = rows(await db().execute(sql`SELECT id, request_sha256 AS requestSha256 FROM st_agent_runtime_plans WHERE idempotency_key=${key} AND factory_id=${session.factory.id} LIMIT 1`))[0]
  if (existing) {
    if (String(existing.requestSha256) !== requestSha256) throw new TRPCError({ code: 'CONFLICT', message: '同一幂等键不得提交不同编排请求' })
    return { ...(await readPlan(Number(existing.id))), already: true }
  }
  const planNo = numberId('RP')
  let planId = 0
  try {
    const inserted = await db().execute(sql`INSERT INTO st_agent_runtime_plans (plan_no, factory_id, department_id, creator_user_id, natural_language, request_sha256, idempotency_key, status) VALUES (${planNo}, ${session.factory.id}, ${input.departmentId}, ${session.user.id}, ${input.instruction ?? JSON.stringify(input.tasks)}, ${requestSha256}, ${key}, 'planning')`)
    planId = insertId(inserted)
  } catch (error) {
    if (!isDupEntry(error)) throw error
    const winner = rows(await db().execute(sql`SELECT id, request_sha256 AS requestSha256 FROM st_agent_runtime_plans WHERE idempotency_key=${key} AND factory_id=${session.factory.id} LIMIT 1`))[0]
    if (!winner) throw error
    if (String(winner.requestSha256) !== requestSha256) throw new TRPCError({ code: 'CONFLICT', message: '同一幂等键不得提交不同编排请求' })
    return { ...(await readPlan(Number(winner.id))), already: true }
  }
  let tasks: AgentRuntimeTaskInput[]
  let evidence: Awaited<ReturnType<typeof planNaturalLanguage>>['evidence'] | null = null
  try {
    if (input.instruction) {
      const planned = await planner({ instruction: input.instruction, departmentId: input.departmentId, departments, availableRuntimes: runtimeRegistry().filter((item) => item.ready).map((item) => item.id) })
      tasks = planned.tasks; evidence = planned.evidence
    } else tasks = input.tasks!
  } catch (error) {
    const code = errorCode(error)
    await db().transaction(async (tx) => {
      await tx.execute(sql`UPDATE st_agent_runtime_plans SET status='failed', planner_error=${code}, version=version+1 WHERE id=${planId}`)
      await audit(tx, planId, null, 'plan.failed', Number(session.user.id), { code })
    })
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '真实自然语言规划未完成，未创建岗位、未调用任何 runtime', cause: error })
  }
  await db().transaction(async (tx) => {
    for (const [index, task] of tasks.entries()) {
      const roleNo = `${planNo}R${index + 1}`
      const inserted = await tx.execute(sql`INSERT INTO st_agent_runtime_roles (role_no, plan_id, role_name, title, brief, reward_job_tokens, runtime_preference, status) VALUES (${roleNo}, ${planId}, ${task.role}, ${task.title}, ${task.brief}, ${input.rewardJobTokens}, ${task.runtime}, 'planned')`)
      await audit(tx, planId, insertId(inserted), 'role.planned', Number(session.user.id), { runtimePreference: task.runtime, rewardJobTokens: input.rewardJobTokens })
    }
    await tx.execute(sql`UPDATE st_agent_runtime_plans SET status='planned', planner_provider=${evidence?.provider ?? null}, planner_model=${evidence?.model ?? null}, planner_request_sha256=${evidence?.requestSha256 ?? null}, planner_response_sha256=${evidence?.responseSha256 ?? null}, planner_usage_tokens=${evidence?.usageTokens ?? 0}, planner_latency_ms=${evidence?.latencyMs ?? 0}, version=version+1 WHERE id=${planId}`)
    await audit(tx, planId, null, 'plan.planned', Number(session.user.id), { roleCount: tasks.length, planner: evidence?.provider ?? 'structured' })
  })
  return { ...(await readPlan(planId)), already: false }
}

export async function openRuntimeCompetition(token: string, planId: number) {
  const { plan, session } = await scopedPlan(token, planId)
  requireCreator(plan, Number(session.user.id))
  if (['running', 'awaiting_review', 'completed', 'cancelled'].includes(String(plan.status))) throw new TRPCError({ code: 'CONFLICT', message: '当前计划状态不可发起竞岗' })
  const roles = rows(await db().execute(sql`SELECT * FROM st_agent_runtime_roles WHERE plan_id=${planId} AND status IN ('planned','awaiting_selection','blocked') ORDER BY id ASC`))
  for (const role of roles) {
    try {
      let jobId = Number(role.job_id ?? 0)
      if (!jobId) {
        const job = await work.publishJob({ token, idempotencyKey: `runtime:${String(plan.plan_no)}:${String(role.role_no)}:job`, departmentId: String(plan.department_id), title: String(role.title), description: String(role.brief), headcount: 1, budgetJobTokens: Number(role.reward_job_tokens) })
        jobId = job.id
        await db().execute(sql`UPDATE st_agent_runtime_roles SET job_id=${jobId}, version=version+1 WHERE id=${Number(role.id)}`)
      }
      const preference = String(role.runtime_preference) as AgentRuntimePreference
      const identities = rows(await db().execute(sql`SELECT runtime, registration_id AS registrationId FROM st_agent_runtime_identities WHERE factory_id=${Number(plan.factory_id)} AND owner_user_id=${Number(plan.creator_user_id)} AND BINARY department_id=BINARY ${String(plan.department_id)} AND enabled=1`))
      const eligible = identities.filter((identity) => (preference === 'auto' || String(identity.runtime) === preference) && runtimeReady(String(identity.runtime) as AgentRuntimeId))
      for (const identity of eligible) {
        const runtime = String(identity.runtime) as AgentRuntimeId
        const registrationId = Number(identity.registrationId)
        const existing = rows(await db().execute(sql`SELECT id, application_id AS applicationId, status FROM st_agent_runtime_candidates WHERE role_id=${Number(role.id)} AND runtime=${runtime} AND registration_id=${registrationId} LIMIT 1`))[0]
        if (existing?.applicationId) continue
        try {
          const application = await work.applyJob({ token, registrationId, jobId, idempotencyKey: `runtime:${String(role.role_no)}:${runtime}:apply`, coverNote: `由 ${runtime} 参与岗位竞聘；录用后方可领取任务。` })
          await db().execute(sql`INSERT INTO st_agent_runtime_candidates (role_id, runtime, registration_id, application_id, status) VALUES (${Number(role.id)}, ${runtime}, ${registrationId}, ${application.applicationId}, 'applied') ON DUPLICATE KEY UPDATE application_id=VALUES(application_id), status='applied', error_code=NULL`)
          await db().transaction(async (tx) => { await audit(tx, planId, Number(role.id), 'candidate.applied', Number(session.user.id), { runtime, registrationId, applicationId: application.applicationId }) })
        } catch (error) {
          await db().execute(sql`INSERT INTO st_agent_runtime_candidates (role_id, runtime, registration_id, status, error_code) VALUES (${Number(role.id)}, ${runtime}, ${registrationId}, 'ineligible', ${errorCode(error)}) ON DUPLICATE KEY UPDATE status='ineligible', error_code=VALUES(error_code)`)
        }
      }
      const applied = rows(await db().execute(sql`SELECT COUNT(*) AS count FROM st_agent_runtime_candidates WHERE role_id=${Number(role.id)} AND status='applied'`))[0]
      const status = Number(applied?.count ?? 0) > 0 ? 'awaiting_selection' : 'blocked'
      await db().execute(sql`UPDATE st_agent_runtime_roles SET status=${status}, error_code=${status === 'blocked' ? 'no_ready_qualified_candidate' : null}, version=version+1 WHERE id=${Number(role.id)}`)
    } catch (error) {
      await db().execute(sql`UPDATE st_agent_runtime_roles SET status='blocked', error_code=${errorCode(error)}, version=version+1 WHERE id=${Number(role.id)}`)
    }
  }
  await db().transaction(async (tx) => { await refreshPlanStatus(tx, planId); await audit(tx, planId, null, 'competition.opened', Number(session.user.id), {}) })
  return readPlan(planId)
}

export async function selectRuntimeCandidate(token: string, candidateId: number) {
  const candidate = rows(await db().execute(sql`SELECT c.*, r.plan_id AS planId, r.id AS roleId, r.status AS roleStatus, p.factory_id AS factoryId, p.department_id AS departmentId, p.creator_user_id AS creatorUserId FROM st_agent_runtime_candidates c JOIN st_agent_runtime_roles r ON r.id=c.role_id JOIN st_agent_runtime_plans p ON p.id=r.plan_id WHERE c.id=${candidateId} LIMIT 1`))[0]
  if (!candidate) throw new TRPCError({ code: 'NOT_FOUND', message: '候选记录不存在' })
  const session = await requireWbRole(token, ['admin', 'manager'], '仅企业负责人或部门负责人可录用')
  if (Number(session.factory.id) !== Number(candidate.factoryId)) throw new TRPCError({ code: 'NOT_FOUND', message: '候选记录不存在或不属于本企业' })
  await requireDeptScope(token, String(candidate.departmentId))
  if (Number(session.user.id) === Number(candidate.creatorUserId)) throw new TRPCError({ code: 'FORBIDDEN', message: '岗位创建人不得录用自己提交的 Agent' })
  if (String(candidate.status) !== 'applied' || !candidate.application_id) throw new TRPCError({ code: 'CONFLICT', message: '候选不在待录用状态' })
  const accepted = await work.reviewApplication({ token, applicationId: Number(candidate.application_id), verdict: 'accept' })
  const employment = rows(await db().execute(sql`SELECT id FROM st_agent_employments WHERE job_id=(SELECT job_id FROM st_agent_runtime_roles WHERE id=${Number(candidate.roleId)}) AND registration_id=${Number(candidate.registration_id)} AND status='active' LIMIT 1`))[0]
  await db().transaction(async (tx) => {
    await tx.execute(sql`UPDATE st_agent_runtime_candidates SET status='selected', error_code=NULL WHERE id=${candidateId}`)
    await tx.execute(sql`UPDATE st_agent_runtime_roles SET status='selected', selected_application_id=${Number(candidate.application_id)}, employment_id=${employment ? Number(employment.id) : null}, assigned_runtime=${String(candidate.runtime)}, version=version+1 WHERE id=${Number(candidate.roleId)}`)
    await audit(tx, Number(candidate.planId), Number(candidate.roleId), 'candidate.selected', Number(session.user.id), { candidateId, employmentCreated: accepted.employmentCreated, wageSettled: false })
    await refreshPlanStatus(tx, Number(candidate.planId))
  })
  const others = rows(await db().execute(sql`SELECT id, application_id AS applicationId FROM st_agent_runtime_candidates WHERE role_id=${Number(candidate.roleId)} AND id<>${candidateId} AND status='applied'`))
  for (const other of others) {
    try {
      await work.reviewApplication({ token, applicationId: Number(other.applicationId), verdict: 'reject' })
      await db().execute(sql`UPDATE st_agent_runtime_candidates SET status='rejected' WHERE id=${Number(other.id)}`)
    } catch { /* 未录用候选保留真实 applied 状态；岗位已满，不能再次被录用 */ }
  }
  return readPlan(Number(candidate.planId))
}

export async function dispatchRuntimePlan(token: string, planId: number) {
  const { plan, session } = await scopedPlan(token, planId)
  requireCreator(plan, Number(session.user.id))
  assertRuntimeDelegationConfigured()
  const roles = rows(await db().execute(sql`SELECT * FROM st_agent_runtime_roles WHERE plan_id=${planId} AND status IN ('selected','claimed') ORDER BY id ASC`))
  if (roles.length === 0) throw new TRPCError({ code: 'CONFLICT', message: '没有已录用且待派发的岗位' })
  for (const role of roles) {
    try {
      let workTaskId = Number(role.work_task_id ?? 0)
      if (!workTaskId) {
        const task = await work.publishTask({ token, idempotencyKey: `runtime:${String(role.role_no)}:task`, departmentId: String(plan.department_id), jobId: Number(role.job_id), title: String(role.title), brief: String(role.brief), rewardJobTokens: Number(role.reward_job_tokens) })
        workTaskId = task.id
        await db().execute(sql`UPDATE st_agent_runtime_roles SET work_task_id=${workTaskId}, version=version+1 WHERE id=${Number(role.id)}`)
      }
      const selected = rows(await db().execute(sql`SELECT registration_id AS registrationId, runtime FROM st_agent_runtime_candidates WHERE role_id=${Number(role.id)} AND status='selected' LIMIT 1`))[0]
      if (!selected) throw new Error('selected_candidate_missing')
      let claimId = Number(role.claim_id ?? 0)
      if (!claimId) {
        const claim = await work.claimTask({ token, registrationId: Number(selected.registrationId), taskId: workTaskId, idempotencyKey: `runtime:${String(role.role_no)}:claim` })
        claimId = claim.claimId
        await db().execute(sql`UPDATE st_agent_runtime_roles SET claim_id=${claimId}, version=version+1 WHERE id=${Number(role.id)}`)
      }
      const activeDelegation = rows(await db().execute(sql`SELECT id FROM st_agent_runtime_delegations WHERE role_id=${Number(role.id)} AND revoked_at IS NULL AND expires_at>NOW() LIMIT 1`))[0]
      if (!activeDelegation) await issueSubmitDelegation(Number(role.id), claimId, Number(plan.creator_user_id), Number(plan.factory_id))
      await db().transaction(async (tx) => {
        await tx.execute(sql`UPDATE st_agent_runtime_roles SET status='claimed', assigned_runtime=${String(selected.runtime)}, error_code=NULL, version=version+1 WHERE id=${Number(role.id)}`)
        await tx.execute(sql`INSERT INTO st_agent_runtime_outbox (plan_id, role_id, event_type, dedupe_key, payload_json, status) VALUES (${planId}, ${Number(role.id)}, 'runtime.execute', ${`runtime.execute:${Number(role.id)}:${claimId}`}, ${JSON.stringify({ claimId, runtime: selected.runtime })}, 'pending') ON DUPLICATE KEY UPDATE id=id`)
        await audit(tx, planId, Number(role.id), 'runtime.execute.queued', Number(session.user.id), { claimId, runtime: selected.runtime })
      })
    } catch (error) {
      await db().execute(sql`UPDATE st_agent_runtime_roles SET status='failed', error_code=${errorCode(error)}, version=version+1 WHERE id=${Number(role.id)}`)
    }
  }
  await db().transaction(async (tx) => { await refreshPlanStatus(tx, planId); await audit(tx, planId, null, 'plan.dispatched', Number(session.user.id), {}) })
  return readPlan(planId)
}

export function runtimeEventBackoffSeconds(attemptCount: number): number { return Math.min(60, 2 ** Math.max(1, attemptCount)) }
type ClaimedEvent = Row & { leaseOwner: string; leaseToken: string }
async function claimOneEvent(connection: Db, workerId: string): Promise<ClaimedEvent | null> {
  return connection.transaction(async (tx) => {
    const item = rows(await tx.execute(sql`SELECT o.*, r.role_no, r.role_name, r.title, r.brief, r.claim_id, r.assigned_runtime, p.factory_id AS factoryId FROM st_agent_runtime_outbox o JOIN st_agent_runtime_roles r ON r.id=o.role_id JOIN st_agent_runtime_plans p ON p.id=o.plan_id WHERE o.status='pending' AND o.available_at<=NOW() AND r.status IN ('claimed','executing') AND p.status NOT IN ('cancelled','completed') ORDER BY o.id ASC LIMIT 1 FOR UPDATE SKIP LOCKED`))[0]
    if (!item) return null
    const leaseToken = randomBytes(32).toString('hex')
    await tx.execute(sql`UPDATE st_agent_runtime_outbox SET status='claimed', lease_owner=${workerId}, lease_token=${leaseToken}, lease_expires_at=DATE_ADD(NOW(), INTERVAL 180 SECOND), attempt_count=attempt_count+1 WHERE id=${Number(item.id)} AND status='pending'`)
    await tx.execute(sql`UPDATE st_agent_runtime_roles SET status='executing', version=version+1 WHERE id=${Number(item.role_id)} AND status IN ('claimed','executing')`)
    await audit(tx, Number(item.plan_id), Number(item.role_id), 'runtime.claimed', null, { workerId, attemptCount: Number(item.attempt_count) + 1 })
    await refreshPlanStatus(tx, Number(item.plan_id))
    return { ...item, leaseOwner: workerId, leaseToken }
  })
}
async function finishEventFailure(item: ClaimedEvent, code: string, resultSha256?: string) {
  const current = rows(await db().execute(sql`SELECT o.status AS outboxStatus, o.attempt_count AS attemptCount, o.max_attempts AS maxAttempts, r.status AS roleStatus, c.status AS claimStatus FROM st_agent_runtime_outbox o JOIN st_agent_runtime_roles r ON r.id=o.role_id LEFT JOIN st_agent_task_claims c ON c.id=r.claim_id WHERE o.id=${Number(item.id)} LIMIT 1`))[0]
  if (current && String(current.claimStatus) === 'submitted') {
    await db().transaction(async (tx) => {
      await tx.execute(sql`UPDATE st_agent_runtime_outbox SET status='done', processed_at=NOW(), lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL WHERE id=${Number(item.id)}`)
      await tx.execute(sql`UPDATE st_agent_runtime_roles SET status='awaiting_review', version=version+1 WHERE id=${Number(item.role_id)}`)
      await refreshPlanStatus(tx, Number(item.plan_id))
    })
    await revokeSubmitDelegation(Number(item.role_id))
    return 'submitted'
  }
  if (!current || String(current.outboxStatus) === 'cancelled' || String(current.roleStatus) === 'cancelled') {
    await db().transaction(async (tx) => { await audit(tx, Number(item.plan_id), Number(item.role_id), 'runtime.outcome_unknown', null, { code, resultSha256: resultSha256 ?? null, reason: 'cancelled_before_completion' }) })
    return 'outcome_unknown'
  }
  const retry = Number(current.attemptCount) < Number(current.maxAttempts)
  await db().transaction(async (tx) => {
    if (retry) {
      const delay = runtimeEventBackoffSeconds(Number(current.attemptCount))
      await tx.execute(sql`UPDATE st_agent_runtime_outbox SET status='pending', available_at=DATE_ADD(NOW(), INTERVAL ${delay} SECOND), last_error=${code}, lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL WHERE id=${Number(item.id)} AND status='claimed' AND lease_owner=${item.leaseOwner} AND lease_token=${item.leaseToken}`)
      await tx.execute(sql`UPDATE st_agent_runtime_roles SET status='claimed', error_code=${code}, version=version+1 WHERE id=${Number(item.role_id)} AND status='executing'`)
      await audit(tx, Number(item.plan_id), Number(item.role_id), 'runtime.retry_scheduled', null, { code, delay })
    } else {
      await tx.execute(sql`UPDATE st_agent_runtime_outbox SET status='failed', last_error=${code}, processed_at=NOW(), lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL WHERE id=${Number(item.id)} AND status='claimed' AND lease_owner=${item.leaseOwner} AND lease_token=${item.leaseToken}`)
      await tx.execute(sql`UPDATE st_agent_runtime_roles SET status='failed', error_code=${code}, version=version+1 WHERE id=${Number(item.role_id)} AND status='executing'`)
      await audit(tx, Number(item.plan_id), Number(item.role_id), 'runtime.failed', null, { code })
    }
    await refreshPlanStatus(tx, Number(item.plan_id))
  })
  if (!retry) await revokeSubmitDelegation(Number(item.role_id))
  return retry ? 'retry' : 'failed'
}
export async function pumpRuntimeEvents(args: { workerId: string; limit?: number; executor?: RuntimeExecutor }) {
  const connection = db()
  const limit = Math.max(1, Math.min(16, Math.floor(args.limit ?? 8)))
  const claimed: ClaimedEvent[] = []
  for (let index = 0; index < limit; index += 1) {
    const item = await claimOneEvent(connection, args.workerId)
    if (!item) break
    claimed.push(item)
  }
  const outcomes = await Promise.all(claimed.map(async (item) => {
    const runtime = String(item.assigned_runtime) as AgentRuntimeId
    const result = await (args.executor ?? executeRuntimeTask)(runtime, { taskNo: String(item.role_no), role: String(item.role_name), title: String(item.title), brief: String(item.brief), factoryId: Number(item.factoryId) }).catch((): { ok: false; runtime: AgentRuntimeId; errorCode: string; latencyMs: number } => ({ ok: false, runtime, errorCode: 'runtime_adapter_crash', latencyMs: 0 }))
    if (!result.ok) return finishEventFailure(item, result.errorCode)
    try {
      const delegation = await readSubmitDelegation(Number(item.role_id))
      if (!delegation || delegation.claimId !== Number(item.claim_id)) {
        return finishEventFailure(item, 'delegation_missing_or_claim_mismatch', result.resultSha256)
      }
      const deliverable = `【${runtime} 实际执行交付】
${result.content}

【证据】resultSha256=${result.resultSha256}; requestSha256=${result.requestSha256}; responseSha256=${result.responseSha256}
【边界】runtime 已执行并提交，仍须独立验收；当前未结算工资。`.slice(0, 18000)
      await work.submitTask({ token: delegation.token, claimId: delegation.claimId, deliverable })
      await db().transaction(async (tx) => {
        const updated = await tx.execute(sql`UPDATE st_agent_runtime_outbox SET status='done', processed_at=NOW(), last_error=NULL, lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL WHERE id=${Number(item.id)} AND status='claimed' AND lease_owner=${item.leaseOwner} AND lease_token=${item.leaseToken}`)
        if (affectedRows(updated) !== 1) throw new Error('runtime_outbox_lease_lost_after_submit')
        await tx.execute(sql`UPDATE st_agent_runtime_roles SET status='awaiting_review', result_text=${result.content}, result_sha256=${result.resultSha256}, result_provider=${result.provider}, result_model=${result.model}, result_usage_tokens=${result.usageTokens}, result_latency_ms=${result.latencyMs}, error_code=NULL, version=version+1 WHERE id=${Number(item.role_id)} AND status='executing'`)
        await audit(tx, Number(item.plan_id), Number(item.role_id), 'runtime.submitted', null, { runtime, resultSha256: result.resultSha256, requestSha256: result.requestSha256, responseSha256: result.responseSha256, agentSession: result.agentSession, wageSettled: false })
        await refreshPlanStatus(tx, Number(item.plan_id))
      })
      await revokeSubmitDelegation(Number(item.role_id))
      return 'submitted'
    } catch (error) { return finishEventFailure(item, errorCode(error), result.resultSha256) }
  }))
  return { claimed: claimed.length, submitted: outcomes.filter((item) => item === 'submitted').length, retries: outcomes.filter((item) => item === 'retry').length, failed: outcomes.filter((item) => item === 'failed').length, outcomeUnknown: outcomes.filter((item) => item === 'outcome_unknown').length, executedNotDone: true }
}

export async function retryRuntimeRole(token: string, roleId: number) {
  const role = rows(await db().execute(sql`SELECT r.*, p.factory_id AS factoryId, p.department_id AS departmentId, p.creator_user_id AS creatorUserId FROM st_agent_runtime_roles r JOIN st_agent_runtime_plans p ON p.id=r.plan_id WHERE r.id=${roleId} LIMIT 1`))[0]
  if (!role) throw new TRPCError({ code: 'NOT_FOUND', message: '编排岗位不存在' })
  const session = await requireWbRole(token, ['admin', 'manager'], '仅企业负责人或部门负责人可重试失败岗位')
  if (Number(session.factory.id) !== Number(role.factoryId)) throw new TRPCError({ code: 'NOT_FOUND', message: '编排岗位不存在或不属于本企业' })
  await requireDeptScope(token, String(role.departmentId))
  requireCreator({ creator_user_id: role.creatorUserId }, Number(session.user.id))
  if (String(role.status) !== 'failed') throw new TRPCError({ code: 'CONFLICT', message: '只有失败岗位可重试' })
  const claim = rows(await db().execute(sql`SELECT status FROM st_agent_task_claims WHERE id=${Number(role.claim_id)} LIMIT 1`))[0]
  if (!claim || String(claim.status) !== 'claimed') throw new TRPCError({ code: 'CONFLICT', message: '原领取已失效，不能沿旧任务重试' })
  assertRuntimeDelegationConfigured()
  await issueSubmitDelegation(roleId, Number(role.claim_id), Number(role.creatorUserId), Number(role.factoryId))
  await db().transaction(async (tx) => {
    await tx.execute(sql`UPDATE st_agent_runtime_outbox SET status='pending', attempt_count=0, available_at=NOW(), last_error=NULL, lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL, processed_at=NULL WHERE role_id=${roleId} AND event_type='runtime.execute' AND status IN ('failed','cancelled')`)
    await tx.execute(sql`UPDATE st_agent_runtime_roles SET status='claimed', error_code=NULL, version=version+1 WHERE id=${roleId} AND status='failed'`)
    await audit(tx, Number(role.plan_id), roleId, 'runtime.retry_requested', Number(session.user.id), { claimId: Number(role.claim_id) })
    await refreshPlanStatus(tx, Number(role.plan_id))
  })
  return readPlan(Number(role.plan_id))
}

export async function reviewRuntimeRole(args: { token: string; roleId: number; verdict: 'accept' | 'reject'; note: string }) {
  const role = rows(await db().execute(sql`SELECT r.*, p.factory_id AS factoryId, p.department_id AS departmentId FROM st_agent_runtime_roles r JOIN st_agent_runtime_plans p ON p.id=r.plan_id WHERE r.id=${args.roleId} LIMIT 1`))[0]
  if (!role) throw new TRPCError({ code: 'NOT_FOUND', message: '编排岗位不存在' })
  const session = await requireWbRole(args.token, ['admin', 'manager'], '仅企业负责人或部门负责人可验收')
  if (Number(session.factory.id) !== Number(role.factoryId)) throw new TRPCError({ code: 'NOT_FOUND', message: '编排岗位不存在或不属于本企业' })
  await requireDeptScope(args.token, String(role.departmentId))
  if (String(role.status) !== 'awaiting_review' || !role.claim_id) throw new TRPCError({ code: 'CONFLICT', message: '只有已提交且待验收岗位可复核' })
  const reviewed = await work.reviewTask({ token: args.token, claimId: Number(role.claim_id), verdict: args.verdict, note: args.note })
  await db().transaction(async (tx) => {
    await tx.execute(sql`UPDATE st_agent_runtime_roles SET status=${args.verdict === 'accept' ? 'accepted' : 'rejected'}, wage_settled=${reviewed.wageSettled ? 1 : 0}, version=version+1 WHERE id=${args.roleId}`)
    await audit(tx, Number(role.plan_id), args.roleId, args.verdict === 'accept' ? 'review.accepted' : 'review.rejected', Number(session.user.id), { wageSettled: reviewed.wageSettled, settledJobTokens: reviewed.settledJobTokens ?? 0 })
    await refreshPlanStatus(tx, Number(role.plan_id))
  })
  return readPlan(Number(role.plan_id))
}

export async function cancelRuntimePlan(token: string, planId: number, reason: string) {
  const { plan, session } = await scopedPlan(token, planId)
  if (['completed', 'cancelled'].includes(String(plan.status))) throw new TRPCError({ code: 'CONFLICT', message: '已完成或已撤销计划不能重复撤销' })
  const roles = rows(await db().execute(sql`SELECT * FROM st_agent_runtime_roles WHERE plan_id=${planId} AND status NOT IN ('accepted','cancelled') ORDER BY id ASC`))
  if (roles.some((role) => String(role.status) === 'awaiting_review')) throw new TRPCError({ code: 'CONFLICT', message: '存在待验收交付，请先独立验收或驳回，不能直接撤销抹掉交付事实' })
  await db().transaction(async (tx) => {
    await tx.execute(sql`UPDATE st_agent_runtime_outbox SET status='cancelled', last_error='plan_cancelled', processed_at=NOW(), lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL WHERE plan_id=${planId} AND status IN ('pending','claimed')`)
    await tx.execute(sql`UPDATE st_agent_runtime_delegations d JOIN st_agent_runtime_roles r ON r.id=d.role_id SET d.revoked_at=NOW() WHERE r.plan_id=${planId} AND d.revoked_at IS NULL`)
  })
  for (const role of roles) {
    if (!role.work_task_id) continue
    try { await work.cancelTask({ token, taskId: Number(role.work_task_id), reason }) }
    catch (error) {
      const claim = rows(await db().execute(sql`SELECT status FROM st_agent_task_claims WHERE id=${Number(role.claim_id)} LIMIT 1`))[0]
      if (String(claim?.status ?? '') !== 'submitted') throw error
      await db().transaction(async (tx) => {
        await tx.execute(sql`UPDATE st_agent_runtime_roles SET status='awaiting_review', version=version+1 WHERE id=${Number(role.id)}`)
        await tx.execute(sql`UPDATE st_agent_runtime_outbox SET status='done', processed_at=NOW(), lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL WHERE role_id=${Number(role.id)} AND status IN ('claimed','cancelled')`)
        await audit(tx, planId, Number(role.id), 'cancel.rejected_submitted', Number(session.user.id), { claimId: Number(role.claim_id) })
        await refreshPlanStatus(tx, planId)
      })
      throw new TRPCError({ code: 'CONFLICT', message: '交付已先行提交，计划不能撤销；请先完成独立验收', cause: error })
    }
  }
  await db().transaction(async (tx) => {
    for (const role of roles) {
      await tx.execute(sql`UPDATE st_agent_runtime_roles SET status='cancelled', error_code=${`cancelled:${reason.slice(0, 80)}`}, version=version+1 WHERE id=${Number(role.id)}`)
      await audit(tx, planId, Number(role.id), 'role.cancelled', Number(session.user.id), { previousStatus: role.status, reasonLength: reason.length })
    }
    await refreshPlanStatus(tx, planId)
    await audit(tx, planId, null, 'plan.cancelled', Number(session.user.id), { reasonLength: reason.length })
  })
  return readPlan(planId)
}

export async function listRuntimePlans(token: string) {
  const session = await requireWbRole(token, ['admin', 'manager'], '仅企业负责人或部门负责人可查看编排计划')
  const role = await effectiveRoleOf(session.user)
  const scope = role === 'admin' ? sql`1=1` : sql`BINARY department_id=BINARY ${String(session.user.departmentId ?? '')}`
  const plans = rows(await db().execute(sql`SELECT id FROM st_agent_runtime_plans WHERE factory_id=${session.factory.id} AND ${scope} ORDER BY id DESC LIMIT 20`))
  return Promise.all(plans.map((plan) => getRuntimePlan(token, Number(plan.id))))
}
let workerTimer: ReturnType<typeof setInterval> | null = null
let workerRunning = false
export function startRuntimeContainerWorker(): void {
  if (workerTimer || process.env.AGENT_RUNTIME_CONTAINER_WORKER !== '1') return
  const workerId = String(process.env.AGENT_RUNTIME_CONTAINER_WORKER_ID ?? '').trim()
  if (!workerId) throw new Error('AGENT_RUNTIME_CONTAINER_WORKER_ID_REQUIRED')
  const tick = async () => {
    if (workerRunning) return
    workerRunning = true
    try { await pumpRuntimeEvents({ workerId, limit: 8 }) }
    catch (error) { console.error('[agent-runtime] worker tick failed:', error instanceof Error ? error.message.slice(0, 120) : 'unknown') }
    finally { workerRunning = false }
  }
  void tick()
  workerTimer = setInterval(() => void tick(), 2000)
  workerTimer.unref()
}
