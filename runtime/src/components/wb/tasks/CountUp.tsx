import { useEffect, useRef, useState } from 'react'
import { animate, useInView } from 'framer-motion'

interface CountUpProps {
  value: number
  duration?: number
  format?: (n: number) => string
  className?: string
}

/** 数字滚动计数（1.2s easeOutExpo，进入视口时触发） */
export default function CountUp({ value, duration = 1.2, format, className }: CountUpProps) {
  const ref = useRef<HTMLSpanElement>(null)
  const inView = useInView(ref, { once: true, margin: '-40px' })
  const [display, setDisplay] = useState(0)

  useEffect(() => {
    if (!inView) return
    const controls = animate(0, value, {
      duration,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => setDisplay(v),
    })
    return () => controls.stop()
  }, [inView, value, duration])

  const fmt = format ?? ((n: number) => Math.round(n).toLocaleString('zh-CN'))
  return (
    <span ref={ref} className={className}>
      {fmt(display)}
    </span>
  )
}
