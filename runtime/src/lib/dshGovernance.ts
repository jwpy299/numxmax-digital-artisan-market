/**
 * DSH 服务端治理适配器 —— 智能工作台（wb）与超级终端管理后台（admin）共用。
 *
 * 与 NumX Max APP 端 src/dsh/serverGovernance.ts 同契约、同纪律：
 * - DTO 与服务端 contracts/dshGovernance.ts 逐字段对齐；
 * - token 一律请求体字段注入（复用 callWb），绝不进 URL/header；
 * - 绝不携带 factoryId——factoryId 只能由服务端会话解析，客户端传了就是越权；
 * - 服务端九个过程均为 publicQuery 语义，本适配器全部走 query 通道
 *   （wbSession 的 httpBatchLink 已 methodOverride: 'POST'，物理上全是 POST）；
 * - C 级动作走「申请票据 → 另一名本厂 admin 确认」双签链路，本适配器只做透明转发，
 *   双签拦截由服务端强制执行（发起人自确认必被 FORBIDDEN）。
 * - 治理返回文本上屏前仍须过脱敏兜底的页面自行处理；本层不做文案改写。
 */
import { callWb, type WbSession } from './wbSession'

export type DshGovRisk = 'A' | 'B' | 'C'
export type DshGovAutonomy = 'L0' | 'L1' | 'L2' | 'L3' | 'L4'
export type DshGovKind = 'skill' | 'employee' | 'workflow'
export type DshGovContractStatus = 'proposed' | 'shadow' | 'active' | 'retired' | 'rolled_back'
export type DshGovTicketAction = 'install' | 'rollback' | 'retire'
export type DshGovTicketStatus = 'pending' | 'consumed' | 'cancelled'

/** 与服务端 contracts/dshGovernance.ts DshContractDto 逐字段对齐 */
export interface DshGovContract {
  id: number
  contractNo: string
  requestId: string
  factoryId: number
  capabilityKey: string
  kind: DshGovKind
  risk: DshGovRisk
  autonomy: DshGovAutonomy
  permissions: string[]
  budgetMonthly: number
  budgetUsed: number
  status: DshGovContractStatus
  successCount: number
  failCount: number
  evalScore: number
  createdBy: string
  createdAt: string
  updatedAt: string
}

/** 与服务端 DshTicketDto 对齐 */
export interface DshGovTicket {
  id: number
  ticketNo: string
  factoryId: number
  contractId: number
  action: DshGovTicketAction
  status: DshGovTicketStatus
  createdBy: string
  confirmedBy: string | null
  createdAt: string
  consumedAt: string | null
}

/** 与服务端 DshAuditDto 对齐（detail 服务端已脱敏） */
export interface DshGovAudit {
  id: number
  factoryId: number
  contractId: number | null
  actor: string
  action: string
  risk: DshGovRisk | null
  detail: string
  createdAt: string
}

export interface DshGovProposeInput {
  requestId: string
  capabilityKey: string
  kind: DshGovKind
  risk: DshGovRisk
  autonomy: DshGovAutonomy
  permissions?: string[]
  budgetMonthly: number
}

export interface DshGovProposeResult {
  ok: true
  idempotent: boolean
  contract: DshGovContract
  ticket: DshGovTicket | null
}

export interface DshGovTicketResult {
  ok: true
  idempotent: boolean
  ticket: DshGovTicket
}

export interface DshGovContractResult {
  ok: true
  contract: DshGovContract
}

export interface DshGovTrialInput {
  contractId: number
  success: boolean
  cost?: number
  autonomous?: boolean
  note?: string
}

export interface DshGovEvaluateResult {
  ok: true
  promoted: boolean
  score: number
  contract: DshGovContract
}

const PATH = 'dshGovernance'

function gov<T>(proc: string, session: WbSession | null, input?: Record<string, unknown>): Promise<T> {
  // 纵深防御：与 APP 端「缺少登录态」直拒同口径，未登录绝不发请求
  if (!session?.token) return Promise.reject(new Error('未登录或会话已失效，请重新登录'))
  return callWb<T>('query', `${PATH}.${proc}`, session, input)
}

/** 本厂合同列表（factoryId 服务端会话解析，客户端不传） */
export function dshGovContracts(session: WbSession | null, status?: DshGovContractStatus): Promise<DshGovContract[]> {
  return gov<DshGovContract[]>('contracts', session, status ? { status } : {})
}

/** 能力安装/雇佣提案（requestId 幂等；C 级自动签发 install 票据） */
export function dshGovPropose(session: WbSession | null, input: DshGovProposeInput): Promise<DshGovProposeResult> {
  return gov<DshGovProposeResult>('propose', session, { ...input })
}

/** C 级 rollback/retire 申请一次性票据 */
export function dshGovRequestTicket(
  session: WbSession | null,
  contractId: number,
  action: 'rollback' | 'retire',
): Promise<DshGovTicketResult> {
  return gov<DshGovTicketResult>('requestTicket', session, { contractId, action })
}

/** 票据确认：C 级必须双签——发起人确认自己的票据会被服务端拒绝（设计使然） */
export function dshGovConfirmTicket(session: WbSession | null, ticketNo: string): Promise<DshGovContractResult> {
  return gov<DshGovContractResult>('confirmTicket', session, { ticketNo })
}

/** 影子/正式试用记账（预算服务端条件扣减，客户端不算账） */
export function dshGovTrial(session: WbSession | null, input: DshGovTrialInput): Promise<DshGovContractResult> {
  return gov<DshGovContractResult>('trial', session, { ...input })
}

/** 沙箱评估晋升 */
export function dshGovEvaluate(session: WbSession | null, contractId: number): Promise<DshGovEvaluateResult> {
  return gov<DshGovEvaluateResult>('evaluate', session, { contractId })
}

/** A/B 直接回滚；C 级走 dshGovRequestTicket + dshGovConfirmTicket */
export function dshGovRollback(session: WbSession | null, contractId: number, reason: string): Promise<DshGovContractResult> {
  return gov<DshGovContractResult>('rollback', session, { contractId, reason })
}

/** A/B 直接退休；C 级走 dshGovRequestTicket + dshGovConfirmTicket */
export function dshGovRetire(session: WbSession | null, contractId: number, reason: string): Promise<DshGovContractResult> {
  return gov<DshGovContractResult>('retire', session, { contractId, reason })
}

/** 本厂治理审计（detail 服务端已脱敏） */
export function dshGovAudit(session: WbSession | null, contractId?: number): Promise<DshGovAudit[]> {
  return gov<DshGovAudit[]>('audit', session, contractId ? { contractId } : {})
}
