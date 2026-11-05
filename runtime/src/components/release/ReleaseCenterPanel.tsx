/**
 * 系统更新机制面板（M51）——超级终端管理后台 Releases 页嵌入。
 *
 * 四端（APP APK / 智能工作台 wb / 超级终端 admin / 门户 portal / 服务端 server）版本台账 +
 * 五道闸流水线：提案 draft → 验证登记 verified → C 级票据 → 双签确认 → published/rolled_back。
 * 双签纪律：发起人≠确认人（服务端强制）；本面板只做透明转发与状态呈现。
 * AI 更新执行官席：每版可出风险评估建议（degraded 时明确标注模板降级）。
 */
import { useCallback, useEffect, useState } from 'react'
import { useWbSession } from '@/lib/wbSession'
import {
  rcAdvise, rcAudit, rcConfirmTicket, rcList, rcMarkVerified, rcPropose, rcRequestTicket,
  type ReleaseChannel, type ReleaseItem,
} from '@/lib/releaseCenter'
import { WbButton, WbEmpty, WbError } from '@/components/wb/ui'

const CHANNEL_LABEL: Record<ReleaseChannel, string> = {
  app_apk: 'NumX Max APP（APK）',
  wb: '智能工作台',
  admin: '超级终端',
  portal: '数字员工超市门户',
  server: '服务端',
}

const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  verified: '已验证',
  published: '已发布',
  rolled_back: '已回滚',
}

const STATUS_COLOR: Record<string, string> = {
  draft: 'text-ink-secondary',
  verified: 'text-pulse-cyan',
  published: 'text-jade-green',
  rolled_back: 'text-ember-red',
}

