/**
 * BuyerCenter（/my）—— 买家中心（⑤功能模块·买家面，2026-10-01）。
 *
 * 三卡：我的合约（雇佣中/试用中/已到期，状态全真）· 我的词元钱包（余额+近 10 笔流水）· 邀请返佣（5% 台账）。
 * 数据：buyerCenter.overview 一拉三件（会话厂域焊死）；未登录引导登录（注册归位后门户注册即通）。
 */
import { Link } from 'react-router'
import { FileCheck2, Wallet, Gift, ArrowRight, LogIn, Star, X } from 'lucide-react'
import { loadWbSession } from '@/lib/wbSession'
import { useEffect, useRef, useState } from 'react'
import { formatToken } from '@/components/market/types'
import HudCorner from '@/components/HudCorner'

interface Overview {
  contracts: Array<{
    id: number; status: string; periodMonths: number; monthlyPrice: number
    startsAt: unknown; endsAt: unknown; createdAt: unknown
    agentName: string; agentSlug: string | null; agentAvatar: string | null
    rating: number | null; review: string | null
  }>
  wallet: {
    balance: number
    flows: Array<{ direction: string; amount: number; balanceAfter: number; bizType: string; note: string | null; createdAt: unknown }>
  }
  bonuses: { rows: Array<{ orderRef: string; orderAmount: number; bonus: number; createdAt: unknown }>; total: number }
}


/** 评价弹窗（hire.review 真链：星级+内容+雇主抬头——写入即 recomputeAgentRating 货架评分真涨） */
function ReviewDialog({
  contractId,
  agentName,
  token,
  onClose,
  onDone,
}: {
  contractId: number | null
  agentName: string
  token: string
  onClose: () => void
  onDone: () => void
}) {
  const [rating, setRating] = useState(5)
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  if (contractId == null) return null
  const canSubmit = content.trim().length >= 1 && !busy

  async function submit() {
    if (!canSubmit) return
    setBusy(true)
    setErr(null)
    try {
      const r = await fetch('/api/trpc/hire.review', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ json: { token, hireRecordId: contractId, rating, content: content.trim() } }),
      })
      const d = await r.json()
      if (d?.error) throw new Error(d.error?.json?.message ?? '提交失败')
      onDone()
    } catch (e) {
      setErr(e instanceof Error ? e.message : '提交失败，稍后再试')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl border border-line-subtle bg-[#0A0F1E] p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <p className="font-display text-lg font-bold text-ink-primary">评价「{agentName}」</p>
          <button onClick={onClose} className="text-ink-faint hover:text-ink-primary"><X className="h-5 w-5" /></button>
        </div>
        <p className="mt-1 text-xs text-ink-faint">评价真实上墙——写入即计入该员工货架评分。</p>
        <div className="mt-4 flex gap-1.5">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} type="button" onClick={() => setRating(n)} aria-label={`${n} 星`}>
              <Star className={`h-7 w-7 ${n <= rating ? 'fill-forge-amber text-forge-amber' : 'text-ink-faint'}`} />
            </button>
          ))}
        </div>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={4}
          maxLength={500}
          placeholder="这位数字员工干得怎么样？（一句真话就值钱）"
          className="mt-4 w-full rounded-[10px] border border-line-subtle bg-panel/60 px-3.5 py-2.5 text-sm text-ink-primary placeholder:text-ink-faint"
        />
        {err && <p className="mt-2 text-sm text-ember-red">{err}</p>}
        <button
          onClick={() => void submit()}
          disabled={!canSubmit}
          className="mt-4 w-full rounded-[10px] bg-amber-gradient py-2.5 text-sm font-semibold text-[#1A1206] disabled:opacity-40"
        >
          {busy ? '提交中…' : '提交评价'}
        </button>
      </div>
    </div>
  )
}

const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  trial: { label: '试用中', cls: 'text-forge-amber border-forge-amber/40 bg-forge-amber/10' },
  active: { label: '雇佣中', cls: 'text-jade-green border-jade-green/40 bg-jade-green/10' },
  expired: { label: '已到期', cls: 'text-ink-faint border-line-subtle bg-panel/60' },
  cancelled: { label: '已解约', cls: 'text-ink-faint border-line-subtle bg-panel/60' },
}

