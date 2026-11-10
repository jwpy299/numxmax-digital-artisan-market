import { useEffect, useRef } from 'react'
import { ArrowRight } from 'lucide-react'
import GlowButton from '@/components/GlowButton'

export default function LifecycleCta() {
  const scope = useRef<HTMLElement>(null)

  useEffect(() => {
    const node = scope.current
    if (!node) return
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          node.classList.add('lc-inview')
          observer.disconnect()
        }
      }
    }, { threshold: 0.2 })
    observer.observe(node)

    let frame = 0
    const update = () => {
      frame = 0
      const rect = node.getBoundingClientRect()
      const progress = Math.max(0, Math.min(1, (window.innerHeight - rect.top) / (window.innerHeight + rect.height)))
      const band = node.querySelector<HTMLElement>('.lc-cta-band')
      if (band) band.style.backgroundPositionX = `${Math.round(progress * 60)}%`
    }
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    update()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      observer.disconnect()
      window.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [])

  const title = '每一条经验曲线，都值得被延续'

  return (
    <section ref={scope} className="relative overflow-hidden bg-deep py-24 md:py-32">
      <style>{`
        .lc-cta-word{display:inline-block;opacity:0;transform:translateY(30px);transition:opacity .5s ease,transform .5s ease}
        .lc-cta-btn{display:inline-block;opacity:0;transform:scale(.9);transition:opacity .45s ease,transform .45s cubic-bezier(.2,1.4,.4,1)}
        .lc-inview .lc-cta-word{opacity:1;transform:translateY(0)}
        .lc-inview .lc-cta-btn{opacity:1;transform:scale(1)}
        .lc-inview .lc-cta-btn:nth-child(2){transition-delay:.1s}
        .lc-cta-band{transition:background-position-x .2s linear}
        @media (prefers-reduced-motion:reduce){.lc-cta-word,.lc-cta-btn{opacity:1;transform:none;transition:none}}
      `}</style>
      <div
        aria-hidden
        className="lc-cta-band pointer-events-none absolute inset-0 opacity-40"
        style={{
          backgroundImage: 'url(/nebula-band.png)',
          backgroundSize: '140% auto',
          backgroundPosition: '0% 50%',
          backgroundRepeat: 'no-repeat',
        }}
      />
      <div className="relative z-10 mx-auto flex max-w-2xl flex-col items-center px-5 text-center">
        <p className="hud-label text-pulse-cyan/80">THE JOURNEY CONTINUES</p>
        <h2 className="mt-4 font-display text-[26px] font-bold leading-snug tracking-[0.02em] text-ink-primary md:text-4xl">
          {title.split('，').map((part, i) => (
            <span key={part} className="inline-block">
              {Array.from(part).map((ch, j) => (
                <span key={j} className="lc-cta-word inline-block" style={{ transitionDelay: `${j * 35}ms` }}>
                  {ch}
                </span>
              ))}
              {i === 0 && <span className="lc-cta-word inline-block">，</span>}
            </span>
          ))}
        </h2>
        <div className="mt-10 flex flex-col items-center gap-4 sm:flex-row">
          <span className="lc-cta-btn">
            <GlowButton to="/market">
              去市场雇佣工匠
              <ArrowRight className="h-4 w-4" />
            </GlowButton>
          </span>
          <span className="lc-cta-btn">
            <GlowButton to="/pricing" variant="secondary">
              了解定价模式
            </GlowButton>
          </span>
        </div>
      </div>
    </section>
  )
}
