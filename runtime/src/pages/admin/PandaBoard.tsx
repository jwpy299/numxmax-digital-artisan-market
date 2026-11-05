/**
 * PandaBoard（/admin/panda）—— Panda 组织驾驶舱（iter79）。
 * 四角色席位管理（co指挥官/ex执行者/va监察者/ev学习者，平台级+租户级）+
 * 分级审批中心（l1_auto/l2_tenant/l3_platform 待审批操作单，一键审批/驳回）。
 * 数据：claw.pandaMembers / pandaMemberUpsert / pandaMemberToggle /
 *       claw.pandaApprovals / pandaApprove / clawReject
 */
import { useState } from 'react'
import { CheckCircle2, Plus, RefreshCw, ShieldCheck, XCircle } from 'lucide-react'
import { useWbSession, useWbQuery, wbMutation, wbErrorMessage } from '@/lib/wbSession'
import {
  WbButton,
  WbEmpty,
  WbError,
  WbLoading,
  WbPageHeader,
  WbPanel,
  wbInputCls,
} from '@/components/wb/ui'
import { adminConfirm, fmtTime } from './shared'
import BaseKitChips from '@/components/wb/BaseKitChips'
import { cn } from '@/lib/utils'

interface PandaMember {
  id: number
  factoryId: number | null
  role: 'co' | 'ex' | 'va' | 'ev'
  refType: string
  refKey: string
  deptKey: string | null
  duty: string
  enabled: number
  createdAt: unknown
  updatedAt: unknown
}

interface ApprovalItem {
  opNo: string
  instanceKey: string | null
  actor: string
  task: string
  domain: string | null
  risk: string
  approvalLevel: 'l1_auto' | 'l2_tenant' | 'l3_platform'
  factoryId: number | null
  createdAt: unknown
}

const ROLE_META: Record<string, { label: string; emoji: string; desc: string }> = {
  co: { label: 'Panda-CO 指挥官', emoji: '🎖️', desc: '任务分解、派单与仲裁' },
  ex: { label: 'Panda-EX 执行者', emoji: '🦞', desc: '龙虾内核：浏览器/工具执行' },
  va: { label: 'Panda-VA 监察者', emoji: '🛡️', desc: '过程巡检与证据核验' },
  ev: { label: 'Panda-EV 学习者', emoji: '🧠', desc: '进化报告与自愈' },
}

const LEVEL_META: Record<string, { label: string; cls: string }> = {
  l1_auto: { label: 'L1 自动', cls: 'border-pulse-cyan/40 bg-pulse-cyan/10 text-pulse-cyan' },
  l2_tenant: { label: 'L2 租户', cls: 'border-forge-amber/40 bg-forge-amber/10 text-forge-amber' },
  l3_platform: { label: 'L3 平台', cls: 'border-red-400/40 bg-red-400/10 text-red-300' },
}

const RISK_CLS: Record<string, string> = {
  low: 'text-ink-faint',
  mid: 'text-forge-amber',
  high: 'text-red-300',
}

