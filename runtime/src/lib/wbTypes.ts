/**
 * 工作台服务端响应类型（与 api/routers/agentic|nebulaLink|workbenchMarket|showroomPortal
 * 及《NumX Max 智能工作台 API 文档》字段级对齐；仅声明前端用到的形状）。
 */

export interface WbDepartment {
  id: string
  name: string
  headcount?: string
  duty?: string
}

/** agentic.enterpriseActiveProfile / authMe.profile */
export interface WbEnterpriseProfile {
  factoryId: number
  enterpriseName: string
  industry: string
  industryGroup?: string | null
  industryText: string | null
  creditCode?: string | null
  headcount: string
  departments: WbDepartment[]
  painPoints: string | null
  profile: Record<string, unknown> | null
}

/** agentic.orgMembers 行 */
export interface WbOrgMember {
  deptId: string | null
  deptName: string | null
  name: string
  memberRole: string // admin / owner / member / dept_head
  username: string
}

/** agentic.authMe 输出（个人账号 profile=null，factoryId=0） */
export interface WbAuthMe {
  user: {
    id: number
    username: string
    displayName: string
    role: string
    kind?: 'person' | 'enterprise'
    phone?: string | null
    factoryId: number
    departmentId: string | null
  }
  profile: WbEnterpriseProfile | null
}

/** nebulaLink.consumeWorkbenchTicket 输出 */
export interface WbConsumeResult {
  token: string
  username: string
  displayName: string
  enterpriseName: string
  factoryId: number
  role: string
  target: string
  profileSummary: {
    industry: string
    industryText: string | null
    headcount: string
    deptCount: number
    departments: WbDepartment[]
    painPoints: string | null
  }
}

/** workbenchMarket.issuePublishKey 输出（publishKey 明文仅本次返回） */
export interface WbIssuedKey {
  publishKey: string
  keyId: number
  assetType: 'skill' | 'agent' | 'both'
  expiresAt: Date
}

/** workbenchMarket.myPublishKeys 行（无 hash / 无明文） */
export interface WbPublishKeyMeta {
  keyId: number
  assetType: 'skill' | 'agent' | 'both'
  expiresAt: Date
  revokedAt: Date | null
  createdAt: Date
  status: 'active' | 'expired' | 'revoked'
}

/** workbenchMarket.myHireContracts 行 */
export interface WbHireContract {
  id: number
  factoryId: number
  listingId: number
  roleScope: string
  workMode: string
  trialDays: number | null
  note: string | null
  status: 'pending' | 'active' | 'rejected'
  decidedBy: number | null
  decidedAt: Date | null
  createdAt: Date
  listingTitle: string | null
  listingType: 'skill' | 'agent' | null
}

/** showroomPortal.status 输出 */
export interface WbShowroomStatus {
  factoryId: number
  enterpriseName: string
  publication: {
    status: 'learning' | 'pending_confirm' | 'published' | 'rejected'
    score: number
    requestedAt: Date | null
    decidedAt: Date | null
    productCount: number
  }
  learning: {
    score: number
    metrics: { memberCount: number; departmentCount: number; listedCount: number }
    thresholds: { memberCount: number; departmentCount: number; listedCount: number; readyScore: number }
    missing: string[]
  }
  ready: boolean
}

/** agentic.orgAutoSetup 输出（幂等；reused:true 表示返回既有结果） */
export interface WbRoleAgentAssignment {
  role: string
  agentName: string
  agentId: number | null
  agentSource: 'market' | 'listing'
}

export interface WbOrgAutoSetupResult {
  departments: { name: string; roles: WbRoleAgentAssignment[] }[]
  summary: string
  generatedBy: string
  reused: boolean
}

/** showroomPortal.metrics 输出（公开，无需 token） */
export interface WbShowroomMetrics {
  factoryId: number
  enterpriseName: string
  capacity: number
  yieldRate: number
  availability: string
  gatewayHeartbeat: Date
  endorsedBy: '决策基因链'
  tokenRevenue: {
    total: number
    lastMonth: number
    unsettled: number
    source: string
    note: string
  }
}

