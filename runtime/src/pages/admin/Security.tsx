/**
 * Security（/admin/security）—— 反攻击矩阵（迭代 27，opsCenter.*）。
 * 可疑 IP 表（IP/1h请求/1h错误/评分/原因/状态 + AI研判(assessIp) + 封锁/解封）+
 * 顶部「生成安全态势报告」(securityReport) + 手动添加封锁 IP 表单。
 */
import { useState, type FormEvent } from 'react'
import { BrainCircuit, Loader2, ShieldAlert, ShieldCheck, ShieldX, X } from 'lucide-react'
import { useWbSession, useWbQuery, wbMutation, wbErrorMessage } from '@/lib/wbSession'
import { WbButton, WbError, WbLoading, WbNotice, WbPageHeader, WbPanel, wbInputCls } from '@/components/wb/ui'
import { AdminTable, adminTdCls, adminConfirm, fmtTime } from '@/pages/admin/shared'
import { cn } from '@/lib/utils'

interface SuspiciousIp {
  ip: string
  reqCount1h: number
  errCount1h: number
  score: number
  reasons: string[]
  blocked: boolean
}

export default function AdminSecurity() {
  const { session } = useWbSession()
  const query = useWbQuery<SuspiciousIp[]>('opsCenter.suspiciousIps', session, {}, { enabled: !!session?.token })
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [opPending, setOpPending] = useState(false)

  // AI 研判弹窗
  const [assess, setAssess] = useState<{ ip: string; text: string; loading: boolean } | null>(null)
  // 安全态势报告
  const [report, setReport] = useState<{ report: string; cachedAt: string } | null>(null)
  const [reportPending, setReportPending] = useState(false)
  // 手动封锁
  const [blockForm, setBlockForm] = useState({ ip: '', reason: '' })

  async function mutate(path: string, input: Record<string, unknown>, okText: string) {
    if (!session?.token) return
    setError(null)
    setNotice(null)
    setOpPending(true)
    try {
      await wbMutation(path, { token: session.token, ...input })
      setNotice(okText)
      query.refetch()
    } catch (err) {
      setError(wbErrorMessage(err))
    } finally {
      setOpPending(false)
    }
  }

  async function handleAssess(ip: string) {
    if (!session?.token) return
    setAssess({ ip, text: '', loading: true })
    try {
      const res = await wbMutation<{ ip: string; assessment: string }>('opsCenter.assessIp', {
        token: session.token,
        ip,
      })
      setAssess({ ip, text: res.assessment, loading: false })
    } catch (err) {
      setAssess({ ip, text: `研判失败：${wbErrorMessage(err)}`, loading: false })
    }
  }

  async function handleReport() {
    if (!session?.token) return
    setError(null)
    setReportPending(true)
    try {
      const res = await wbMutation<{ report: string; cachedAt: string }>('opsCenter.securityReport', {
        token: session.token,
      })
      setReport(res)
    } catch (err) {
      setError(wbErrorMessage(err))
    } finally {
      setReportPending(false)
    }
  }

  async function handleManualBlock(e: FormEvent) {
    e.preventDefault()
    if (!adminConfirm(`封锁 IP ${blockForm.ip.trim()}`)) return
    await mutate(
      'opsCenter.blockIp',
      { ip: blockForm.ip.trim(), reason: blockForm.reason.trim() || undefined },
      `已封锁 ${blockForm.ip.trim()}，提交后由系统执行，页面刷新后生效。`,
    )
    setBlockForm({ ip: '', reason: '' })
  }

  const rows = query.data ?? []

  return (
    <div>
      <WbPageHeader
        hud="SECURITY MATRIX"
        title="反攻击矩阵"
        desc="可疑 IP 自动评分（近 1 小时请求/错误），支持 AI 研判、封锁/解封与安全态势报告。"
      />

      {/* 顶部操作：生成安全态势报告 + 手动封锁 */}
      <WbPanel
        hud="ACTIONS"
        title="安全操作"
        className="mb-6"
        actions={
          <WbButton loading={reportPending} onClick={() => void handleReport()}>
            <BrainCircuit className="h-4 w-4" />
            生成安全态势报告
          </WbButton>
        }
      >
        <form onSubmit={(e) => void handleManualBlock(e)} className="flex flex-wrap items-end gap-3">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-secondary">封锁 IP</label>
            <input
              className={cn(wbInputCls, 'font-mono')}
              value={blockForm.ip}
              onChange={(e) => setBlockForm((f) => ({ ...f, ip: e.target.value }))}
              placeholder="如 203.0.113.8"
              required
            />
          </div>
          <div className="min-w-0 flex-1">
            <label className="mb-1.5 block text-xs font-medium text-ink-secondary">原因（选填）</label>
            <input
              className={wbInputCls}
              value={blockForm.reason}
              onChange={(e) => setBlockForm((f) => ({ ...f, reason: e.target.value }))}
              placeholder="如：高频 4xx 扫描"
            />
          </div>
          <WbButton type="submit" variant="danger" loading={opPending}>
            <ShieldX className="h-4 w-4" />
            添加封锁
          </WbButton>
        </form>
        <WbNotice message={notice} className="mt-3" />
        <WbError message={error} className="mt-3" />
      </WbPanel>

      {/* 安全态势报告 */}
      {report && (
        <WbPanel
          hud="SECURITY REPORT"
          title="安全态势报告"
          className="mb-6"
          actions={<span className="font-mono text-[11px] text-ink-faint">生成于 {fmtTime(report.cachedAt)}（10 分钟缓存）</span>}
        >
          <pre className="whitespace-pre-wrap break-words rounded-xl border border-line-subtle bg-void/40 p-4 font-mono text-xs leading-relaxed text-ink-secondary">
            {report.report}
          </pre>
        </WbPanel>
      )}

      {/* 可疑 IP 表 */}
      <WbPanel
        hud="SUSPICIOUS IPS"
        title="可疑 IP 列表"
        actions={<span className="font-mono text-[11px] text-ink-faint">{rows.length} 条</span>}
      >
        {query.loading ? (
          <WbLoading text="可疑 IP 加载中…" />
        ) : query.error ? (
          <WbError message={query.error} />
        ) : rows.length === 0 ? (
          <p className="flex items-center gap-2 py-6 text-sm text-ink-secondary">
            <ShieldCheck className="h-4 w-4 text-jade-green" />
            暂无可疑 IP，访问态势良好。
          </p>
        ) : (
          <AdminTable head={['IP', '1h 请求', '1h 错误', '评分', '原因', '状态', '操作']}>
            {rows.map((r) => (
              <tr key={r.ip}>
                <td className={cn(adminTdCls, 'font-mono text-ink-primary')}>{r.ip}</td>
                <td className={cn(adminTdCls, 'font-mono')}>{r.reqCount1h}</td>
                <td className={cn(adminTdCls, 'font-mono', r.errCount1h > 0 && 'text-ember-red')}>{r.errCount1h}</td>
                <td className={cn(adminTdCls, 'font-mono', r.score >= 80 ? 'text-ember-red' : r.score >= 50 ? 'text-forge-amber' : '')}>
                  {r.score}
                </td>
                <td className={cn(adminTdCls, 'max-w-[260px]')}>
                  <span className="line-clamp-2 text-xs">{r.reasons.join('；') || '—'}</span>
                </td>
                <td className={adminTdCls}>
                  {r.blocked ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-ember-red/40 bg-ember-red/10 px-2 py-0.5 text-[11px] text-ember-red">
                      <ShieldAlert className="h-3 w-3" /> 已封锁
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full border border-jade-green/40 bg-jade-green/10 px-2 py-0.5 text-[11px] text-jade-green">
                      正常
                    </span>
                  )}
                </td>
                <td className={adminTdCls}>
                  <div className="flex flex-wrap gap-2">
                    <WbButton variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => void handleAssess(r.ip)}>
                      AI 研判
                    </WbButton>
                    {r.blocked ? (
                      <WbButton
                        variant="secondary"
                        className="px-2.5 py-1 text-xs"
                        disabled={opPending}
                        onClick={() => void mutate('opsCenter.unblockIp', { ip: r.ip }, `已解封 ${r.ip}，提交后由系统执行，页面刷新后生效。`)}
                      >
                        解封
                      </WbButton>
                    ) : (
                      <WbButton
                        variant="danger"
                        className="px-2.5 py-1 text-xs"
                        disabled={opPending}
                        onClick={() => {
                          if (adminConfirm(`封锁 IP ${r.ip}`))
                            void mutate('opsCenter.blockIp', { ip: r.ip }, `已封锁 ${r.ip}，提交后由系统执行，页面刷新后生效。`)
                        }}
                      >
                        封锁
                      </WbButton>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </AdminTable>
        )}
      </WbPanel>

      {/* 死端点处置类一·4：访问日志流（opsCenter.accessLog，管理员只读） */}
      <AccessLogPanel />

      {/* AI 研判弹窗 */}
      {assess && (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-void/80 px-4 backdrop-blur-sm"
          onClick={() => setAssess(null)}
        >
          <div className="glass-panel w-full max-w-lg rounded-xl p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-base font-bold text-ink-primary">
                <BrainCircuit className="h-4 w-4 text-forge-amber" />
                AI 研判：<span className="font-mono">{assess.ip}</span>
              </h3>
              <button
                type="button"
                aria-label="关闭"
                onClick={() => setAssess(null)}
                className="rounded-full p-1.5 text-ink-secondary transition-colors hover:text-ink-primary"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {assess.loading ? (
              <p className="mt-4 flex items-center gap-2 text-sm text-ink-secondary">
                <Loader2 className="h-4 w-4 animate-spin text-pulse-cyan" />
                大模型研判中…
              </p>
            ) : (
              <pre className="mt-4 whitespace-pre-wrap break-words rounded-xl border border-line-subtle bg-void/40 p-4 font-mono text-xs leading-relaxed text-ink-secondary">
                {assess.text}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── 死端点处置类一·4：访问日志流（opsCenter.accessLog）────────────────────────
interface AccessLogRow {
  id: number
  ts?: string
  ip: string
  path: string
  method?: string
  status?: number
  latency_ms?: number
  ua?: string
}

function AccessLogPanel() {
  const { session } = useWbSession()
  const [page, setPage] = useState(1)
  const q = useWbQuery<{ items: AccessLogRow[]; total?: number }>('opsCenter.accessLog', session, { page })
  const rows = q.data?.items ?? []

  return (
    <WbPanel
      hud="ACCESS LOG"
      title="访问日志流"
      className="mt-6"
      actions={
        <span className="flex items-center gap-2 font-mono text-[11px] text-ink-faint">
          <button className="rounded border border-line-subtle px-2 py-0.5 disabled:opacity-40" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            上一页
          </button>
          第 {page} 页
          <button
            className="rounded border border-line-subtle px-2 py-0.5 disabled:opacity-40"
            disabled={rows.length < 50}
            onClick={() => setPage((p) => p + 1)}
          >
            下一页
          </button>
        </span>
      }
    >
      {q.loading ? (
        <WbLoading text="访问日志加载中…" />
      ) : q.error ? (
        <WbError message={q.error} />
      ) : rows.length === 0 ? (
        <p className="py-6 text-sm text-ink-secondary">暂无访问日志。</p>
      ) : (
        <AdminTable head={['时间', 'IP', '路径', '方法', '状态', '耗时']}>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-line-subtle/50">
              <td className="px-3 py-2 font-mono text-[11px] text-ink-faint">{String(r.ts ?? '').replace('T', ' ').slice(5, 19)}</td>
              <td className="px-3 py-2 font-mono text-xs text-ink-primary">{r.ip}</td>
              <td className="max-w-[280px] truncate px-3 py-2 font-mono text-[11px] text-ink-secondary" title={r.path}>
                {r.path}
              </td>
              <td className="px-3 py-2 font-mono text-[11px] text-ink-secondary">{r.method ?? '—'}</td>
              <td className={cn('px-3 py-2 font-mono text-[11px]', Number(r.status) >= 500 ? 'text-ember-red' : Number(r.status) >= 400 ? 'text-forge-amber' : 'text-jade-green')}>
                {r.status ?? '—'}
              </td>
              <td className="px-3 py-2 font-mono text-[11px] text-ink-faint">{r.latency_ms != null ? `${r.latency_ms}ms` : '—'}</td>
            </tr>
          ))}
        </AdminTable>
      )}
    </WbPanel>
  )
}
