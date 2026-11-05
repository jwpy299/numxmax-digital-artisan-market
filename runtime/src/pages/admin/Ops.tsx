/**
 * Ops（/admin/ops）—— 运营监控（迭代 27，opsCenter.overview）。
 * 今日六指标卡片（请求/错误/独立IP/注册/订单/已支付）+ 7 日趋势（简单柱状 div）+
 * 五模型槽位状态灯。
 */
import { useEffect, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  BellRing,
  BrainCircuit,
  Cpu,
  Globe,
  HardDrive,
  Loader2,
  MemoryStick,
  Server,
  ShoppingCart,
  UserPlus,
  BadgeCheck,
} from 'lucide-react'
import { callWb, useWbSession, useWbQuery, type WbSession } from '@/lib/wbSession'
import { WbError, WbLoading, WbPageHeader, WbPanel } from '@/components/wb/ui'
import { cn } from '@/lib/utils'

interface Overview {
  today: {
    requests: number
    errors: number
    uniqueIps: number
    signups: number
    orders: number
    paidOrders: number
  }
  trend7d: { date: string; requests: number; errors: number; signups: number; orders: number }[]
  llm: { slot: string; model: string; verified: boolean }[]
  skillTools?: { ok: number; fail: number; failRate: number; recentFails: { skillKey: string; at: number; channel: string }[] }
  northStar?: { weekAdopted: number; weekRejected: number; adoptRate: number | null }
}

// ─── 迭代29：实时监控与预警（opsCenter.healthLatest / alerts / alertSetStatus） ──

interface HealthSample {
  ts?: string | null
}
interface ServerHealth {
  server: string
  service?: string | null
  http?: (HealthSample & { code?: number | null; latencyMs?: number | null }) | null
  mem?: (HealthSample & { pct?: number | null }) | null
  load?: (HealthSample & { avg?: number | null }) | null
  disk?: (HealthSample & { pct?: number | null }) | null
  overall?: 'ok' | 'warn' | 'down' | null
  latestTs?: string | null
}

interface AlertRow {
  id: number
  server: string
  severity: string
  title: string
  detail: string | null
  status: string
  createdAt: string
}

type AlertFilter = 'open' | 'ack' | 'resolved' | 'all'

// ─── M61：模型时延看板（adminAnalytics.llmLatencyBoard） ─────────────────────

interface LatAgg {
  calls: number
  okRate: number | null
  fallbackRate: number | null
  avgLatencyMs: number | null
  p95LatencyMs: number | null
  avgFirstTokenMs: number | null
  streamCalls: number
}
interface LatencyBoard {
  windowHours: number
  available: boolean
  sampled?: boolean
  note?: string
  summary: (LatAgg & { calls: number }) | null
  bySlot: ({ name: string } & LatAgg)[]
  byContext: ({ name: string } & LatAgg)[]
  hourly: ({ bucket: string } & LatAgg)[]
}