export default function BuyerCenter() {
  const [data, setData] = useState<Overview | null>(null)
  const [reviewTarget, setReviewTarget] = useState<{ id: number; name: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const session = loadWbSession()

  const loadRef = useRef<() => void>(() => {})
  useEffect(() => {
    if (!session?.token) return
    let cancelled = false
    const load = () => {
      fetch('/api/trpc/buyerCenter.overview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ json: { token: session.token } }),
      })
        .then((r) => r.json())
        .then((d) => {
          if (cancelled) return
          const j = d?.result?.data?.json
          if (j) setData(j as Overview)
          else setErr(d?.error?.json?.message ?? '读取失败')
        })
        .catch(() => { if (!cancelled) setErr('网络异常，稍后再试') })
    }
    loadRef.current = load
    load()
    return () => {
      cancelled = true
      loadRef.current = () => {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.token])

  if (!session?.token) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center px-4">
        <div className="cyber-glow-card relative w-full max-w-md rounded-2xl bg-zinc-950/85 p-8 text-center">
          <HudCorner />
          <LogIn className="mx-auto h-10 w-10 text-forge-amber" />
          <p className="mt-4 text-lg font-semibold text-ink-primary">登录后查看买家中心</p>
          <p className="mt-2 text-sm text-ink-secondary">我的合约 / 词元钱包 / 邀请返佣——都在等你</p>
          <Link
            to="/login"
            className="mt-5 inline-block rounded-[10px] bg-amber-gradient px-8 py-3 text-sm font-semibold text-[#1A1206]"
          >
            去登录 / 注册
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-site px-5 pb-[72px] pt-12 md:px-12">
      <p className="hud-label text-pulse-cyan/80">BUYER CENTER</p>
      <h1 className="mt-2 font-display text-3xl font-bold text-ink-primary">买家中心</h1>
      <p className="mt-2 text-sm text-ink-secondary">
        {session.enterpriseName ?? session.displayName ?? session.username} · 我的合约 / 钱包 / 返佣——一屏看全
      </p>

      {err && <p className="mt-6 rounded-xl border border-ember-red/30 bg-ember-red/[0.06] px-4 py-3 text-sm text-ember-red">{err}</p>}

      <div className="mt-8 grid gap-6 lg:grid-cols-3">
        {/* 我的合约 */}
        <section className="cyber-glow-card relative rounded-2xl bg-zinc-950/80 p-6 lg:col-span-2">
          <HudCorner />
          <div className="flex items-center gap-2">
            <FileCheck2 className="h-5 w-5 text-forge-amber" />
            <h2 className="font-display text-lg font-bold text-ink-primary">
              我的合约 · {data ? data.contracts.length : '—'}
            </h2>
          </div>
          <div className="mt-4 space-y-3">
            {data == null && <div className="h-24 animate-pulse rounded-xl bg-panel/60" />}
            {data?.contracts.length === 0 && (
              <div className="rounded-xl border border-dashed border-line-subtle px-4 py-8 text-center">
                <p className="text-sm text-ink-secondary">还没有合约——去匠市挑一位数字员工雇佣，TA 会出现在这里。</p>
                <Link to="/market" className="mt-3 inline-flex items-center gap-1.5 text-sm text-forge-amber hover:underline">
                  去数字匠市 <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
            )}
            {data?.contracts.map((c) => {
              const st = STATUS_LABEL[c.status] ?? STATUS_LABEL.expired
              return (
                <div key={c.id} className="flex items-center gap-4 rounded-xl border border-line-subtle bg-panel/40 px-4 py-3.5">
                  {c.agentAvatar && (
                    <img src={c.agentAvatar} alt={c.agentName} className="h-11 w-11 rounded-lg object-cover" loading="lazy" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-ink-primary">{c.agentName}</p>
                    <p className="mt-0.5 text-xs text-ink-faint">
                      {c.periodMonths} 个月 · {formatToken(c.monthlyPrice)} Token/月
                    </p>
                  </div>
                  <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] ${st.cls}`}>{st.label}</span>
                  {(c.status === 'active' || c.status === 'expired') && c.rating == null && (
                    <button
                      onClick={() => setReviewTarget({ id: c.id, name: c.agentName })}
                      className="shrink-0 rounded-full border border-forge-amber/40 bg-forge-amber/10 px-2.5 py-0.5 text-[11px] text-forge-amber transition-colors hover:bg-forge-amber/20"
                    >
                      评价
                    </button>
                  )}
                  {c.rating != null && (
                    <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-forge-amber">
                      <Star className="h-3 w-3 fill-forge-amber" /> {c.rating}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </section>

        {/* 钱包 + 返佣 */}
        <div className="space-y-6">
          <section className="cyber-glow-card relative rounded-2xl bg-zinc-950/80 p-6">
            <HudCorner />
            <div className="flex items-center gap-2">
              <Wallet className="h-5 w-5 text-jade-green" />
              <h2 className="font-display text-lg font-bold text-ink-primary">词元钱包</h2>
            </div>
            <p className="mt-3 font-grotesk text-3xl font-bold text-ink-primary">
              {data ? formatToken(data.wallet.balance) : '—'}
              <span className="ml-1 text-xs font-normal text-ink-faint">Token</span>
            </p>
            <div className="mt-4 space-y-2 border-t border-line-subtle pt-3">
              {data?.wallet.flows.length === 0 && <p className="text-xs text-ink-faint">暂无流水</p>}
              {data?.wallet.flows.map((f, i) => (
                <p key={i} className="flex items-center justify-between font-mono text-[11px] text-ink-secondary">
                  <span className="truncate">{f.note ?? f.bizType}</span>
                  <span className={f.direction === 'in' ? 'text-jade-green' : 'text-ember-red'}>
                    {f.direction === 'in' ? '+' : '-'}{formatToken(Math.abs(Number(f.amount)))}
                  </span>
                </p>
              ))}
            </div>
            <p className="mt-3 text-[11px] text-ink-faint">企业域钱包面在途——挂账 P-ENT-WALLET</p>
          </section>

          <section className="cyber-glow-card relative rounded-2xl bg-zinc-950/80 p-6">
            <HudCorner />
            <div className="flex items-center gap-2">
              <Gift className="h-5 w-5 text-pulse-cyan" />
              <h2 className="font-display text-lg font-bold text-ink-primary">邀请返佣</h2>
            </div>
            <p className="mt-3 font-grotesk text-2xl font-bold text-ink-primary">
              {data ? formatToken(data.bonuses.total) : '—'}
              <span className="ml-1 text-xs font-normal text-ink-faint">Token 累计</span>
            </p>
            <div className="mt-3 rounded-[10px] border border-pulse-cyan/25 bg-pulse-cyan/[0.05] px-3.5 py-2.5">
              <p className="text-[11px] text-ink-faint">我的推荐码（好友注册时填）</p>
              <p className="mt-0.5 font-mono text-sm font-semibold text-pulse-cyan">{session.username ?? session.displayName ?? '—'}</p>
            </div>
            <div className="mt-3 space-y-2">
              {data?.bonuses.rows.length === 0 && (
                <p className="text-xs leading-relaxed text-ink-faint">
                  邀请好友注册，好友首笔雇佣订单你拿 5% 返佣（平台抽成里出，不动供给侧）。
                </p>
              )}
              {data?.bonuses.rows.map((b, i) => (
                <p key={i} className="flex items-center justify-between font-mono text-[11px] text-ink-secondary">
                  <span className="truncate">{b.orderRef}</span>
                  <span className="text-jade-green">+{formatToken(Number(b.bonus))}</span>
                </p>
              ))}
            </div>
          </section>
        </div>
      </div>

      {reviewTarget && session?.token && (
        <ReviewDialog
          contractId={reviewTarget.id}
          agentName={reviewTarget.name}
          token={session.token}
          onClose={() => setReviewTarget(null)}
          onDone={() => {
            setReviewTarget(null)
            // 评完重拉（评分星态即时翻——同一 load 单点不 reload）
            loadRef.current()
          }}
        />
      )}
    </div>
  )
}
