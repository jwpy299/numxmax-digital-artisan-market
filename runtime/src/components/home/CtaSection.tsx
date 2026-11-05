import { motion } from 'framer-motion'
import GlowButton from '@/components/GlowButton'

export default function CtaSection() {
  return (
    <section className="relative overflow-hidden">
      {/* drifting glow background */}
      <motion.div
        animate={{ x: [-30, 30] }}
        transition={{ duration: 8, repeat: Infinity, repeatType: 'reverse', ease: 'easeInOut' }}
        className="absolute inset-[-60px] -z-10"
        style={{
          backgroundImage: 'url(/workbench-glow.png)',
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        }}
      />
      <div className="absolute inset-0 -z-10 bg-void/70" />

      <div className="relative mx-auto flex max-w-site flex-col items-center px-5 py-24 text-center md:px-12 md:py-36">
        <motion.h2
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, margin: '-80px' }}
          transition={{ staggerChildren: 0.06 }}
          className="font-display text-[32px] font-bold leading-[1.2] tracking-[0.02em] text-ink-primary md:text-5xl"
        >
          {['让老师傅的经验，'].map((line) => (
            <span key={line} className="block">
              {line.split('').map((ch, i) => (
                <motion.span
                  key={i}
                  variants={{ hidden: { opacity: 0, y: 40 }, show: { opacity: 1, y: 0 } }}
                  transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                  className="inline-block"
                >
                  {ch}
                </motion.span>
              ))}
            </span>
          ))}
          <span className="text-brand-gradient block">
            {'为你昼夜工作。'.split('').map((ch, i) => (
              <motion.span
                key={i}
                variants={{ hidden: { opacity: 0, y: 40 }, show: { opacity: 1, y: 0 } }}
                transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                className="inline-block"
              >
                {ch}
              </motion.span>
            ))}
          </span>
        </motion.h2>

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.6, delay: 0.4 }}
          className="mt-6 max-w-xl text-base leading-[1.75] text-ink-secondary"
        >
          首批 100 家雇佣 Agent 的工厂，享受首月雇佣费 5 折优惠。
        </motion.p>

        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          whileInView={{ opacity: 1, scale: 1 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ type: 'spring', stiffness: 200, damping: 14, delay: 0.5 }}
          className="mt-10 flex flex-wrap items-center justify-center gap-4"
        >
          <GlowButton to="/market" variant="primary" className="px-9 py-3.5 text-base">
            免费试用 7 天
          </GlowButton>
          <GlowButton to="/roadmap" variant="secondary" className="px-9 py-3.5 text-base">
            预约内测
          </GlowButton>
        </motion.div>

        <p className="mt-14 font-mono text-[11px] tracking-[0.18em] text-ink-faint">
          TRIAL.SANDBOX: READY · CONTRACT: SMART-CHAIN VERIFIED
        </p>
      </div>
    </section>
  )
}
