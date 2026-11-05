import { deptCodeOfAgent } from '@contracts/deptMap' // 员工→部门键归因单源（战区② 2.2——彭总策略：单员工展示+部门包主调）
import { useState, Suspense } from 'react'
import { DigitalHumanSafe } from '@/components/digitalhuman/DigitalHumanSafe'
import { motion } from 'framer-motion'
import {
  BadgeCheck,
  CheckCircle2,
  FlaskConical,
  Loader2,
  Package,
  PenLine,
  Sparkles,
  Volume2,
} from 'lucide-react'
// 直接引用纯 DOM 模块，避免经 barrel 静态拉入 DigitalHuman/three
import { SpeechBubble } from '@/components/digitalhuman/SpeechBubble'
import { useVoiceGreeting } from '@/components/digitalhuman/useVoiceGreeting'

// iter83 3D 数字人：懒加载隔离 three 体积
import { trpc } from '@/providers/trpc'
import { loadWbSession } from '@/lib/wbSession'
import type { DetailData } from '@/components/agent-detail/detail-data'
import { formatToken } from '@/components/market/types'
import PriceChart from '@/components/agent-detail/PriceChart'
import HudCorner from '@/components/HudCorner'
import GlowButton from '@/components/GlowButton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

/** 试岗真链（⑤）：enterpriseId 一律取会话厂域（loadWbSession——DEMO 硬编码华辰精工退役；
 *  后端 trials.create 已补 token+owner/admin+厂域对齐闸） */

interface HirePanelProps {
  detail: DetailData
}

interface TrialReport {
  suitabilityScore: number
  diagnosticAccuracy: number
  avgResponseSec: number
  tasksCompleted: number
  confidenceGrade: string
  advice: string
  summary: string
  highlights: string[]
}

