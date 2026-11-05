/**
 * Dashboard（/admin）—— 总览 KPI 卡片组（admin.overview）。
 */
import { useNavigate } from 'react-router'
import { AlertTriangle, ClipboardList, Hourglass, Moon, ShieldCheck, Ticket } from 'lucide-react'
import { useWbSession, useWbQuery } from '@/lib/wbSession'
import { WbError, WbLoading, WbPageHeader, WbPanel, WbStat } from '@/components/wb/ui'
import { cn } from '@/lib/utils'

// ─── 迭代 35：今日待办工单卡（adminAnalytics.todoQueue）─────────────────────

interface TodoItem {
  kind?: 'review' | 'silent' | 'alert' | 'confirmTimeout'
  title?: string
  ref?: string
  severity?: string
  createdAt?: string
  created_at?: string
}
interface TodoResp {
  items?: TodoItem[]
  counts?: Record<string, number | undefined>
}

const TODO_KINDS = [
  { key: 'review', label: '待审技能包/上架', icon: ShieldCheck, to: '/admin/skill-shop', tone: 'text-forge-amber' },
  { key: 'silent', label: '沉默企业（warn/critical）', icon: Moon, to: '/admin/health', tone: 'text-pulse-cyan' },
  { key: 'alert', label: '活跃运营告警', icon: AlertTriangle, to: '/admin/ops', tone: 'text-ember-red' },
  { key: 'confirmTimeout', label: '超48h未确权申请', icon: Hourglass, to: '/admin/skill-shop', tone: 'text-nebula-violet' },
] as const

