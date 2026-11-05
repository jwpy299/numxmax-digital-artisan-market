/**
 * Vulns（/admin/vulns）—— 漏洞修复矩阵（迭代 27，opsCenter.vuln*）。
 * 「立即扫描」(vulnScan → added/total) + 漏洞表（severity 色标/标题/来源/状态 +
 * 「生成修复方案」(vulnPlan) + 状态下拉流转 open/fixing/fixed/ignored）。
 */
import { Fragment, useState } from 'react'
import { Loader2, ScanSearch, Wrench } from 'lucide-react'
import { useWbSession, useWbQuery, wbMutation, wbErrorMessage } from '@/lib/wbSession'
import { WbButton, WbError, WbLoading, WbNotice, WbPageHeader, WbPanel, wbInputCls } from '@/components/wb/ui'
import { AdminTable, adminTdCls, adminConfirm, fmtTime } from '@/pages/admin/shared'
import { cn } from '@/lib/utils'

interface Vuln {
  id: number
  source: string
  severity: string
  title: string
  detail: string
  status: string
  plan: string | null
  createdAt: string
}

const SEVERITY_STYLES: Record<string, string> = {
  critical: 'border-ember-red/50 bg-ember-red/10 text-ember-red',
  high: 'border-ember-red/40 bg-ember-red/[0.07] text-ember-red',
  moderate: 'border-forge-amber/40 bg-forge-amber/10 text-forge-amber',
  medium: 'border-forge-amber/40 bg-forge-amber/10 text-forge-amber',
  low: 'border-pulse-cyan/40 bg-pulse-cyan/10 text-pulse-cyan',
  info: 'border-line-subtle bg-panel text-ink-secondary',
}

const STATUS_LABELS: Record<string, string> = {
  open: '待处理',
  fixing: '修复中',
  fixed: '已修复',
  ignored: '已忽略',
}

