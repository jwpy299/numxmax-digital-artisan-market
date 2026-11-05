/**
 * Recommend（/admin/recommend）—— 推荐位运营（迭代 35 批次B，opsRecommend.*）。
 * 3 个槽位 Tab：portal_agents（门户数字员工）/ portal_packs（门户技能包）/ shop_packs（技能商店）。
 * 每槽列表（targetName / weight / pinned / note）+ 设置（upsert，含审计）+ 移除。
 * 消费侧排序 pinned desc, weight desc，仅排序不滤除。
 */
import { useState } from 'react'
import { Pin, PinOff, Star, Trash2 } from 'lucide-react'
import { callWb, useWbQuery, useWbSession, wbErrorMessage } from '@/lib/wbSession'
import { WbButton, WbEmpty, WbError, WbLoading, WbNotice, WbPageHeader, WbPanel } from '@/components/wb/ui'
import { cn } from '@/lib/utils'

interface RecoItem {
  targetId?: string | number
  target_id?: string | number
  targetName?: string
  target_name?: string
  weight?: number
  pinned?: boolean
  note?: string | null
  updatedBy?: string
  updated_by?: string
  updatedAt?: string
  updated_at?: string
}
interface RecoListResp {
  items?: RecoItem[]
  rows?: RecoItem[]
}

const SLOTS = [
  { key: 'portal_agents', label: '门户数字员工', hint: 'portal 数字员工列表排序' },
  { key: 'portal_packs', label: '门户技能包', hint: 'portal 技能包列表排序' },
  { key: 'shop_packs', label: '技能商店', hint: '技能商店列表排序' },
] as const
type SlotKey = (typeof SLOTS)[number]['key']

function fmt(v: unknown): string {
  return v ? new Date(String(v)).toLocaleString('zh-CN', { hour12: false }) : '—'
}

