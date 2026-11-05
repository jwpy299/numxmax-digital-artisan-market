import { useState } from 'react'
import { motion } from 'framer-motion'
import { ArrowUpRight, CloudOff, Loader2, Satellite, TicketCheck } from 'lucide-react'
import GlowButton from '@/components/GlowButton'
import HudCorner from '@/components/HudCorner'
import { trpc } from '@/providers/trpc'
import {
  NEBULA_WORKBENCH_URL,
  resolveWorkbenchUrl,
  type WorkbenchTarget,
} from '@/config/workbench'
import type { WorkbenchSession } from './session'
import { ACCOUNT_CARD_ANCHOR_ID } from './AccountCard'

interface JumpCardProps {
  session: WorkbenchSession | null
}

/** 滚动引导到工作台账号卡（无 token 时的引导路径） */
function scrollToAccountCard() {
  document
    .getElementById(ACCOUNT_CARD_ANCHOR_ID)
    ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

/** 中央跳转主卡：桥接状态 + 两段式 SSO 免密跳转（落地页选择器已退役——彭总 2026-10-15 瘦身令） */
export default function JumpCard({ session }: JumpCardProps) {
  // 桥接自检：转发 nebulaLink.bridgeStatus；不可达时返回 reachable:false 而非报错
  const statusQuery = trpc.workbenchLink.bridgeStatus.useQuery(undefined, {
    retry: false,
    staleTime: 60_000,
  })
  const reachable = statusQuery.data?.reachable === true
  // 落地页固定默认 /dept（选择器退役[彭总 2026-10-15 瘦身令]：6 深链对未登录访客=撞登录墙、已登录用户工作台内自有导航——选择面零价值）
  const target: WorkbenchTarget = '/dept'
  const [jumpError, setJumpError] = useState<string | null>(null)
  const ticketMutation = trpc.workbenchLink.createWorkbenchTicket.useMutation()

  async function handleEnter() {
    setJumpError(null)
    // 无 token → 滚动引导到账号卡（注册 / 登录后写入 localStorage("nebula_auth")）
    if (!session?.token) {
      scrollToAccountCard()
      return
    }
    // 有 token → 签发一次性 ticket（st_ 前缀，TTL 300s）→ 整页跳转 entryUrl
    const res = await ticketMutation.mutateAsync({
      token: session.token,
      target,
      source: 'craftsman-market',
    })
    if (res.ok) {
      // entryUrl 形如 /bridge?ticket=...（相对路径时拼接工作台 web base）
      window.location.href = resolveWorkbenchUrl(res.entryUrl)
      return
    }
    // 签发失败：token 单点有效，可能已失效——内联提示并引导重新登录
    setJumpError(
      res.reachable
        ? `跳转票据签发失败：${res.message}。token 单点有效，可能已在别处重新登录而失效，请重新登录后再试。`
        : res.message,
    )
  }

  return (
    <section className="relative bg-deep">
      <div className="mx-auto max-w-site px-5 py-16 md:px-12 md:py-24">
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          className="glass-panel relative mx-auto max-w-2xl rounded-2xl px-6 py-12 text-center md:px-12 md:py-16"
        >
          <HudCorner />
          <div aria-hidden className="nebula-halo pointer-events-none absolute -top-20 left-1/2 h-64 w-[480px] -translate-x-1/2" />

          {/* 工作台 Logo 意象 */}
          <div className="relative mx-auto flex h-24 w-24 items-center justify-center rounded-2xl border border-nebula-violet/30 bg-panel/60 shadow-[0_0_36px_rgba(124,92,255,0.35)]">
            <img src="/logo-mark.png" alt="星云智能工作台" className="h-16 w-16 object-contain" />
          </div>

          <p className="hud-label mt-8 text-pulse-cyan/80">EXECUTION CONSOLE</p>
          <h2 className="mt-3 font-display text-[24px] font-bold tracking-[0.02em] text-ink-primary md:text-3xl">
            进入<span className="text-brand-gradient">星云智能工作台</span>
          </h2>
          <p className="mx-auto mt-4 max-w-md text-sm leading-relaxed text-ink-secondary">
            下达任务、追踪执行、收回结构化报告——你的数字工匠已在那里待命。
          </p>

          {/* 桥接连通状态（nebulaLink.bridgeStatus 自检） */}
          <div className="mt-6 flex justify-center">
            {statusQuery.isPending ? (
              <span className="inline-flex items-center gap-2 rounded-full border border-line-subtle bg-void/60 px-3 py-1 text-xs text-ink-secondary">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                正在检测工作台桥接状态…
              </span>
            ) : reachable && statusQuery.data?.reachable ? (
              <span className="inline-flex items-center gap-2 rounded-full border border-jade-green/40 bg-jade-green/10 px-3 py-1 text-xs text-jade-green">
                <Satellite className="h-3.5 w-3.5" />
                桥接已连通 · Ticket TTL {statusQuery.data.ticketTtlSeconds}s ·{' '}
                {statusQuery.data.requiresLogin ? '需登录' : '免登录'}
              </span>
            ) : (
              <span className="inline-flex items-center gap-2 rounded-full border border-forge-amber/40 bg-forge-amber/10 px-3 py-1 text-xs text-forge-amber">
                <CloudOff className="h-3.5 w-3.5" />
                工作台服务未连通（地址未配置或网络不可达），SSO 已就绪待接入
              </span>
            )}
          </div>

          <div className="mt-8 flex flex-col items-center gap-4">
            <GlowButton
              onClick={() => void handleEnter()}
              variant="primary"
              className={`px-10 py-4 text-base ${ticketMutation.isPending || !reachable ? 'cursor-not-allowed opacity-60' : ''}`}
            >
              {ticketMutation.isPending ? (
                <>
                  <Loader2 className="h-5 w-5 animate-spin" />
                  正在签发跳转票据…
                </>
              ) : (
                <>
                  进入星云智能工作台
                  <ArrowUpRight className="h-5 w-5" />
                </>
              )}
            </GlowButton>

            {/* 两段式 SSO 徽标 */}
            <span className="inline-flex items-center gap-2 rounded-full border border-pulse-cyan/40 bg-pulse-cyan/10 px-3 py-1 text-xs text-pulse-cyan">
              <TicketCheck className="h-3.5 w-3.5" />
              两段式 SSO 已按官方文档实现 · 一次性 ticket 免密跳转
            </span>
          </div>

          {/* 签发失败 / 未连通 内联提示 */}
          {jumpError && (
            <div className="mx-auto mt-5 max-w-md rounded-xl border border-ember-red/30 bg-ember-red/[0.06] px-4 py-3 text-left">
              <p className="text-xs leading-relaxed text-ember-red">{jumpError}</p>
              {session && (
                <button
                  type="button"
                  onClick={scrollToAccountCard}
                  className="mt-2 text-xs font-medium text-pulse-cyan underline-offset-4 hover:underline"
                >
                  前往账号卡重新登录 →
                </button>
              )}
            </div>
          )}

          {!session && (
            <button
              type="button"
              onClick={scrollToAccountCard}
              className="mt-5 text-xs text-ink-secondary underline-offset-4 transition-colors hover:text-pulse-cyan hover:underline"
            >
              还没有工作台账号？前往下方账号卡注册 / 登录 →
            </button>
          )}

          <p className="mt-6 font-mono text-[11px] tracking-wider text-ink-faint">
            {NEBULA_WORKBENCH_URL}
          </p>
        </motion.div>
      </div>
    </section>
  )
}
