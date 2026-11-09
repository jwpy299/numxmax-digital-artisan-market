import { z } from 'zod'
import { createRouter, publicQuery } from '../middleware'
import { AGENT_RUNTIME_CONTAINER_CONTRACT, AGENT_RUNTIME_IDS, AGENT_RUNTIME_PREFERENCES } from '../../contracts/agentRuntimeContainer'
import { AGENT_RUNTIME_PLUGIN_PROTOCOL } from '../../contracts/agentRuntimePlugin'
import { JOB_TOKEN_AMOUNT_MAX, JOB_TOKEN_AMOUNT_MIN } from '../../contracts/agentEmploymentRules'
import { runtimeStatus, bindRuntimeIdentity, cancelRuntimePlan, createRuntimePlan, dispatchRuntimePlan, getRuntimePlan, listRuntimePlans, openRuntimeCompetition, reviewRuntimeRole, retryRuntimeRole, selectRuntimeCandidate } from '../runtimeContainer/service'

const token = z.string().trim().min(1)
const idempotencyKey = z.string().trim().min(8).max(96)
const departmentId = z.string().trim().min(1).max(64)
const taskInput = z.object({ role: z.string().trim().min(2).max(96), title: z.string().trim().min(2).max(160), brief: z.string().trim().min(4).max(4000), runtime: z.enum(AGENT_RUNTIME_PREFERENCES) }).strict()
const createInput = z.object({
  token, departmentId, idempotencyKey,
  rewardJobTokens: z.number().int().min(JOB_TOKEN_AMOUNT_MIN).max(JOB_TOKEN_AMOUNT_MAX),
  instruction: z.string().trim().min(4).max(6000).optional(), tasks: z.array(taskInput).min(1).max(8).optional(),
}).strict().refine((value) => Boolean(value.instruction) !== Boolean(value.tasks?.length), { message: '自然语言与结构化任务必须二选一' })

export const agentRuntimeContainerRouter = createRouter({
  runtimes: publicQuery.input(z.object({ token, departmentId }).strict()).query(async ({ input }) => runtimeStatus(input.token, input.departmentId)),
  bindIdentity: publicQuery.input(z.object({ token, departmentId, runtime: z.enum(AGENT_RUNTIME_IDS), registrationId: z.number().int().positive() }).strict()).mutation(async ({ input }) => bindRuntimeIdentity(input)),
  createPlan: publicQuery.input(createInput).mutation(async ({ input }) => createRuntimePlan(input)),
  plan: publicQuery.input(z.object({ token, planId: z.number().int().positive() }).strict()).query(async ({ input }) => getRuntimePlan(input.token, input.planId)),
  list: publicQuery.input(z.object({ token }).strict()).query(async ({ input }) => listRuntimePlans(input.token)),
  openCompetition: publicQuery.input(z.object({ token, planId: z.number().int().positive() }).strict()).mutation(async ({ input }) => openRuntimeCompetition(input.token, input.planId)),
  selectCandidate: publicQuery.input(z.object({ token, candidateId: z.number().int().positive() }).strict()).mutation(async ({ input }) => selectRuntimeCandidate(input.token, input.candidateId)),
  dispatch: publicQuery.input(z.object({ token, planId: z.number().int().positive() }).strict()).mutation(async ({ input }) => dispatchRuntimePlan(input.token, input.planId)),
  retry: publicQuery.input(z.object({ token, roleId: z.number().int().positive() }).strict()).mutation(async ({ input }) => retryRuntimeRole(input.token, input.roleId)),
  review: publicQuery.input(z.object({ token, roleId: z.number().int().positive(), verdict: z.enum(['accept', 'reject']), note: z.string().trim().min(4).max(1000) }).strict()).mutation(async ({ input }) => reviewRuntimeRole(input)),
  cancel: publicQuery.input(z.object({ token, planId: z.number().int().positive(), reason: z.string().trim().min(4).max(200) }).strict()).mutation(async ({ input }) => cancelRuntimePlan(input.token, input.planId, input.reason)),
  contract: publicQuery.query(async () => AGENT_RUNTIME_CONTAINER_CONTRACT),
  protocol: publicQuery.query(async () => AGENT_RUNTIME_PLUGIN_PROTOCOL),
})