export default function HirePanel({ detail }: HirePanelProps) {
  const { agent, pricing } = detail
  const [trialOpen, setTrialOpen] = useState(false)

  // iter83：购买/试用前必须先经过数字人自我介绍
  const [introOpen, setIntroOpen] = useState(false)


  const rising = pricing.changePct >= 0

  const openWithIntro = () => {
    setIntroOpen(true) // 单员工雇佣面退役（彭总策略：单员工只做展示——hire 分支摘=introNext/hireOpen 死面同摘，portal#57 复审票）
  }
  const onIntroDone = () => {
    setIntroOpen(false)
    setTrialOpen(true) // 恒 trial（hire 面退役——分支摘=恒假死面封死）
  }

  return (
    <motion.aside
      initial={{ opacity: 0, x: 60 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: 0.3, duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
      className="relative rounded-2xl glass-panel p-7 lg:sticky lg:top-24"
    >
      <HudCorner />
      <p className="hud-label text-pulse-cyan/80">HIRE PANEL · 雇佣报价</p>

      {/* live price */}
      <div className="mt-4 flex items-end gap-2">
        <p className="font-grotesk text-[40px] font-bold leading-none text-forge-amber">
          {formatToken(agent.monthlyPrice)}
        </p>
        <span className="pb-1 text-sm text-ink-faint">Token/月</span>
      </div>
      <p
        className={cn(
          'mt-2 flex items-center gap-1 text-[13px]',
          rising ? 'text-ember-red' : 'text-jade-green',
        )}
      >
        {/* 2026-09-05 脱假（彭总令）：无真实成交史时不编造涨跌幅 */}
        开市首价 · 走势待真实成交积累
      </p>
      <p className="mt-2 font-mono text-[11px] leading-relaxed text-ink-faint">
        价格构成：正价 {formatToken(pricing.suggestedPrice)}（人类员工月成本÷3）· 创始验证期{' '}
        {formatToken(pricing.suggestedPrice + pricing.masterAdjustment)}（3 折锁一年）
      </p>

      {/* 30-day sparkline */}
      <div className="mt-5">
        <p className="mb-2 font-mono text-[10px] uppercase tracking-widest text-ink-faint">
          30 天价格走势
        </p>
        <PriceChart points={pricing.history} />
      </div>

      {/* CTAs：先听数字人自我介绍，再进购买流程 */}
      <div className="mt-6 space-y-3">
        <GlowButton className="w-full" onClick={() => openWithIntro()}>
          <FlaskConical className="h-4 w-4" /> 申请 7 天免费试用
        </GlowButton>
        <p className="text-center font-mono text-[10px] text-ink-faint">
          沙箱执行 · 技能调用费照常
        </p>
        {/* 彭总 2026-10-14 策略：单员工只做展示，雇佣租借以部门级订阅服务包为主调——
            雇佣钮改「按部门订阅」跳部门包页（带员工所属部门归因=deptCodeOfAgent 单源） */}
        <GlowButton variant="secondary" className="w-full" onClick={() => {
          const dept = deptCodeOfAgent(detail.agent.industryGroup ?? detail.agent.industry, detail.agent.capabilityTags)
          window.location.href = dept ? `/packages?dept=${dept}` : '/packages'
        }}>
          <Package className="h-4 w-4" /> 按部门订阅
        </GlowButton>
      </div>

      <p className="mt-5 border-t border-line-subtle pt-4 font-mono text-[11px] leading-relaxed text-ink-faint">
        最短周期 1 个月 · 平台佣金 15% · 随时可解约
      </p>

      <IntroDialog
        open={introOpen}
        onOpenChange={setIntroOpen}
        onDone={onIntroDone}
        nextLabel="去申请试用"
        agentName={agent.name}
        introText={agent.introText}
        avatarConfig={agent.avatarConfig}
        capabilityTags={agent.capabilityTags}
      />
      <TrialDialog
        open={trialOpen}
        onOpenChange={setTrialOpen}
        agentId={agent.numericId}
        agentName={agent.name}
      />
    </motion.aside>
  )
}

/* ---------------- 7 天试用申请 ---------------- */

function TrialDialog({
  open,
  onOpenChange,
  agentId,
  agentName,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  agentId: number | null
  agentName: string
}) {
  const [productionLine, setProductionLine] = useState('')
  const [trialId, setTrialId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const createTrial = trpc.trials.create.useMutation({
    onSuccess: (data) => {
      setTrialId(data.id)
      setError(null)
    },
    onError: (e) => setError(e.message),
  })

  const reportQuery = trpc.trials.report.useQuery(
    { trialId: trialId ?? 0 },
    { enabled: trialId != null, retry: 1 },
  )
  const report = (reportQuery.data?.report ?? null) as TrialReport | null

  const submit = () => {
    if (createTrial.isPending) return
    setError(null)
    if (agentId == null) {
      setError('离线演示模式下无法提交真实试用申请，请稍后在联机环境重试。')
      return
    }
    const session = loadWbSession()
    if (!session?.token || typeof session.factoryId !== 'number') {
      setError('申请试用仅限企业负责人操作，请先登录星云智能工作台。')
      return
    }
    createTrial.mutate({
      token: session.token,
      agentId,
      enterpriseId: session.factoryId,
      productionLine: productionLine.trim() || undefined,
    })
  }

  const reset = (v: boolean) => {
    if (!v) {
      setTrialId(null)
      setError(null)
      setProductionLine('')
    }
    onOpenChange(v)
  }

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogContent className="border-line-subtle bg-[#0A0F1E] text-ink-primary sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">申请 7 天免费试用 · {agentName}</DialogTitle>
          <DialogDescription className="text-ink-secondary">
            Agent 将在隔离沙箱中接入脱敏数据执行，技能调用费照常计收（每次 100 Token，平台抽 20%）。
          </DialogDescription>
        </DialogHeader>

        {trialId == null ? (
          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-xs text-ink-faint">产线基本信息（选填，10 秒完成）</label>
              <textarea
                value={productionLine}
                onChange={(e) => setProductionLine(e.target.value)}
                rows={3}
                placeholder="如：3 条 CNC 产线，主力机型 FANUC 系统，希望先做振动诊断试点"
                className="w-full rounded-lg border border-line-subtle bg-panel/60 px-3 py-2 text-sm text-ink-primary placeholder:text-ink-faint focus:border-pulse-cyan/50 focus:outline-none"
              />
            </div>
            <p className="font-mono text-[11px] text-ink-faint">申请企业：华辰精工股份有限公司（内测示范账户）</p>
            {error && <p className="text-xs text-ember-red">{error}</p>}
            <GlowButton className="w-full" onClick={submit}>
              {createTrial.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> 正在提交申请…
                </>
              ) : (
                <>
                  <FlaskConical className="h-4 w-4" /> 确认申请试用
                </>
              )}
            </GlowButton>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-2 rounded-lg border border-jade-green/40 bg-jade-green/10 px-3 py-2.5 text-sm text-jade-green">
              <CheckCircle2 className="h-4 w-4" /> 试用申请已通过，沙箱已启动（试用编号 #{trialId}，7 天）
            </div>

            {reportQuery.isLoading && (
              <p className="flex items-center gap-2 font-mono text-xs text-ink-faint">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在生成评估报告…
              </p>
            )}
            {reportQuery.isError && (
              <p className="text-xs text-ink-faint">评估报告暂未生成，沙箱执行结束后自动出具。</p>
            )}

            {report && (
              <div className="relative rounded-xl glass-panel p-4">
                <HudCorner />
                <p className="hud-label text-pulse-cyan/80">TRIAL REPORT</p>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <div>
                    <p className="font-grotesk text-2xl font-bold text-pulse-cyan">
                      {report.suitabilityScore}
                    </p>
                    <p className="text-[11px] text-ink-faint">适配度评分</p>
                  </div>
                  <div>
                    <p className="font-grotesk text-2xl font-bold text-ink-primary">
                      {report.diagnosticAccuracy.toFixed(1)}%
                    </p>
                    <p className="text-[11px] text-ink-faint">诊断准确率</p>
                  </div>
                  <div>
                    <p className="font-grotesk text-2xl font-bold text-ink-primary">
                      {report.avgResponseSec.toFixed(1)}s
                    </p>
                    <p className="text-[11px] text-ink-faint">平均响应</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="rounded-md bg-forge-amber/15 px-2.5 py-1 font-grotesk text-xl font-bold text-forge-amber">
                      {report.confidenceGrade}
                    </span>
                    <p className="text-[11px] text-ink-faint">综合置信度</p>
                  </div>
                </div>
                <p className="mt-3 text-[13px] leading-relaxed text-ink-secondary">{report.summary}</p>
                {report.highlights.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {report.highlights.slice(0, 3).map((h, i) => (
                      <li key={i} className="flex items-start gap-1.5 text-xs text-ink-secondary">
                        <BadgeCheck className="mt-0.5 h-3 w-3 shrink-0 text-jade-green" />
                        {h}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-3 border-t border-line-subtle pt-2 text-xs text-forge-amber">
                  建议：{report.advice}
                </p>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/* ---------------- iter83 · 数字人自我介绍（购买/试用前置） ---------------- */

function IntroDialog({
  open,
  onOpenChange,
  onDone,
  nextLabel,
  agentName,
  introText,
  avatarConfig,
  capabilityTags,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onDone: () => void
  nextLabel: string
  agentName: string
  introText: string | null
  avatarConfig: { seed: string; palette: { primary: string; accent: string }; ring?: boolean } | null
  capabilityTags: string[]
}) {
  const { speak, speaking, supported, stop } = useVoiceGreeting()
  const text =
    introText ??
    `你好！我是${agentName}。我擅长${capabilityTags.slice(0, 3).join('、') || '企业数字化工作'}，雇佣我之后，我会 7×24 小时在岗为你干活。`

  // 打开时自动尝试语音（浏览器策略拦截则静默降级为气泡），关闭时停止
  const handleOpenChange = (v: boolean) => {
    if (!v) stop()
    onOpenChange(v)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="border-line-subtle bg-[#0A0F1E] text-ink-primary sm:max-w-[480px]"
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          // 用户已点击「购买/试用」按钮 = 有手势上下文，多数浏览器允许播报
          if (supported) {
            try {
              speak(text)
            } catch {
              /* 降级：仅气泡 */
            }
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display text-xl">
            <Sparkles className="h-5 w-5 text-forge-amber" /> {agentName} 的自我介绍
          </DialogTitle>
          <DialogDescription className="text-ink-secondary">
            雇佣之前，先听听它能为你做什么
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-4 py-2">
          <Suspense
            fallback={
              <div className="flex h-[260px] w-[260px] items-center justify-center font-mono text-xs text-ink-faint">
                数字人加载中…
              </div>
            }
          >
            <DigitalHumanSafe
              seed={avatarConfig?.seed ?? agentName}
              palette={avatarConfig?.palette ?? { primary: '#e8a33d', accent: '#7dd3c8' }}
              speaking={speaking}
              size={260}
            />
          </Suspense>
          <SpeechBubble text={text} visible className="w-full" />
          {supported && (
            <button
              type="button"
              onClick={() => (speaking ? stop() : speak(text))}
              className="inline-flex items-center gap-1.5 rounded-full border border-line-subtle px-3 py-1 text-xs text-ink-secondary transition-colors hover:border-pulse-cyan/40 hover:text-ink-primary"
            >
              <Volume2 className="h-3.5 w-3.5" /> {speaking ? '停止播报' : '重听一遍'}
            </button>
          )}
        </div>

        <div className="space-y-2">
          <GlowButton
            className="w-full"
            onClick={() => {
              stop()
              onDone()
            }}
          >
            <PenLine className="h-4 w-4" /> 了解了，{nextLabel}
          </GlowButton>
          <button
            type="button"
            onClick={() => handleOpenChange(false)}
            className="w-full py-1 text-center text-xs text-ink-faint transition-colors hover:text-ink-secondary"
          >
            再想想
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
