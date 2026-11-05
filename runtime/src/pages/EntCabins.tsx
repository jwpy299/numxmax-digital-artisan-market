/**
 * 企业舱位图（企业智能工作台首屏芯，彭总定稿 2026-08-31）：
 * 舱位网格（每舱：舱主/数字员工数/开任务数）→ 点舱进舱内（任务双轨派单/完成）。
 * 行业预置一键落座 + x_ 自建舱。
 */
import { useCallback, useEffect, useState } from 'react'
import { useWbSession, wbQuery, wbMutation } from '@/lib/wbSession'

interface Cabin { id: number; code: string; name: string; headName: string | null; openTasks: number; agents: number }
interface Task { id: number; title: string; status: string; aUser: number | null; aAgent: number | null; userName: string | null; agentName: string | null; at: string }

export default function EntCabins() {
  const { session } = useWbSession()
  const token = session?.token ?? ''
  const [cabins, setCabins] = useState<Cabin[]>([])
  const [active, setActive] = useState<Cabin | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!token) return
    try {
      const r = await wbQuery<any>('entCabin.map', { token })
      setCabins(r.cabins as Cabin[])
      setErr(null)
    } catch (e) { setErr(e instanceof Error ? e.message : '加载失败') }
  }, [token])
  useEffect(() => { void load() }, [load])

  const openCabin = async (c: Cabin) => {
    setActive(c)
    try {
      const r = await wbQuery<any>('entCabin.tasks', { token, cabinId: c.id })
      setTasks(r.tasks as Task[])
    } catch { setTasks([]) }
  }

  const seatPreset = async () => {
    setBusy(true)
    try {
      const r = await wbMutation<any>('entCabin.seatPreset', { token, industry: 'manufacturing' })
      setMsg(`已落座 ${r.seated}/${r.total} 舱`)
      await load()
    } catch (e) { setMsg(e instanceof Error ? e.message : '落座失败') } finally { setBusy(false) }
  }

  const dispatch = async () => {
    if (!active || !title.trim() || busy) return
    setBusy(true); setMsg(null)
    try {
      await wbMutation<any>('entCabin.dispatchTask', { token, cabinId: active.id, title: title.trim() })
      setTitle(''); setMsg('已派单')
      await openCabin(active)
    } catch (e) { setMsg(e instanceof Error ? e.message : '派单失败') } finally { setBusy(false) }
  }

  const done = async (t: Task) => {
    try {
      await wbMutation<any>('entCabin.doneTask', { token, taskId: t.id })
      if (active) await openCabin(active)
    } catch (e) { setMsg(e instanceof Error ? e.message : '操作失败') }
  }

  return (
    <div className="mx-auto max-w-6xl px-5 py-8">
      <h1 className="font-display text-xl font-bold text-ink-primary">企业舱位图</h1>
      <p className="mt-1 text-xs text-ink-faint">一舱一作战单元：舱主（真人）+ 数字员工（责任人制）+ 本舱任务（人机双轨）</p>
      {err && <p className="mt-3 rounded-lg border border-ember-red/40 bg-ember-red/10 px-3 py-2 text-xs text-ember-red">{err}</p>}
      {msg && <p className="mt-3 rounded-lg border border-forge-amber/40 bg-forge-amber/10 px-3 py-2 text-xs text-forge-amber">{msg}</p>}

      {cabins.length === 0 && !err && (
        <button onClick={() => void seatPreset()} disabled={busy} className="mt-4 rounded-lg bg-forge-amber/20 px-4 py-2 text-sm font-bold text-forge-amber hover:bg-forge-amber/30">
          制造业预置舱一键落座（生产/质量/采购/销售/财务/行政）
        </button>
      )}

      <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cabins.map((c) => (
          <button key={c.id} onClick={() => void openCabin(c)}
            className={`rounded-2xl border p-4 text-left transition-colors ${active?.id === c.id ? 'border-forge-amber/60 bg-forge-amber/[0.08]' : 'border-line-subtle hover:border-pulse-cyan/40'}`}>
            <p className="text-sm font-bold text-ink-primary">{c.name}</p>
            <p className="mt-1 text-[11px] text-ink-faint">{c.code}</p>
            <p className="mt-2 text-xs text-ink-secondary">舱主 {c.headName ?? '待任命'} · 数字员工 {c.agents} · 开任务 {c.openTasks}</p>
          </button>
        ))}
      </div>

      {active && (
        <section className="glass-panel mt-6 rounded-2xl p-4">
          <h2 className="text-sm font-bold text-pulse-cyan">{active.name} · 舱内任务</h2>
          <div className="mt-3 flex gap-2">
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="新任务标题（派给舱内成员）"
              className="flex-1 rounded-lg border border-line-subtle bg-void px-3 py-2 text-xs text-ink-primary outline-none focus:border-pulse-cyan" />
            <button onClick={() => void dispatch()} disabled={busy} className="rounded-lg bg-pulse-cyan/20 px-3 py-2 text-xs font-bold text-pulse-cyan hover:bg-pulse-cyan/30">派单</button>
          </div>
          <div className="mt-3 space-y-2">
            {tasks.length === 0 && <p className="text-xs text-ink-faint">本舱暂无任务</p>}
            {tasks.map((t) => (
              <div key={t.id} className="flex items-center justify-between rounded-lg border border-line-subtle px-3 py-2 text-xs">
                <span className="text-ink-primary">{t.title} <span className="text-ink-faint">· {t.userName ?? t.agentName ?? '未指派'} · {t.at}</span></span>
                {t.status === 'open'
                  ? <button onClick={() => void done(t)} className="rounded border border-forge-amber/40 px-2 py-0.5 text-forge-amber hover:bg-forge-amber/10">完成</button>
                  : <span className="text-emerald-300">已完成</span>}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
