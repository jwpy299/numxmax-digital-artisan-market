/**
 * StationQueues —— 灵智枢四舱队列页（彭总令 2026-08-31：各舱队列挂进超终 Tab）。
 * 运行舱（告警）/ 更新舱（待审提案，可认领）/ 市场舱（上架审核）/ 渠道舱（合伙人队列：认领→联系/签约/驳回）。
 * 数据：internalOps.myStation + internalOps.channelLeads（HQ 闸，服务端认领制）。
 */
import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import { useWbSession, wbMutation, wbQuery } from '@/lib/wbSession'
import { DEFAULT_STATION_TAB, STATION_CODE_REL, STATION_CODE_MKT, STATION_CODE_FIN, STATION_CODE_OPS, STATION_CODE_RUNOPS, STATION_CODE_LAW, STATION_CODE_BRAND, STATION_CODE_CH, STATION_CODE_KNOW } from '@/lib/adminStations'

interface StationItem { kind: string; station: string; id: number; title: string; claimedBy: number | null; mine: boolean; at: string }
interface Lead { id: number; city: string; role: string; name: string; phone: string; note: string | null; status: string; claimed_by: number | null; claimedName: string | null; at: string }

const TABS = [
  { key: STATION_CODE_REL, label: '更新舱', color: 'text-forge-amber' },
  { key: STATION_CODE_MKT, label: '市场舱', color: 'text-pink-300' },
  { key: STATION_CODE_FIN, label: '财务舱', color: 'text-yellow-300' },
  { key: STATION_CODE_OPS, label: '运行舱', color: 'text-emerald-300' },
  { key: STATION_CODE_RUNOPS, label: '运营舱', color: 'text-teal-300' },
  { key: STATION_CODE_LAW, label: '法务舱', color: 'text-sky-300' },
  { key: STATION_CODE_BRAND, label: '品牌舱', color: 'text-rose-300' },
  { key: STATION_CODE_CH, label: '渠道舱', color: 'text-indigo-300' },
  { key: STATION_CODE_KNOW, label: '文化知识舱', color: 'text-violet-300' },
]
const LEAD_STATUS: Record<string, string> = { pending: '待联系', contacted: '已联系', signed: '已签约', rejected: '已驳回' }