/** workbenchMarket.forgePackage 输出 */
export interface WbForgeDraft {
  name: string
  category: string
  description: string
  priceSuggested: number
  pricingModel: string
  delivery: string
  masterName: string
  years: number
  complexity: number
}

export interface WbForgeResult {
  listingId: number
  status: 'pending'
  draft: WbForgeDraft
  geneEventId: string
  message: string
}

/** showroomPortal.requestPublication 输出（未达标为正常返回 ok:false，非异常） */
export interface WbRequestPublicationResult {
  ok: boolean
  status: 'learning' | 'pending_confirm' | 'published'
  score: number
  metrics: { memberCount: number; departmentCount: number; listedCount: number }
  missing?: string[]
  thresholds: { memberCount: number; departmentCount: number; listedCount: number; readyScore: number }
  message: string
}


// ─── evolution（进化中枢：memory / identity / tools / autonomy）───────────────

/** 工业记忆库分区 */
export type WbEvoStore = 'events' | 'entities' | 'insights' | 'domain' | 'cases'

/** memory.recall 行 */
export interface WbEvoRecallItem {
  id: number
  store: WbEvoStore
  text: string
  metadata: Record<string, unknown> | null
  severity: number // 1-5
  similarity: number
  createdAt: Date
}

export interface WbEvoRecallResult {
  total: number
  items: WbEvoRecallItem[]
}

/** memory.write 输出 */
export interface WbEvoWriteResult {
  id: number
  store: WbEvoStore
  embeddingDim: number
}

/** memory.reflect 输出 */
export interface WbEvoReflectResult {
  newInsights: string[]
  skipped: number
  trigger: 'count' | 'shift' | 'anomaly'
}

/** autonomy 调度步骤 */
export interface WbEvoPlanStep {
  seq: number
  action: string
  target: string
  rationale: string
  durationMs: number
  riskLevel: 'low' | 'medium' | 'high'
}

export type WbEvoPlanStatus =
  | 'awaiting_confirm'
  | 'exempted_auto'
  | 'executing'
  | 'done'
  | 'rejected'
  | 'expired_rejected'

/** wb_evo_plans 行（autonomy.tick/get 返回） */
export interface WbEvoPlan {
  id: number
  planId: string
  factoryId: number
  agentId: number
  goal: string
  schedule: WbEvoPlanStep[]
  reasoning: { summary: string; appliedInsights: string[] }
  status: WbEvoPlanStatus
  confirmDeadline: Date | null
  trustLevel: number
  createdAt: Date
  updatedAt: Date
}

/** autonomy.plan 输出 */
export interface WbEvoPlanResult {
  planId: string
  status: 'awaiting_confirm' | 'exempted_auto'
  goal: string
  schedule: WbEvoPlanStep[]
  reasoning: { summary: string; appliedInsights: string[] }
  trustLevel: number
  confirmDeadline: Date | null
  message: string
}

/** autonomy.confirm 输出（approve / reject / 非 awaiting 三种并集） */
export interface WbEvoConfirmResult {
  ok: boolean
  planId?: string
  status: WbEvoPlanStatus
  message: string
  executedSteps?: number
  trustLevel?: number
  consecutiveApprovals?: number
  leveledUp?: boolean
  reflection?: WbEvoReflectResult
}

/** autonomy.tick 输出 */
export interface WbEvoTrustRow {
  agentId: number
  level: number
  consecutiveApprovals: number
  totalPlans: number
}

export interface WbEvoTickResult {
  settled: number
  plans: WbEvoPlan[]
  trust: WbEvoTrustRow[]
}

/** identity.issue 输出（reused:true 表示幂等返回既有卡） */
export interface WbEvoIdentityCard {
  name: string
  role: string
  skillFingerprint: string
  issuedBy: string
  trustLevel: number
}