export default function AdminPandaBoard() {
  const { session } = useWbSession()
  const members = useWbQuery<{ items: PandaMember[] }>('claw.pandaMembers', session)
  const approvals = useWbQuery<{ items: ApprovalItem[] }>('claw.pandaApprovals', session)
  // iter97 打通：相关协同会议（共生工作空间最近 5 场）
  const meetings = useWbQuery<{ items: { id: number; topic: string; status: string; createdAt: unknown }[] }>('terminal.meetingList', session)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [opErr, setOpErr] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // 新席位表单
  const [role, setRole] = useState<'co' | 'ex' | 'va' | 'ev'>('co')
  const [refType, setRefType] = useState<'agent' | 'staff' | 'admin' | 'model' | 'kernel'>('staff')
  const [refKey, setRefKey] = useState('')
  const [factoryId, setFactoryId] = useState('')
  const [duty, setDuty] = useState('')
  const [adding, setAdding] = useState(false)

  async function run(key: string, fn: () => Promise<unknown>, okMsg?: string) {
    if (!session) return
    setBusyKey(key)
    setOpErr(null)
    setNotice(null)
    try {
      await fn()
      if (okMsg) setNotice(okMsg)
      members.refetch()
      approvals.refetch()
    } catch (e) {
      setOpErr(wbErrorMessage(e))
    } finally {
      setBusyKey(null)
    }
  }

  function handleAdd() {
    if (!session?.token || !refKey.trim() || adding) return
    if (!adminConfirm(`新增席位：${ROLE_META[role].label} ← ${refType}:${refKey.trim()}${factoryId.trim() ? `（租户 #${factoryId.trim()}）` : '（平台级）'}`)) return
    setAdding(true)
    void run('add', async () => {
      await wbMutation('claw.pandaMemberUpsert', {
        token: session!.token,
        role,
        refType,
        refKey: refKey.trim(),
        factoryId: factoryId.trim() ? Number(factoryId.trim()) : null,
        duty: duty.trim() || undefined,
      })
      setRefKey('')
      setDuty('')
    }, '席位已配置').finally(() => setAdding(false))
  }

  function handleToggle(m: PandaMember) {
    if (!session?.token) return
    const next = !m.enabled
    void run(`toggle-${m.id}`, async () => {
      await wbMutation('claw.pandaMemberToggle', { token: session!.token, id: m.id, enabled: next })
    }, next ? '席位已启用' : '席位已停用')
  }

  function handleApprove(a: ApprovalItem) {
    if (!session?.token) return
    if (!adminConfirm(`审批通过操作单 ${a.opNo}？\n任务：${a.task.slice(0, 80)}\n通过后实例将后台执行。`)) return
    void run(`ap-${a.opNo}`, async () => {
      const res = await wbMutation<{ message: string }>('claw.pandaApprove', { token: session!.token, opNo: a.opNo })
      setNotice(res.message)
    })
  }

  function handleReject(a: ApprovalItem) {
    if (!session?.token) return
    if (!adminConfirm(`驳回操作单 ${a.opNo}？（留痕，不可恢复）`)) return
    void run(`rj-${a.opNo}`, async () => {
      await wbMutation('claw.clawReject', { token: session!.token, opNo: a.opNo })
    }, '已驳回并留痕')
  }

  const platformSeats = (members.data?.items ?? []).filter((m) => m.factoryId == null)
  const tenantSeats = (members.data?.items ?? []).filter((m) => m.factoryId != null)

  return (
    <div>
      <WbPageHeader
        hud="PANDA ORG · COMMAND DECK"
        title="Panda 组织驾驶舱"
        desc="四角色组织框架（指挥官/执行者/监察者/学习者）席位管理 + 分级审批中心（L1 自动 / L2 租户 / L3 平台）。"
      />
      <WbError message={opErr} />
      {notice && (
        <div className="mb-4 rounded-xl border border-pulse-cyan/30 bg-pulse-cyan/[0.06] px-4 py-2.5 text-sm text-pulse-cyan">
          {notice}
        </div>
      )}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        {/* 四角色席位 */}
        <div className="space-y-4">
          <WbPanel title="四角色席位" hud="ORG SEATS">
            {members.loading && <WbLoading />}
            <WbError message={members.error} />
            {/* iter99：全员出生自带标配技能徽章 */}
            <BaseKitChips className="mb-2" />
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {(['co', 'ex', 'va', 'ev'] as const).map((r) => {
                const meta = ROLE_META[r]
                const seat = platformSeats.find((m) => m.role === r)
                return (
                  <div key={r} className="rounded-[10px] border border-line-subtle bg-void/40 p-3">
                    <p className="text-sm font-medium text-ink-primary">
                      {meta.emoji} {meta.label}
                    </p>
                    <p className="mt-0.5 text-[11px] text-ink-faint">{meta.desc}</p>
                    {seat ? (
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <span className="font-mono text-[11px] text-pulse-cyan">
                          {seat.refType}:{seat.refKey}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleToggle(seat)}
                          disabled={busyKey === `toggle-${seat.id}`}
                          className={cn(
                            'rounded-full border px-2 py-0.5 text-[10px] transition-colors duration-300',
                            seat.enabled
                              ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300'
                              : 'border-line-subtle text-ink-faint',
                          )}
                        >
                          {seat.enabled ? '运行中' : '已停用'}
                        </button>
                      </div>
                    ) : (
                      <p className="mt-2 text-[11px] text-ink-faint">（未配置平台级席位）</p>
                    )}
                  </div>
                )
              })}
            </div>
            {tenantSeats.length > 0 && (
              <div className="mt-4 border-t border-line-subtle pt-3">
                <p className="hud-label mb-2">租户级席位（{tenantSeats.length}）</p>
                <div className="space-y-1.5">
                  {tenantSeats.map((m) => (
                    <div key={m.id} className="flex items-center justify-between gap-2 rounded-[8px] border border-line-subtle px-3 py-1.5 text-xs">
                      <span className="text-ink-secondary">
                        #{m.factoryId} · {ROLE_META[m.role]?.emoji} {ROLE_META[m.role]?.label ?? m.role}
                        <span className="ml-2 font-mono text-pulse-cyan">{m.refType}:{m.refKey}</span>
                        {m.duty && <span className="ml-2 text-ink-faint">{m.duty}</span>}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleToggle(m)}
                        className={cn(
                          'rounded-full border px-2 py-0.5 text-[10px]',
                          m.enabled ? 'border-emerald-400/40 text-emerald-300' : 'border-line-subtle text-ink-faint',
                        )}
                      >
                        {m.enabled ? '运行中' : '已停用'}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </WbPanel>

          <WbPanel title="配置席位" hud="NEW SEAT">
            <div className="grid grid-cols-2 gap-2">
              <select className={wbInputCls} value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
                {(['co', 'ex', 'va', 'ev'] as const).map((r) => (
                  <option key={r} value={r}>{ROLE_META[r].label}</option>
                ))}
              </select>
              <select className={wbInputCls} value={refType} onChange={(e) => setRefType(e.target.value as typeof refType)}>
                {(['staff', 'agent', 'admin', 'model', 'kernel'] as const).map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
            <input
              className={cn(wbInputCls, 'mt-2')}
              value={refKey}
              onChange={(e) => setRefKey(e.target.value)}
              placeholder="引用键（如 staff 用户名 / agent code / 模型名）"
              maxLength={64}
            />
            <div className="mt-2 grid grid-cols-2 gap-2">
              <input
                className={wbInputCls}
                value={factoryId}
                onChange={(e) => setFactoryId(e.target.value.replace(/\D/g, ''))}
                placeholder="租户ID（留空=平台级）"
                maxLength={10}
              />
              <input
                className={wbInputCls}
                value={duty}
                onChange={(e) => setDuty(e.target.value)}
                placeholder="职责说明（可选）"
                maxLength={200}
              />
            </div>
            <WbButton className="mt-3 w-full" onClick={handleAdd} loading={adding} disabled={!refKey.trim()}>
              <Plus className="h-4 w-4" />
              配置席位
            </WbButton>
          </WbPanel>
        </div>

        {/* 分级审批中心 */}
        <WbPanel title="分级审批中心" hud="APPROVALS">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-xs text-ink-faint">
              待审批 {approvals.data?.items.length ?? 0} 单 · L1 自动 / L2 租户 / L3 平台
            </p>
            <WbButton variant="secondary" onClick={() => approvals.refetch()}>
              <RefreshCw className="h-3.5 w-3.5" />
              刷新
            </WbButton>
          </div>
          {approvals.loading && <WbLoading />}
          <WbError message={approvals.error} />
          {approvals.data && approvals.data.items.length === 0 && (
            <WbEmpty text="无待审批操作单" hint="龙虾/组织任务产生待办单后会出现在这里。" />
          )}
          <div className="space-y-2">
            {(approvals.data?.items ?? []).map((a) => {
              const lv = LEVEL_META[a.approvalLevel] ?? LEVEL_META.l2_tenant
              return (
                <div key={a.opNo} className="rounded-[10px] border border-line-subtle bg-void/40 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={cn('rounded-full border px-2 py-0.5 font-mono text-[10px]', lv.cls)}>{lv.label}</span>
                    <span className="font-mono text-[11px] text-ink-faint">{a.opNo}</span>
                    <span className={cn('text-[11px]', RISK_CLS[a.risk] ?? 'text-ink-faint')}>风险:{a.risk}</span>
                    {a.domain && <span className="text-[11px] text-pulse-cyan">{a.domain}</span>}
                    <span className="ml-auto text-[10px] text-ink-faint">{fmtTime(a.createdAt)}</span>
                  </div>
                  <p className="mt-1.5 text-sm text-ink-primary">{a.task}</p>
                  <p className="mt-1 text-[11px] text-ink-faint">
                    发起人 {a.actor} · 实例 {a.instanceKey ?? 'main'}{a.factoryId ? ` · 租户 #${a.factoryId}` : ''}
                  </p>
                  <div className="mt-2 flex gap-2">
                    <WbButton onClick={() => handleApprove(a)} loading={busyKey === `ap-${a.opNo}`}>
                      <CheckCircle2 className="h-4 w-4" />
                      审批执行
                    </WbButton>
                    <WbButton variant="secondary" onClick={() => handleReject(a)} loading={busyKey === `rj-${a.opNo}`}>
                      <XCircle className="h-4 w-4" />
                      驳回
                    </WbButton>
                  </div>
                </div>
              )
            })}
          </div>
          <p className="mt-4 flex items-center gap-1.5 text-[10px] text-ink-faint">
            <ShieldCheck className="h-3.5 w-3.5" />
            审批留痕 approved_by/approved_at，并发互斥保护（单实例单任务）。
          </p>
        </WbPanel>
        {/* iter97 打通：相关协同会议 */}
        <WbPanel title="相关协同会议（共生工作空间）" hud="MEETINGS" className="xl:col-span-2">
          {meetings.loading && <WbLoading />}
          <div className="space-y-2">
            {(meetings.data?.items ?? []).slice(0, 5).map((m) => (
              <div key={m.id}
                className="flex items-center justify-between rounded-lg border border-white/5 px-3 py-2 text-sm text-ink-secondary">
                <span>{m.topic}</span>
                <span className="text-xs text-ink-faint">{m.status} · {String(m.createdAt).slice(0, 10)}（详情到工作台·共生工作空间）</span>
              </div>
            ))}
            {(meetings.data?.items ?? []).length === 0 && !meetings.loading && (
              <WbEmpty text="暂无会议" hint="共生工作空间发起圆桌会议后会出现在这里。" />
            )}
          </div>
        </WbPanel>
      </div>
    </div>
  )
}