export default function AdminRecommend() {
  const { session } = useWbSession()
  const [slot, setSlot] = useState<SlotKey>('portal_agents')
  const query = useWbQuery<RecoListResp>('opsRecommend.recoList', session, { slotKey: slot }, { enabled: !!session?.token })
  const items: RecoItem[] = query.data?.items ?? query.data?.rows ?? []

  // 设置表单
  const [targetId, setTargetId] = useState('')
  const [weight, setWeight] = useState('0')
  const [pinned, setPinned] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [removeBusy, setRemoveBusy] = useState<string | number | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)

  const switchSlot = (k: SlotKey) => {
    setSlot(k)
    setErr(null)
    setOk(null)
    setTargetId('')
    setWeight('0')
    setPinned(false)
    setNote('')
  }

  const submitSet = async () => {
    const tid = targetId.trim()
    if (!tid) {
      setErr('请填写目标 ID（targetId）')
      return
    }
    const w = Number(weight)
    setBusy(true)
    setErr(null)
    setOk(null)
    try {
      await callWb('mutation', 'opsRecommend.recoSet', session, {
        slotKey: slot,
        targetId: tid,
        ...(Number.isFinite(w) ? { weight: Math.trunc(w) } : {}),
        pinned,
        ...(note.trim() ? { note: note.trim() } : {}),
      })
      setOk(`已写入推荐位（写入即审计留痕）。`)
      query.refetch()
    } catch (e) {
      setErr(wbErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (tid: string | number) => {
    setRemoveBusy(tid)
    setErr(null)
    setOk(null)
    try {
      await callWb('mutation', 'opsRecommend.recoRemove', session, { slotKey: slot, targetId: tid })
      setOk('已移除，消费侧排序随即恢复默认。')
      query.refetch()
    } catch (e) {
      setErr(wbErrorMessage(e))
    } finally {
      setRemoveBusy(null)
    }
  }

  const activeSlot = SLOTS.find((s) => s.key === slot)!

  return (
    <div>
      <WbPageHeader
        hud="RECOMMEND SLOTS"
        title="推荐位运营"
        desc="三个推荐槽位统一运营：置顶 + 权重决定展示顺序（pinned desc, weight desc, 原排序），只影响排序不滤除任何条目；写操作自动审计。"
      />

      {/* 槽位 Tab */}
      <div className="mb-5 flex flex-wrap gap-1.5">
        {SLOTS.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => switchSlot(s.key)}
            className={cn(
              'rounded-lg border px-3.5 py-1.5 text-xs transition-colors duration-300',
              slot === s.key
                ? 'border-forge-amber/50 bg-forge-amber/10 text-forge-amber'
                : 'border-line-subtle text-ink-secondary hover:border-pulse-cyan/50 hover:text-ink-primary',
            )}
          >
            {s.label}
            <span className="ml-1.5 font-mono text-[10px] opacity-70">{s.key}</span>
          </button>
        ))}
      </div>

      <WbError message={err} className="mb-4" />
      <WbNotice message={ok} className="mb-4" />

      {/* 设置表单 */}
      <WbPanel hud="UPSERT" title={`设置推荐（${activeSlot.label}）`} className="mb-6">
        <p className="mb-4 text-[11px] text-ink-faint">
          同槽位同 targetId 为 upsert（唯一键 uk_slot_target）；留空字段保持原值。影响：{activeSlot.hint}。
        </p>
        <div className="grid gap-4 md:grid-cols-[1.4fr_0.7fr_0.8fr_1.6fr_auto]">
          <div>
            <label className="mb-1 block text-xs text-ink-faint">目标 ID（targetId）</label>
            <input
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              placeholder="数字员工/技能包 ID 或 key"
              className="w-full rounded-[10px] border border-line-subtle bg-void/60 px-3 py-2 font-mono text-sm text-ink-primary outline-none transition-colors focus:border-forge-amber/50"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-ink-faint">权重</label>
            <input
              type="number"
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
              className="w-full rounded-[10px] border border-line-subtle bg-void/60 px-3 py-2 font-mono text-sm text-ink-primary outline-none transition-colors focus:border-forge-amber/50"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-ink-faint">置顶</label>
            <button
              type="button"
              onClick={() => setPinned((p) => !p)}
              className={cn(
                'flex w-full items-center justify-center gap-1.5 rounded-[10px] border px-3 py-2 text-sm transition-colors',
                pinned
                  ? 'border-forge-amber/50 bg-forge-amber/10 text-forge-amber'
                  : 'border-line-subtle text-ink-secondary hover:border-pulse-cyan/50',
              )}
            >
              {pinned ? <Pin className="h-4 w-4" /> : <PinOff className="h-4 w-4" />}
              {pinned ? '已置顶' : '不置顶'}
            </button>
          </div>
          <div>
            <label className="mb-1 block text-xs text-ink-faint">备注（可选）</label>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full rounded-[10px] border border-line-subtle bg-void/60 px-3 py-2 text-sm text-ink-primary outline-none transition-colors focus:border-forge-amber/50"
            />
          </div>
          <div className="flex items-end">
            <WbButton onClick={submitSet} loading={busy}>
              <Star className="h-4 w-4" /> 写入
            </WbButton>
          </div>
        </div>
      </WbPanel>

      {/* 槽位列表 */}
      <WbPanel hud="SLOT ITEMS" title={`当前槽位条目（${items.length}）`}>
        {query.loading && !query.data ? (
          <WbLoading text="推荐位加载中…" />
        ) : query.error ? (
          <WbError message={query.error} />
        ) : items.length === 0 ? (
          <WbEmpty text="该槽位暂无推荐条目" hint="写入后消费侧按 pinned desc, weight desc 排序。" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-left text-sm">
              <thead>
                <tr className="border-b border-line-subtle text-xs text-ink-faint">
                  <th className="pb-2 pr-3 font-medium">目标</th>
                  <th className="pb-2 pr-3 font-medium">targetId</th>
                  <th className="pb-2 pr-3 font-medium">权重</th>
                  <th className="pb-2 pr-3 font-medium">置顶</th>
                  <th className="pb-2 pr-3 font-medium">备注</th>
                  <th className="pb-2 pr-3 font-medium">更新时间</th>
                  <th className="pb-2 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, i) => {
                  const tid = it.targetId ?? it.target_id ?? `row-${i}`
                  return (
                    <tr key={String(tid)} className="border-b border-line-subtle/60 last:border-0">
                      <td className="py-2.5 pr-3 text-ink-primary">{it.targetName ?? it.target_name ?? '—'}</td>
                      <td className="py-2.5 pr-3 font-mono text-xs text-ink-secondary">{String(it.targetId ?? it.target_id ?? '—')}</td>
                      <td className="py-2.5 pr-3 font-mono text-ink-secondary">{Number(it.weight ?? 0)}</td>
                      <td className="py-2.5 pr-3">
                        {it.pinned ? (
                          <span className="inline-flex items-center gap-1 rounded-full border border-forge-amber/40 bg-forge-amber/10 px-2 py-0.5 font-mono text-[10px] text-forge-amber">
                            <Pin className="h-3 w-3" /> 置顶
                          </span>
                        ) : (
                          <span className="text-[11px] text-ink-faint">—</span>
                        )}
                      </td>
                      <td className="max-w-[200px] truncate py-2.5 pr-3 text-xs text-ink-secondary">{it.note ?? '—'}</td>
                      <td className="py-2.5 pr-3 font-mono text-[11px] text-ink-faint">{fmt(it.updatedAt ?? it.updated_at)}</td>
                      <td className="py-2.5">
                        <button
                          type="button"
                          disabled={removeBusy === tid}
                          onClick={() => remove(tid)}
                          className="inline-flex items-center gap-1 rounded-md border border-ember-red/40 px-2.5 py-1 text-[11px] text-ember-red transition-colors hover:bg-ember-red/[0.08] disabled:opacity-50"
                        >
                          <Trash2 className="h-3 w-3" /> 移除
                        </button>
                      </td>
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
