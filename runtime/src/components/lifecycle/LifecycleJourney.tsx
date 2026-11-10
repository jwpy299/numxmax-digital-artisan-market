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
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    const node = scope.current
    if (!node) return
    let frame = 0
    const update = () => {
      frame = 0
      const rect = node.getBoundingClientRect()
      const scrollable = Math.max(1, node.offsetHeight - window.innerHeight)
      const next = Math.max(0, Math.min(1, -rect.top / scrollable))
      setProgress(next)
      setActiveAct(Math.min(ACTS.length - 1, Math.floor(next * ACTS.length)))
    }
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    update()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [])

  useEffect(() => {
    registerScroller((act: number) => {
      const node = scope.current
      if (!node) return
      const scrollable = Math.max(1, node.offsetHeight - window.innerHeight)
      const y = node.offsetTop + ((act + 0.08) / ACTS.length) * scrollable
      window.scrollTo({ top: y, behavior: 'auto' })
    })
  }, [registerScroller])

  const act = ACTS[activeAct]
  const panelStyle = (index: number) => ({
    opacity: index === activeAct ? 1 : 0,
    transform: `translateY(${index < activeAct ? -60 : index > activeAct ? 60 : 0}px)`,
    transition: 'opacity .3s ease, transform .3s ease',
    pointerEvents: index === activeAct ? 'auto' as const : 'none' as const,
  })
  const stageStyle = (index: number) => ({
    opacity: index === activeAct ? 1 : 0,
    transform: `scale(${index === activeAct ? 1 : 0.94})`,
    transition: 'opacity .3s ease, transform .3s ease',
    pointerEvents: index === activeAct ? 'auto' as const : 'none' as const,
  })

  return (
    <section ref={scope} id="journey" className="relative h-[700dvh] bg-deep">
      <div className="sticky top-0 flex h-[100dvh] flex-col overflow-hidden">
        <div className="absolute inset-x-0 top-0 z-20 px-5 pt-20 md:px-12">
          <div className="mx-auto max-w-site">
            <div className="h-[3px] overflow-hidden rounded-full bg-muted/60">
              <div className="journey-fill h-full w-full origin-left rounded-full bg-gradient-to-r from-nebula-violet to-pulse-cyan" style={{ transform: `scaleX(${progress})` }} />
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
          <div className="relative h-[36%] shrink-0 lg:h-[70%] lg:w-[42%]">
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
              <div key={a.id} className="act-panel absolute inset-0 flex flex-col justify-center" style={panelStyle(i)} aria-hidden={i !== activeAct}>
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

          <div className="relative min-h-0 flex-1 lg:h-[70%] lg:w-[58%]">
            {STAGES.map((Stage, i) => (
              <div key={ACTS[i].id} className="act-stage absolute inset-0 flex items-center justify-center" style={stageStyle(i)} aria-hidden={i !== activeAct}>
                <div className="w-full max-w-[660px]">
                  <Stage />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
