import { lazy, Suspense, useRef } from 'react'
import { ChevronDown } from 'lucide-react'
import { ACTS } from './acts'

const HeroStarfield = lazy(() => import('./HeroStarfield'))

interface LifecycleHeroProps {
  /** scroll to the n-th act of the pinned journey (0-based) */
  onActClick: (act: number) => void
}

export default function LifecycleHero({ onActClick }: LifecycleHeroProps) {
  const scope = useRef<HTMLElement>(null)


  return (
    <section ref={scope} className="relative flex min-h-[100dvh] flex-col overflow-hidden bg-void">
      <Suspense fallback={null}>
        <HeroStarfield />
      </Suspense>
      <div aria-hidden className="nebula-halo pointer-events-none absolute -top-40 left-1/2 h-[560px] w-[900px] -translate-x-1/2" />

      <div className="relative z-10 mx-auto flex w-full max-w-site flex-1 flex-col items-center justify-center px-5 pb-40 pt-24 text-center md:px-12">
        <p className="lc-hud hud-label text-pulse-cyan/80">AGENT LIFECYCLE · 6 ACTS</p>
        <h1 className="mt-6 font-display text-[40px] font-black leading-[1.15] tracking-[0.02em] text-ink-primary md:text-[64px]">
          <span className="lc-title-line block">从一段老师傅的经验</span>
          <span className="lc-title-line mt-2 block">
            到一位<span className="text-brand-gradient">身价不菲</span>的数字工匠
          </span>
        </h1>
        <p className="mt-6 max-w-xl text-[15px] leading-relaxed text-ink-secondary md:text-base">
          孵化、上架、定价、雇佣、执行、进化——六幕旅程，见证一门手艺如何成为可被雇佣的数字劳动力。
        </p>
      </div>

      {/* act tick navigation */}
      <div className="absolute inset-x-0 bottom-0 z-10 pb-8">
        <div className="mx-auto flex max-w-3xl items-end justify-between px-5 md:px-0">
          {ACTS.map((act, i) => (
            <button
              key={act.id}
              type="button"
              onClick={() => onActClick(i)}
              className="lc-tick group flex flex-col items-center gap-2"
            >
              <span className="font-grotesk text-sm font-medium text-ink-faint transition-colors duration-300 group-hover:text-pulse-cyan">
                {act.numeral}
              </span>
              <span className="h-px w-8 bg-line-subtle transition-all duration-300 group-hover:w-12 group-hover:bg-pulse-cyan md:w-12" />
              <span className="text-[12px] text-ink-faint transition-colors duration-300 group-hover:text-ink-primary">
                {act.name}
              </span>
            </button>
          ))}
        </div>
        <div className="lc-scroll-hint mt-8 flex flex-col items-center gap-1 text-ink-faint">
          <ChevronDown className="lc-arrow h-4 w-4 text-pulse-cyan/70" />
          <span className="hud-label">向下滚动开始</span>
        </div>
      </div>
    </section>
  )
}
