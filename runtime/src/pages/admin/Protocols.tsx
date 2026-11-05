/**
 * Protocols（/admin/protocols）—— 组织中枢·协议评审台（iter100 M2-1）。
 * 具名协议全生命周期：草案提交（draft）→ 评审（approve/reject）→ 上线（active）→ 废止（deprecated）。
 * 数据：gate.protocolList / gate.protocolDraft / gate.protocolReview / gate.protocolDeprecate（均 admin）。
 * 铁律：active 协议不可改写——只能废止后立新（服务端强约束，前端同步禁用）。
 */
import { useState } from 'react'
import { Gavel, ScrollText, Trash2 } from 'lucide-react'
import { callWb, useWbQuery, useWbSession, wbErrorMessage } from '@/lib/wbSession'
import {
  WbButton,
  WbEmpty,
  WbError,
  WbField,
  WbLoading,
  WbNotice,
  WbPageHeader,
  WbPanel,
  wbInputCls,
} from '@/components/wb/ui'
import { cn } from '@/lib/utils'
import { adminConfirm } from '@/pages/admin/shared'

interface ProtocolRow {
  code: string
  name: string
  level: string
  version: number
  status: string
  reviewedBy: string | null
  createdAt: string | null
}

interface ReviewRow {
  code: string
  action: string
  reviewer: string
  comment: string | null
  createdAt: string | null
}

const STATUS_LABEL: Record<string, string> = {
  draft: '草案',
  reviewing: '评审中',
  active: '已上线',
  rejected: '已驳回',
  deprecated: '已废止',
}

const STATUS_CLS: Record<string, string> = {
  draft: 'border-pulse-cyan/40 text-pulse-cyan',
  reviewing: 'border-forge-amber/40 text-forge-amber',
  active: 'border-jade-green/40 text-jade-green',
  rejected: 'border-ember-red/40 text-ember-red',
  deprecated: 'border-line-subtle text-ink-faint',
}

const LEVEL_CLS: Record<string, string> = {
  A: 'text-jade-green',
  B: 'text-pulse-cyan',
  C: 'text-forge-amber',
  D: 'text-ember-red',
}

