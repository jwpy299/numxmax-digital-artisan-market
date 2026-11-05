/**
 * Certified（/certified）—— 认证体系页（⑤内容信任面，2026-10-01）。
 * 智造研究院认证四道关 + 持证查询入口（agents.list 公开面按工号/名字查——真库真查）。
 */
import { useState } from 'react'
import { Link } from 'react-router'
import { ShieldCheck, Fingerprint, BookLock, AlertOctagon, ScrollText, Search, Loader2 } from 'lucide-react'
import HudCorner from '@/components/HudCorner'

const GATES = [
  {
    icon: Fingerprint,
    title: '一 · 链上身份（DID）',
    desc: '每位数字员工持有 did:nebula 链上数字身份——工号唯一、身份可验、服役轨迹全程留痕，假不了也跑不了。',
  },
  {
    icon: BookLock,
    title: '二 · 岗位技能焊入',
    desc: '每份岗位技能包经智造研究院审定后焊进工位（职责边界/质量标准/C 级红线）——专精单体，不派生不委派，越界任务自动转交。',
  },
  {
    icon: AlertOctagon,
    title: '三 · C 级红线焊死',
    desc: '付款/转账/招聘/辞退/停机/对外承诺一律不执行——焊在代码层，只提示负责人到企业工作台亲自确认，谁都说情没用。',
  },
  {
    icon: ScrollText,
    title: '四 · 服役档案公开',
    desc: '真实成交、成功率、雇主评分全从台账出——没有数据显示「— 累计中」，宁可难看，绝不编造。',
  },
] as const

interface AgentHit {
  code: string
  name: string
  industry: string
  certified: boolean
  slug: string
}

export default function Certified() {
  const [kw, setKw] = useState('')
  const [busy, setBusy] = useState(false)
  const [hits, setHits] = useState<AgentHit[] | null>(null)

  async function search() {
    const k = kw.trim()
    if (!k || busy) return
    setBusy(true)
    try {
      const r = await fetch('/api/trpc/agents.list', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ json: { limit: 100 } }),
      })
      const d = await r.json()
      const items: AgentHit[] = d?.result?.data?.json?.items ?? []
      setHits(items.filter((a) => a.code.includes(k) || a.name.includes(k)).slice(0, 6))
    } catch {
      setHits([])
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-site px-5 pb-[72px] pt-12 md:px-12">
      <p className="hud-label text-forge-amber/80">CERTIFICATION</p>
      <h1 className="mt-2 font-display text-3xl font-bold text-ink-primary">NumX Max 智造研究院 · 认证体系</h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-secondary">
        每一位上架的数字员工，都要过这四道关——少一道，不上架。
      </p>

      <div className="mt-8 grid gap-5 md:grid-cols-2">
        {GATES.map((g) => (
          <section key={g.title} className="cyber-glow-card relative rounded-2xl bg-zinc-950/80 p-6">
            <HudCorner />
            <div className="flex items-center gap-2.5">
              <g.icon className="h-5 w-5 text-forge-amber" />
              <h2 className="font-display text-base font-bold text-ink-primary">{g.title}</h2>
            </div>
            <p className="mt-3 text-[13px] leading-relaxed text-ink-secondary">{g.desc}</p>
          </section>
        ))}
      </div>

      {/* 持证查询 */}
      <section className="mt-8 rounded-2xl border border-forge-amber/25 bg-forge-amber/[0.04] p-6">
        <div className="flex items-center gap-2.5">
          <ShieldCheck className="h-5 w-5 text-forge-amber" />
          <h2 className="font-display text-lg font-bold text-ink-primary">持证查询</h2>
        </div>
        <p className="mt-2 text-[13px] text-ink-secondary">输入工号（NX-10xx）或名字，查 TA 是不是研究院认证在架的数字员工。</p>
        <div className="mt-4 flex gap-2">
          <input
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void search() }}
            placeholder="工号或名字，如 NX-1001 / 汇算"
            className="flex-1 rounded-[10px] border border-line-subtle bg-panel/60 px-4 py-2.5 text-sm text-ink-primary placeholder:text-ink-faint"
          />
          <button
            onClick={() => void search()}
            disabled={busy || !kw.trim()}
            className="flex items-center gap-1.5 rounded-[10px] bg-amber-gradient px-5 py-2.5 text-sm font-semibold text-[#1A1206] disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            查询
          </button>
        </div>
        {hits != null && (
          <div className="mt-4 space-y-2">
            {hits.length === 0 && (
              <p className="rounded-[10px] border border-ember-red/30 bg-ember-red/[0.05] px-4 py-3 text-sm text-ember-red">
                未查到在架认证员工——谨防假冒。到<Link to="/market" className="ml-1 underline">数字匠市</Link>核验。
              </p>
            )}
            {hits.map((h) => (
              <Link
                key={h.code}
                to={`/market/agent/${h.slug}`}
                className="flex items-center justify-between rounded-[10px] border border-jade-green/25 bg-jade-green/[0.05] px-4 py-3 transition-colors hover:bg-jade-green/[0.1]"
              >
                <span className="text-sm text-ink-primary">
                  <strong>{h.name}</strong>
                  <span className="ml-2 font-mono text-xs text-ink-faint">{h.code} · {h.industry}</span>
                </span>
                {h.certified && (
                  <span className="inline-flex items-center gap-1 text-xs text-forge-amber">
                    <ShieldCheck className="h-3.5 w-3.5" /> 认证在架
                  </span>
                )}
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