export default function AdminVulns() {
  const { session } = useWbSession()
  const query = useWbQuery<Vuln[]>('opsCenter.vulnList', session, {}, { enabled: !!session?.token })
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [planPendingId, setPlanPendingId] = useState<number | null>(null)
  const [expandedPlan, setExpandedPlan] = useState<Record<number, string>>({})

  async function handleScan() {
    if (!session?.token) return
    setError(null)
    setNotice(null)
    setScanning(true)
    try {
      const res = await wbMutation<{ scanned: true; added: number; total: number; summary: string }>(
        'opsCenter.vulnScan',
        { token: session.token },
      )
      setNotice(`扫描完成：新增 ${res.added} 条，累计 ${res.total} 条。${res.summary ?? ''}`)
      query.refetch()
    } catch (err) {
      setError(wbErrorMessage(err))
    } finally {
      setScanning(false)
    }
  }

  async function handlePlan(v: Vuln) {
    if (!session?.token) return
    setError(null)
    setPlanPendingId(v.id)
    try {
      const res = await wbMutation<{ vulnId: number; plan: string }>('opsCenter.vulnPlan', {
        token: session.token,
        vulnId: v.id,
      })
      setExpandedPlan((m) => ({ ...m, [v.id]: res.plan }))
      query.refetch()
    } catch (err) {
      setError(wbErrorMessage(err))
    } finally {
      setPlanPendingId(null)
    }
  }

  async function handleSetStatus(v: Vuln, status: string) {
    if (!session?.token) return
    if (!adminConfirm(`将漏洞「${v.title}」状态流转为 ${STATUS_LABELS[status] ?? status}`)) {
      query.refetch() // 还原下拉显示
      return
    }
    setError(null)
    setNotice(null)
    try {
      await wbMutation('opsCenter.vulnSetStatus', { token: session.token, vulnId: v.id, status })
      setNotice(`已提交状态流转：${STATUS_LABELS[status] ?? status}。`)
      query.refetch()
    } catch (err) {
      setError(wbErrorMessage(err))
    }
  }

  const rows = query.data ?? []

  return (
    <div>
      <WbPageHeader
        hud="VULN MATRIX"
        title="漏洞修复矩阵"
        desc="依赖审计与错误日志规则扫描出的漏洞清单，支持大模型生成结构化修复方案与状态流转。"
      />

      <WbPanel
        hud="VULNS"
        title="漏洞清单"
        actions={
          <div className="flex items-center gap-3">
            <span className="font-mono text-[11px] text-ink-faint">{rows.length} 条</span>
            <WbButton loading={scanning} onClick={() => void handleScan()}>
              <ScanSearch className="h-4 w-4" />
              立即扫描
            </WbButton>
          </div>
        }
      >
        <WbNotice message={notice} className="mb-3" />
        <WbError message={error} className="mb-3" />
        {query.loading ? (
          <WbLoading text="漏洞清单加载中…" />
        ) : query.error ? (
          <WbError message={query.error} />
        ) : rows.length === 0 ? (
          <p className="py-6 text-sm text-ink-secondary">暂无漏洞记录，可点击「立即扫描」发起一次扫描。</p>
        ) : (
          <AdminTable head={['严重级别', '标题', '来源', '发现时间', '状态', '操作']}>
            {rows.map((v) => (
              <Fragment key={v.id}>
                <tr>
                  <td className={adminTdCls}>
                    <span
                      className={cn(
                        'inline-block rounded-full border px-2 py-0.5 font-mono text-[11px] uppercase',
                        SEVERITY_STYLES[v.severity] ?? SEVERITY_STYLES.info,
                      )}
                    >
                      {v.severity}
                    </span>
                  </td>
                  <td className={cn(adminTdCls, 'max-w-[320px]')}>
                    <p className="line-clamp-2 text-xs text-ink-primary">{v.title}</p>
                  </td>
                  <td className={cn(adminTdCls, 'font-mono text-xs')}>{v.source}</td>
                  <td className={cn(adminTdCls, 'font-mono text-xs')}>{fmtTime(v.createdAt)}</td>
                  <td className={adminTdCls}>
                    <select
                      className={cn(wbInputCls, 'w-28 px-2 py-1 text-xs')}
                      value={v.status}
                      onChange={(e) => void handleSetStatus(v, e.target.value)}
                    >
                      {Object.entries(STATUS_LABELS).map(([k, label]) => (
                        <option key={k} value={k}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className={adminTdCls}>
                    <div className="flex flex-wrap gap-2">
                      <WbButton
                        variant="secondary"
                        className="px-2.5 py-1 text-xs"
                        loading={planPendingId === v.id}
                        onClick={() => void handlePlan(v)}
                      >
                        <Wrench className="h-3.5 w-3.5" />
                        生成修复方案
                      </WbButton>
                      {(v.plan || expandedPlan[v.id]) && (
                        <WbButton
                          variant="secondary"
                          className="px-2.5 py-1 text-xs"
                          onClick={() =>
                            setExpandedPlan((m) => {
                              if (m[v.id]) {
                                const next = { ...m }
                                delete next[v.id]
                                return next
                              }
                              return { ...m, [v.id]: v.plan ?? '' }
                            })
                          }
                        >
                          {expandedPlan[v.id] ? '收起方案' : '查看方案'}
                        </WbButton>
                      )}
                    </div>
                  </td>
                </tr>
                {expandedPlan[v.id] && (
                  <tr>
                    <td colSpan={6} className="px-3 py-2.5">
                      {planPendingId === v.id ? (
                        <p className="flex items-center gap-2 text-xs text-ink-secondary">
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-pulse-cyan" />
                          修复方案生成中…
                        </p>
                      ) : (
                        <pre className="whitespace-pre-wrap break-words rounded-xl border border-line-subtle bg-void/40 p-4 font-mono text-xs leading-relaxed text-ink-secondary">
                          {expandedPlan[v.id]}
                        </pre>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </AdminTable>
        )}
      </WbPanel>
    </div>
  )
}
