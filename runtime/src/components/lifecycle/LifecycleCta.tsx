import { useRef } from 'react'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { useGSAP } from '@gsap/react'
import { ArrowRight } from 'lucide-react'
import GlowButton from '@/components/GlowButton'

gsap.registerPlugin(ScrollTrigger)

export default function LifecycleCta() {
  const scope = useRef<HTMLElement>(null)

  useGSAP(
    () => {
      const words = gsap.utils.toArray<HTMLElement>('.lc-cta-word')
      gsap.from(words, {
        y: 40,
        opacity: 0,
        stagger: 0.06,
        duration: 0.7,
        ease: 'power3.out',
        scrollTrigger: { trigger: scope.current, start: 'top 78%' },
      })
      gsap.from('.lc-cta-btn', {
        scale: 0.85,
        opacity: 0,
        stagger: 0.12,
        duration: 0.6,
        ease: 'back.out(1.8)',
        scrollTrigger: { trigger: scope.current, start: 'top 72%' },
      })
      // slow nebula band drift
      gsap.to('.lc-cta-band', {
        backgroundPositionX: '60%',
        ease: 'none',
        scrollTrigger: { trigger: scope.current, start: 'top bottom', end: 'bottom top', scrub: true },
      })
    },
    { scope },
  )

  const title = '每一条经验曲线，都值得被延续'

  return (
    <section ref={scope} className="relative overflow-hidden bg-deep py-24 md:py-32">
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
                <span key={j} className="lc-cta-word inline-block">
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
