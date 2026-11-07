/**
 * System（/admin/system）—— 系统健康：门户 / 工作台双系统 HTTP 探测 + 数据库连通状态。
 * 单个目标失败不影响其他目标展示（后端 5s 超时兜底）。
 */
import { Activity, BrainCircuit, Database, Download, Globe, RefreshCw, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { useWbSession, useWbQuery, wbMutation, type WbSession } from '@/lib/wbSession'
import { WbError, WbLoading, WbPageHeader, WbPanel, WbButton } from '@/components/wb/ui'
import { cn } from '@/lib/utils'

interface ProbeResult {
  url: string
  httpCode: number
  latencyMs: number
  ok: boolean
}

interface HealthResp {
  portal: ProbeResult
  workbench: ProbeResult
  database: { ok: boolean; latencyMs: number }
}

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={cn(
        'inline-block h-2.5 w-2.5 rounded-full',
        ok ? 'bg-jade-green shadow-[0_0_8px_rgba(52,211,153,0.6)]' : 'bg-ember-red shadow-[0_0_8px_rgba(255,107,74,0.6)]',
      )}
    />
  )
}

function ProbeCard({ title, icon: Icon, probe }: { title: string; icon: typeof Globe; probe: ProbeResult }) {
  return (
    <div className="glass-panel relative rounded-xl px-5 py-4">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-2 text-sm font-medium text-ink-primary">
          <Icon className="h-4 w-4 text-forge-amber" />
          {title}
        </p>
        <StatusDot ok={probe.ok} />
      </div>
      <p className="mt-2 break-all font-mono text-xs text-ink-faint">{probe.url}</p>
      <div className="mt-3 flex items-center gap-4 text-xs text-ink-secondary">
        <span>
          HTTP <span className="font-mono text-ink-primary">{probe.httpCode || '—'}</span>
        </span>
        <span>
          延迟 <span className="font-mono text-ink-primary">{probe.latencyMs}ms</span>
        </span>
        <span className={probe.ok ? 'text-jade-green' : 'text-ember-red'}>
          {probe.ok ? '可达' : '不可达'}
        </span>
      </div>
    </div>
  )
}

// ─── 模型网关（海禛云五模型统一接入）─────────────────────────────────────────
interface SlotRow {
  slot: string
  model: string
  label: string
  envOverride: string
  verified: boolean
}
interface ModelGatewayResp {
  configuredCount: number
  verifiedCount: number
  totalCount: number
  note: string
  ido?: {
    label: string
    configured: boolean
    baseUrl: string
    verifiedCount: number
    totalCount: number
    models: { model: string; verified: boolean }[]
    slots: SlotRow[]
    // M67：海禛云 41 模型全量目录（服务端 GATEWAY_CATALOG 下发，只读）
    catalog?: CatalogRow[]
    catalogCount?: number
  }
}
interface CatalogRow {
  id: string
  vendor: string
  label: string
  variant?: 'cloud' | 'idoictos'
}
interface SlotPingResp {
  ok: boolean
  results: { slot: string; model: string; ok: boolean; latencyMs?: number; reason?: string }[]
}

const SLOT_NAMES: Record<string, string> = {
  brain: '公司大脑/人设',
  orggen: '组织架构生成',
  chat: '对话交互',
  flash: '轻量任务',
  creative: '文案创意',
}

