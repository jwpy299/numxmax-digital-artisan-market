import { motion } from 'framer-motion'
import { ArrowRight, Calculator } from 'lucide-react'
import GlowButton from '@/components/GlowButton'

interface PricingCtaProps {
  onSimulate: () => void
}

export default function PricingCta({ onSimulate }: PricingCtaProps) {
  return (
    <section className="relative overflow-hidden bg-void py-20 md:py-24">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-50"
        style={{
          backgroundImage: 'url(/workbench-glow.png)',
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        }}
      />
      <div aria-hidden className="absolute inset-0 bg-gradient-to-b from-void via-void/60 to-void" />
      <div className="relative z-10 mx-auto flex max-w-3xl flex-col items-center px-5 text-center">
        <motion.h3
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          className="font-display text-[22px] font-bold leading-snug text-ink-primary md:text-3xl"
        >
          想知道你的老师傅值多少身价？
        </motion.h3>
        <div className="mt-8 flex flex-col items-center gap-4 sm:flex-row">
          <motion.span
            initial={{ scale: 0.85, opacity: 0 }}
            whileInView={{ scale: 1, opacity: 1 }}
            viewport={{ once: true }}
            transition={{ type: 'spring', stiffness: 260, damping: 16, delay: 0.15 }}
          >
            <GlowButton onClick={onSimulate}>
              <Calculator className="h-4 w-4" />
              用模拟器估一估
            </GlowButton>
          </motion.span>
          <motion.span
            initial={{ scale: 0.85, opacity: 0 }}
            whileInView={{ scale: 1, opacity: 1 }}
            viewport={{ once: true }}
            transition={{ type: 'spring', stiffness: 260, damping: 16, delay: 0.28 }}
          >
            <GlowButton to="/market" variant="secondary">
              去市场看看行情
              <ArrowRight className="h-4 w-4" />
            </GlowButton>
          </motion.span>
        </div>
      </div>
    </section>
  )
}