export default function AdminProtocols() {
  const { session } = useWbSession()
  const { data, error, loading, refetch } = useWbQuery<{ protocols: ProtocolRow[]; reviews: ReviewRow[] }>(
    'gate.protocolList',
    session,
  )

  // 草案表单
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [level, setLevel] = useState<'A' | 'B' | 'C' | 'D'>('B')
  const [script, setScript] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    setErr(null)
    setNotice(null)
    try {
      await fn()
      setNotice(ok)
      refetch()
    } catch (e) {
      setErr(wbErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const submitDraft = () =>
    run(
      () =>
        callWb('mutation', 'gate.protocolDraft', session, {
          code: code.trim(),
          name: name.trim(),
          level,
          script: script.trim() || undefined,
        }),
      `协议 ${code.trim()} 草案已登记，待评审`,
    )

  const review = (c: string, decision: 'approve' | 'reject') => {
    const comment = window.prompt(decision === 'approve' ? '通过意见（可选）' : '驳回理由（建议填写）') ?? ''
    run(
      () => callWb('mutation', 'gate.protocolReview', session, { code: c, decision, comment: comment || undefined }),
      decision === 'approve' ? `协议 ${c} 已上线（active）` : `协议 ${c} 已驳回`,
    )
  }

  const deprecate = (c: string) => {
    if (!window.confirm(`确认废止协议 ${c}？白名单即刻失效，相关意图提交将被拒。`)) return
    run(() => callWb('mutation', 'gate.protocolDeprecate', session, { code: c }), `协议 ${c} 已废止`)
  }

  // ─── M7-e：自然语言评审指令（解析 → 复述预览 → 确认执行，同权同流水） ───
  const [nlCmd, setNlCmd] = useState('')
  const [nlPreview, setNlPreview] = useState<string | null>(null)

  const nlParse = async () => {
    const cmd = nlCmd.trim()
    if (!cmd || busy) return
    setBusy(true)
    setErr(null)
    setNotice(null)
    setNlPreview(null)
    try {
      const r = await callWb<{ stage: string; recite?: string }>('mutation', 'adminAi.reviewCommand', session, {
        command: cmd,
      })
      setNlPreview(r.recite ?? '解析完成，确认后执行。')
    } catch (e) {
      setErr(wbErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const nlConfirm = async () => {
    const cmd = nlCmd.trim()
    if (!cmd || busy) return
    setBusy(true)
    setErr(null)
    setNotice(null)
    try {
      const r = await callWb<{ reply?: string }>('mutation', 'adminAi.reviewCommand', session, {
        command: cmd,
        confirm: true,
      })
      setNotice(r.reply ?? '评审指令已执行')
      setNlPreview(null)
      setNlCmd('')
      refetch()
    } catch (e) {
      setErr(wbErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <WbPageHeader
        hud="GATE"
        title="协议评审台"
        desc="组织中枢具名协议全生命周期：草案 → 评审 → 上线 → 废止。active 协议不可改写，只能废止后立新。"
      />

      {/* M7-e：自然语言评审指令（灵枢解析，确认后执行，流水 reviewer=ai-cmd:<admin>） */}
      <WbPanel hud="AI COMMAND" title="自然语言评审指令">
        <div className="flex items-center gap-2">
          <input
            value={nlCmd}
            onChange={(e) => setNlCmd(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !nlPreview) nlParse()
            }}
            placeholder="例如：驳回 device_rehearsal，理由：缺 undo"
            className={cn(wbInputCls, 'flex-1')}
          />
          {!nlPreview ? (
            <WbButton onClick={nlParse} disabled={busy || !nlCmd.trim()}>
              解析指令
            </WbButton>
          ) : (
            <>
              <WbButton onClick={nlConfirm} disabled={busy}>
                确认执行
              </WbButton>
              <button
                type="button"
                onClick={() => setNlPreview(null)}
                className="rounded-lg px-3 py-2 text-xs text-ink-muted transition-colors hover:text-ink-primary"
              >
                放弃
              </button>
            </>
          )}
        </div>
        {nlPreview && (
          <p className="mt-2 rounded-lg border border-forge-amber/40 bg-forge-amber/10 px-3 py-2 text-xs text-forge-amber">
            {nlPreview}
          </p>
        )}
      </WbPanel>

      <WbPanel title="新建协议草案">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <WbField label="协议 code（小写蛇形）" hint="如 device_rehearsal">
            <input className={wbInputCls} value={code} onChange={(e) => setCode(e.target.value)} placeholder="device_rehearsal" />
          </WbField>
          <WbField label="协议名称">
            <input className={wbInputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="设备预演工单" />
          </WbField>
          <WbField label="级别" hint="A 只读自动 / B 自动 / C 两段式 / D 永不自动">
            <select className={wbInputCls} value={level} onChange={(e) => setLevel(e.target.value as 'A' | 'B' | 'C' | 'D')}>
              <option value="A">A</option>
              <option value="B">B</option>
              <option value="C">C</option>
              <option value="D">D</option>
            </select>
          </WbField>
          <WbField label="剧本（步骤与逆操作）">
            <input className={wbInputCls} value={script} onChange={(e) => setScript(e.target.value)} placeholder="步骤：…；逆操作：…" />
          </WbField>
        </div>
        <div className="mt-4">
          <WbButton onClick={submitDraft} loading={busy} disabled={!code.trim() || !name.trim()}>
            <ScrollText className="h-4 w-4" /> 提交草案
          </WbButton>
        </div>
      </WbPanel>

      <WbError message={error ?? err} />
      <WbNotice message={notice} />

      <WbPanel title="协议集">
        {loading && <WbLoading />}
        {!loading && data && data.protocols.length === 0 && <WbEmpty text="暂无协议" />}
        {!loading && data && data.protocols.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line-subtle text-left text-xs text-ink-faint">
                  <th className="py-2 pr-4">code</th>
                  <th className="py-2 pr-4">名称</th>
                  <th className="py-2 pr-4">级别</th>
                  <th className="py-2 pr-4">版本</th>
                  <th className="py-2 pr-4">状态</th>
                  <th className="py-2 pr-4">评审人</th>
                  <th className="py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {data.protocols.map((p) => (
                  <tr key={p.code} className="border-b border-line-subtle/50">
                    <td className="py-2.5 pr-4 font-mono text-xs text-ink-primary">{p.code}</td>
                    <td className="py-2.5 pr-4 text-ink-primary">{p.name}</td>
                    <td className={cn('py-2.5 pr-4 font-bold', LEVEL_CLS[p.level] ?? 'text-ink-secondary')}>{p.level}</td>
                    <td className="py-2.5 pr-4 text-ink-secondary">v{p.version}</td>
                    <td className="py-2.5 pr-4">
                      <span className={cn('rounded-full border px-2 py-0.5 text-xs', STATUS_CLS[p.status] ?? 'border-line-subtle text-ink-secondary')}>
                        {STATUS_LABEL[p.status] ?? p.status}
                      </span>
                    </td>
                    <td className="py-2.5 pr-4 text-xs text-ink-faint">{p.reviewedBy ?? '—'}</td>
                    <td className="py-2.5">
                      <div className="flex gap-2">
                        {(p.status === 'draft' || p.status === 'reviewing') && (
                          <>
                            <WbButton variant="secondary" className="px-2.5 py-1 text-xs" disabled={busy} onClick={() => review(p.code, 'approve')}>
                              <Gavel className="h-3.5 w-3.5" /> 通过
                            </WbButton>
                            <WbButton variant="danger" className="px-2.5 py-1 text-xs" disabled={busy} onClick={() => review(p.code, 'reject')}>
                              驳回
                            </WbButton>
                          </>
                        )}
                        {p.status === 'active' && (
                          <WbButton variant="danger" className="px-2.5 py-1 text-xs" disabled={busy} onClick={() => deprecate(p.code)}>
                            <Trash2 className="h-3.5 w-3.5" /> 废止
                          </WbButton>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </WbPanel>

      {/* 死端点处置 t8：解冻确认台（gate.pendingUnfreezes + unfreezeConfirm） */}
      <UnfreezePanel />

      <WbPanel title="评审流水">
        {data && data.reviews.length === 0 && <WbEmpty text="暂无评审记录" />}
        {data && data.reviews.length > 0 && (
          <div className="space-y-2">
            {data.reviews.map((r, i) => (
              <div key={i} className="flex items-baseline gap-3 text-xs">
                <span className="text-ink-faint">{r.createdAt ? new Date(String(r.createdAt)).toLocaleString('zh-CN', { hour12: false }) : ''}</span>
                <span className="font-mono text-pulse-cyan">{r.code}</span>
                <span className={cn(r.action === 'approve' ? 'text-jade-green' : r.action === 'reject' ? 'text-ember-red' : 'text-ink-secondary')}>
                  {r.action}
                </span>
                <span className="text-ink-secondary">{r.reviewer}</span>
                {r.comment && <span className="truncate text-ink-faint">{r.comment}</span>}
              </div>
            ))}
          </div>
        )}
      </WbPanel>
    </div>
  )
}


// ─── 死端点处置 t8：平台解冻确认台 ───────────────────────────────────────────
interface UnfreezeItem {
  factoryId: number
  enterpriseName: string
  requestedAt: string | null
}

function UnfreezePanel() {
  const { session } = useWbSession()
  const q = useWbQuery<{ items: UnfreezeItem[] }>('gate.pendingUnfreezes', session)
  const [busy, setBusy] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const confirm = async (factoryId: number, name: string) => {
    if (!session?.token || busy != null) return
    if (!adminConfirm(`确认为「${name}」解冻？解冻须企业主已发起请求，本操作即刻恢复该厂写权限。`)) return
    setBusy(factoryId)
    setErr(null)
    try {
      await callWb('mutation', 'gate.unfreezeConfirm', session, { factoryId })
      setNote(`「${name}」已解冻。`)
      q.refetch()
    } catch (e) {
      setErr(wbErrorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const items = q.data?.items ?? []
  return (
    <WbPanel title="解冻确认台" hud="FREEZE GATE" className="mb-6">
      <WbError message={err} className="mb-2" />
      <WbNotice message={note} className="mb-2" />
      {q.loading ? (
        <WbLoading text="读取待解冻清单…" />
      ) : items.length === 0 ? (
        <WbEmpty text="暂无待确认的解冻请求" hint="企业被冻结后由企业主发起解冻请求，平台在此单方确认（双方动作缺一不可）" />
      ) : (
        <div className="space-y-2">
          {items.map((it) => (
            <div key={it.factoryId} className="flex items-center justify-between rounded-lg border border-line-subtle/60 px-3.5 py-2.5 text-xs">
              <span className="text-ink-primary">{it.enterpriseName}</span>
              <span className="font-mono text-[10px] text-ink-faint">{it.requestedAt?.replace('T', ' ').slice(0, 16) ?? ''}</span>
              <WbButton variant="secondary" loading={busy === it.factoryId} onClick={() => void confirm(it.factoryId, it.enterpriseName)} className="px-3 py-1 text-xs">
                确认解冻
              </WbButton>
            </div>
          ))}
        </div>
      )}
    </WbPanel>
  )
}
