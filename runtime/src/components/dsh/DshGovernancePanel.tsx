/**
 * DshGovernancePanel —— DSH 服务端治理闭环面板（智能工作台 / 超级终端管理后台共用）。
 *
 * 与 NumX Max APP 端 DshSandboxRuntimePanel 的服务端治理区同契约：
 * - 全部调用走 src/lib/dshGovernance.ts（token 请求体注入、无 factoryId、superjson 通道）；
 * - C 级动作（安装/回滚/退休）服务端强制双签：发起人申请票据后，必须由另一名本厂
 *   admin 在「票据确认」区输入票据号完成确认，发起人自确认会被服务端 FORBIDDEN 拒绝；
 * - 面板只读本厂数据（factoryId 服务端会话解析）；
 * - 审计 detail 服务端已脱敏，本组件原样展示不二次加工。
 */
import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, ShieldCheck, FileSignature, ListChecks } from 'lucide-react'
import { useWbSession, wbErrorMessage } from '@/lib/wbSession'
import {
  dshGovAudit, dshGovConfirmTicket, dshGovContracts, dshGovEvaluate, dshGovPropose,
  dshGovRequestTicket, dshGovRetire, dshGovRollback, dshGovTrial,
  type DshGovAudit, type DshGovAutonomy, type DshGovContract, type DshGovKind, type DshGovRisk,
} from '@/lib/dshGovernance'
import { WbButton, wbInputCls } from '@/components/wb/ui'
import { cn } from '@/lib/utils'

const RISK_LABEL: Record<DshGovRisk, string> = { A: 'A 级·只读', B: 'B 级·写入', C: 'C 级·资金/生产' }
const STATUS_LABEL: Record<DshGovContract['status'], string> = {
  proposed: '已提案', shadow: '影子试用', active: '正式在役', retired: '已退休', rolled_back: '已回滚',
}
const STATUS_CLS: Record<DshGovContract['status'], string> = {
  proposed: 'text-amber-300', shadow: 'text-sky-300', active: 'text-emerald-300',
  retired: 'text-ink-faint', rolled_back: 'text-rose-300',
}