function ModelGatewayPanel({ session }: { session: WbSession | null }) {
  const { data, error, loading, refetch } = useWbQuery<ModelGatewayResp>('modelGateway.status', session)
  const [pinging, setPinging] = useState(false)
  const [ping, setPing] = useState<SlotPingResp | null>(null)
  const [pingErr, setPingErr] = useState<string | null>(null)

  async function runPing() {
    if (!session) return
    setPinging(true)
    setPingErr(null)
    try {
      const res = await wbMutation<SlotPingResp>('modelGateway.slotPing', { token: session.token })
      setPing(res)
      refetch()
    } catch (e) {
      setPingErr(e instanceof Error ? e.message : '健康检查失败')
    } finally {
      setPinging(false)
    }
  }

  const ido = data?.ido
  return (
    <WbPanel
      title="模型网关 · 五模型统一接入"
      hud="MODEL GATEWAY"
      className="mt-6"
      actions={
        <WbButton variant="secondary" loading={pinging} onClick={() => void runPing()}>
          <RefreshCw className="h-4 w-4" />
          五模型健康检查
        </WbButton>
      }
    >
      <WbError message={error ?? pingErr} className="mb-3" />
      {loading && !data && <WbLoading text="模型状态加载中…" />}
      {data && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3 text-xs">
            <span className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5">
              <BrainCircuit className="h-4 w-4 text-forge-amber" />
              海禛云统一网关：
              {ido?.configured ? (
                <span className="text-jade-green">已配置（已验证 {ido.verifiedCount}/{ido.totalCount}）</span>
              ) : (
                <span className="text-ember-red">未配置</span>
              )}
            </span>
            <span className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5">
              官方四模型备用链：{data.configuredCount}/{data.totalCount} 已配置
            </span>
          </div>
          <p className="mb-4 text-xs text-ink-secondary">{data.note}</p>
          {ido && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-white/10 text-ink-faint">
                    <th className="px-3 py-2">能力槽位</th>
                    <th className="px-3 py-2">驱动场景</th>
                    <th className="px-3 py-2">模型</th>
                    <th className="px-3 py-2">状态</th>
                    {ping && <th className="px-3 py-2">实测</th>}
                  </tr>
                </thead>
                <tbody>
                  {ido.slots.map((s) => {
                    const pr = ping?.results.find((r) => r.slot === s.slot)
                    return (
                      <tr key={s.slot} className="border-b border-white/5">
                        <td className="px-3 py-2 font-mono text-forge-amber">{s.slot}</td>
                        <td className="px-3 py-2 text-ink-secondary">{SLOT_NAMES[s.slot] ?? s.label}</td>
                        <td className="px-3 py-2 font-mono text-ink-primary">{s.model}</td>
                        <td className="px-3 py-2">
                          <span className="flex items-center gap-1.5">
                            <StatusDot ok={s.verified} />
                            <span className={s.verified ? 'text-jade-green' : 'text-ink-faint'}>
                              {s.verified ? '已验证' : '未验证'}
                            </span>
                          </span>
                        </td>
                        {ping && (
                          <td className="px-3 py-2 font-mono">
                            {pr ? (
                              pr.ok ? (
                                <span className="text-jade-green">OK {pr.latencyMs}ms</span>
                              ) : (
                                <span className="text-ember-red">{pr.reason ?? 'fail'}</span>
                              )
                            ) : (
                              '—'
                            )}
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
                槽位型号可用服务端环境变量覆盖：IDO_MODEL_BRAIN / IDO_MODEL_ORGGEN / IDO_MODEL_CHAT /
                IDO_MODEL_FLASH / IDO_MODEL_CREATIVE；密钥仅存服务端环境变量，本页面绝不明文展示。
                网关不可用时自动回退官方四模型故障转移链，再失败降级为规则模板（不影响业务运行）。
              </p>
              {/* M67：海禛云统一网关 41 模型全量目录（按厂商分组，超终直读） */}
              {ido.catalog && ido.catalog.length > 0 && (
                <div className="mt-4">
                  <p className="mb-2 text-xs font-medium text-ink-secondary">
                    海禛云全量模型目录（{ido.catalogCount ?? ido.catalog.length} 个，任一模型可通过槽位
                    envOverride 零代码接入）
                  </p>
                  <div className="overflow-x-auto rounded-lg border border-white/10">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b border-white/10 bg-white/[0.03] text-ink-faint">
                          <th className="px-3 py-2">厂商</th>
                          <th className="px-3 py-2">模型 ID</th>
                          <th className="px-3 py-2">展示名</th>
                          <th className="px-3 py-2">通道</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ido.catalog.map((m) => (
                          <tr key={m.id} className="border-b border-white/5">
                            <td className="px-3 py-1.5 font-mono text-forge-amber">{m.vendor}</td>
                            <td className="px-3 py-1.5 font-mono text-ink-primary">{m.id}</td>
                            <td className="px-3 py-1.5 text-ink-secondary">{m.label}</td>
                            <td className="px-3 py-1.5 text-ink-faint">{m.variant ?? '默认'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </WbPanel>
  )
}

// ─── 龙虾派活台（组织版 OpenClaw · 两段式审批闸门）───────────────────────────
interface ClawOp {
  opNo: string
  instanceKey: string
  actor: string
  task: string
  domain: string | null
  status: string
  reply: string | null
  evidenceArtifactId: number | null
  error: string | null
  createdAt: string | null
  finishedAt: string | null
}

interface ClawInstance {
  instanceKey: string
  displayName: string
  containerName: string
  agentId: string
  status: string
  busyOpNo: string | null
}

const INST_STATUS: Record<string, { label: string; cls: string }> = {
  active: { label: '在役', cls: 'text-jade-green' },
  paused: { label: '已暂停', cls: 'text-forge-amber' },
  retired: { label: '已退休', cls: 'text-ink-faint' },
}

const CLAW_STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: '待审批', cls: 'text-forge-amber' },
  running: { label: '执行中', cls: 'text-sky-300' },
  done: { label: '已完成', cls: 'text-jade-green' },
  failed: { label: '失败', cls: 'text-ember-red' },
  rejected: { label: '已驳回', cls: 'text-ink-faint' },
}

function ClawPanel({ session }: { session: WbSession | null }) {
  const { data, error, loading, refetch } = useWbQuery<{ rows: ClawOp[] }>('claw.clawList', session)
  const instQ = useWbQuery<{ rows: ClawInstance[] }>('claw.clawInstances', session)
  const [reg, setReg] = useState({ instanceKey: '', displayName: '', containerName: '', agentId: 'main' })
  const [instKey, setInstKey] = useState('main')
  const [task, setTask] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [mutErr, setMutErr] = useState<string | null>(null)

  async function act(mut: string, input: Record<string, unknown>, busyKey: string) {
    if (!session) return
    setBusy(busyKey)
    setMutErr(null)
    setNotice(null)
    try {
      const res = await wbMutation<{ ok: boolean; message?: string; reason?: string }>(
        mut,
        { token: session.token, ...input },
      )
      setNotice(res.message ?? res.reason ?? (res.ok ? '操作成功' : '操作未生效'))
      if (mut === 'claw.clawDispatch') setTask('')
      if (mut === 'claw.clawInstanceUpsert') setReg({ instanceKey: '', displayName: '', containerName: '', agentId: 'main' })
      refetch()
      instQ.refetch()
    } catch (e) {
      setMutErr(e instanceof Error ? e.message : '操作失败')
    } finally {
      setBusy(null)
    }
  }

  async function downloadEvidence(op: ClawOp) {
    if (!session || !op.evidenceArtifactId) return
    setBusy(`dl-${op.opNo}`)
    setMutErr(null)
    try {
      const res = await wbMutation<{ filename: string; mime: string; base64: string }>(
        'terminal.artifactDownload',
        { token: session.token, artifactId: op.evidenceArtifactId },
      )
      const bin = atob(res.base64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const url = URL.createObjectURL(new Blob([bytes], { type: res.mime }))
      const link = document.createElement('a')
      link.href = url
      link.download = res.filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      setMutErr(e instanceof Error ? e.message : '证据下载失败')
    } finally {
      setBusy(null)
    }
  }

  const rows = data?.rows ?? []
  return (
    <WbPanel
      title="龙虾派活台 · 浏览器自动化"
      hud="CLAW DISPATCH"
      className="mt-6"
      actions={
        <WbButton variant="secondary" loading={loading} onClick={refetch}>
          <RefreshCw className="h-4 w-4" />
          刷新
        </WbButton>
      }
    >
      <WbError message={error ?? mutErr} className="mb-3" />
      {notice && (
        <p className="mb-3 rounded-lg border border-jade-green/30 bg-jade-green/10 px-3 py-2 text-xs text-jade-green">
          {notice}
        </p>
      )}
      <div className="mb-4 flex gap-2">
        <input
          value={task}
          onChange={(e) => setTask(e.target.value)}
          placeholder="给龙虾派一个浏览器任务，例如：打开 example.com 截图首页"
          className="flex-1 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-ink-primary placeholder:text-ink-faint focus:border-forge-amber/50 focus:outline-none"
          maxLength={500}
        />
        {instQ.data && instQ.data.rows.filter((i) => i.status === 'active').length > 1 && (
          <select
            value={instKey}
            onChange={(e) => setInstKey(e.target.value)}
            className="rounded-lg border border-white/10 bg-white/[0.04] px-2 py-2 text-xs text-ink-primary focus:outline-none"
          >
            {instQ.data.rows.filter((i) => i.status === 'active').map((i) => (
              <option key={i.instanceKey} value={i.instanceKey}>{i.displayName}</option>
            ))}
          </select>
        )}
        <WbButton
          loading={busy === 'dispatch'}
          disabled={task.trim().length < 2}
          onClick={() => void act('claw.clawDispatch', { task: task.trim(), instanceKey: instKey }, 'dispatch')}
        >
          <ShieldCheck className="h-4 w-4" />
          派活（待审批）
        </WbButton>
      </div>
      <p className="mb-4 text-[11px] leading-relaxed text-ink-faint">
        两段式闸门：派活仅创建操作单，需手动「批准执行」龙虾才会动手；域名白名单管控（默认允许
        example.com / baidu.com，可由服务端环境变量 CLAW_ALLOWED_DOMAINS 覆盖），白名单外任务自动驳回并留痕。
        并发互斥：同一实例同一时刻只执行一个任务（单会话保护），执行中的新审批将被拒绝并提示实例忙。
      </p>
      {instQ.data && (
        <div className="mb-5 rounded-xl border border-white/10 bg-white/[0.03] p-4">
          <p className="mb-3 text-xs font-medium text-ink-primary">龙虾实例农场（{instQ.data.rows.length}）</p>
          <table className="mb-4 w-full text-left text-xs">
            <thead>
              <tr className="border-b border-white/10 text-ink-faint">
                <th className="px-2 py-1.5">实例</th>
                <th className="px-2 py-1.5">名称</th>
                <th className="px-2 py-1.5">容器 / Agent</th>
                <th className="px-2 py-1.5">状态</th>
                <th className="px-2 py-1.5">操作</th>
              </tr>
            </thead>
            <tbody>
              {instQ.data.rows.map((i) => {
                const st = INST_STATUS[i.status] ?? { label: i.status, cls: 'text-ink-faint' }
                return (
                  <tr key={i.instanceKey} className="border-b border-white/5">
                    <td className="px-2 py-1.5 font-mono text-forge-amber">{i.instanceKey}</td>
                    <td className="px-2 py-1.5 text-ink-primary">{i.displayName}</td>
                    <td className="px-2 py-1.5 font-mono text-ink-secondary">{i.containerName} / {i.agentId}</td>
                    <td className={cn('px-2 py-1.5', st.cls)}>
                      {st.label}{i.busyOpNo && <span className="ml-1 text-sky-300">·忙 {i.busyOpNo}</span>}
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      {i.status === 'active' && (
                        <button
                          className="text-forge-amber hover:underline disabled:opacity-40"
                          disabled={busy !== null}
                          onClick={() => void act('claw.clawInstanceSetStatus', { instanceKey: i.instanceKey, status: 'paused' }, `st-${i.instanceKey}`)}
                        >暂停</button>
                      )}
                      {i.status !== 'retired' && !i.busyOpNo && (
                        <button
                          className="mr-3 text-sky-300 hover:underline disabled:opacity-40"
                          disabled={busy !== null}
                          onClick={() => void act('claw.clawInstanceProvision', { instanceKey: i.instanceKey, dryRun: false }, `pv-${i.instanceKey}`)}
                        >起容器</button>
                      )}
                      {i.status === 'retired' && (
                        <button
                          className="text-ink-faint hover:underline disabled:opacity-40"
                          disabled={busy !== null}
                          onClick={() => void act('claw.clawInstanceTeardown', { instanceKey: i.instanceKey }, `td-${i.instanceKey}`)}
                        >回收容器</button>
                      )}
                      {i.status === 'paused' && (
                        <>
                          <button
                            className="text-jade-green hover:underline disabled:opacity-40"
                            disabled={busy !== null}
                            onClick={() => void act('claw.clawInstanceSetStatus', { instanceKey: i.instanceKey, status: 'active' }, `st-${i.instanceKey}`)}
                          >启用</button>
                          {i.instanceKey !== 'main' && (
                            <button
                              className="ml-3 text-ember-red hover:underline disabled:opacity-40"
                              disabled={busy !== null}
                              onClick={() => void act('claw.clawInstanceSetStatus', { instanceKey: i.instanceKey, status: 'retired' }, `st-${i.instanceKey}`)}
                            >退休</button>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div className="flex flex-wrap gap-2">
            <input value={reg.instanceKey} onChange={(e) => setReg({ ...reg, instanceKey: e.target.value })} placeholder="实例标识 如 tenant-a" className="w-36 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 text-xs text-ink-primary placeholder:text-ink-faint focus:outline-none" />
            <input value={reg.displayName} onChange={(e) => setReg({ ...reg, displayName: e.target.value })} placeholder="显示名称" className="w-32 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 text-xs text-ink-primary placeholder:text-ink-faint focus:outline-none" />
            <input value={reg.containerName} onChange={(e) => setReg({ ...reg, containerName: e.target.value })} placeholder="容器名 如 orgclaw-ta" className="w-40 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 text-xs text-ink-primary placeholder:text-ink-faint focus:outline-none" />
            <input value={reg.agentId} onChange={(e) => setReg({ ...reg, agentId: e.target.value })} placeholder="agent" className="w-20 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 text-xs text-ink-primary placeholder:text-ink-faint focus:outline-none" />
            <WbButton
              variant="secondary"
              loading={busy === 'reg'}
              disabled={reg.instanceKey.trim().length < 2 || reg.displayName.trim().length < 2 || reg.containerName.trim().length < 2}
              onClick={() => void act('claw.clawInstanceUpsert', { instanceKey: reg.instanceKey.trim(), displayName: reg.displayName.trim(), containerName: reg.containerName.trim(), agentId: reg.agentId.trim() || 'main' }, 'reg')}
            >注册实例</WbButton>
          </div>
          <p className="mt-2 text-[10px] text-ink-faint">注册仅落账（懒接触，不校验容器存在）；暂停/退休需实例空闲；主实例 main 不可退休防自锁。</p>
        </div>
      )}
      {loading && !data && <WbLoading text="操作单加载中…" />}
      {data && rows.length === 0 && <p className="text-xs text-ink-faint">暂无操作单，派一个任务试试。</p>}
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-white/10 text-ink-faint">
                <th className="px-3 py-2">单号</th>
                <th className="px-3 py-2">实例</th>
                <th className="px-3 py-2">任务</th>
                <th className="px-3 py-2">域名</th>
                <th className="px-3 py-2">状态</th>
                <th className="px-3 py-2">结果</th>
                <th className="px-3 py-2">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((op) => {
                const st = CLAW_STATUS[op.status] ?? { label: op.status, cls: 'text-ink-faint' }
                return (
                  <tr key={op.opNo} className="border-b border-white/5 align-top">
                    <td className="px-3 py-2 font-mono text-forge-amber">{op.opNo}</td>
                    <td className="px-3 py-2 font-mono text-ink-secondary">{op.instanceKey ?? 'main'}</td>
                    <td className="max-w-[260px] px-3 py-2 text-ink-primary">
                      <span className="line-clamp-2">{op.task}</span>
                      <span className="mt-1 block text-[10px] text-ink-faint">
                        {op.actor} · {op.createdAt ?? ''}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-ink-secondary">{op.domain ?? '—'}</td>
                    <td className={cn('px-3 py-2 whitespace-nowrap', st.cls)}>{st.label}</td>
                    <td className="max-w-[240px] px-3 py-2">
                      {op.reply && <span className="line-clamp-2 text-ink-secondary">{op.reply}</span>}
                      {op.error && <span className="line-clamp-2 text-ember-red">{op.error}</span>}
                      {!op.reply && !op.error && <span className="text-ink-faint">—</span>}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {op.status === 'pending' && (
                        <span className="flex gap-2">
                          <WbButton
                            variant="secondary"
                            loading={busy === `ok-${op.opNo}`}
                            onClick={() => void act('claw.clawConfirm', { opNo: op.opNo }, `ok-${op.opNo}`)}
                          >
                            批准执行
                          </WbButton>
                          <WbButton
                            variant="danger"
                            loading={busy === `no-${op.opNo}`}
                            onClick={() => void act('claw.clawReject', { opNo: op.opNo }, `no-${op.opNo}`)}
                          >
                            驳回
                          </WbButton>
                        </span>
                      )}
                      {op.status === 'done' && op.evidenceArtifactId && (
                        <WbButton
                          variant="secondary"
                          loading={busy === `dl-${op.opNo}`}
                          onClick={() => void downloadEvidence(op)}
                        >
                          <Download className="h-4 w-4" />
                          下载证据
                        </WbButton>
                      )}
                      {op.status === 'running' && <span className="text-ink-faint">浏览器作业中…</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </WbPanel>
  )
}

export default function AdminSystem() {
  const { session } = useWbSession()
  const { data, error, loading, refetch } = useWbQuery<HealthResp>('admin.systemHealth', session)

  return (
    <div>
      <WbPageHeader
        hud="SYSTEM HEALTH"
        title="系统健康"
        desc="门户与工作台公开地址探测（5 秒超时，单个失败不影响整体）与本库连通状态。"
      />
      <WbPanel
        title="运行状态"
        hud="HEALTH CHECK"
        actions={<WbButton variant="secondary" loading={loading} onClick={refetch}>重新探测</WbButton>}
      >
        <WbError message={error} className="mb-3" />
        {loading && !data && <WbLoading text="探测中…" />}
        {data && (
          <div className="grid gap-4 md:grid-cols-3">
            <ProbeCard title="NumX Max·数字匠市门户" icon={Globe} probe={data.portal} />
            <ProbeCard title="NumX Max 智能工作台" icon={Activity} probe={data.workbench} />
            <div className="glass-panel relative rounded-xl px-5 py-4">
              <div className="flex items-center justify-between">
                <p className="flex items-center gap-2 text-sm font-medium text-ink-primary">
                  <Database className="h-4 w-4 text-forge-amber" />
                  统一数据库（MySQL）
                </p>
                <StatusDot ok={data.database.ok} />
              </div>
              <p className="mt-2 font-mono text-xs text-ink-faint">SELECT 1 连通性检查</p>
              <div className="mt-3 flex items-center gap-4 text-xs text-ink-secondary">
                <span>
                  延迟 <span className="font-mono text-ink-primary">{data.database.latencyMs}ms</span>
                </span>
                <span className={data.database.ok ? 'text-jade-green' : 'text-ember-red'}>
                  {data.database.ok ? '已连接' : '连接失败'}
                </span>
              </div>
            </div>
          </div>
        )}
        <p className="mt-4 text-[11px] leading-relaxed text-ink-faint">
          探测地址由后端环境变量 PORTAL_URL / WORKBENCH_URL 配置，默认值分别为
          https://downloads.example.invalid 与 https://wb.lingshu-nebulaai.com（:3100/:3000 死端口面已退役）。
        </p>
      </WbPanel>
      <ModelGatewayPanel session={session} />
      <ClawPanel session={session} />
    </div>
  )
}
