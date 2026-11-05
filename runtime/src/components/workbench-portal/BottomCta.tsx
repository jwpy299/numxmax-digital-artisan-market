import { motion } from 'framer-motion'
import { Store } from 'lucide-react'
import GlowButton from '@/components/GlowButton'

/** 底部 CTA：引导尚未雇佣的用户前往数字匠市 */
export default function BottomCta() {
  return (
    <section className="relative overflow-hidden bg-deep">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-25"
        style={{
          backgroundImage: 'url(/workbench-glow.png)',
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          maskImage: 'linear-gradient(to top, black 20%, transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to top, black 20%, transparent 100%)',
        }}
      />
      <div className="relative mx-auto max-w-site px-5 py-16 text-center md:px-12 md:py-20">
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
        >
          <p className="hud-label text-pulse-cyan/80">GET STARTED</p>
          <h2 className="mt-3 font-display text-[24px] font-bold tracking-[0.02em] text-ink-primary md:text-3xl">
            还没有数字工匠？
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-ink-secondary md:text-base">
            前往数字匠市，找到懂产线、懂工艺的数字工匠，先试用、再雇佣。
          </p>
          <div className="mt-8 flex justify-center">
            <GlowButton to="/market" variant="primary" className="px-8 py-4 text-base">
              <Store className="h-5 w-5" />
              去数字匠市雇佣
            </GlowButton>
          </div>
        </motion.div>
      </div>
    </section>
  )
}
