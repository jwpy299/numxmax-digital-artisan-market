/**
 * 系统更新机制适配器 —— 超级终端管理后台（admin）用（M51）。
 *
 * 与 DSH 治理适配器同纪律：
 * - DTO 与服务端 api/routers/releaseCenter.ts 返回逐字段对齐；
 * - token 一律请求体字段注入（复用 callWb），绝不进 URL/header；
 * - 全部过程 requireHqAdmin 本厂闸守门（fail-closed），未登录本地直拒（纵深防御）；
 * - 发布/回滚为 C 级：「申请票据 → 另一名负责人确认」双签链路，本层只做透明转发，
 *   双签拦截由服务端强制执行（发起人自确认必被 FORBIDDEN）。
 */
import { callWb, type WbSession } from './wbSession'

export type ReleaseChannel = 'app_apk' | 'wb' | 'admin' | 'portal' | 'server'
export type ReleaseStatus = 'draft' | 'verified' | 'published' | 'rolled_back'
export type ReleaseAction = 'publish' | 'rollback'

/** 与服务端 releaseDto 逐字段对齐 */
export interface ReleaseItem {
  id: number
  channel: ReleaseChannel
  version: string
  artifactUri: string | null
  md5: string | null
  status: ReleaseStatus
  verifier: string | null
  reportRef: string | null
  note: string | null
  createdBy: string
  createdAt: string
  publishedAt: string | null
}

export interface ReleaseTicket {
  ticketNo: string
  action: ReleaseAction
  status: 'pending'
}

export interface ReleaseAuditItem {
  id: number
  releaseId: number | null
  channel: string | null
  actor: string
  action: string
  detail: string | null
  createdAt: string
}

const PATH = 'releaseCenter'

/** 唯一出口：callWb（token 请求体注入）；未登录纵深防御直拒 */
function gov<T>(proc: string, session: WbSession | null, input?: Record<string, unknown>): Promise<T> {
  if (!session?.token) return Promise.reject(new Error('未登录或会话已失效，请重新登录'))
  return callWb<T>('query', `${PATH}.${proc}`, session, input)
}

export function rcList(session: WbSession | null, channel?: ReleaseChannel) {
  return gov<{ ok: true; channels: readonly ReleaseChannel[]; items: ReleaseItem[] }>(
    'list', session, channel ? { channel } : {})
}

export function rcPropose(session: WbSession | null, input: {
  channel: ReleaseChannel; version: string; artifactUri?: string; md5?: string; note?: string
}) {
  return gov<{ ok: true; idempotent: boolean; release: ReleaseItem }>('propose', session, { ...input })
}

export function rcMarkVerified(session: WbSession | null, input: {
  releaseId: number; verifier: string; reportRef?: string
}) {
  return gov<{ ok: true; idempotent: boolean; release: ReleaseItem }>('markVerified', session, { ...input })
}

export function rcRequestTicket(session: WbSession | null, releaseId: number, action: ReleaseAction) {
  return gov<{ ok: true; idempotent: boolean; ticket: ReleaseTicket }>('requestTicket', session, { releaseId, action })
}

export function rcConfirmTicket(session: WbSession | null, ticketNo: string) {
  return gov<{ ok: true; release: ReleaseItem }>('confirmTicket', session, { ticketNo })
}

export function rcAudit(session: WbSession | null, releaseId?: number, limit = 50) {
  return gov<{ ok: true; items: ReleaseAuditItem[] }>('audit', session,
    releaseId ? { releaseId, limit } : { limit })
}

export function rcAdvise(session: WbSession | null, releaseId: number) {
  return gov<{ ok: true; degraded: boolean; advice: string }>('advise', session, { releaseId })
}