function newRequestId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export default function DshGovernancePanel() {
  const { session } = useWbSession()
  const [contracts, setContracts] = useState<DshGovContract[]>([])
  const [audits, setAudits] = useState<DshGovAudit[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  // 提案表单
  const [capKey, setCapKey] = useState('')
  const [kind, setKind] = useState<DshGovKind>('skill')
  const [risk, setRisk] = useState<DshGovRisk>('B')
  const [autonomy, setAutonomy] = useState<DshGovAutonomy>('L1')
  const [budget, setBudget] = useState('200')
  const [busy, setBusy] = useState(false)

  // 票据确认区
  const [ticketNo, setTicketNo] = useState('')

  const refresh = useCallback(async () => {
    if (!session?.token) return
    setLoading(true)
    setErr(null)
    try {
      const [cs, as] = await Promise.all([dshGovContracts(session), dshGovAudit(session)])
      setContracts(cs)
      setAudits(as.slice(0, 20))
    } catch (e) {
      setErr(wbErrorMessage(e))
    } finally {
      setLoading(false)
    }
  }, [session])

  useEffect(() => { void refresh() }, [refresh])

  async function run(fn: () => Promise<unknown>, okText: string) {
    if (busy) return
    setBusy(true)
    setErr(null)
    setNote(null)
    try {
      await fn()
      setNote(okText)
      await refresh()
    } catch (e) {
      setErr(wbErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  function propose() {
    const key = capKey.trim()
    const budgetMonthly = Number(budget)
    if (!key) { setErr('请填写能力标识 capabilityKey'); return }
    if (!Number.isFinite(budgetMonthly) || budgetMonthly <= 0) { setErr('月预算必须为正数'); return }
    void run(async () => {
      const r = await dshGovPropose(session, {
        requestId: newRequestId(), capabilityKey: key, kind, risk, autonomy, budgetMonthly,
      })
      if (r.ticket) {
        setNote(`C 级提案已签发 install 票据 ${r.ticket.ticketNo}——须另一名本厂负责人完成双签确认后生效`)
      }
    }, '提案已提交')
  }

  function cLevelFlow(c: DshGovContract, action: 'rollback' | 'retire') {
    const reason = window.prompt(`${action === 'rollback' ? '回滚' : '退休'}原因（必填）`)?.trim()
    if (!reason) return
    void run(async () => {
      if (c.risk === 'C') {
        const r = await dshGovRequestTicket(session, c.id, action)
        setNote(`已签发 ${action} 票据 ${r.ticket.ticketNo}——须另一名本厂负责人双签确认`)
      } else if (action === 'rollback') {
        await dshGovRollback(session, c.id, reason)
      } else {
        await dshGovRetire(session, c.id, reason)
      }
    }, '操作已提交')
  }

  if (!session?.token) {
    return <p className="text-xs text-ink-faint">登录后可使用 DSH 服务端治理。</p>
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-semibold text-ink-primary">
          <ShieldCheck className="h-4 w-4 text-pulse-cyan" /> DSH 服务端治理（本厂合同）
        </p>
        <WbButton variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className={cn('mr-1 h-3.5 w-3.5', loading && 'animate-spin')} /> 刷新
        </WbButton>
      </div>

      {err && <p className="rounded-lg border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-xs text-rose-200">{err}</p>}
      {note && <p className="rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-xs text-emerald-200">{note}</p>}

      {/* 提案区 */}
      <div className="rounded-xl border border-line-subtle bg-void/40 p-3">
        <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-ink-primary"><FileSignature className="h-3.5 w-3.5" /> 新能力提案</p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <input className={wbInputCls} placeholder="capabilityKey（如 invoice.ocr）" value={capKey} onChange={(e) => setCapKey(e.target.value)} />
          <select className={wbInputCls} value={kind} onChange={(e) => setKind(e.target.value as DshGovKind)}>
            <option value="skill">技能</option><option value="employee">数字员工</option><option value="workflow">工作流</option>
          </select>
          <select className={wbInputCls} value={risk} onChange={(e) => setRisk(e.target.value as DshGovRisk)}>
            <option value="A">A 级·只读</option><option value="B">B 级·写入</option><option value="C">C 级·资金/生产（双签）</option>
          </select>
          <select className={wbInputCls} value={autonomy} onChange={(e) => setAutonomy(e.target.value as DshGovAutonomy)}>
            {(['L0', 'L1', 'L2', 'L3', 'L4'] as const).map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <input className={wbInputCls} placeholder="月预算" value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="decimal" />
          <WbButton className="px-2.5 py-1 text-xs" onClick={propose} disabled={busy}>提交提案</WbButton>
        </div>
      </div>

      {/* 合同列表 */}
      <div className="space-y-2">
        {contracts.length === 0 && !loading && <p className="text-xs text-ink-faint">本厂暂无治理合同。</p>}
        {contracts.map((c) => {
          const pct = c.budgetMonthly > 0 ? Math.min(100, Math.round((c.budgetUsed / c.budgetMonthly) * 100)) : 0
          return (
            <div key={c.id} className="rounded-xl border border-line-subtle bg-void/40 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink-primary">{c.capabilityKey} <span className="text-ink-faint">#{c.contractNo}</span></p>
                  <p className="mt-0.5 text-xs text-ink-faint">
                    {RISK_LABEL[c.risk]} · 自治 {c.autonomy} · <span className={STATUS_CLS[c.status]}>{STATUS_LABEL[c.status]}</span>
                    {' '}· 评估 {c.evalScore} 分 · 成功 {c.successCount} / 失败 {c.failCount}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {(c.status === 'proposed' || c.status === 'shadow') && (
                    <>
                      <WbButton variant="secondary" className="px-2.5 py-1 text-xs" disabled={busy}
                        onClick={() => void run(() => dshGovTrial(session, { contractId: c.id, success: true }), '已记一笔成功试用')}>试用✓</WbButton>
                      <WbButton variant="secondary" className="px-2.5 py-1 text-xs" disabled={busy}
                        onClick={() => void run(() => dshGovTrial(session, { contractId: c.id, success: false }), '已记一笔失败试用')}>试用✗</WbButton>
                      <WbButton variant="secondary" className="px-2.5 py-1 text-xs" disabled={busy}
                        onClick={() => void run(async () => {
                          const r = await dshGovEvaluate(session, c.id)
                          setNote(r.promoted ? `评估 ${r.score} 分，已晋升正式在役` : `评估 ${r.score} 分，未达晋升线`)
                        }, '评估完成')}>评估</WbButton>
                    </>
                  )}
                  {(c.status === 'active' || c.status === 'shadow' || c.status === 'proposed') && (
                    <>
                      <WbButton variant="secondary" className="px-2.5 py-1 text-xs" disabled={busy} onClick={() => cLevelFlow(c, 'rollback')}>回滚</WbButton>
                      <WbButton variant="secondary" className="px-2.5 py-1 text-xs" disabled={busy} onClick={() => cLevelFlow(c, 'retire')}>退休</WbButton>
                    </>
                  )}
                </div>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-void">
                <div className={cn('h-full rounded-full', pct >= 90 ? 'bg-rose-400' : pct >= 70 ? 'bg-amber-300' : 'bg-pulse-cyan')}
                  style={{ width: `${pct}%` }} />
              </div>
              <p className="mt-1 text-right text-[10px] text-ink-faint">预算 {c.budgetUsed} / {c.budgetMonthly}（{pct}%）</p>
            </div>
          )
        })}
      </div>

      {/* 票据双签确认区 */}
      <div className="rounded-xl border border-line-subtle bg-void/40 p-3">
        <p className="mb-2 text-xs font-semibold text-ink-primary">C 级票据双签确认（须非发起人操作）</p>
        <div className="flex gap-2">
          <input className={cn(wbInputCls, 'flex-1')} placeholder="票据号（如 TKT-…）" value={ticketNo} onChange={(e) => setTicketNo(e.target.value)} />
          <WbButton className="px-2.5 py-1 text-xs" disabled={busy || !ticketNo.trim()}
            onClick={() => void run(() => dshGovConfirmTicket(session, ticketNo.trim()), '票据已确认生效')}>确认</WbButton>
        </div>
      </div>

      {/* 审计流水 */}
      <div className="rounded-xl border border-line-subtle bg-void/40 p-3">
        <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-ink-primary"><ListChecks className="h-3.5 w-3.5" /> 治理审计（最近 20 条，已脱敏）</p>
        <div className="max-h-56 space-y-1 overflow-y-auto">
          {audits.length === 0 && <p className="text-xs text-ink-faint">暂无审计记录。</p>}
          {audits.map((a) => (
            <p key={a.id} className="truncate text-[11px] text-ink-faint">
              <span className="text-ink-primary">{a.actor}</span> · {a.action}{a.risk ? ` · ${a.risk}级` : ''} · {a.detail} · {a.createdAt}
            </p>
          ))}
        </div>
      </div>
    </div>
  )
}