function fmtMs(v?: number | null): string {
  if (typeof v !== 'number') return '—'
  return v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`
}

// ─── M64：超终账号治理（注册申请审批 + 原生账号管理） ─────────────────────

interface AdminApplication {
  id: number
  username: string
  phone: string
  displayName: string
  reason: string
  inviteCode: string | null
  status: string
  reviewedBy: string | null
  reviewedAt: string | null
  reviewNote: string | null
  createdAt: string | null
}

interface AdminAccountItem {
  id: number
  username: string
  phone: string | null
  displayName: string
  role: string
  disabled: boolean
  lastLoginAt: string | null
  createdAt: string | null
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN', { hour12: false })
}

// ─── M65：Nebula Harness 状态面（三运行时车道） ────────────────────────────

interface HarnessRuntime {
  id: 'dsh' | 'codex'
  name: string
  origin: string
  versionPin: string
  role: string
  lane: string
  capabilities: string[]
  health: { configured: boolean; ready: boolean; detail: string }
}

interface HarnessStatus {
  charterFp: string
  lanes: {
    interactive: { ready: boolean; slots: { slot: string; model: string; label: string; verified: boolean }[] }
    heavy: { ready: boolean; configured: boolean }
    construction: { ready: boolean; enabled: boolean; executor: string }
  }
  runtimes?: HarnessRuntime[]
}

/** M69 自进化回路状态面 */
interface HarnessEvolution {
  ok: boolean
  signals24h: number
  proposals: Record<string, number>
  releases: Record<string, number>
  lastArmRun: { id: number; releaseId: number | null; actor: string; createdAt: string } | null
  stages: { signal: boolean; proposal: boolean; draft: boolean; arm: boolean }
}

/** M69 运行台账行（元数据级） */
interface HarnessRunRow {
  id: number
  tier: string
  lane: string
  factory_id: number | null
  ok: number
  error: string | null
  duration_ms: number | null
  charter_fp: string | null
  text_len: number
  created_at: string
}

/** M65 Nebula Harness 面板：interactive（modelGateway 五槽）/ heavy（DSH 运行时）/ construction（evoArm 提案闸）三车道状态灯 */
function HarnessPanel({ session }: { session: WbSession | null }) {
  const { data, loading } = useWbQuery<HarnessStatus>('nebulaHarness.status', session, {})
  if (loading || !data) return <WbPanel hud="NEBULA HARNESS" title="Nebula Harness 运行时">{loading ? <WbLoading /> : null}</WbPanel>
  const { lanes } = data
  const laneCard = (
    title: string,
    ready: boolean,
    lines: string[],
  ) => (
    <div className="rounded-xl border border-line-subtle/60 bg-void/30 px-4 py-3">
      <div className="flex items-center gap-2">
        <span className={cn('inline-block h-2 w-2 rounded-full', ready ? 'bg-emerald-400' : 'bg-red-400')} />
        <span className="text-sm font-medium text-ink-primary">{title}</span>
        <span className={cn('ml-auto text-[11px]', ready ? 'text-emerald-400' : 'text-red-400')}>
          {ready ? 'READY' : 'DOWN'}
        </span>
      </div>
      <div className="mt-2 space-y-1">
        {lines.map((l, i) => (
          <p key={i} className="text-[11px] leading-relaxed text-ink-faint">{l}</p>
        ))}
      </div>
    </div>
  )
  return (
    <WbPanel hud="NEBULA HARNESS" title="Nebula Harness 运行时">
      <p className="mb-3 text-[11px] text-ink-faint">
        执行官宪章指纹 <span className="font-mono text-forge-amber">{data.charterFp}</span>（内容变更即变，可溯源）
      </p>
      <div className="grid gap-3 md:grid-cols-3">
        {laneCard(
          '交互级 · modelGateway',
          lanes.interactive.ready,
          lanes.interactive.slots.map((s) => `${s.slot} → ${s.model}${s.verified ? ' ✓' : ''}`),
        )}
        {laneCard('重型级 · DSH 运行时', lanes.heavy.ready, [
          lanes.heavy.configured ? 'DSH_SERVICE_TOKEN 已配（127.0.0.1:18795 本机 runtime）' : 'DSH_SERVICE_TOKEN 未配置',
          'MAX_CONC=2 忙线排队 · factoryId 下行隔离',
        ])}
        {laneCard('施工级 · evoArm 提案闸', lanes.construction.ready, [
          lanes.construction.enabled ? `EVO_ARM_ENABLED=1 · executor=${lanes.construction.executor}` : 'fail-closed（生产默认关）',
          '只接受 st_releases draft · C 级双签人工闸',
        ])}
      </div>

      {/* M69：双运行时注册表面（DSH × Codex 组织版融合） */}
      {data.runtimes && data.runtimes.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-[11px] font-medium tracking-wider text-ink-faint">双运行时（GitHub 全量源码钉版内嵌 · 沙箱同构验证）</p>
          <div className="grid gap-3 md:grid-cols-2">
            {data.runtimes.map((rt) => (
              <div key={rt.id} className="rounded-xl border border-line-subtle/60 bg-void/30 px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className={cn('inline-block h-2 w-2 rounded-full', rt.health.ready ? 'bg-emerald-400' : 'bg-amber-400')} />
                  <span className="text-sm font-medium text-ink-primary">{rt.name}</span>
                  <span className="rounded bg-void/60 px-1.5 py-0.5 font-mono text-[10px] text-forge-amber">{rt.versionPin}</span>
                  <span className={cn('ml-auto text-[11px]', rt.health.ready ? 'text-emerald-400' : 'text-amber-400')}>
                    {rt.health.ready ? 'READY' : 'GATED'}
                  </span>
                </div>
                <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">{rt.role}</p>
                <p className="mt-1 font-mono text-[10px] text-ink-faint/70">{rt.origin}</p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {rt.capabilities.map((c) => (
                    <span key={c} className="rounded-full border border-line-subtle/50 px-2 py-0.5 text-[10px] text-ink-faint">{c}</span>
                  ))}
                </div>
                <p className="mt-2 text-[11px] text-ink-faint">{rt.health.detail}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* M69：自进化回路四段灯 + 运行台账 */}
      <HarnessEvolutionBlock session={session} />
    </WbPanel>
  )
}

/** M69 自进化回路：信号→提案→draft→施工 四段灯 + 计数 + 统一运行台账 */
function HarnessEvolutionBlock({ session }: { session: WbSession | null }) {
  const evo = useWbQuery<HarnessEvolution>('nebulaHarness.evolution', session, {})
  const runs = useWbQuery<{ ok: boolean; items: HarnessRunRow[] }>('nebulaHarness.runs', session, { limit: 20 })
  const e = evo.data
  const stageDefs: { key: keyof HarnessEvolution['stages']; label: string; hint: string }[] = [
    { key: 'signal', label: '信号采集', hint: 'st_evo_signals 24h' },
    { key: 'proposal', label: '提案审批', hint: 'st_evo_proposals' },
    { key: 'draft', label: 'draft 提案', hint: 'st_releases' },
    { key: 'arm', label: '施工臂', hint: "arm:run 审计" },
  ]
  return (
    <div className="mt-4">
      <p className="mb-2 text-[11px] font-medium tracking-wider text-ink-faint">自进化回路（AI 提案 · 人工双签 · AI 永不持扳机）</p>
      <div className="grid gap-3 md:grid-cols-4">
        {stageDefs.map((s, i) => {
          const on = e?.stages?.[s.key] ?? false
          return (
            <div key={s.key} className="rounded-xl border border-line-subtle/60 bg-void/30 px-4 py-3">
              <div className="flex items-center gap-2">
                <span className={cn('inline-block h-2 w-2 rounded-full', on ? 'bg-emerald-400' : 'bg-zinc-500')} />
                <span className="text-[12px] font-medium text-ink-primary">{i + 1}. {s.label}</span>
              </div>
              <p className="mt-1 font-mono text-[10px] text-ink-faint/70">{s.hint}</p>
              <p className="mt-1 text-[11px] text-ink-faint">
                {s.key === 'signal' && `${e?.signals24h ?? 0} 条/24h`}
                {s.key === 'proposal' && Object.entries(e?.proposals ?? {}).map(([k, v]) => `${k}:${v}`).join(' · ')}
                {s.key === 'draft' && Object.entries(e?.releases ?? {}).map(([k, v]) => `${k}:${v}`).join(' · ')}
                {s.key === 'arm' && (e?.lastArmRun ? `最近 #${e.lastArmRun.id} · ${e.lastArmRun.actor}` : '暂无施工记录')}
              </p>
            </div>
          )
        })}
      </div>

      <p className="mb-2 mt-4 text-[11px] font-medium tracking-wider text-ink-faint">统一运行台账（st_harness_runs · 元数据级，不落任务正文）</p>
      <div className="overflow-x-auto rounded-xl border border-line-subtle/60">
        <table className="w-full text-left text-[11px]">
          <thead>
            <tr className="border-b border-line-subtle/60 text-ink-faint">
              <th className="px-3 py-2 font-medium">时间</th>
              <th className="px-3 py-2 font-medium">分级</th>
              <th className="px-3 py-2 font-medium">执行链</th>
              <th className="px-3 py-2 font-medium">结果</th>
              <th className="px-3 py-2 font-medium">时延</th>
              <th className="px-3 py-2 font-medium">宪章指纹</th>
            </tr>
          </thead>
          <tbody>
            {(runs.data?.items ?? []).map((r) => (
              <tr key={r.id} className="border-b border-line-subtle/30 last:border-0">
                <td className="px-3 py-1.5 font-mono text-ink-faint">{String(r.created_at).replace('T', ' ').slice(0, 19)}</td>
                <td className="px-3 py-1.5 text-ink-primary">{r.tier}</td>
                <td className="px-3 py-1.5 font-mono text-ink-faint">{r.lane}</td>
                <td className={cn('px-3 py-1.5', r.ok === 1 ? 'text-emerald-400' : 'text-red-400')}>
                  {r.ok === 1 ? 'ok' : (r.error ?? 'fail')}
                </td>
                <td className="px-3 py-1.5 font-mono text-ink-faint">{r.duration_ms == null ? '—' : `${r.duration_ms}ms`}</td>
                <td className="px-3 py-1.5 font-mono text-forge-amber">{r.charter_fp ?? '—'}</td>
              </tr>
            ))}
            {(runs.data?.items ?? []).length === 0 && (
              <tr><td colSpan={6} className="px-3 py-4 text-center text-ink-faint">
                {runs.loading ? '加载中…' : '暂无台账记录（执行链跑起来后自动落账）'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** M64 超终账号治理面板：注册申请审批（approve 一次性初始密码醒目展示）+ 原生账号停用/启用 */
function AdminAuthPanel({ session }: { session: WbSession | null }) {
  const [statusFilter, setStatusFilter] = useState<'pending' | 'approved' | 'rejected' | 'all'>('pending')
  const { data, loading, refetch } = useWbQuery<{ items: AdminApplication[] }>(
    'adminAuth.applications',
    session,
    { status: statusFilter },
  )
  const accts = useWbQuery<{ items: AdminAccountItem[] }>('adminAuth.accounts', session, {})
  const [busy, setBusy] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rejectNote, setRejectNote] = useState<Record<number, string>>({})
  /** approve 成功的一次性初始密码——仅此处展示一次，审批人须立即抄录转告 */
  const [issued, setIssued] = useState<{ username: string; password: string } | null>(null)

  async function doReview(id: number, decision: 'approve' | 'reject') {
    if (!session?.token) return
    setBusy(id)
    setError(null)
    try {
      const res = await callWb<{ ok: boolean; decision: string; username?: string; initialPassword?: string }>(
        'mutation',
        'adminAuth.review',
        session,
        { applicationId: id, decision, reviewNote: rejectNote[id]?.trim() || undefined },
      )
      if (decision === 'approve' && res.initialPassword) {
        setIssued({ username: res.username ?? '', password: res.initialPassword })
      }
      refetch()
      accts.refetch()
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败')
    } finally {
      setBusy(null)
    }
  }

  async function toggleDisabled(a: AdminAccountItem) {
    if (!session?.token) return
    setBusy(a.id)
    setError(null)
    try {
      await callWb('mutation', 'adminAuth.setDisabled', session, { accountId: a.id, disabled: !a.disabled })
      accts.refetch()
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败')
    } finally {
      setBusy(null)
    }
  }

  const items = data?.items ?? []
  const accountItems = accts.data?.items ?? []

  return (
    <WbPanel hud="ADMIN ACCOUNTS" title="超终账号治理">
      {/* 一次性初始密码横幅（仅出现一次） */}
      {issued && (
        <div className="mb-4 rounded-xl border border-emerald-400/40 bg-emerald-400/10 px-4 py-3">
          <p className="text-sm font-semibold text-emerald-300">
            已通过「{issued.username}」的注册申请。初始密码（仅此一次显示，请立即抄录转告申请人）：
          </p>
          <p className="mt-1 select-all font-mono text-lg font-bold tracking-wider text-emerald-200">
            {issued.password}
          </p>
          <button
            type="button"
            onClick={() => setIssued(null)}
            className="mt-2 rounded-md border border-emerald-400/40 px-2.5 py-1 text-xs text-emerald-300 hover:bg-emerald-400/10"
          >
            我已抄录，关闭
          </button>
        </div>
      )}

      <div className="mb-3 flex items-center gap-1.5">
        {(['pending', 'approved', 'rejected', 'all'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatusFilter(s)}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs transition-colors',
              statusFilter === s
                ? 'bg-forge-amber/15 font-medium text-forge-amber'
                : 'text-ink-faint hover:text-ink-secondary',
            )}
          >
            {{ pending: '待审批', approved: '已通过', rejected: '已驳回', all: '全部' }[s]}
          </button>
        ))}
      </div>
      <WbError message={error} />

      {loading ? (
        <WbLoading />
      ) : items.length === 0 ? (
        <p className="py-4 text-center text-xs text-ink-faint">当前状态下暂无注册申请</p>
      ) : (
        <div className="mb-5 space-y-2.5">
          {items.map((a) => (
            <div key={a.id} className="rounded-xl border border-line-subtle/60 bg-void/30 px-4 py-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                <span className="font-medium text-ink-primary">{a.displayName}</span>
                <span className="font-mono text-xs text-ink-secondary">{a.username}</span>
                <span className="font-mono text-xs text-ink-faint">{a.phone}</span>
                <span
                  className={cn(
                    'rounded px-1.5 py-0.5 text-[11px]',
                    a.status === 'pending' && 'bg-forge-amber/15 text-forge-amber',
                    a.status === 'approved' && 'bg-emerald-400/15 text-emerald-400',
                    a.status === 'rejected' && 'bg-red-400/15 text-red-400',
                  )}
                >
                  {a.status === 'pending' ? '待审批' : a.status === 'approved' ? '已通过' : '已驳回'}
                </span>
                <span className="ml-auto text-[11px] text-ink-faint">{fmtTime(a.createdAt)}</span>
              </div>
              {(a.reason || a.inviteCode) && (
                <p className="mt-1.5 text-xs text-ink-faint">
                  {a.reason && <>理由：{a.reason}</>}
                  {a.inviteCode && <span className="ml-3">邀请码：{a.inviteCode}</span>}
                </p>
              )}
              {a.status !== 'pending' && (a.reviewedBy || a.reviewNote) && (
                <p className="mt-1 text-[11px] text-ink-faint">
                  审批人：{a.reviewedBy ?? '—'} {a.reviewNote && `· 备注：${a.reviewNote}`} · {fmtTime(a.reviewedAt)}
                </p>
              )}
              {a.status === 'pending' && (
                <div className="mt-2.5 flex items-center gap-2">
                  <input
                    className="h-8 flex-1 rounded-md border border-line-subtle bg-panel/60 px-2.5 text-xs text-ink-primary placeholder:text-ink-faint focus:border-forge-amber/50 focus:outline-none"
                    placeholder="审批备注（选填，驳回时建议注明原因）"
                    value={rejectNote[a.id] ?? ''}
                    onChange={(e) => setRejectNote({ ...rejectNote, [a.id]: e.target.value })}
                  />
                  <button
                    type="button"
                    disabled={busy === a.id}
                    onClick={() => void doReview(a.id, 'approve')}
                    className="inline-flex h-8 items-center gap-1 rounded-md bg-emerald-500/15 px-3 text-xs font-medium text-emerald-400 hover:bg-emerald-500/25 disabled:opacity-50"
                  >
                    {busy === a.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <BadgeCheck className="h-3 w-3" />}
                    通过
                  </button>
                  <button
                    type="button"
                    disabled={busy === a.id}
                    onClick={() => void doReview(a.id, 'reject')}
                    className="inline-flex h-8 items-center rounded-md bg-red-500/15 px-3 text-xs font-medium text-red-400 hover:bg-red-500/25 disabled:opacity-50"
                  >
                    驳回
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 原生账号列表 */}
      <p className="mb-2 border-t border-line-subtle/40 pt-4 text-xs font-medium text-ink-secondary">
        原生超终账号（{accountItems.length}）
      </p>
      {accountItems.length === 0 ? (
        <p className="py-2 text-center text-xs text-ink-faint">暂无原生账号</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-line-subtle/50 text-ink-faint">
                <th className="py-2 pr-3 font-medium">账号</th>
                <th className="py-2 pr-3 font-medium">姓名</th>
                <th className="py-2 pr-3 font-medium">手机号</th>
                <th className="py-2 pr-3 font-medium">角色</th>
                <th className="py-2 pr-3 font-medium">最近登录</th>
                <th className="py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {accountItems.map((a) => (
                <tr key={a.id} className="border-b border-line-subtle/30 text-ink-secondary">
                  <td className="py-2 pr-3 font-mono">{a.username}</td>
                  <td className="py-2 pr-3">{a.displayName}</td>
                  <td className="py-2 pr-3 font-mono">{a.phone ?? '—'}</td>
                  <td className="py-2 pr-3">
                    <span className={cn('rounded px-1.5 py-0.5 text-[11px]', a.role === 'super' ? 'bg-forge-amber/15 text-forge-amber' : 'bg-ink-faint/10 text-ink-faint')}>
                      {a.role === 'super' ? '超管' : '管理员'}
                    </span>
                    {a.disabled && <span className="ml-1.5 rounded bg-red-400/15 px-1.5 py-0.5 text-[11px] text-red-400">已停用</span>}
                  </td>
                  <td className="py-2 pr-3 text-ink-faint">{fmtTime(a.lastLoginAt)}</td>
                  <td className="py-2">
                    {a.role !== 'super' && (
                      <button
                        type="button"
                        disabled={busy === a.id}
                        onClick={() => void toggleDisabled(a)}
                        className={cn(
                          'rounded-md px-2.5 py-1 text-[11px] font-medium disabled:opacity-50',
                          a.disabled ? 'bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25' : 'bg-red-500/15 text-red-400 hover:bg-red-500/25',
                        )}
                      >
                        {a.disabled ? '启用' : '停用'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </WbPanel>
  )
}

/** 时延看板面板：summary 四卡 + 槽位表 + 逐小时双轨柱状（时延/首字） */
function LatencyPanel({ session }: { session: WbSession | null }) {
  const [hours, setHours] = useState<24 | 168>(24)
  const { data, loading } = useWbQuery<LatencyBoard>(
    'adminAnalytics.llmLatencyBoard',
    session,
    { hours },
  )
  const s = data?.summary ?? null
  const maxLat = Math.max(1, ...(data?.hourly ?? []).map((h) => h.avgLatencyMs ?? 0))
  const cards: { label: string; value: string; sub: string; warn?: boolean }[] = [
    { label: '窗口调用量', value: s ? String(s.calls) : '—', sub: `近 ${hours === 24 ? '24 小时' : '7 天'}` },
    {
      label: '成功率', value: s?.okRate != null ? `${s.okRate}%` : '—',
      sub: `降级率 ${s?.fallbackRate != null ? `${s.fallbackRate}%` : '—'}`,
      warn: s?.okRate != null && s.okRate < 95,
    },
    { label: '平均时延', value: fmtMs(s?.avgLatencyMs), sub: `p95 ${fmtMs(s?.p95LatencyMs)}` },
    {
      label: '平均首字时延',
      value: fmtMs(s?.avgFirstTokenMs),
      sub: s ? `流式调用 ${s.streamCalls} 次` : '',
      warn: s?.avgFirstTokenMs != null && s.avgFirstTokenMs > 3000,
    },
  ]
  return (
    <WbPanel hud="LLM LATENCY" title="模型时延看板">
      <div className="mb-3 flex items-center gap-2">
        {([24, 168] as const).map((h) => (
          <button
            key={h}
            onClick={() => setHours(h)}
            className={cn(
              'rounded-lg border px-3 py-1 text-xs transition-colors',
              hours === h
                ? 'border-forge-amber/60 bg-forge-amber/10 text-forge-amber'
                : 'border-line-subtle text-ink-secondary hover:text-ink-primary',
            )}
          >
            {h === 24 ? '近 24 小时' : '近 7 天'}
          </button>
        ))}
        {data?.available === false && (
          <span className="text-[11px] text-ember-red">st_llm_events 不可用（表缺失/查询失败）</span>
        )}
        {data?.sampled && <span className="text-[11px] text-ink-faint">按最近 1 万行近似</span>}
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {cards.map((c) => (
          <div key={c.label} className="rounded-xl border border-line-subtle bg-void/40 px-4 py-3">
            <p className="text-[11px] text-ink-faint">{c.label}</p>
            <p className={cn('mt-1 text-xl font-bold', c.warn ? 'text-ember-red' : 'text-ink-primary')}>
              {loading && !data ? '…' : c.value}
            </p>
            {c.sub && <p className="mt-0.5 text-[11px] text-ink-faint">{c.sub}</p>}
          </div>
        ))}
      </div>
      {(data?.bySlot.length ?? 0) > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-line-subtle text-ink-faint">
                <th className="py-2 pr-3 font-medium">槽位</th>
                <th className="py-2 pr-3 font-medium">调用</th>
                <th className="py-2 pr-3 font-medium">成功率</th>
                <th className="py-2 pr-3 font-medium">降级率</th>
                <th className="py-2 pr-3 font-medium">均时延</th>
                <th className="py-2 pr-3 font-medium">p95</th>
                <th className="py-2 font-medium">均首字</th>
              </tr>
            </thead>
            <tbody>
              {data!.bySlot.map((r) => (
                <tr key={r.name} className="border-b border-line-subtle/50 text-ink-secondary">
                  <td className="py-2 pr-3 text-ink-primary">{SLOT_NAMES[r.name] ?? r.name}</td>
                  <td className="py-2 pr-3">{r.calls}</td>
                  <td className={cn('py-2 pr-3', r.okRate != null && r.okRate < 95 && 'text-ember-red')}>
                    {r.okRate != null ? `${r.okRate}%` : '—'}
                  </td>
                  <td className="py-2 pr-3">{r.fallbackRate != null ? `${r.fallbackRate}%` : '—'}</td>
                  <td className="py-2 pr-3">{fmtMs(r.avgLatencyMs)}</td>
                  <td className="py-2 pr-3">{fmtMs(r.p95LatencyMs)}</td>
                  <td className="py-2">{fmtMs(r.avgFirstTokenMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(data?.hourly.length ?? 0) > 1 && (
        <div className="mt-4">
          <p className="mb-2 text-[11px] text-ink-faint">逐小时平均时延（柱）· 首字（琥珀色底线）</p>
          <div className="flex h-24 items-end gap-1">
            {data!.hourly.map((h) => (
              <div
                key={h.bucket}
                title={`${h.bucket}\n调用 ${h.calls} · 时延 ${fmtMs(h.avgLatencyMs)} · 首字 ${fmtMs(h.avgFirstTokenMs)}`}
                className="group relative flex-1 rounded-t-sm bg-jade-green/40 transition-colors hover:bg-jade-green/70"
                style={{ height: `${Math.max(4, ((h.avgLatencyMs ?? 0) / maxLat) * 100)}%` }}
              >
                {h.avgFirstTokenMs != null && (
                  <span
                    className="absolute bottom-0 left-0 right-0 h-0.5 bg-forge-amber"
                    style={{ bottom: `${Math.min(96, (h.avgFirstTokenMs / Math.max(1, h.avgLatencyMs ?? 1)) * 100)}%` }}
                  />
                )}
              </div>
            ))}
          </div>
          <div className="mt-1 flex justify-between text-[10px] text-ink-faint">
            <span>{data!.hourly[0]?.bucket}</span>
            <span>{data!.hourly[data!.hourly.length - 1]?.bucket}</span>
          </div>
        </div>
      )}
      {data?.note && <p className="mt-3 text-[10px] text-ink-faint">{data.note}</p>}
    </WbPanel>
  )
}

const SERVER_NAMES: Record<string, string> = {
  portal: '数字匠市门户',
  workbench: '智能工作台',
  admin: '超级终端后台',
}
const SERVER_ORDER = ['portal', 'workbench', 'admin']

const OVERALL_STYLE: Record<string, { dot: string; label: string; text: string }> = {
  ok: { dot: 'bg-jade-green shadow-[0_0_8px_rgba(52,211,153,0.6)]', label: '正常', text: 'text-jade-green' },
  warn: { dot: 'bg-forge-amber shadow-[0_0_8px_rgba(245,165,36,0.6)]', label: '异常', text: 'text-forge-amber' },
  down: { dot: 'bg-ember-red shadow-[0_0_8px_rgba(255,107,74,0.6)]', label: '宕机', text: 'text-ember-red' },
}

const SEVERITY_STYLE: Record<string, { cls: string; label: string }> = {
  critical: { cls: 'border-ember-red/40 bg-ember-red/10 text-ember-red', label: '严重' },
  high: { cls: 'border-forge-amber/50 bg-forge-amber/10 text-forge-amber', label: '高危' },
  medium: { cls: 'border-yellow-300/40 bg-yellow-300/10 text-yellow-200', label: '中危' },
}

const ALERT_STATUS_LABEL: Record<string, string> = { open: '未处理', ack: '已确认', resolved: '已解决' }

function fmtPct(v?: number | null): string {
  return typeof v === 'number' ? `${v.toFixed(1)}%` : '—'
}

/** 相对时间："N 分钟前"（<1 分钟显示"刚刚"，≥1 天显示日期） */
function relativeTime(ts?: string | null): string {
  if (!ts) return '—'
  const t = new Date(ts)
  if (Number.isNaN(t.getTime())) return '—'
  const mins = Math.floor((Date.now() - t.getTime()) / 60000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins} 分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} 小时前`
  return t.toLocaleDateString('zh-CN')
}

/** 服务器最新采集时间（取各指标 ts 的最大值） */
function latestTs(h: ServerHealth): string | null {
  if (typeof h.latestTs === 'string' && h.latestTs) return h.latestTs
  const list = [h.http?.ts, h.mem?.ts, h.load?.ts, h.disk?.ts].filter(
    (v): v is string => typeof v === 'string' && !!v,
  )
  if (list.length === 0) return null
  return list.reduce((a, b) => (new Date(a).getTime() >= new Date(b).getTime() ? a : b))
}

function HealthCard({ h }: { h: ServerHealth }) {
  const overall = OVERALL_STYLE[h.overall ?? 'down'] ?? OVERALL_STYLE.down
  const metrics: { label: string; icon: typeof Activity; value: string }[] = [
    {
      label: 'HTTP',
      icon: Globe,
      value: h.http
        ? `${h.http.code ?? '—'}${typeof h.http.latencyMs === 'number' ? ` / ${h.http.latencyMs}ms` : ''}`
        : '—',
    },
    { label: '内存', icon: MemoryStick, value: fmtPct(h.mem?.pct) },
    { label: '负载', icon: Cpu, value: typeof h.load?.avg === 'number' ? h.load.avg.toFixed(2) : '—' },
    { label: '磁盘', icon: HardDrive, value: fmtPct(h.disk?.pct) },
  ]
  return (
    <div className="glass-panel relative rounded-xl px-5 py-4">
      <div className="flex items-center gap-2.5">
        <span className={cn('inline-block h-2.5 w-2.5 shrink-0 rounded-full', overall.dot)} />
        <p className="flex items-center gap-1.5 text-sm font-medium text-ink-primary">
          <Server className="h-3.5 w-3.5 text-forge-amber" />
          {SERVER_NAMES[h.server] ?? h.server}
        </p>
        <span className={cn('ml-auto text-[11px] font-medium', overall.text)}>{overall.label}</span>
      </div>
      <p className="mt-1.5 truncate font-mono text-[11px] text-ink-faint" title={h.service ?? undefined}>
        服务：{h.service ?? '—'}
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {metrics.map((m) => (
          <div key={m.label} className="rounded-lg border border-line-subtle bg-void/40 px-3 py-2">
            <p className="flex items-center gap-1.5 text-[10px] text-ink-faint">
              <m.icon className="h-3 w-3 text-pulse-cyan" />
              {m.label}
            </p>
            <p className="mt-1 truncate font-mono text-sm font-medium text-ink-primary">{m.value}</p>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11px] text-ink-faint">最后采集：{relativeTime(latestTs(h))}</p>
    </div>
  )
}

/** 实时监控与预警区（30 秒自动刷新，卸载清理 timer） */
function RealtimeMonitor({ session }: { session: { token: string } | null }) {
  const health = useWbQuery<{ servers: ServerHealth[] }>('opsCenter.healthLatest', session, {}, {
    enabled: !!session?.token,
  })
  const [filter, setFilter] = useState<AlertFilter>('open')
  const alerts = useWbQuery<{ rows: AlertRow[]; total: number }>('opsCenter.alerts', session, { status: filter }, {
    enabled: !!session?.token,
  })
  const [busyId, setBusyId] = useState<number | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  // 30 秒自动刷新两个数据源
  useEffect(() => {
    if (!session?.token) return
    const timer = window.setInterval(() => {
      health.refetch()
      alerts.refetch()
    }, 30000)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.token])

  const setStatus = async (alertId: number, status: 'ack' | 'resolved') => {
    setBusyId(alertId)
    setActionError(null)
    try {
      await callWb('mutation', 'opsCenter.alertSetStatus', session, { alertId, status })
      alerts.refetch()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  const servers = SERVER_ORDER.map((name) => {
    const found = health.data?.servers?.find((s) => s.server === name)
    return found ?? { server: name, overall: 'down' as const }
  })

  return (
    <div className="mb-6">
      {/* 服务器健康卡 */}
      <div className="mb-2 flex items-center gap-2">
        <BellRing className="h-4 w-4 text-forge-amber" />
        <h2 className="text-sm font-bold text-ink-primary">实时监控与预警</h2>
        <span className="font-mono text-[10px] text-ink-faint">每 30 秒自动刷新</span>
      </div>
      {health.error && <WbError message={health.error} className="mb-3" />}
      <div className="grid gap-4 md:grid-cols-3">
        {health.loading && !health.data ? (
          <div className="md:col-span-3">
            <WbLoading text="服务器健康数据加载中…" />
          </div>
        ) : (
          servers.map((s) => <HealthCard key={s.server} h={s} />)
        )}
      </div>

      {/* 预警中心 */}
      <WbPanel
        hud="ALERTS"
        title="预警中心"
        className="mt-4"
        actions={
          <div className="flex gap-1.5">
            {(['open', 'ack', 'resolved', 'all'] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={cn(
                  'rounded-lg border px-3 py-1 text-xs transition-colors duration-300',
                  filter === f
                    ? 'border-forge-amber/50 bg-forge-amber/10 text-forge-amber'
                    : 'border-line-subtle text-ink-secondary hover:border-pulse-cyan/50 hover:text-ink-primary',
                )}
              >
                {f === 'open' ? '未处理' : f === 'ack' ? '已确认' : f === 'resolved' ? '已解决' : '全部'}
              </button>
            ))}
          </div>
        }
      >
        {actionError && <WbError message={actionError} className="mb-3" />}
        {alerts.error && <WbError message={alerts.error} className="mb-3" />}
        {alerts.loading && !alerts.data ? (
          <WbLoading text="预警数据加载中…" />
        ) : (alerts.data?.rows.length ?? 0) === 0 ? (
          <p className="py-6 text-center text-sm text-ink-faint">暂无预警，系统运行良好</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="border-b border-line-subtle text-xs text-ink-faint">
                  <th className="pb-2 pr-3 font-medium">级别</th>
                  <th className="pb-2 pr-3 font-medium">服务器</th>
                  <th className="pb-2 pr-3 font-medium">标题</th>
                  <th className="pb-2 pr-3 font-medium">详情</th>
                  <th className="pb-2 pr-3 font-medium">时间</th>
                  <th className="pb-2 pr-3 font-medium">状态</th>
                  {filter === 'open' && <th className="pb-2 font-medium">操作</th>}
                </tr>
              </thead>
              <tbody>
                {alerts.data!.rows.map((a) => {
                  const sev = SEVERITY_STYLE[a.severity] ?? {
                    cls: 'border-line-subtle text-ink-secondary',
                    label: a.severity,
                  }
                  return (
                    <tr key={a.id} className="border-b border-line-subtle/60 last:border-0">
                      <td className="py-2.5 pr-3">
                        <span
                          className={cn(
                            'inline-flex items-center rounded-full border px-2.5 py-0.5 font-mono text-[11px]',
                            sev.cls,
                          )}
                        >
                          {sev.label}
                        </span>
                      </td>
                      <td className="py-2.5 pr-3 text-ink-secondary">{SERVER_NAMES[a.server] ?? a.server}</td>
                      <td className="max-w-[180px] truncate py-2.5 pr-3 text-ink-primary" title={a.title}>
                        {a.title}
                      </td>
                      <td className="max-w-[220px] truncate py-2.5 pr-3 text-ink-faint" title={a.detail ?? ''}>
                        {a.detail ?? '—'}
                      </td>
                      <td className="whitespace-nowrap py-2.5 pr-3 font-mono text-[11px] text-ink-faint">
                        {a.createdAt ? new Date(a.createdAt).toLocaleString('zh-CN', { hour12: false }) : '—'}
                      </td>
                      <td className="py-2.5 pr-3">
                        <span
                          className={cn(
                            'text-[11px]',
                            a.status === 'open'
                              ? 'text-ember-red'
                              : a.status === 'ack'
                                ? 'text-forge-amber'
                                : 'text-jade-green',
                          )}
                        >
                          {ALERT_STATUS_LABEL[a.status] ?? a.status}
                        </span>
                      </td>
                      {filter === 'open' && (
                        <td className="py-2.5">
                          {a.status === 'open' && (
                            <div className="flex gap-2">
                              <button
                                type="button"
                                disabled={busyId === a.id}
                                onClick={() => void setStatus(a.id, 'ack')}
                                className="rounded-md border border-forge-amber/40 px-2.5 py-1 text-[11px] text-forge-amber transition-colors hover:bg-forge-amber/[0.08] disabled:opacity-50"
                              >
                                确认
                              </button>
                              <button
                                type="button"
                                disabled={busyId === a.id}
                                onClick={() => void setStatus(a.id, 'resolved')}
                                className="rounded-md border border-jade-green/40 px-2.5 py-1 text-[11px] text-jade-green transition-colors hover:bg-jade-green/[0.08] disabled:opacity-50"
                              >
                                解决
                              </button>
                            </div>
                          )}
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </WbPanel>
    </div>
  )
}

const SLOT_NAMES: Record<string, string> = {
  brain: '公司大脑/人设',
  orggen: '组织架构生成',
  chat: '对话交互',
  flash: '轻量任务',
  creative: '文案创意',
}

export default function AdminOps() {
  const { session } = useWbSession()
  const { data, error, loading } = useWbQuery<Overview>('opsCenter.overview', session, {}, {
    enabled: !!session?.token,
  })

  const maxReq = Math.max(1, ...(data?.trend7d.map((t) => t.requests) ?? [1]))

  return (
    <div>
      <WbPageHeader hud="OPS CENTER" title="运营监控" desc="今日核心指标、近 7 日趋势与五模型槽位状态。" />
      {/* 迭代29：实时监控与预警（独立数据源，30 秒自动刷新） */}
      <RealtimeMonitor session={session} />
      {loading ? (
        <WbLoading text="运营数据加载中…" />
      ) : error ? (
        <WbError message={error} />
      ) : !data ? null : (
        <>
          {/* 今日六指标 */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
            {[
              { label: '今日请求', value: data.today.requests, icon: Activity },
              { label: '今日错误', value: data.today.errors, icon: AlertTriangle, danger: data.today.errors > 0 },
              { label: '独立 IP', value: data.today.uniqueIps, icon: Globe },
              { label: '今日注册', value: data.today.signups, icon: UserPlus },
              { label: '今日订单', value: data.today.orders, icon: ShoppingCart },
              { label: '已支付', value: data.today.paidOrders, icon: BadgeCheck, ok: true },
            ].map((m) => (
              <div key={m.label} className="glass-panel relative rounded-xl px-5 py-4">
                <p className="flex items-center gap-2 text-xs text-ink-secondary">
                  <m.icon className={cn('h-4 w-4', m.danger ? 'text-ember-red' : m.ok ? 'text-jade-green' : 'text-forge-amber')} />
                  {m.label}
                </p>
                <p
                  className={cn(
                    'mt-2 font-display text-2xl font-bold',
                    m.danger ? 'text-ember-red' : m.ok ? 'text-jade-green' : 'text-ink-primary',
                  )}
                >
                  {m.value}
                </p>
              </div>
            ))}
          </div>

          {/* 北极星：周均被采纳产出物（B1 反馈环） */}
          {data.northStar && (
            <div className="glass-panel mt-4 flex flex-wrap items-center gap-x-8 gap-y-2 rounded-xl border-forge-amber/30 px-5 py-4">
              <p className="flex items-center gap-2 text-xs text-ink-secondary">
                <BadgeCheck className="h-4 w-4 text-forge-amber" />
                北极星 · 周均被采纳产出物
              </p>
              <p className="font-display text-2xl font-bold text-forge-amber">{data.northStar.weekAdopted}</p>
              <p className="text-xs text-ink-faint">
                驳回 {data.northStar.weekRejected} · 采纳率 {data.northStar.adoptRate === null ? '暂无反馈' : `${data.northStar.adoptRate}%`}
              </p>
            </div>
          )}

          <div className="mt-6 grid gap-6 xl:grid-cols-[1fr_360px]">
            {/* 7 日趋势（简单柱状 div） */}
            <WbPanel hud="TREND 7D" title="近 7 日趋势">
              {data.trend7d.length === 0 ? (
                <p className="text-sm text-ink-faint">暂无趋势数据</p>
              ) : (
                <div className="flex items-end gap-3">
                  {data.trend7d.map((t) => (
                    <div key={t.date} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
                      <span className="font-mono text-[10px] text-ink-faint">{t.requests}</span>
                      <div className="flex h-36 w-full items-end justify-center gap-1">
                        <div
                          title={`请求 ${t.requests}`}
                          className="w-1/3 rounded-t bg-pulse-cyan/60"
                          style={{ height: `${Math.max(4, (t.requests / maxReq) * 100)}%` }}
                        />
                        <div
                          title={`错误 ${t.errors}`}
                          className="w-1/3 rounded-t bg-ember-red/70"
                          style={{ height: `${Math.max(t.errors > 0 ? 4 : 0, (t.errors / maxReq) * 100)}%` }}
                        />
                      </div>
                      <span className="truncate font-mono text-[10px] text-ink-faint">{String(t.date).slice(5)}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-3 flex items-center gap-4 text-[11px] text-ink-faint">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2 w-2 rounded-sm bg-pulse-cyan/60" /> 请求
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2 w-2 rounded-sm bg-ember-red/70" /> 错误
                </span>
              </div>
            </WbPanel>

            {/* 五模型槽位状态灯 */}
            <WbPanel hud="LLM SLOTS" title="模型槽位状态">
              <ul className="space-y-3">
                {data.llm.map((s) => (
                  <li key={s.slot} className="flex items-center gap-3 rounded-xl border border-line-subtle bg-void/40 px-4 py-3">
                    <span
                      className={cn(
                        'inline-block h-2.5 w-2.5 shrink-0 rounded-full',
                        s.verified
                          ? 'bg-jade-green shadow-[0_0_8px_rgba(52,211,153,0.6)]'
                          : 'bg-ember-red shadow-[0_0_8px_rgba(255,107,74,0.6)]',
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 text-sm font-medium text-ink-primary">
                        <BrainCircuit className="h-3.5 w-3.5 text-forge-amber" />
                        {SLOT_NAMES[s.slot] ?? s.slot}
                      </p>
                      <p className="truncate font-mono text-[11px] text-ink-faint">{s.model}</p>
                    </div>
                    <span className={cn('text-[11px]', s.verified ? 'text-jade-green' : 'text-ember-red')}>
                      {s.verified ? '已验证' : '未验证'}
                    </span>
                  </li>
                ))}
              </ul>
              {/* B4 技能执行可靠性：失败率>5% 红色告警，不再让用户当告警器 */}
              {data.skillTools && (
                <div className={cn(
                  'mt-4 rounded-xl border px-4 py-3 text-xs',
                  data.skillTools.failRate > 5
                    ? 'border-ember-red/40 bg-ember-red/10 text-ember-red'
                    : 'border-line-subtle bg-void/40 text-ink-secondary',
                )}>
                  <p className="flex items-center gap-2 font-medium">
                    技能执行可靠性：成功 {data.skillTools.ok} 次 · 失败 {data.skillTools.fail} 次 · 失败率 {data.skillTools.failRate}%
                    {data.skillTools.failRate > 5 && <span className="font-bold">⚠ 超阈值，请检查模型网关</span>}
                  </p>
                  {data.skillTools.recentFails.length > 0 && (
                    <p className="mt-1 text-[11px] opacity-80">
                      最近失败：{data.skillTools.recentFails.slice(-3).map((f) => `${f.skillKey}(${f.channel})`).join('、')}
                    </p>
                  )}
                </div>
              )}
            </WbPanel>

            {/* M61 模型时延看板：LLM 链路从此有眼睛（st_llm_events 窗口聚合） */}
            <div className="xl:col-span-2">
              <LatencyPanel session={session} />
            </div>

            {/* M64 超终账号治理：注册申请审批 + 原生账号停用/启用 */}
            <div className="xl:col-span-2">
              <AdminAuthPanel session={session} />
            </div>

            {/* M65 Nebula Harness：三运行时车道状态 */}
            <div className="xl:col-span-2">
              <HarnessPanel session={session} />
            </div>
          </div>
        </>
      )}
    </div>
  )
}
