import { useRef, useState } from 'react'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { useGSAP } from '@gsap/react'
import { ACTS } from './acts'
import { IncubateStage, ListingStage, PricingStage, HireStage, ExecuteStage, EvolveStage } from './stages'
import { cn } from '@/lib/utils'

gsap.registerPlugin(ScrollTrigger)

const STAGES = [IncubateStage, ListingStage, PricingStage, HireStage, ExecuteStage, EvolveStage]

const ACT_EN: Record<string, string> = {
  incubate: 'INCUBATE',
  listing: 'LISTING',
  pricing: 'PRICING',
  hire: 'HIRE',
  execute: 'EXECUTE',
  evolve: 'EVOLVE',
}

interface LifecycleJourneyProps {
  /** register a scroll-to-act handler for the hero tick navigation */
  registerScroller: (fn: (act: number) => void) => void
}

export default function LifecycleJourney({ registerScroller }: LifecycleJourneyProps) {
  const scope = useRef<HTMLElement>(null)
  const [activeAct, setActiveAct] = useState(0)

  useGSAP(
    () => {
      const q = gsap.utils.selector(scope)
      const panels = q('.act-panel')
      const stages = q('.act-stage')

      const tl = gsap.timeline({
        defaults: { ease: 'power2.out' },
        scrollTrigger: {
          trigger: scope.current,
          start: 'top top',
          end: '+=600%',
          pin: true,
          scrub: 0.6,
          anticipatePin: 1,
          onUpdate: (self) => {
            setActiveAct(Math.min(ACTS.length - 1, Math.floor(self.progress * ACTS.length)))
          },
        },
      })

      // top progress fill across the whole journey
      tl.fromTo('.journey-fill', { scaleX: 0 }, { scaleX: 1, ease: 'none', duration: ACTS.length }, 0)

      ACTS.forEach((_, i) => {
        // narrative panel + stage enter / exit
        tl.fromTo(panels[i], { y: 60, opacity: 0 }, { y: 0, opacity: 1, duration: 0.3 }, i === 0 ? 0 : i - 0.15)
        tl.fromTo(stages[i], { opacity: 0, scale: 0.94 }, { opacity: 1, scale: 1, duration: 0.3 }, i === 0 ? 0 : i - 0.15)
        if (i < ACTS.length - 1) {
          tl.to(panels[i], { y: -60, opacity: 0, duration: 0.3, ease: 'power2.in' }, i + 0.7)
          tl.to(stages[i], { opacity: 0, scale: 0.94, duration: 0.3, ease: 'power2.in' }, i + 0.7)
        }
      })

      /* ── act-specific scrub animations ─────────────────────────── */
      // I · 孵化：光流 + 技能小球 stagger + Agent 卡定格
      tl.fromTo('.st1-flow', { strokeDashoffset: 0 }, { strokeDashoffset: -48, ease: 'none', duration: 1 }, 0)
      tl.fromTo('.st1-orb', { scale: 0 }, { scale: 1, stagger: 0.05, duration: 0.12, ease: 'back.out(2)' }, 0.15)
      tl.fromTo('.st1-agent', { opacity: 0, filter: 'blur(8px)' }, { opacity: 1, filter: 'blur(0px)', duration: 0.3 }, 0.55)

      // II · 上架：卡片滑入 + 印章 + 信息块展开
      tl.fromTo('.st2-card', { x: -80, opacity: 0 }, { x: 0, opacity: 1, duration: 0.3, ease: 'power3.out' }, 1.0)
      tl.fromTo('.st2-stamp', { scale: 2, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.22, ease: 'back.out(1.7)' }, 1.32)
      tl.fromTo('.st2-block', { y: 16, opacity: 0 }, { y: 0, opacity: 1, stagger: 0.08, duration: 0.18 }, 1.42)

      // III · 定价：曲线描画 + 事件气泡 + 天平倾斜
      tl.fromTo('.st3-curve', { strokeDashoffset: 1 }, { strokeDashoffset: 0, ease: 'none', duration: 0.7 }, 2.05)
      tl.fromTo('.st3-area', { opacity: 0 }, { opacity: 1, duration: 0.4 }, 2.35)
      tl.fromTo('.st3-event', { scale: 0, opacity: 0 }, { scale: 1, opacity: 1, stagger: 0.15, duration: 0.14, ease: 'back.out(2)' }, 2.35)
      tl.fromTo('.st3-beam', { rotate: -6 }, { rotate: 6, ease: 'none', duration: 0.9 }, 2.05)

      // IV · 雇佣：三步翻转 + 合约展开 + 链式印章
      tl.fromTo('.st4-step', { rotateY: 90, opacity: 0 }, { rotateY: 0, opacity: 1, stagger: 0.12, duration: 0.2 }, 3.05)
      tl.fromTo('.st4-contract', { scaleY: 0, opacity: 0 }, { scaleY: 1, opacity: 1, duration: 0.35, ease: 'power3.out' }, 3.5)
      tl.fromTo('.st4-chain', { opacity: 0.08 }, { opacity: 1, stagger: 0.05, duration: 0.08 }, 3.85)

      // V · 执行：技能链点亮 + 进度 + 报告弹出
      tl.fromTo('.st5-node', { borderColor: 'rgba(124,140,222,0.16)' }, { borderColor: 'rgba(34,211,238,0.7)', stagger: 0.14, duration: 0.08 }, 4.1)
      tl.fromTo('.st5-node-dot', { backgroundColor: '#55638A' }, { backgroundColor: '#22D3EE', boxShadow: '0 0 8px rgba(34,211,238,0.8)', stagger: 0.14, duration: 0.08 }, 4.1)
      tl.fromTo('.st5-progress', { scaleX: 0 }, { scaleX: 1, ease: 'none', duration: 0.65 }, 4.1)
      tl.fromTo('.st5-report', { y: 30, rotate: 1, opacity: 0 }, { y: 0, rotate: 0, opacity: 1, duration: 0.22 }, 4.72)

      // VI · 进化：螺旋点亮 + 增长标签 + 收尾放大
      tl.fromTo('.st6-dot', { opacity: 0.05, scale: 0.5 }, { opacity: 1, scale: 1, stagger: 0.008, duration: 0.1 }, 5.05)
      tl.fromTo('.st6-tag', { scale: 0, opacity: 0 }, { scale: 1, opacity: 1, stagger: 0.1, duration: 0.14, ease: 'back.out(2)' }, 5.5)
      tl.fromTo('.st6-skill', { scale: 0, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.18, ease: 'back.out(2)' }, 5.72)
      tl.fromTo('.st6-stage', { scale: 1 }, { scale: 1.04, duration: 0.28, ease: 'sine.inOut' }, 5.7)

      // hero tick navigation → scrub position of each act
      const st = tl.scrollTrigger
      if (st) {
        registerScroller((act: number) => {
          const y = st.start + ((act + 0.08) / ACTS.length) * (st.end - st.start)
          window.scrollTo({ top: y, behavior: 'auto' })
        })
      }
    },
    { scope },
  )

  const act = ACTS[activeAct]

  return (
    <section ref={scope} id="journey" className="relative h-[100dvh] overflow-hidden bg-deep">
      {/* 顶部进度条 */}
      <div className="absolute inset-x-0 top-0 z-20 px-5 pt-20 md:px-12">
        <div className="mx-auto max-w-site">
          <div className="h-[3px] overflow-hidden rounded-full bg-muted/60">
            <div className="journey-fill h-full w-full origin-left rounded-full bg-gradient-to-r from-nebula-violet to-pulse-cyan" style={{ transform: 'scaleX(0)' }} />
          </div>
          <div className="mt-2 flex justify-between">
            {ACTS.map((a, i) => (
              <span
                key={a.id}
                className={cn(
                  'font-mono text-[10px] uppercase tracking-[0.18em] transition-colors duration-300',
                  i === activeAct ? 'text-pulse-cyan' : 'text-ink-faint/60',
                )}
              >
                {a.numeral} · {a.name}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="mx-auto flex h-full w-full max-w-site flex-col px-5 pb-10 pt-32 md:px-12 lg:flex-row lg:items-center lg:gap-10 lg:pt-24">
        {/* 左栏 · 叙事 */}
        <div className="relative h-[36%] shrink-0 lg:h-[70%] lg:w-[42%]">
          {/* 巨大罗马数字底纹 */}
          <span
            key={act.numeral}
            aria-hidden
            className="pointer-events-none absolute -top-8 left-0 select-none font-grotesk text-[110px] font-bold leading-none text-ink-primary/[0.07] md:text-[160px] lg:-top-14"
            style={{ animation: 'lc-numeral-in 0.6s ease both' }}
          >
            {act.numeral}
          </span>
          <style>{'@keyframes lc-numeral-in { from { opacity: 0; transform: translateX(-24px); } to { opacity: 1; transform: translateX(0); } }'}</style>

          {ACTS.map((a) => (
            <div key={a.id} className="act-panel absolute inset-0 flex flex-col justify-center">
              <p className="hud-label text-pulse-cyan/80">
                ACT {a.numeral} · {ACT_EN[a.id]}
              </p>
              <h2 className="mt-3 font-display text-[26px] font-bold leading-snug tracking-[0.02em] text-ink-primary md:text-[40px]">
                {a.title}
              </h2>
              <p className="mt-4 max-w-md text-[13px] leading-[1.75] text-ink-secondary md:text-base">{a.body}</p>
              <ul className="mt-5 space-y-2.5">
                {a.bullets.map((b) => (
                  <li key={b} className="flex items-center gap-2.5 text-[13px] text-ink-primary md:text-sm">
                    <span className="h-1.5 w-1.5 shrink-0 bg-pulse-cyan" />
                    {b}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* 右栏 · 可视化舞台 */}
        <div className="relative min-h-0 flex-1 lg:h-[70%] lg:w-[58%]">
          {STAGES.map((Stage, i) => (
            <div key={ACTS[i].id} className="act-stage absolute inset-0 flex items-center justify-center">
              <div className="w-full max-w-[660px]">
                <Stage />
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
