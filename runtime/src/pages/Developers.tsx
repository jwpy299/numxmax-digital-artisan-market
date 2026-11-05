import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Link } from 'react-router'
import type { FormEvent, ReactNode } from 'react'
import {
  ArrowRight,
  BadgeCheck,
  CircleDollarSign,
  Clock3,
  Coins,
  Factory,
  Landmark,
  Loader2,
  LogOut,
  PackageOpen,
  UploadCloud,
  UserRound,
  XCircle,
} from 'lucide-react'
import HudCorner from '@/components/HudCorner'
import GlowButton from '@/components/GlowButton'
import { cn } from '@/lib/utils'
import { formatToken } from '@/components/market/types'
import {
  clearDevSession,
  loadDevSession,
  saveDevSession,
  trpcDev,
  type DevSession,
} from '@/lib/trpcDev'

const easeOut = [0.16, 1, 0.3, 1] as [number, number, number, number]

/* ───────────────────────── 通用小部件 ───────────────────────── */

function Field({
  label,
  children,
  hint,
}: {
  label: string
  children: ReactNode
  hint?: string
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-ink-secondary">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-ink-faint">{hint}</span>}
    </label>
  )
}

const inputCls =
  'w-full rounded-lg border border-line-subtle bg-zinc-950/70 px-3.5 py-2.5 text-sm text-ink-primary outline-none transition-colors placeholder:text-ink-faint focus:border-amber-500/50 focus:ring-1 focus:ring-amber-500/30'

const LISTING_STATUS_META: Record<string, { label: string; cls: string; icon: typeof Clock3 }> = {
  pending_review: { label: '审核中', cls: 'border-amber-500/40 bg-amber-500/10 text-amber-400', icon: Clock3 },
  listed: { label: '已上架', cls: 'border-emerald-400/40 bg-emerald-400/10 text-emerald-400', icon: BadgeCheck },
  rejected: { label: '已驳回', cls: 'border-ember-red/40 bg-ember-red/10 text-ember-red', icon: XCircle },
  delisted: { label: '已下架', cls: 'border-zinc-500/40 bg-zinc-500/10 text-zinc-400', icon: PackageOpen },
}

/* ───────────────────────── 注册 / 登录表单 ───────────────────────── */

