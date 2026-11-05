/**
 * 灵智枢内部版工作台（三区芯，彭总定稿 2026-08-31）：
 * ① 我的任务位（四舱队列：认领/处理）② 我的舱（HQ 舱位实况）③ DSH 对话位（Harness 驱动）。
 * 入口：?internal=lingshu 或 /internal（HQ 成员限定，服务端 hqOnly 闸）。
 */
import { useCallback, useEffect, useState } from 'react'
import { useWbSession, wbQuery, wbMutation } from '@/lib/wbSession'

interface StationItem { kind: string; station: string; id: number; title: string; claimedBy: number | null; mine: boolean; at: string }
interface Cabin { id: number; code: string; name: string; headName: string | null; openTasks: number; agents: number }
const STATION_CN: Record<string, string> = { x_ops: '运行舱', x_rel: '更新舱', x_mkt: '市场舱', x_ch: '渠道舱' }

export default function InternalHome() {
  const { session } = useWbSession()
  const token = session?.token ?? ''
  const [items, setItems] = useState<StationItem[]>([])
  const [cabins, setCabins] = useState<Cabin[]>([])
  const [msgs, setMsgs] = useState<{ role: 'me' | 'ai'; text: string }[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!token) return
    try {
      const [s, c] = await Promise.all([
        wbQuery<any>('internalOps.myStation', { token }),
        wbQuery<any>('entCabin.map', { token }),
      ])
      setItems(s.items as StationItem[])
      setCabins(c.cabins as Cabin[])
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : '加载失败（需灵智枢内部成员）')
    }
  }, [token])
  useEffect(() => { void load() }, [load])

  const claim = async (it: StationItem) => {
    if (it.claimedBy != null) return
    try {
      await wbMutation<any>('internalOps.claim', { token, kind: it.kind as 'proposal' | 'partner', id: it.id })
      await load()
    } catch (e) { setErr(e instanceof Error ? e.message : '认领失败') }
  }

  const send = async () => {
    const text = input.trim()
    if (!text || busy) return
    setInput(''); setBusy(true)
    setMsgs((p) => [...p, { role: 'me', text }])
    try {
      const r = await wbMutation<any>('dshBridge.chat', { token, persona: 'lingshu', message: text })
      setMsgs((p) => [...p, { role: 'ai', text: r.reply }])
    } catch { setMsgs((p) => [...p, { role: 'ai', text: '（线路忙，稍后再喊我）' }]) } finally { setBusy(false) }
  }

  return (
    <div className="mx-auto max-w-6xl px-5 py-8">
      <h1 className="font-display text-xl font-bold text-ink-primary">灵智枢内部工作台 <span className="text-xs text-forge-amber">内部版 · 001 号客户狗粮位</span></h1>
      {err && <p className="mt-3 rounded-lg border border-ember-red/40 bg-ember-red/10 px-3 py-2 text-xs text-ember-red">{err}</p>}
      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        {/* ① 我的任务位 */}
        <section className="glass-panel rounded-2xl p-4">
          <h2 className="text-sm font-bold text-pulse-cyan">① 我的任务位（四舱队列）</h2>
          <div className="mt-3 space-y-2">
            {items.length === 0 && <p className="text-xs text-ink-faint">队列清爽</p>}
            {items.map((it) => (
              <div key={`${it.kind}-${it.id}`} className="rounded-lg border border-line-subtle px-3 py-2 text-xs">
                <p className="text-ink-primary">{it.title}</p>
                <p className="mt-1 flex items-center justify-between text-ink-faint">
                  <span>{STATION_CN[it.station] ?? it.station} · {it.at}</span>
                  {it.mine
                    ? <span className="text-forge-amber">我认领的</span>
                    : it.claimedBy != null
                      ? <span>已被认领</span>
                      : <button onClick={() => void claim(it)} className="rounded border border-pulse-cyan/40 px-2 py-0.5 text-pulse-cyan hover:bg-pulse-cyan/10">认领</button>}
                </p>
              </div>
            ))}
          </div>
        </section>
        {/* ② 我的舱 */}
        <section className="glass-panel rounded-2xl p-4">
          <h2 className="text-sm font-bold text-pulse-cyan">② 我的舱（灵智枢舱位实况）</h2>
          <div className="mt-3 space-y-2">
            {cabins.length === 0 && <p className="text-xs text-ink-faint">舱位未落座</p>}
            {cabins.map((c) => (
              <div key={c.id} className="rounded-lg border border-line-subtle px-3 py-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-ink-primary">{c.name} <span className="text-ink-faint">（{c.code}）</span></span>
                  <span className="text-ink-faint">舱主 {c.headName ?? '—'} · 数字员工 {c.agents} · 开任务 {c.openTasks}</span>
                </div>
                <a
                  href={`https://admin.example.invalid:3200/stations?tab=${encodeURIComponent(c.code)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1.5 inline-block rounded border border-pulse-cyan/40 px-2 py-0.5 text-pulse-cyan hover:bg-pulse-cyan/10"
                >去超终办舱 ›</a>
              </div>
            ))}
          </div>
        </section>
        {/* ③ DSH 对话位 */}
        <section className="glass-panel flex flex-col rounded-2xl p-4">
          <h2 className="text-sm font-bold text-pulse-cyan">③ DSH 对话位（Harness 驱动）</h2>
          <div className="mt-3 flex-1 space-y-2 overflow-y-auto text-xs" style={{ maxHeight: 280 }}>
            {msgs.length === 0 && <p className="text-ink-faint">一个输入框，剩下的交给灵枢。</p>}
            {msgs.map((m, i) => (
              <p key={i} className={m.role === 'me' ? 'text-right text-ink-secondary' : 'text-ink-primary'}>{m.text}</p>
            ))}
            {busy && <p className="text-ink-faint">灵枢思考中…</p>}
          </div>
          <div className="mt-3 flex gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void send() }}
              placeholder="说事儿…"
              className="flex-1 rounded-lg border border-line-subtle bg-void px-3 py-2 text-xs text-ink-primary outline-none focus:border-pulse-cyan"
            />
            <button onClick={() => void send()} disabled={busy} className="rounded-lg bg-pulse-cyan/20 px-3 py-2 text-xs font-bold text-pulse-cyan hover:bg-pulse-cyan/30">发</button>
          </div>
        </section>
      </div>
    </div>
  )
}
