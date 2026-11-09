import { z } from 'zod'
import { AGENT_RUNTIME_PREFERENCES, type AgentRuntimeTaskInput } from '../../contracts/agentRuntimeContainer'
import { callScnetInference, SCNET_MODEL } from '../lib/scnetRuntime'

const PLANNER_MODEL = 'DeepSeek-V4.1-Flash-1017'
if (SCNET_MODEL !== PLANNER_MODEL) throw new Error('agent_runtime_planner_model_mismatch')

const taskSchema = z.object({
  role: z.string().trim().min(2).max(96),
  title: z.string().trim().min(2).max(160),
  brief: z.string().trim().min(4).max(4000),
  runtime: z.enum(AGENT_RUNTIME_PREFERENCES),
}).strict()
const planSchema = z.object({ tasks: z.array(taskSchema).min(1).max(8) }).strict()

export interface PlannerEvidence {
  provider: 'scnet'
  model: string
  requestSha256: string
  responseSha256: string
  usageTokens: number
  latencyMs: number
}
export interface NaturalLanguagePlan {
  tasks: AgentRuntimeTaskInput[]
  evidence: PlannerEvidence
}

export function parsePlannerContent(content: string): AgentRuntimeTaskInput[] {
  const trimmed = content.trim()
  const unfenced = trimmed.startsWith('```') && trimmed.endsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    : trimmed
  let raw: unknown
  try { raw = JSON.parse(unfenced) } catch { throw new Error('agent_runtime_planner_invalid_json') }
  const parsed = planSchema.safeParse(raw)
  if (!parsed.success) throw new Error('agent_runtime_planner_invalid_plan')
  return parsed.data.tasks
}

export async function planNaturalLanguage(args: {
  instruction: string
  departmentId: string
  departments: Array<{ id: string; name: string }>
  availableRuntimes: string[]
  fetchImpl?: typeof fetch
}): Promise<NaturalLanguagePlan> {
  const system = [
    '你是企业多Agent编排规划器，只输出严格JSON，不执行任何任务。',
    '把用户自然语言拆成1至8个可并行岗位任务，字段只能是tasks[{role,title,brief,runtime}]。',
    'runtime只能是auto,dsh,kimi,glm,workbuddy,qwen；auto表示由系统从已接通适配器分配。',
    `当前已接通runtime：${args.availableRuntimes.join(',') || '无'}。未接通的命名runtime不得强行分配，可用auto让用户后续看到阻断。`,
    `当前部门：${args.departmentId}；企业部门目录：${JSON.stringify(args.departments)}。`,
    'brief必须写清岗位责任、具体交付物与已知边界；不得编造已执行结果，不得包含薪资或自动验收指令。',
  ].join('\n')
  const result = await callScnetInference({
    messages: [{ role: 'system', content: system }, { role: 'user', content: args.instruction }],
    maxTokens: 1800, temperature: 0.1, timeoutMs: 60_000, fetchImpl: args.fetchImpl,
  })
  if (!result.ok) throw new Error(`agent_runtime_planner_${result.reason}`)
  return {
    tasks: parsePlannerContent(result.content),
    evidence: {
      provider: result.provider, model: result.model, requestSha256: result.requestSha256,
      responseSha256: result.responseSha256, usageTokens: result.usageTokens, latencyMs: result.latencyMs,
    },
  }
}
