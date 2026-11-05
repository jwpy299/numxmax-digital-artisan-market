export interface AgentTrainingReviewItem {
  id: number
  dayNo: number
  title: string
  brief: string
  rubric: string[]
  hasDeliverable: 0 | 1
  evidenceSha256: string
  submittedAt: string | Date
  cycleId: number
  attemptNo: number
  endsAt: string | Date
  registrationId: number
  agentName: string
  ownerUserId: number
}
export interface AgentTrainingReviewQueue {
  tasks: AgentTrainingReviewItem[]
  total: number
  truncated: boolean
  rules: {
    maxAttempts: number
    cycleDays: number
    reviewGraceDays: number
    passScore: number
    minTaskScore: number
    reviewQueueLimit: number
  }
}
export type AgentTrainingCycleOutcome = 'qualified' | 'awaiting_retake' | 'disqualified' | null
export type AgentTrainingRefundSettlement = 'not_requested' | 'succeeded' | 'pending_provider' | 'pending_retry' | 'failed'