function AuthPanel({ onAuthed }: { onAuthed: (s: DevSession) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('register')
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [contact, setContact] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const loginMut = trpcDev.developer.login.useMutation({
    onError: (err: { message?: string }) => setError(err?.message ?? '登录失败，请稍后重试'),
    onSuccess: (data: { token?: string; account?: DevSession['account'] }) => {
      if (data?.token) {
        const session = { ...data, token: data.token }
        saveDevSession(session)
        onAuthed(session)
      } else {
        setError('登录返回缺少会话令牌，请稍后重试')
      }
    },
  })
  const registerMut = trpcDev.developer.register.useMutation({
    onError: (err: { message?: string }) => setError(err?.message ?? '注册失败，请稍后重试'),
    onSuccess: (data: { token?: string; account?: DevSession['account'] }) => {
      // 注册即登录（若后端直接下发 token），否则引导切换到登录
      if (data?.token) {
        const session = { ...data, token: data.token }
        saveDevSession(session)
        onAuthed(session)
      } else {
        setNotice('注册成功，请使用账号密码登录')
        setMode('login')
      }
    },
  })

  const pending = loginMut.isPending || registerMut.isPending

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setNotice(null)
    if (mode === 'login') {
      loginMut.mutate({ username: username.trim(), password })
    } else {
      registerMut.mutate({
        username: username.trim(),
        displayName: displayName.trim() || username.trim(),
        password,
        contact: contact.trim(),
      })
    }
  }

  return (
    <div className="cyber-glow-card cyber-scanline relative rounded-2xl bg-zinc-950/80 p-7 md:p-9">
      <HudCorner />
      <div className="mb-6 flex rounded-lg border border-line-subtle bg-zinc-950/60 p-1">
        {(['register', 'login'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => {
              setMode(m)
              setError(null)
              setNotice(null)
            }}
            className={cn(
              'flex-1 rounded-md py-2 text-sm font-medium transition-colors',
              mode === m ? 'bg-amber-gradient text-[#1A1206]' : 'text-ink-secondary hover:text-ink-primary',
            )}
          >
            {m === 'register' ? '注册开发者' : '登录'}
          </button>
        ))}
      </div>

      <form onSubmit={submit} className="space-y-4">
        <Field label="用户名">
          <input
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="用于登录的英文/数字用户名"
            className={inputCls}
            autoComplete="username"
          />
        </Field>
        {mode === 'register' && (
          <>
            <Field label="匠人名号（展示名）">
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="将展示在上架作品与排行榜上"
                className={inputCls}
              />
            </Field>
            <Field label="联系方式" hint="用于审核沟通与结算确认，不会公开展示">
              <input
                required
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                placeholder="手机号或邮箱"
                className={inputCls}
              />
            </Field>
          </>
        )}
        <Field label="密码">
          <input
            required
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === 'register' ? '至少 8 位' : '登录密码'}
            className={inputCls}
            autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
          />
        </Field>

        {error && (
          <p className="rounded-lg border border-ember-red/40 bg-ember-red/10 px-3.5 py-2.5 text-xs text-ember-red">
            {error}
          </p>
        )}
        {notice && (
          <p className="rounded-lg border border-emerald-400/40 bg-emerald-400/10 px-3.5 py-2.5 text-xs text-emerald-400">
            {notice}
          </p>
        )}

        <button
          type="submit"
          disabled={pending}
          className="flex w-full items-center justify-center gap-2 rounded-[10px] bg-amber-gradient py-3 text-sm font-medium text-[#1A1206] transition-shadow hover:shadow-[0_0_28px_rgba(245,165,36,0.45)] disabled:opacity-60"
        >
          {pending && <Loader2 className="h-4 w-4 animate-spin" />}
          {mode === 'register' ? '注册并进入开发者中心' : '登录开发者中心'}
        </button>
      </form>
    </div>
  )
}

/* ───────────────────────── 上架表单 ───────────────────────── */

