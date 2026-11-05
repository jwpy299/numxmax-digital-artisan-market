import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'

interface SectionHeaderProps {
  hud: string
  title: string
  subtitle?: string
  align?: 'left' | 'center'
  className?: string
}

export default function SectionHeader({ hud, title, subtitle, align = 'center', className }: SectionHeaderProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 40 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-80px' }}
      transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
      className={cn(align === 'center' ? 'text-center mx-auto' : 'text-left', 'max-w-2xl', className)}
    >
      <p className="hud-label text-pulse-cyan/80">{hud}</p>
      <h2 className="mt-3 font-display text-[26px] md:text-4xl font-bold tracking-[0.02em] text-ink-primary">
        {title}
      </h2>
      {subtitle && <p className="mt-4 text-[15px] md:text-base leading-relaxed text-ink-secondary">{subtitle}</p>}
    </motion.div>
  )
}