export default function StationQueues() {
  const { session } = useWbSession()
  const token = session?.token ?? ''
  const [params, setParams] = useSearchParams()
  const rawTab = params.get('tab')
  // R19 票③+R21 票③：未知 tab 同按缺失回落＋URL 同步清洗（脏参数不滞留地址栏——刷新/分享不再带回脏态）
  const tab = rawTab && TABS.some((t) => t.key === rawTab) ? rawTab : DEFAULT_STATION_TAB
  useEffect(() => {
    // R26 票④+R27 票③：rawTab !== null 覆盖全部脏参数（空值 ''/未知值——不再读 params.has，依赖数组干净）
    if (rawTab !== null && rawTab !== tab) {
      setParams((prev) => {
        const next = new URLSearchParams(prev)
        next.delete('tab')
        return next
      }, { replace: true })
    }
  }, [rawTab, tab, setParams]) // deps：rawTab 派生自 params（URLSearchParams 每 render 新算——params 对象身份随 setParams 变，rawTab 已是最新值）
  const [items, setItems] = useState<StationItem[]>([])
  const [leads, setLeads] = useState<Lead[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!token) return
    try {
      const [s, l] = await Promise.all([
        wbQuery<{ items: StationItem[] }>('internalOps.myStation', { token }),
        wbQuery<{ leads: Lead[] }>('internalOps.channelLeads', { token }),
      ])
      setItems(s.items); setLeads(l.leads); setErr(null)
    } catch (e) { setErr(e instanceof Error ? e.message : '加载失败（需灵智枢内部成员）') }
  }, [token])
  useEffect(() => { void load() }, [load])

  const claim = async (it: StationItem) => {
    setBusy(true)
    try {
      await wbMutation('internalOps.claim', { token, kind: it.kind, id: it.id })
      await load()
    } catch (e) { setErr(e instanceof Error ? e.message : '认领失败') } finally { setBusy(false) }
  }
  const decide = async (l: Lead, action: 'contacted' | 'signed' | 'rejected') => {
    setBusy(true)
    try {
      await wbMutation('internalOps.leadDecide', { token, leadId: l.id, action })
      await load()
    } catch (e) { setErr(e instanceof Error ? e.message : '处置失败') } finally { setBusy(false) }
  }
  const claimLead = async (l: Lead) => {
    setBusy(true)
    try {
      await wbMutation('internalOps.claim', { token, kind: 'partner', id: l.id })
      await load()
    } catch (e) { setErr(e instanceof Error ? e.message : '认领失败') } finally { setBusy(false) }
  }

  const tabItems = items.filter((i) => i.station === tab)

  return (
    <div className="mx-auto max-w-5xl px-5 py-6">
      <h1 className="font-display text-lg font-bold text-ink-primary">灵智枢四舱队列</h1>
      <div className="mt-3 flex gap-2">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setParams({ tab: t.key })}
            className={`rounded-lg border px-3 py-1.5 text-xs font-bold ${t.color} ${tab === t.key ? 'border-current bg-white/[0.06]' : 'border-line-subtle opacity-60'}`}>
            {t.label}
          </button>
        ))}
      </div>
      {err && <p className="mt-3 rounded-lg border border-ember-red/40 bg-ember-red/10 px-3 py-2 text-xs text-ember-red">{err}</p>}

      {tab === STATION_CODE_CH ? (
        <div className="mt-4 space-y-2">
          {leads.length === 0 && <p className="text-xs text-ink-faint">渠道舱队列清爽</p>}
          {leads.map((l) => (
            <div key={l.id} className="rounded-xl border border-line-subtle px-4 py-3 text-xs">
              <div className="flex items-center justify-between">
                <p className="text-sm font-bold text-ink-primary">{l.name} <span className="text-ink-faint">（{l.city} · {l.role === 'partner' ? '城市合伙人' : '城市代理人'}）</span></p>
                <span className="text-forge-amber">{LEAD_STATUS[l.status] ?? l.status}</span>
              </div>
              <p className="mt-1 text-ink-secondary">{l.phone}{l.note ? ` · ${l.note}` : ''} · {l.at}</p>
              <div className="mt-2 flex items-center gap-2">
                {l.status === 'pending' && (
                  l.claimed_by == null
                    ? <button disabled={busy} onClick={() => void claimLead(l)} className="rounded border border-pulse-cyan/40 px-2 py-0.5 text-pulse-cyan hover:bg-pulse-cyan/10">认领</button>
                    : <>
                        <span className="text-ink-faint">认领人：{l.claimedName ?? '—'}</span>
                        <button disabled={busy} onClick={() => void decide(l, 'contacted')} className="rounded border border-emerald-300/40 px-2 py-0.5 text-emerald-300 hover:bg-emerald-300/10">已联系</button>
                        <button disabled={busy} onClick={() => void decide(l, 'signed')} className="rounded border border-forge-amber/40 px-2 py-0.5 text-forge-amber hover:bg-forge-amber/10">签约</button>
                        <button disabled={busy} onClick={() => void decide(l, 'rejected')} className="rounded border border-ember-red/40 px-2 py-0.5 text-ember-red hover:bg-ember-red/10">驳回</button>
                      </>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-4 space-y-2">
          {tabItems.length === 0 && <p className="text-xs text-ink-faint">本舱队列清爽</p>}
          {tabItems.map((it) => (
            <div key={`${it.kind}-${it.id}`} className="flex items-center justify-between rounded-xl border border-line-subtle px-4 py-3 text-xs">
              <div>
                <p className="text-sm text-ink-primary">{it.title}</p>
                <p className="mt-1 text-ink-faint">{it.kind} · {it.at}</p>
              </div>
              {it.mine
                ? <span className="text-forge-amber">我认领的</span>
                : it.claimedBy != null
                  ? <span className="text-ink-faint">已被认领</span>
                  : <button disabled={busy} onClick={() => void claim(it)} className="rounded border border-pulse-cyan/40 px-2 py-0.5 text-pulse-cyan hover:bg-pulse-cyan/10">认领</button>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