function UploadForm({ token, onUploaded }: { token: string; onUploaded: () => void }) {
  const [kind, setKind] = useState<'agent' | 'skill'>('agent')
  const [name, setName] = useState('')
  const [summary, setSummary] = useState('')
  const [category, setCategory] = useState('')
  const [priceToken, setPriceToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)

  const uploadMut = trpcDev.developer.uploadListing.useMutation({
    onError: (err: { message?: string }) => {
      setSubmitted(false)
      setError(err?.message ?? '提交失败，请稍后重试')
    },
    onSuccess: () => {
      setSubmitted(true)
      setError(null)
      setName('')
      setSummary('')
      setCategory('')
      setPriceToken('')
      onUploaded()
    },
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setSubmitted(false)
    const price = Number(priceToken)
    if (!Number.isFinite(price) || price <= 0) {
      setError('请填写有效的 Token 定价（正整数）')
      return
    }
    uploadMut.mutate({
      token,
      kind,
      name: name.trim(),
      summary: summary.trim(),
      category: category.trim(),
      priceToken: Math.round(price),
    })
  }

  return (
    <form onSubmit={submit} className="cyber-glow-card cyber-scanline relative rounded-2xl bg-zinc-950/80 p-7 md:p-8">
      <HudCorner />
      <p className="hud-label text-amber-400/80">UPLOAD LISTING</p>
      <h3 className="mt-2 font-display text-xl font-bold text-ink-primary">上架新作品</h3>

      <div className="mt-5 space-y-4">
        <div>
          <span className="mb-1.5 block text-xs font-medium text-ink-secondary">作品类型</span>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                { v: 'agent', label: 'Agent 应用', desc: '完整数字员工' },
                { v: 'skill', label: 'Skill 技能', desc: '可挂载的单项技能' },
              ] as const
            ).map((opt) => (
              <button
                key={opt.v}
                type="button"
                onClick={() => setKind(opt.v)}
                className={cn(
                  'rounded-lg border px-3.5 py-3 text-left transition-colors',
                  kind === opt.v
                    ? 'border-amber-500/50 bg-amber-500/10'
                    : 'border-line-subtle bg-zinc-950/60 hover:border-zinc-500/50',
                )}
              >
                <span className={cn('block text-sm font-medium', kind === opt.v ? 'text-amber-400' : 'text-ink-primary')}>
                  {opt.label}
                </span>
                <span className="mt-0.5 block text-[11px] text-ink-faint">{opt.desc}</span>
              </button>
            ))}
          </div>
        </div>

        <Field label="名称">
          <input required maxLength={64} value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder={kind === 'agent' ? '如：产线巡检助手' : '如：振动频谱分析'} />
        </Field>
        <Field label="一句话简介">
          <textarea
            required
            maxLength={255}
            rows={3}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            className={cn(inputCls, 'resize-none')}
            placeholder="它能帮工厂解决什么问题？"
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="分类">
            <input required maxLength={64} value={category} onChange={(e) => setCategory(e.target.value)} className={inputCls} placeholder="如：设备运维 / 视觉质检" />
          </Field>
          <Field label="定价（Token）" hint={kind === 'agent' ? '按月雇佣价' : '按次调用价'}>
            <input
              required
              type="number"
              min={1}
              step={1}
              value={priceToken}
              onChange={(e) => setPriceToken(e.target.value)}
              className={inputCls}
              placeholder="如：2000"
            />
          </Field>
        </div>

        {error && (
          <p className="rounded-lg border border-ember-red/40 bg-ember-red/10 px-3.5 py-2.5 text-xs text-ember-red">{error}</p>
        )}
        {submitted && (
          <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3.5 py-2.5 text-xs leading-relaxed text-amber-400">
            已提交，等待 NumX Max 智造研究院审核。所有上架申请均需人工确认，审核结果将同步到「我的上架」列表，请耐心等待，勿重复提交。
          </p>
        )}

        <button
          type="submit"
          disabled={uploadMut.isPending}
          className="flex w-full items-center justify-center gap-2 rounded-[10px] bg-amber-gradient py-3 text-sm font-medium text-[#1A1206] transition-shadow hover:shadow-[0_0_28px_rgba(245,165,36,0.45)] disabled:opacity-60"
        >
          {uploadMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
          提交审核
        </button>
        <p className="text-center text-[11px] leading-relaxed text-ink-faint">
          提交后进入人工审核流程，由 NumX Max 智造研究院逐项确认，不会即时生效。
        </p>
      </div>
    </form>
  )
}

/* ───────────────────────── 已登录面板 ───────────────────────── */