export function ReleaseCenterPanel() {
  const { session } = useWbSession()
  const [items, setItems] = useState<ReleaseItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // 提案表单
  const [channel, setChannel] = useState<ReleaseChannel>('app_apk')
  const [version, setVersion] = useState('')
  const [note, setNote] = useState('')
  // 双签确认区
  const [ticketNo, setTicketNo] = useState('')
  // AI 建议
  const [advice, setAdvice] = useState<Record<number, { text: string; degraded: boolean }>>({})

  const reload = useCallback(() => {
    rcList(session)
      .then((r) => { setItems(r.items); setError(null) })
      .catch((e) => setError(e instanceof Error ? e.message : '加载失败'))
  }, [session])

  useEffect(reload, [reload])

  const run = useCallback((fn: () => Promise<unknown>, okMsg: string) => {
    if (busy) return
    setBusy(true); setMsg(null)
    fn()
      .then(() => { setMsg(okMsg); reload() })
      .catch((e) => setMsg(e instanceof Error ? e.message : '操作失败'))
      .finally(() => setBusy(false))
  }, [busy, reload])

  const propose = () => {
    if (!version.trim()) { setMsg('请填写版本号'); return }
    run(() => rcPropose(session, { channel, version: version.trim(), note: note.trim() || undefined }),
      '版本提案已登记（draft）')
    setVersion(''); setNote('')
  }

  const requestTicket = (r: ReleaseItem, action: 'publish' | 'rollback') =>
    run(async () => {
      const t = await rcRequestTicket(session, r.id, action)
      setTicketNo(t.ticket.ticketNo)
    }, '票据已签发，请交由另一名负责人双签确认')

  const confirmTicket = () => {
    if (ticketNo.trim().length < 12) { setMsg('请填写完整票据号'); return }
    run(() => rcConfirmTicket(session, ticketNo.trim()), '双签确认完成，状态已推进')
    setTicketNo('')
  }

  const advise = (r: ReleaseItem) =>
    run(async () => {
      const a = await rcAdvise(session, r.id)
      setAdvice((m) => ({ ...m, [r.id]: { text: a.advice, degraded: a.degraded } }))
    }, '')

  if (error) return <WbError message={error} />
  if (!items) return <p className="text-sm text-ink-secondary">读取版本台账…</p>

  return (
    <div className="space-y-4">
      {/* 提案表单 */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="rounded-lg border border-line-subtle bg-transparent px-2 py-1.5 text-xs text-ink-primary"
          value={channel}
          onChange={(e) => setChannel(e.target.value as ReleaseChannel)}
        >
          {(Object.keys(CHANNEL_LABEL) as ReleaseChannel[]).map((c) => (
            <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>
          ))}
        </select>
        <input
          className="w-28 rounded-lg border border-line-subtle bg-transparent px-2 py-1.5 text-xs text-ink-primary"
          placeholder="版本号 v2.1.0"
          value={version}
          onChange={(e) => setVersion(e.target.value)}
        />
        <input
          className="min-w-40 flex-1 rounded-lg border border-line-subtle bg-transparent px-2 py-1.5 text-xs text-ink-primary"
          placeholder="版本说明（选填）"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <WbButton variant="primary" disabled={busy} onClick={propose}>登记提案</WbButton>
      </div>

      {msg && <p className="text-xs text-pulse-cyan">{msg}</p>}

      {/* 双签确认区 */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line-subtle p-3">
        <span className="text-xs text-ink-faint">C 级双签确认（确认人须与发起人不同）：</span>
        <input
          className="w-64 rounded-lg border border-line-subtle bg-transparent px-2 py-1.5 font-mono text-xs text-ink-primary"
          placeholder="票据号 RLT-…"
          value={ticketNo}
          onChange={(e) => setTicketNo(e.target.value)}
        />
        <WbButton variant="danger" disabled={busy} onClick={confirmTicket}>确认执行</WbButton>
      </div>

      {/* 版本台账 */}
      {items.length === 0 ? (
        <WbEmpty text="暂无版本记录" hint="从上方表单登记第一个版本提案开始" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line-subtle text-left text-xs text-ink-faint">
                <th className="px-3 py-2">通道</th>
                <th className="px-3 py-2">版本</th>
                <th className="px-3 py-2">状态</th>
                <th className="px-3 py-2">验证闸</th>
                <th className="px-3 py-2">提案人</th>
                <th className="px-3 py-2">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id} className="border-b border-line-subtle/50 align-top">
                  <td className="px-3 py-2 text-xs text-ink-secondary">{CHANNEL_LABEL[r.channel] ?? r.channel}</td>
                  <td className="px-3 py-2 font-mono text-xs text-ink-primary">
                    {r.version}
                    {r.note && <p className="mt-0.5 font-sans text-ink-faint">{r.note}</p>}
                    {advice[r.id] && (
                      <p className="mt-1 whitespace-pre-wrap font-sans text-ink-secondary">
                        {advice[r.id].degraded && <span className="text-ink-faint">（模板降级） </span>}
                        {advice[r.id].text}
                      </p>
                    )}
                  </td>
                  <td className={`px-3 py-2 text-xs font-medium ${STATUS_COLOR[r.status] ?? ''}`}>
                    {STATUS_LABEL[r.status] ?? r.status}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-ink-faint">{r.verifier ?? '—'}</td>
                  <td className="px-3 py-2 text-xs text-ink-faint">{r.createdBy}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1.5">
                      {r.status === 'draft' && (
                        <WbButton variant="secondary" className="px-2.5 py-1 text-xs" disabled={busy}
                          onClick={() => run(() => rcMarkVerified(session, {
                            releaseId: r.id, verifier: `v${Date.now().toString(36)}`,
                          }), '已登记验证（verified）')}>
                          登记验证
                        </WbButton>
                      )}
                      {r.status === 'verified' && (
                        <WbButton variant="secondary" className="px-2.5 py-1 text-xs" disabled={busy}
                          onClick={() => requestTicket(r, 'publish')}>
                          申请发布票据
                        </WbButton>
                      )}
                      {r.status === 'published' && (
                        <WbButton variant="secondary" className="px-2.5 py-1 text-xs" disabled={busy}
                          onClick={() => requestTicket(r, 'rollback')}>
                          申请回滚票据
                        </WbButton>
                      )}
                      <WbButton variant="secondary" className="px-2.5 py-1 text-xs" disabled={busy}
                        onClick={() => advise(r)}>
                        AI 评估
                      </WbButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <AuditList />
    </div>
  )
}

function AuditList() {
  const { session } = useWbSession()
  const [rows, setRows] = useState<Awaited<ReturnType<typeof rcAudit>>['items'] | null>(null)
  useEffect(() => {
    rcAudit(session, undefined, 20).then((r) => setRows(r.items)).catch(() => setRows([]))
  }, [session])
  if (!rows || rows.length === 0) return null
  return (
    <div className="rounded-lg border border-line-subtle p-3">
      <p className="mb-2 text-xs font-medium text-ink-faint">审计流水（近 20 条）</p>
      <div className="space-y-1">
        {rows.map((a) => (
          <p key={a.id} className="font-mono text-xs text-ink-secondary">
            {a.createdAt} · {a.actor} · {a.action}{a.channel ? ` · ${a.channel}` : ''}
          </p>
        ))}
      </div>
    </div>
  )
}
