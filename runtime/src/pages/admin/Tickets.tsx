/**
 * Tickets（/admin/tickets）—— 客服工单闭环（迭代 35 批次B，opsTickets.*）。
 * 筛选（状态/来源）+ 列表 + 详情抽屉（事件流时间线）+ 认领/回复/关闭 + 手动建单。
 * 字段 camelCase/snake_case 双兼容；{items} vs {rows} 回退；日期一律
 * new Date(String(v)).toLocaleString('zh-CN',{hour12:false}) 防 superjson Date 直渲（React#31）。
 */
import { useEffect, useState } from 'react'
import {
  CheckCircle2,
  ClipboardList,
  Hand,
  MessageSquarePlus,
  Moon,
  Plus,
  Send,
  X,
} from 'lucide-react'
import { callWb, useWbQuery, useWbSession, wbErrorMessage } from '@/lib/wbSession'
import { WbButton, WbEmpty, WbError, WbField, WbLoading, WbNotice, WbPageHeader, WbPanel } from '@/components/wb/ui'
import { cn } from '@/lib/utils'

// ─── 类型（双字段兼容）───────────────────────────────────────────────────────

interface TicketEvent {
  id?: number
  actor?: string
  event?: string
  detail?: string | null
  createdAt?: string
  created_at?: string
}

interface TicketItem {
  id?: number
  source?: 'feedback' | 'silent' | 'manual'
  factoryId?: number
  factory_id?: number
  factoryName?: string
  factory_name?: string
  refId?: number | null
  ref_id?: number | null
  title?: string
  status?: 'open' | 'processing' | 'done'
  assignee?: string | null
  note?: string | null
  reply?: string | null
  createdAt?: string
  created_at?: string
  updatedAt?: string
  updated_at?: string
  closedAt?: string | null
  closed_at?: string | null
  // ticketList 契约：工单 + 最近事件（字段名防御）
  lastEvent?: TicketEvent | null
  last_event?: TicketEvent | null
  events?: TicketEvent[]
}

interface TicketListResp {
  items?: TicketItem[]
  rows?: TicketItem[]
  total?: number
}

const STATUS_META = {
  open: { label: '开放', cls: 'border-ember-red/40 bg-ember-red/10 text-ember-red' },
  processing: { label: '处理中', cls: 'border-forge-amber/40 bg-forge-amber/10 text-forge-amber' },
  done: { label: '已关闭', cls: 'border-jade-green/40 bg-jade-green/10 text-jade-green' },
} as const

const SOURCE_META: Record<string, { label: string; cls: string }> = {
  feedback: { label: '技能反馈', cls: 'border-pulse-cyan/40 bg-pulse-cyan/10 text-pulse-cyan' },
  silent: { label: '沉默企业', cls: 'border-nebula-violet/40 bg-nebula-violet/10 text-nebula-violet' },
  manual: { label: '手动建单', cls: 'border-line-subtle bg-void/60 text-ink-secondary' },
}

function fmt(v: unknown): string {
  return v ? new Date(String(v)).toLocaleString('zh-CN', { hour12: false }) : '—'
}

function pick<T, K extends keyof T>(obj: T, ...keys: K[]): T[K] | undefined {
  for (const k of keys) {
    const v = obj[k]
    if (v !== undefined && v !== null) return v
  }
  return undefined
}

const STATUS_FILTERS = [
  { key: '', label: '全部状态' },
  { key: 'open', label: '开放' },
  { key: 'processing', label: '处理中' },
  { key: 'done', label: '已关闭' },
] as const
const SOURCE_FILTERS = [
  { key: '', label: '全部来源' },
  { key: 'feedback', label: '技能反馈' },
  { key: 'silent', label: '沉默企业' },
  { key: 'manual', label: '手动建单' },
] as const

// ─── 手动建单弹窗 ────────────────────────────────────────────────────────────

function CreateTicketModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { session } = useWbSession()
  const [factoryId, setFactoryId] = useState('')
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    const fid = Number(factoryId)
    if (!Number.isInteger(fid) || fid <= 0) {
      setErr('请填写有效的企业 ID（正整数）')
      return
    }
    if (!title.trim()) {
      setErr('请填写工单标题')
      return
    }
    setBusy(true)
    setErr(null)
    try {
      await callWb('mutation', 'opsTickets.ticketCreate', session, {
        factoryId: fid,
        title: title.trim(),
        ...(note.trim() ? { note: note.trim() } : {}),
      })
      onCreated()
      onClose()
    } catch (e) {
      setErr(wbErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-void/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl border border-line-subtle bg-panel p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-sm font-bold text-ink-primary">
            <Plus className="h-4 w-4 text-forge-amber" />
            手动建单
          </h3>
          <button type="button" onClick={onClose} className="text-ink-faint transition-colors hover:text-ink-primary">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-4">
          <WbField label="企业 ID（factoryId）">
            <input
              value={factoryId}
              onChange={(e) => setFactoryId(e.target.value)}
              placeholder="如 12"
              className="w-full rounded-[10px] border border-line-subtle bg-void/60 px-3 py-2 font-mono text-sm text-ink-primary outline-none transition-colors focus:border-forge-amber/50"
            />
          </WbField>
          <WbField label="工单标题">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="如：沉默企业回访"
              className="w-full rounded-[10px] border border-line-subtle bg-void/60 px-3 py-2 text-sm text-ink-primary outline-none transition-colors focus:border-forge-amber/50"
            />
          </WbField>
          <WbField label="备注（可选）">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              className="w-full rounded-[10px] border border-line-subtle bg-void/60 px-3 py-2 text-sm text-ink-primary outline-none transition-colors focus:border-forge-amber/50"
            />
          </WbField>
          <WbError message={err} />
          <div className="flex justify-end gap-2">
            <WbButton variant="secondary" onClick={onClose}>取消</WbButton>
            <WbButton onClick={submit} loading={busy}>创建工单</WbButton>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── 详情抽屉（事件流时间线）─────────────────────────────────────────────────

function TicketDrawer({ ticket, onClose, onChanged }: { ticket: TicketItem; onClose: () => void; onChanged: () => void }) {
  const { session } = useWbSession()
  const status = (ticket.status ?? 'open') as keyof typeof STATUS_META
  const [replyText, setReplyText] = useState('')
  const [closeNote, setCloseNote] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)

  const events: TicketEvent[] = Array.isArray(ticket.events) ? ticket.events : []
  const lastEvent = pick(ticket, 'lastEvent', 'last_event')

  // 死端点处置类一·4：抽屉打开即拉全量事件流（opsTickets.ticketEvents），
  // 列表载荷只带最近事件，全量时间线由本查询补齐
  const [fullEvents, setFullEvents] = useState<TicketEvent[] | null>(null)
  useEffect(() => {
    let cancelled = false
    if (!ticket.id) return
    callWb('query', 'opsTickets.ticketEvents', session, { ticketId: ticket.id })
      .then((res) => {
        if (cancelled) return
        const rows = Array.isArray(res) ? res : ((res as { items?: TicketEvent[] })?.items ?? [])
        setFullEvents(rows as TicketEvent[])
      })
      .catch(() => {
        if (!cancelled) setFullEvents(null)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket.id])

  const timeline = (fullEvents && fullEvents.length > 0 ? fullEvents : events.length > 0 ? events : lastEvent ? [lastEvent] : []) as TicketEvent[]

  const run = async (kind: string, path: string, input: Record<string, unknown>, doneMsg: string) => {
    setBusy(kind)
    setErr(null)
    setOk(null)
    try {
      await callWb('mutation', path, session, input)
      setOk(doneMsg)
      setReplyText('')
      setCloseNote('')
      onChanged()
    } catch (e) {
      setErr(wbErrorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const fid = pick(ticket, 'factoryId', 'factory_id')

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-void/60 backdrop-blur-sm" onClick={onClose}>
      <aside
        className="h-full w-full max-w-lg overflow-y-auto border-l border-line-subtle bg-panel p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="hud-label text-forge-amber/70">TICKET #{ticket.id ?? '—'}</p>
            <h3 className="mt-1 break-words text-base font-bold text-ink-primary">{ticket.title ?? '—'}</h3>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
              <span className={cn('inline-flex rounded-full border px-2 py-0.5 font-mono', STATUS_META[status]?.cls)}>
                {STATUS_META[status]?.label ?? status}
              </span>
              <span className={cn('inline-flex rounded-full border px-2 py-0.5 font-mono', SOURCE_META[ticket.source ?? '']?.cls ?? SOURCE_META.manual.cls)}>
                {SOURCE_META[ticket.source ?? '']?.label ?? ticket.source ?? '—'}
              </span>
              <span className="text-ink-faint">
                企业 #{fid ?? '—'}{pick(ticket, 'factoryName', 'factory_name') ? ` · ${pick(ticket, 'factoryName', 'factory_name')}` : ''}
              </span>
            </div>
          </div>
          <button type="button" onClick={onClose} className="shrink-0 text-ink-faint transition-colors hover:text-ink-primary">
            <X className="h-5 w-5" />
          </button>
        </div>

        <dl className="mb-5 grid grid-cols-2 gap-3 rounded-xl border border-line-subtle bg-void/40 p-4 text-xs">
          <div><dt className="text-ink-faint">受理人</dt><dd className="mt-0.5 text-ink-primary">{ticket.assignee ?? '未认领'}</dd></div>
          <div><dt className="text-ink-faint">来源记录</dt><dd className="mt-0.5 font-mono text-ink-primary">{pick(ticket, 'refId', 'ref_id') ?? '—'}</dd></div>
          <div><dt className="text-ink-faint">创建时间</dt><dd className="mt-0.5 font-mono text-ink-primary">{fmt(pick(ticket, 'createdAt', 'created_at'))}</dd></div>
          <div><dt className="text-ink-faint">关闭时间</dt><dd className="mt-0.5 font-mono text-ink-primary">{fmt(pick(ticket, 'closedAt', 'closed_at'))}</dd></div>
          {ticket.note && <div className="col-span-2"><dt className="text-ink-faint">备注</dt><dd className="mt-0.5 whitespace-pre-wrap text-ink-secondary">{ticket.note}</dd></div>}
          {ticket.reply && <div className="col-span-2"><dt className="text-ink-faint">最新回复</dt><dd className="mt-0.5 whitespace-pre-wrap text-ink-secondary">{ticket.reply}</dd></div>}
        </dl>

        {/* 事件流时间线 */}
        <div className="mb-6">
          <p className="mb-3 flex items-center gap-1.5 text-xs font-medium text-ink-faint">
            <ClipboardList className="h-3.5 w-3.5 text-pulse-cyan" />
            处理留痕（{timeline.length}）
          </p>
          {timeline.length === 0 ? (
            <WbEmpty text="暂无事件" hint="认领 / 回复 / 关闭均会写入事件流。" />
          ) : (
            <ol className="relative space-y-4 border-l border-line-subtle pl-5">
              {timeline.map((ev, i) => (
                <li key={ev.id ?? i} className="relative">
                  <span className="absolute -left-[26px] top-1 h-2.5 w-2.5 rounded-full border border-pulse-cyan/60 bg-void" />
                  <p className="text-xs text-ink-primary">
                    <span className="font-mono text-pulse-cyan">{ev.event ?? '—'}</span>
                    <span className="ml-2 text-ink-faint">{ev.actor ?? '—'}</span>
                  </p>
                  {ev.detail && <p className="mt-1 whitespace-pre-wrap text-[11px] text-ink-secondary">{ev.detail}</p>}
                  <p className="mt-0.5 font-mono text-[10px] text-ink-faint">{fmt(pick(ev, 'createdAt', 'created_at'))}</p>
                </li>
              ))}
            </ol>
          )}
        </div>

        <WbError message={err} className="mb-3" />
        <WbNotice message={ok} className="mb-3" />

        {/* 操作区 */}
        {status !== 'done' && (
          <div className="space-y-4">
            {status === 'open' && (
              <WbButton
                variant="secondary"
                loading={busy === 'claim'}
                onClick={() => run('claim', 'opsTickets.ticketClaim', { ticketId: ticket.id }, '已认领，工单进入处理中。')}
              >
                <Hand className="h-4 w-4" /> 认领工单
              </WbButton>
            )}
            <div>
              <WbField label="回复内容">
                <textarea
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  rows={3}
                  placeholder="回复将写入工单并留痕；来源为技能反馈时会尽力回写处理标记。"
                  className="w-full rounded-[10px] border border-line-subtle bg-void/60 px-3 py-2 text-sm text-ink-primary outline-none transition-colors focus:border-forge-amber/50"
                />
              </WbField>
              <div className="mt-2 flex justify-end">
                <WbButton
                  variant="secondary"
                  disabled={!replyText.trim()}
                  loading={busy === 'reply'}
                  onClick={() => run('reply', 'opsTickets.ticketReply', { ticketId: ticket.id, reply: replyText.trim() }, '回复已提交。')}
                >
                  <Send className="h-4 w-4" /> 提交回复
                </WbButton>
              </div>
            </div>
            <div className="rounded-xl border border-ember-red/20 bg-ember-red/[0.04] p-4">
              <WbField label="关闭备注（可选）">
                <input
                  value={closeNote}
                  onChange={(e) => setCloseNote(e.target.value)}
                  className="w-full rounded-[10px] border border-line-subtle bg-void/60 px-3 py-2 text-sm text-ink-primary outline-none transition-colors focus:border-ember-red/50"
                />
              </WbField>
              <div className="mt-2 flex justify-end">
                <WbButton
                  variant="danger"
                  loading={busy === 'close'}
                  onClick={() => run('close', 'opsTickets.ticketClose', { ticketId: ticket.id, ...(closeNote.trim() ? { note: closeNote.trim() } : {}) }, '工单已关闭。')}
                >
                  <CheckCircle2 className="h-4 w-4" /> 关闭工单
                </WbButton>
              </div>
            </div>
          </div>
        )}
      </aside>
    </div>
  )
}

// ─── 页面 ────────────────────────────────────────────────────────────────────

export default function AdminTickets() {
  const { session } = useWbSession()
  const [status, setStatus] = useState('')
  const [source, setSource] = useState('')
  const [page, setPage] = useState(1)
  const query = useWbQuery<TicketListResp>('opsTickets.ticketList', session, {
    ...(status ? { status } : {}),
    ...(source ? { source } : {}),
    page,
  }, { enabled: !!session?.token })

  const items: TicketItem[] = query.data?.items ?? query.data?.rows ?? []
  const total = Number(query.data?.total ?? items.length) || 0
  const [selected, setSelected] = useState<TicketItem | null>(null)
  const [creating, setCreating] = useState(false)

  const pageSize = items.length || 20
  const maxPage = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div>
      <WbPageHeader
        hud="OPS TICKETS"
        title="客服工单"
        desc="反馈 / 沉默企业 / 手动建单统一闭环：认领 → 回复 → 关闭，全程事件留痕。沉默企业由查询侧惰性补单（幂等）。"
      />
      <WbPanel
        hud="TICKET LIST"
        title={`工单列表（${total}）`}
        actions={
          <div className="flex flex-wrap items-center gap-1.5">
            <select
              value={status}
              onChange={(e) => { setStatus(e.target.value); setPage(1) }}
              className="rounded-lg border border-line-subtle bg-void/60 px-2.5 py-1.5 text-xs text-ink-secondary outline-none"
            >
              {STATUS_FILTERS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
            </select>
            <select
              value={source}
              onChange={(e) => { setSource(e.target.value); setPage(1) }}
              className="rounded-lg border border-line-subtle bg-void/60 px-2.5 py-1.5 text-xs text-ink-secondary outline-none"
            >
              {SOURCE_FILTERS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
            </select>
            <WbButton variant="secondary" className="px-3 py-1.5 text-xs" onClick={() => setCreating(true)}>
              <Plus className="h-3.5 w-3.5" /> 手动建单
            </WbButton>
          </div>
        }
      >
        {query.loading && !query.data ? (
          <WbLoading text="工单加载中…" />
        ) : query.error ? (
          <WbError message={query.error} />
        ) : items.length === 0 ? (
          <WbEmpty text="暂无工单" hint="反馈与沉默企业会自动生成工单，也可手动建单。" />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-left text-sm">
                <thead>
                  <tr className="border-b border-line-subtle text-xs text-ink-faint">
                    <th className="pb-2 pr-3 font-medium">#</th>
                    <th className="pb-2 pr-3 font-medium">标题</th>
                    <th className="pb-2 pr-3 font-medium">企业</th>
                    <th className="pb-2 pr-3 font-medium">来源</th>
                    <th className="pb-2 pr-3 font-medium">状态</th>
                    <th className="pb-2 pr-3 font-medium">受理人</th>
                    <th className="pb-2 pr-3 font-medium">最近事件</th>
                    <th className="pb-2 pr-3 font-medium">创建时间</th>
                    <th className="pb-2 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((t, i) => {
                    const st = (t.status ?? 'open') as keyof typeof STATUS_META
                    const lastEv = pick(t, 'lastEvent', 'last_event')
                    const fid = pick(t, 'factoryId', 'factory_id')
                    return (
                      <tr key={t.id ?? i} className="border-b border-line-subtle/60 last:border-0">
                        <td className="py-2.5 pr-3 font-mono text-xs text-ink-faint">{t.id ?? '—'}</td>
                        <td className="max-w-[240px] truncate py-2.5 pr-3 text-ink-primary">{t.title ?? '—'}</td>
                        <td className="py-2.5 pr-3 font-mono text-xs text-ink-secondary">
                          #{fid ?? '—'}
                        </td>
                        <td className="py-2.5 pr-3">
                          <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px]', SOURCE_META[t.source ?? '']?.cls ?? SOURCE_META.manual.cls)}>
                            {t.source === 'silent' && <Moon className="h-3 w-3" />}
                            {SOURCE_META[t.source ?? '']?.label ?? t.source ?? '—'}
                          </span>
                        </td>
                        <td className="py-2.5 pr-3">
                          <span className={cn('inline-flex rounded-full border px-2 py-0.5 font-mono text-[10px]', STATUS_META[st]?.cls)}>
                            {STATUS_META[st]?.label ?? st}
                          </span>
                        </td>
                        <td className="py-2.5 pr-3 text-xs text-ink-secondary">{t.assignee ?? '—'}</td>
                        <td className="max-w-[180px] truncate py-2.5 pr-3 font-mono text-[11px] text-ink-faint">
                          {lastEv ? `${lastEv.event ?? ''} ${fmt(pick(lastEv, 'createdAt', 'created_at'))}` : '—'}
                        </td>
                        <td className="py-2.5 pr-3 font-mono text-[11px] text-ink-faint">{fmt(pick(t, 'createdAt', 'created_at'))}</td>
                        <td className="py-2.5">
                          <button
                            type="button"
                            onClick={() => setSelected(t)}
                            className="inline-flex items-center gap-1 rounded-md border border-line-subtle px-2.5 py-1 text-[11px] text-ink-secondary transition-colors hover:border-forge-amber/50 hover:text-forge-amber"
                          >
                            <MessageSquarePlus className="h-3 w-3" /> 处理
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {maxPage > 1 && (
              <div className="mt-4 flex items-center justify-end gap-2 text-xs text-ink-faint">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="rounded-lg border border-line-subtle px-3 py-1 transition-colors hover:border-pulse-cyan/50 disabled:opacity-40"
                >
                  上一页
                </button>
                <span className="font-mono">{page} / {maxPage}</span>
                <button
                  type="button"
                  disabled={page >= maxPage}
                  onClick={() => setPage((p) => Math.min(maxPage, p + 1))}
                  className="rounded-lg border border-line-subtle px-3 py-1 transition-colors hover:border-pulse-cyan/50 disabled:opacity-40"
                >
                  下一页
                </button>
              </div>
            )}
          </>
        )}
      </WbPanel>

      {creating && (
        <CreateTicketModal onClose={() => setCreating(false)} onCreated={() => query.refetch()} />
      )}
      {selected && (
        <TicketDrawer
          ticket={selected}
          onClose={() => setSelected(null)}
          onChanged={() => query.refetch()}
        />
      )}
    </div>
  )
}
