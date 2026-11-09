export const AGENT_RUNTIME_IDS = ['dsh', 'kimi', 'glm', 'workbuddy', 'qwen'] as const
export const AGENT_RUNTIME_PREFERENCES = ['auto', ...AGENT_RUNTIME_IDS] as const
export type AgentRuntimeId = (typeof AGENT_RUNTIME_IDS)[number]
export type AgentRuntimePreference = (typeof AGENT_RUNTIME_PREFERENCES)[number]
export const AGENT_RUNTIME_PLAN_STATUSES = ['planning', 'planned', 'awaiting_selection', 'ready_to_dispatch', 'running', 'awaiting_review', 'attention_required', 'completed', 'failed', 'cancelled'] as const
export const AGENT_RUNTIME_ROLE_STATUSES = ['planned', 'awaiting_selection', 'selected', 'claimed', 'executing', 'awaiting_review', 'accepted', 'rejected', 'failed', 'blocked', 'cancelled'] as const
export type AgentRuntimePlanStatus = (typeof AGENT_RUNTIME_PLAN_STATUSES)[number]
export type AgentRuntimeRoleStatus = (typeof AGENT_RUNTIME_ROLE_STATUSES)[number]
export interface AgentRuntimeTaskInput { role: string; title: string; brief: string; runtime: AgentRuntimePreference }
export const AGENT_RUNTIME_CONTAINER_CONTRACT = {
  protocol: 'numx-agent-runtime-container-v2', canonicalMysql: true, browserIsSourceOfTruth: false,
  eventDriven: true, competitionRequired: true, executedNotDone: true, awaitingReviewNotDelivered: true,
  wageSettlement: 'existing_agent_work_review_only', existingPluginSystemChanged: false,
  existingSubscriptionPackageSystemChanged: false,
} as const