export interface WbEvoIssueResult {
  did: string
  blockHash: string
  blockHeight: number
  card: WbEvoIdentityCard
  quota: number
  keyState: string
  reused?: boolean
}

/** identity.verify 输出（valid:true 带卡片；false 带 reason） */
export interface WbEvoVerifyResult {
  valid: boolean
  reason?: string
  card?: WbEvoIdentityCard
  blockHeight?: number
  keyState?: string
  quota?: number
}

/** identity.chain 输出 */
export interface WbEvoChainBlock {
  blockHeight: number
  did: string
  agentName: string
  keyState: string
  quota: number
  blockHash: string
  prevHash: string
  createdAt: Date
}

export interface WbEvoChainResult {
  factoryId: number
  height: number
  blocks: WbEvoChainBlock[]
}

/** tools.catalog 输出（只读展示） */
export interface WbEvoToolAction {
  name: string
  description: string
  params: Record<string, unknown>
}

export interface WbEvoToolsCatalog {
  providers: { provider: string; actions: WbEvoToolAction[] }[]
  total: number
}

/** hire.list 入参（主市场路由；token 必传且在请求体，enterpriseId 必须等于会话 factoryId，否则 FORBIDDEN） */
export interface WbHireListInput {
  token: string
  enterpriseId: number
  status?: 'trial' | 'active' | 'expired' | 'cancelled'
}

/** hire.list 行关联的 agent（agents 表 leftJoin，可空；字段对齐 db/schema.ts agents，仅声明前端用到的） */
export interface WbHireAgent {
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

/**
 * hire.list 行（主市场路由，enterpriseId 对齐 factoryId，M22 F1 起 token 在请求体）。
 * 出参对齐 api/routers/hire.ts list：agent_hire_records 全行 + leftJoin agents（经 superjson，日期为 Date）。
 */
export interface WbHireRow {
  id: number
  agentId: number
  enterpriseId: number
  periodMonths: number
  monthlyPrice: number
  status: 'trial' | 'active' | 'expired' | 'cancelled' | string
  tasksCompleted: number
  rating: number | null
  review?: string | null
  startedAt: Date
  endsAt: Date
  createdAt?: Date
  agent: WbHireAgent | null
}

// ─── 迭代 21：账号分发权限化 + 组织架构智能配置（wbOrg / agentic.orgMember*）────

/** agentic.orgMemberList 行 */
export interface WbOrgMemberRow {
  userId: number
  username: string
  displayName: string
  role: string // admin / owner / member / dept_head
  deptId: string | null
  deptName: string | null
  disabled: boolean
  createdAt: string | Date
}

/** wbOrg.orgSmartSetup / 配置摘要中的部门 Agent */
export interface WbOrgDeptAgent {
  deptId: string
  deptName: string
  agentName: string
  title: string
  status?: string
  generatedBy?: string
}

/** wbOrg.orgSmartSetup 输出 */
export interface WbOrgSetupResult {
  needsConfirm: boolean
  brain: { name: string; persona?: string | null; generatedBy?: string }
  departments: WbOrgDeptAgent[]
  degraded: boolean
  generatedBy: 'llm' | 'rule'
}

/** wbOrg.orgConfig 输出 */
export interface WbOrgConfig {
  brain: { name: string; persona?: string | null; status: string; generatedBy?: string } | null
  departments: WbOrgDeptAgent[]
  scope: 'admin' | 'dept_head' | 'member'
}

/** wbOrg.orgChatStart 输出 */
export interface WbOrgChatStart {
  threadId: number
  agent: { targetType: 'brain' | 'deptAgent'; targetId: string; name: string; title: string; deptName: string | null }
  history: WbOrgChatMessage[]
}

export interface WbOrgChatMessage {
  id: number
  role: string
  content: string
  provider: string | null
  degraded: boolean
  createdAt: string | Date
}

/** wbOrg.orgChatSend 输出 */
export interface WbOrgChatSendResult {
  content: string
  provider: string | null
  model: string | null
  degraded: boolean
  agentName: string
  agentTitle: string
}