function TodoQueueCard() {
  const { session } = useWbSession()
  const navigate = useNavigate()
  const { data, error, loading } = useWbQuery<TodoResp>('adminAnalytics.todoQueue', session, {}, { enabled: !!session?.token })
  // 迭代35批次B：开放工单计数（opsTickets.ticketList，status=open 取 total；后端未上线时静默为 —）
  const openTickets = useWbQuery<{ items?: unknown[]; rows?: unknown[]; total?: number }>(
    'opsTickets.ticketList', session, { status: 'open' }, { enabled: !!session?.token })
  const openTicketTotal = openTickets.data ? Number(openTickets.data.total ?? openTickets.data.items?.length ?? openTickets.data.rows?.length ?? 0) : null
  const counts = data?.counts ?? {}
  const items = data?.items ?? []

  return (
    <WbPanel hud="TODO QUEUE" title="今日待办" className="mb-6"
      actions={<ClipboardList className="h-4 w-4 text-forge-amber" />}>
      {loading && !data ? (
        <WbLoading text="待办聚合中…" />
      ) : error ? (
        <WbError message={error} />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <button
              type="button"
              onClick={() => navigate('/admin/tickets')}
              className="group rounded-xl border border-line-subtle bg-void/40 p-4 text-left transition-colors duration-300 hover:border-forge-amber/40"
            >
              <p className="flex items-center gap-1.5 text-xs text-ink-faint">
                <Ticket className="h-3.5 w-3.5 text-ember-red" />
                开放工单
              </p>
              <p className="mt-2 font-grotesk text-2xl font-bold text-ember-red">
                {openTicketTotal === null ? '—' : openTicketTotal}
              </p>
              <p className="mt-1 text-[11px] text-ink-faint group-hover:text-ink-secondary">点击前往处理 →</p>
            </button>
            {TODO_KINDS.map((k) => (
              <button
                key={k.key}
                type="button"
                onClick={() => navigate(k.to)}
                className="group rounded-xl border border-line-subtle bg-void/40 p-4 text-left transition-colors duration-300 hover:border-forge-amber/40"
              >
                <p className="flex items-center gap-1.5 text-xs text-ink-faint">
                  <k.icon className={cn('h-3.5 w-3.5', k.tone)} />
                  {k.label}
                </p>
                <p className={cn('mt-2 font-grotesk text-2xl font-bold', k.tone)}>{counts[k.key] ?? 0}</p>
                <p className="mt-1 text-[11px] text-ink-faint group-hover:text-ink-secondary">点击前往处理 →</p>
              </button>
            ))}
          </div>
          {items.length === 0 ? (
            <p className="py-4 text-center text-xs text-ink-faint">暂无待办工单，一切就绪。</p>
          ) : (
            <div className="mt-4 space-y-1.5">
              {items.slice(0, 8).map((it, i) => (
                <div key={`${it.kind}-${it.ref ?? i}`} className="flex items-center gap-2 rounded-lg border border-line-subtle/60 bg-void/30 px-3 py-2 text-xs">
                  <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', it.severity === 'critical' ? 'bg-ember-red' : it.severity === 'warn' ? 'bg-forge-amber' : 'bg-pulse-cyan')} />
                  <span className="min-w-0 flex-1 truncate text-ink-secondary">{it.title ?? '—'}</span>
                  <span className="shrink-0 font-mono text-[10px] text-ink-faint">{it.ref ?? ''}</span>
                  <span className="shrink-0 font-mono text-[10px] text-ink-faint">
                    {it.createdAt ?? it.created_at ? new Date(String(it.createdAt ?? it.created_at)).toLocaleString('zh-CN', { hour12: false }) : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </WbPanel>
  )
}

interface Overview {
  userTotal: number
  enterpriseUserTotal: number
  personUserTotal: number
  factoryTotal: number
  agentTotal: number
  agentStatusDist: Record<string, number>
  hireOrderTotal: number
  openRecruitmentTotal: number
  pendingListingTotal: number
  tokenFlowTotal: number
  tokenPlatformFeeTotal: number
}

const AGENT_STATUS_LABELS: Record<string, string> = {
  active: '生效中',
  pending: '待审核',
  suspended: '已暂停',
  rejected: '已驳回',
}

export default function AdminDashboard() {
  const { session } = useWbSession()
  const { data, error, loading } = useWbQuery<Overview>('admin.overview', session)

  return (
    <div>
      <WbPageHeader
        hud="OVERVIEW"
        title="统一数据总览"
        desc="门户与工作台共享同一数据源，以下为两边全部数据的实时聚合。"
      />
      <TodoQueueCard />
      {loading && <WbLoading />}
      <WbError message={error} />
      {data && (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <WbStat label="注册账号" value={data.userTotal} tone="cyan"
              sub={`企业 ${data.enterpriseUserTotal} · 个人 ${data.personUserTotal}`} />
            <WbStat label="企业（工作台）" value={data.factoryTotal} tone="cyan" />
            <WbStat label="数字员工" value={data.agentTotal} tone="amber" />
            <WbStat label="雇佣订单" value={data.hireOrderTotal} tone="amber" />
            <WbStat label="招聘中岗位" value={data.openRecruitmentTotal} tone="green" />
            <WbStat label="待审核上架" value={data.pendingListingTotal} tone="green" />
            <WbStat label="Token 流水总额" value={data.tokenFlowTotal} tone="amber"
              sub="按调用计量累计" />
            <WbStat label="平台结算佣金" value={data.tokenPlatformFeeTotal} tone="amber"
              sub="Token 结算口径" />
          </div>

          <WbPanel title="数字员工状态分布" hud="AGENT STATUS" className="mt-6">
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              {(['active', 'pending', 'suspended', 'rejected'] as const).map((s) => (
                <div key={s} className="rounded-xl border border-line-subtle bg-void/40 px-4 py-3">
                  <p className="hud-label">{AGENT_STATUS_LABELS[s]}</p>
                  <p className="mt-1 font-grotesk text-2xl font-bold text-ink-primary">
                    {data.agentStatusDist[s] ?? 0}
                  </p>
                </div>
              ))}
            </div>
          </WbPanel>
        </>
      )}
    </div>
  )
}
