import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'

/** 声望条：0-100，品牌渐变填充 + 刻度读数 */
export default function ReputationBar({
  value,
  className,
  showValue = true,
}: {
  value: number
  className?: string
  showValue?: boolean
}) {
  const pct = Math.max(0, Math.min(100, value))
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <span className="relative h-1.5 w-24 overflow-hidden rounded-full bg-void/80 ring-1 ring-line-subtle">
        <motion.span
          initial={{ width: 0 }}
          whileInView={{ width: `${pct}%` }}
          viewport={{ once: true }}
          transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
          className="absolute inset-y-0 left-0 rounded-full bg-brand-gradient"
        />
      </span>
      {showValue && (
        <span className="font-mono text-xs text-nebula-violet">{pct}</span>
      )}
    </span>
  )
}
