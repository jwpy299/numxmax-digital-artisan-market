/** 智能工作台共享类型 —— 与 backend-api.md 字段级文档对齐 */

/** 种子示范企业「华辰精工股份有限公司」= enterprises 表第一条（自增 id=1） */
export const DEMO_ENTERPRISE_ID = 1

export interface WorkTaskStep {
  order: number
  kind: 'intent' | 'decompose' | 'dispatch' | 'execute' | 'verify' | 'report' | string
  title: string
  detail: string
  skillName?: string
  tokens?: number
  durationMs: number
  status: 'done' | string
  logs?: string[]
}

export interface WorkTaskReport {
  title: string
  findings: string[]
  suggestions: string[]
  processSummary: string
  skillChain: string[]
  confidence: number
  confidenceGrade: string
  durationMs: number
  tokenCost: number
}

export interface WorkTask {
  id: number
  agentId: number
  enterpriseId: number
  hireRecordId: number | null
  instruction: string
  intentSummary: string
  targetDevice: string | null
  status: 'completed' | 'failed' | string
  steps: WorkTaskStep[]
  report: WorkTaskReport
  confidence: number
  tokenCost: number
  durationMs: number
  memoryWritten: boolean
  createdAt: Date
  agentName?: string | null
  agentCode?: string | null
  agentAvatar?: string | null
}

export interface HiredAgent {
  id: number
  slug: string
  code: string
  name: string
  avatar: string
  industry: string
  capabilityTags: string[]
  monthlyPrice: number
  tasksCompleted: number
  successRate: number
  avgRating: number
  memoryCount: number
  skillCount: number
}

export interface HireItem {
  id: number
  agentId: number
  enterpriseId: number
  periodMonths: number
  monthlyPrice: number
  status: 'trial' | 'active' | 'expired' | 'cancelled' | string
  tasksCompleted: number
  rating: number | null
  startedAt: Date
  endsAt: Date
  agent: HiredAgent | null
}

/** 播放状态：后端一次性生成全部步骤，前端节奏化呈现 */
export type StepPhase = 'pending' | 'active' | 'done'
export type PlaybackStatus = 'idle' | 'running' | 'done'

export interface Playback {
  task: WorkTask | null
  status: PlaybackStatus
  stepPhases: StepPhase[]
  /** 已流出的日志行（带时间戳文本） */
  logs: string[]
  /** 整体进度 0..1（驱动频谱描线） */
  progress: number
  /** 每次播放自增，用于重置 framer 动画 */
  runKey: number
  /** 各步骤的前端展示时长（ms，缩放至约 12s 总时长） */
  stepDisplayMs: number[]
}

export function formatNum(n: number): string {
  return n.toLocaleString('zh-CN')
}

export function formatDateTime(d: Date | string): string {
  const dt = d instanceof Date ? d : new Date(d)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}`
}

export function formatDate(d: Date | string): string {
  const dt = d instanceof Date ? d : new Date(d)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`
}

/** 试用期剩余天数（D-N） */
export function trialDaysLeft(endsAt: Date | string): number {
  const dt = endsAt instanceof Date ? endsAt : new Date(endsAt)
  return Math.max(0, Math.ceil((dt.getTime() - Date.now()) / 86400000))
}
