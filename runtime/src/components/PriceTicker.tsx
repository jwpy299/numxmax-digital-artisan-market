import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { cn } from '@/lib/utils'

interface PriceTickerProps {
  value: number
  prefix?: string
  suffix?: string
  className?: string
  /** auto-fluctuate the price every `intervalMs` (demo live pricing) */
  live?: boolean
  intervalMs?: number
}

export default function PriceTicker({
  value,
  prefix = '¥',
  suffix = '/月',
  className,
  live = false,
  intervalMs = 2000,
}: PriceTickerProps) {
  const [display, setDisplay] = useState(value)
  const [prevValue, setPrevValue] = useState(value)

  // adjust during render when the prop changes (no effect needed)
  if (prevValue !== value) {
    setPrevValue(value)
    setDisplay(value)
  }

  useEffect(() => {
    if (!live) return
    const t = setInterval(() => {
      setDisplay((v) => Math.max(0, Math.round(v + (Math.random() - 0.45) * 120)))
    }, intervalMs)
    return () => clearInterval(t)
  }, [live, intervalMs])

  return (
    <span className={cn('inline-flex items-baseline font-mono font-medium text-forge-amber', className)}>
      <span className="mr-0.5 text-[0.75em]">{prefix}</span>
      <span className="relative inline-block overflow-hidden align-baseline">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={display}
            initial={{ y: '100%', opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: '-100%', opacity: 0 }}
            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            className="inline-block tabular-nums"
          >
            {display.toLocaleString('zh-CN')}
          </motion.span>
        </AnimatePresence>
      </span>
      {suffix && <span className="ml-0.5 text-[0.7em] text-ink-faint">{suffix}</span>}
    </span>
  )
}
