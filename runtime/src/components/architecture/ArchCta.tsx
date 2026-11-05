import { motion } from 'framer-motion'
import GlowButton from '@/components/GlowButton'

export default function ArchCta() {
  return (
    <section className="relative overflow-hidden bg-deep">
      <div className="nebula-halo pointer-events-none absolute -bottom-40 left-1/2 h-80 w-[800px] -translate-x-1/2" />
      <div className="relative mx-auto max-w-site px-5 py-[72px] text-center md:px-12 md:py-24">
        <motion.h2
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          className="font-display text-2xl font-bold tracking-[0.02em] text-ink-primary md:text-4xl"
        >
          架构已就绪，就差一位工匠。
        </motion.h2>
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          whileInView={{ opacity: 1, scale: 1 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.5, delay: 0.25, ease: [0.16, 1, 0.3, 1] }}
          className="mt-9 flex flex-wrap items-center justify-center gap-4"
        >
          <GlowButton to="/lifecycle" variant="secondary">
            去看生命周期
          </GlowButton>
          <GlowButton to="/roadmap" variant="primary">
            查看上线路线
          </GlowButton>
        </motion.div>
      </div>
    </section>
  )
}
