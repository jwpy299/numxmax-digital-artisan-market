import { useEffect, useRef, useState } from 'react'
import { ACTS } from './acts'
import { IncubateStage, ListingStage, PricingStage, HireStage, ExecuteStage, EvolveStage } from './stages'
import { cn } from '@/lib/utils'

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
  useEffect(() => { registerScroller(setActiveAct) }, [registerScroller])
  useEffect(() => {
    const onScroll = () => {
      const rect = scope.current?.getBoundingClientRect()
      if (!rect) return
      const progress = Math.min(Math.max(-rect.top / Math.max(rect.height, 1), 0), 1)
      setActiveAct(Math.min(ACTS.length - 1, Math.floor(progress * ACTS.length)))
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => window.removeEventListener('scroll', onScroll)
  }, [])


  const act = ACTS[activeAct]

  return (
    <section ref={scope} id="journey" className="relative h-[100dvh] overflow-hidden bg-deep">
      {/* 顶部进度条 */}
      <div className="absolute inset-x-0 top-0 z-20 px-5 pt-20 md:px-12">
        <div className="mx-auto max-w-site">
          <div className="h-[3px] overflow-hidden rounded-full bg-muted/60">
            <div className="journey-fill h-full w-full origin-left rounded-full bg-gradient-to-r from-nebula-violet to-pulse-cyan" style={{ transform: `scaleX(${(activeAct + 1) / ACTS.length})` }} />
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

          {ACTS.map((a, i) => (
            <div key={a.id} className={cn('act-panel absolute inset-0 flex flex-col justify-center transition-opacity duration-300', i === activeAct ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none')}>
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
            <div key={ACTS[i].id} className={cn('act-stage absolute inset-0 flex items-center justify-center transition-opacity duration-300', i === activeAct ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none')}>
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