function Dashboard({ session, onLogout }: { session: DevSession; onLogout: () => void }) {
  const token = session.token

  const meQuery = trpcDev.developer.me.useQuery({ token }, { retry: 1, staleTime: 30_000 })
  const listingsQuery = trpcDev.developer.myListings.useQuery({ token }, { retry: 1 })
  const earningsQuery = trpcDev.developer.myEarnings.useQuery({ token }, { retry: 1 })

  const me = meQuery.data as
    | {
        account?: { username?: string; displayName?: string; contact?: string; role?: string; createdAt?: string | Date }
        totalEarningsToken?: number
        pendingEarningsToken?: number
        listingCount?: number
        [key: string]: unknown
      }
    | undefined
  const account = me?.account ?? session.account ?? {}
  const listings = useMemo(() => {
    const raw = listingsQuery.data as { items?: unknown[] } | unknown[] | undefined
    return (Array.isArray(raw) ? raw : raw?.items ?? []) as {
      id?: number | string
      listingId?: number | string
      name?: string
      kind?: string
      summary?: string
      category?: string
      priceToken?: number
      status?: string
      createdAt?: string | Date
    }[]
  }, [listingsQuery.data])
  const earnings = useMemo(() => {
    const raw = earningsQuery.data as { items?: unknown[]; totalToken?: number } | unknown[] | undefined
    const items = (Array.isArray(raw) ? raw : raw?.items ?? []) as {
      id?: number | string
      listingName?: string
      name?: string
      amountToken?: number
      token?: number
      source?: string
      createdAt?: string | Date
    }[]
    const total = !Array.isArray(raw) && typeof raw?.totalToken === 'number' ? raw.totalToken : null
    return { items, total }
  }, [earningsQuery.data])

  const displayName = account.displayName || account.username || '开发者'

  return (
    <div className="space-y-10">
      {/* 账户信息 + 收益总览 */}
      <motion.section
        initial={{ opacity: 0, y: 28 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, ease: easeOut }}
        className="grid gap-6 lg:grid-cols-[1fr_1.2fr]"
      >
        <div className="cyber-glow-card cyber-scanline relative rounded-2xl bg-zinc-950/80 p-7">
          <HudCorner />
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3.5">
              <span className="flex h-12 w-12 items-center justify-center rounded-xl border border-amber-500/30 bg-amber-500/10">
                <UserRound className="h-6 w-6 text-amber-400" />
              </span>
              <div>
                <p className="font-display text-xl font-bold text-ink-primary">{displayName}</p>
                <p className="mt-0.5 font-mono text-xs text-ink-faint">@{account.username ?? '—'}</p>
              </div>
            </div>
            <button
              onClick={onLogout}
              className="flex items-center gap-1.5 rounded-lg border border-line-subtle px-3 py-1.5 text-xs text-ink-faint transition-colors hover:border-ember-red/40 hover:text-ember-red"
            >
              <LogOut className="h-3.5 w-3.5" /> 退出
            </button>
          </div>
          <dl className="mt-6 space-y-3 border-t border-amber-500/10 pt-5 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-ink-faint">联系方式</dt>
              <dd className="text-ink-primary">{account.contact ?? '—'}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-ink-faint">上架作品</dt>
              <dd className="font-mono text-ink-primary">
                {typeof me?.listingCount === 'number' ? me.listingCount : listings.length} 件
              </dd>
            </div>
          </dl>
          {meQuery.isLoading && (
            <p className="mt-4 flex items-center gap-2 text-xs text-ink-faint">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在同步账户数据…
            </p>
          )}
        </div>

        <div className="cyber-glow-card cyber-scanline relative rounded-2xl bg-zinc-950/80 p-7">
          <HudCorner />
          <p className="hud-label text-emerald-400/80">EARNINGS OVERVIEW</p>
          <h3 className="mt-2 font-display text-xl font-bold text-ink-primary">收益总览</h3>
          <div className="mt-5 grid grid-cols-2 gap-4">
            <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.05] p-4">
              <p className="flex items-center gap-1.5 text-[11px] text-ink-faint">
                <Coins className="h-3.5 w-3.5 text-amber-400" /> 累计 Token 收益
              </p>
              <p className="mt-2 font-grotesk text-2xl font-bold text-amber-400 md:text-3xl">
                {formatToken(
                  typeof me?.totalEarningsToken === 'number'
                    ? me.totalEarningsToken
                    : (earnings.total ?? earnings.items.reduce((a, e) => a + (e.amountToken ?? e.token ?? 0), 0)),
                )}
              </p>
            </div>
            <div className="rounded-xl border border-emerald-400/20 bg-emerald-400/[0.05] p-4">
              <p className="flex items-center gap-1.5 text-[11px] text-ink-faint">
                <CircleDollarSign className="h-3.5 w-3.5 text-emerald-400" /> 待结算 Token
              </p>
              <p className="mt-2 font-grotesk text-2xl font-bold text-emerald-400 md:text-3xl">
                {formatToken(typeof me?.pendingEarningsToken === 'number' ? me.pendingEarningsToken : 0)}
              </p>
            </div>
          </div>
          <p className="mt-4 rounded-lg border border-line-subtle bg-zinc-950/60 px-3.5 py-2.5 text-[11px] leading-relaxed text-ink-faint">
            Token 可兑换数字人民币（结算通道未来开放）。结算将经由合规通道进行人工确认，平台不承诺任何固定收益。
          </p>
        </div>
      </motion.section>

      {/* 上架表单 + 我的上架 */}
      <motion.section
        initial={{ opacity: 0, y: 28 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-60px' }}
        transition={{ duration: 0.7, ease: easeOut }}
        className="grid gap-6 lg:grid-cols-2"
      >
        <UploadForm token={token} onUploaded={() => listingsQuery.refetch()} />

        <div className="cyber-glow-card cyber-scanline relative rounded-2xl bg-zinc-950/80 p-7 md:p-8">
          <HudCorner />
          <div className="flex items-center justify-between">
            <div>
              <p className="hud-label text-amber-400/80">MY LISTINGS</p>
              <h3 className="mt-2 font-display text-xl font-bold text-ink-primary">我的上架</h3>
            </div>
            <span className="rounded-full border border-line-subtle px-3 py-1 font-mono text-xs text-ink-faint">
              {listings.length} 件
            </span>
          </div>

          <div className="mt-5 space-y-3">
            {listingsQuery.isLoading ? (
              <p className="flex items-center gap-2 py-8 text-sm text-ink-faint">
                <Loader2 className="h-4 w-4 animate-spin" /> 正在载入上架列表…
              </p>
            ) : listings.length === 0 ? (
              <div className="rounded-xl border border-dashed border-zinc-600/60 px-6 py-10 text-center">
                <PackageOpen className="mx-auto h-8 w-8 text-zinc-600" />
                <p className="mt-3 text-sm text-ink-faint">还没有上架作品，从左侧表单提交第一件吧</p>
              </div>
            ) : (
              listings.map((l, i) => {
                const meta = LISTING_STATUS_META[l.status ?? ''] ?? LISTING_STATUS_META.pending_review!
                const StatusIcon = meta.icon
                return (
                  <div
                    key={l.id ?? l.listingId ?? i}
                    className="rounded-xl border border-line-subtle bg-zinc-950/60 p-4 transition-colors hover:border-amber-500/25"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink-primary">
                          {l.name ?? '未命名作品'}
                          <span className="rounded-sm border border-line-subtle px-1.5 py-0.5 font-mono text-[10px] uppercase text-ink-faint">
                            {l.kind === 'skill' ? 'Skill' : 'Agent'}
                          </span>
                        </p>
                        {l.summary && <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-ink-faint">{l.summary}</p>}
                        <p className="mt-2 font-mono text-[11px] text-amber-400/80">
                          {typeof l.priceToken === 'number' ? `${formatToken(l.priceToken)} Token` : '定价待确认'}
                          {l.category ? ` · ${l.category}` : ''}
                        </p>
                      </div>
                      <span className={cn('flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-[11px]', meta.cls)}>
                        <StatusIcon className="h-3 w-3" />
                        {meta.label}
                      </span>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>
      </motion.section>

      {/* 收益明细 */}
      <motion.section
        initial={{ opacity: 0, y: 28 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-60px' }}
        transition={{ duration: 0.7, ease: easeOut }}
        className="cyber-glow-card cyber-scanline relative rounded-2xl bg-zinc-950/80 p-7 md:p-8"
      >
        <HudCorner />
        <p className="hud-label text-emerald-400/80">EARNINGS LEDGER</p>
        <h3 className="mt-2 font-display text-xl font-bold text-ink-primary">收益明细</h3>

        <div className="mt-5">
          {earningsQuery.isLoading ? (
            <p className="flex items-center gap-2 py-8 text-sm text-ink-faint">
              <Loader2 className="h-4 w-4 animate-spin" /> 正在载入收益明细…
            </p>
          ) : earnings.items.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-600/60 px-6 py-10 text-center">
              <Coins className="mx-auto h-8 w-8 text-zinc-600" />
              <p className="mt-3 text-sm text-ink-faint">暂无收益记录 —— 作品被工厂使用或租用后将在此入账</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-left text-sm">
                <thead>
                  <tr className="border-b border-amber-500/10 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
                    <th className="pb-3 pr-4 font-medium">来源作品</th>
                    <th className="pb-3 pr-4 font-medium">类型</th>
                    <th className="pb-3 pr-4 font-medium">时间</th>
                    <th className="pb-3 text-right font-medium">Token</th>
                  </tr>
                </thead>
                <tbody>
                  {earnings.items.map((e, i) => (
                    <tr key={e.id ?? i} className="border-b border-zinc-800/60 last:border-0">
                      <td className="py-3 pr-4 text-ink-primary">{e.listingName ?? e.name ?? '—'}</td>
                      <td className="py-3 pr-4 text-ink-faint">{e.source ?? '使用 / 租用'}</td>
                      <td className="py-3 pr-4 font-mono text-xs text-ink-faint">
                        {e.createdAt ? new Date(e.createdAt).toLocaleDateString('zh-CN') : '—'}
                      </td>
                      <td className="py-3 text-right font-mono font-medium text-amber-400">
                        +{formatToken(e.amountToken ?? e.token ?? 0)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <p className="mt-5 rounded-lg border border-emerald-400/20 bg-emerald-400/[0.05] px-3.5 py-2.5 text-[11px] leading-relaxed text-emerald-300/80">
          以上 Token 收益可兑换数字人民币（结算通道未来开放）。结算开启后将按批次人工确认，请以届时公告为准。
        </p>
      </motion.section>
    </div>
  )
}

/* ───────────────────────── 页面主体 ───────────────────────── */

export default function Developers() {
  const [session, setSession] = useState<DevSession | null>(() => loadDevSession())

  // 跨标签页同步会话
  useEffect(() => {
    const sync = () => setSession(loadDevSession())
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])

  const logout = () => {
    clearDevSession()
    setSession(null)
  }

  return (
    <div className="bg-void">
      {/* Hero */}
      <section className="cyber-grid-bg cyber-scanline relative overflow-hidden">
        <div className="pointer-events-none absolute -top-40 left-1/2 h-[480px] w-[880px] -translate-x-1/2 bg-[radial-gradient(ellipse,rgba(245,165,36,0.12),transparent_65%)]" />
        <div className="relative mx-auto max-w-site px-5 pb-14 pt-16 md:px-12 md:pb-20 md:pt-24">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, ease: easeOut }}
            className="text-center"
          >
            <p className="hud-label text-amber-400/80">DEVELOPER HUB</p>
            <h1 className="mt-3 font-display text-3xl font-bold tracking-[0.02em] text-ink-primary md:text-5xl">
              开发者中心
            </h1>
            <p className="mx-auto mt-4 max-w-2xl text-[15px] leading-relaxed text-ink-secondary">
              上架你的 Agent 应用与 Skill 技能，被 NumX Max 的工厂使用与租用，获得 Token 收益，并可兑换数字人民币结算。
            </p>
          </motion.div>
        </div>
      </section>

      <div className="mx-auto max-w-site px-5 pb-24 md:px-12">
        {!session ? (
          <>
            {/* 未登录：流程介绍 + 注册/登录 */}
            <div className="grid gap-10 lg:grid-cols-[1.2fr_1fr]">
              <div className="space-y-6">
                <motion.div
                  initial={{ opacity: 0, y: 28 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.1, duration: 0.7, ease: easeOut }}
                >
                  <p className="hud-label text-emerald-400/80">HOW IT WORKS</p>
                  <h2 className="mt-2 font-display text-2xl font-bold text-ink-primary">四步接入 NumX Max 生态</h2>
                </motion.div>
                {(
                  [
                    {
                      icon: UploadCloud,
                      title: '上架作品',
                      desc: '提交你的 Agent 应用或 Skill 技能，由 NumX Max 智造研究院人工审核确认后上架。',
                    },
                    {
                      icon: Factory,
                      title: '被工厂使用',
                      desc: 'NumX Max 平台上的工厂按月雇佣你的 Agent，或按次调用你的 Skill 技能。',
                    },
                    {
                      icon: Coins,
                      title: '获得 Token 收益',
                      desc: '每一次使用与租用都按约定计入 Token 收益，明细在面板中逐笔可查。',
                    },
                    {
                      icon: Landmark,
                      title: '数字人民币结算',
                      desc: 'Token 可经合规结算通道兑换数字人民币，批次结算、人工确认。',
                    },
                  ] as const
                ).map((step, i) => (
                  <motion.div
                    key={step.title}
                    initial={{ opacity: 0, x: -24 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.15 + i * 0.08, duration: 0.6, ease: easeOut }}
                    className="cyber-glow-card relative flex gap-4 rounded-2xl bg-zinc-950/80 p-5"
                  >
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-amber-500/30 bg-amber-500/10">
                      <step.icon className="h-5 w-5 text-amber-400" />
                    </span>
                    <div>
                      <p className="font-medium text-ink-primary">
                        <span className="mr-2 font-mono text-xs text-amber-400/80">0{i + 1}</span>
                        {step.title}
                      </p>
                      <p className="mt-1 text-sm leading-relaxed text-ink-secondary">{step.desc}</p>
                    </div>
                  </motion.div>
                ))}

                {/* Token 购买交易服务状态 */}
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.5, duration: 0.6, ease: easeOut }}
                  className="rounded-2xl border border-dashed border-zinc-600/60 bg-zinc-950/40 p-5"
                >
                  <p className="flex flex-wrap items-center gap-2 text-sm text-ink-secondary">
                    Token 购买交易服务
                    <span className="rounded-full border border-zinc-500/50 bg-zinc-900/80 px-2.5 py-0.5 font-mono text-[10px] tracking-widest text-zinc-400">
                      未来开放
                    </span>
                  </p>
                  <p className="mt-2 text-xs leading-relaxed text-ink-faint">
                    当前 Token 仅可通过上架作品被使用获得。平台不提供 Token 炒作或投机渠道，任何收益均以实际使用情况为准。
                  </p>
                </motion.div>
              </div>

              <motion.div
                initial={{ opacity: 0, y: 32 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2, duration: 0.7, ease: easeOut }}
              >
                <AuthPanel onAuthed={setSession} />
                <p className="mt-4 text-center text-xs text-ink-faint">
                  想了解 Token 经济规则？
                  <Link to="/token" className="ml-1 inline-flex items-center gap-1 text-amber-400 hover:underline">
                    查看 Token 说明 <ArrowRight className="h-3 w-3" />
                  </Link>
                </p>
              </motion.div>
            </div>
          </>
        ) : (
          <Dashboard session={session} onLogout={logout} />
        )}

        {/* 底部公共区 */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-60px' }}
          transition={{ duration: 0.7, ease: easeOut }}
          className="mt-14 flex flex-col items-center justify-between gap-5 rounded-2xl border border-line-subtle bg-zinc-950/60 p-7 md:flex-row"
        >
          <div>
            <h3 className="font-display text-lg font-bold text-ink-primary">看看优秀匠人们排在哪里</h3>
            <p className="mt-1 text-sm text-ink-secondary">收益榜、热力榜、口碑榜与周新星，每周更新。</p>
          </div>
          <GlowButton to="/leaderboard" variant="secondary">
            前往匠人排行榜
          </GlowButton>
        </motion.div>
      </div>
    </div>
  )
}
