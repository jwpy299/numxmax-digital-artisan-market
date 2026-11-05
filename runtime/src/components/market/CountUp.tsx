import { useEffect, useRef, useState } from 'react'

/** Count-up number animation (easeOutExpo, ~1.2s) */
export default function CountUp({
  value,
  duration = 1200,
  decimals = 0,
  className,
}: {
  value: number
  duration?: number
  decimals?: number
  className?: string
}) {
  const [display, setDisplay] = useState(0)
  const fromRef = useRef(0)

  useEffect(() => {
    const from = fromRef.current
    let start: number | null = null
    let raf = 0
    const tick = (t: number) => {
      if (start === null) start = t
      const p = Math.min(1, (t - start) / duration)
      const eased = p === 1 ? 1 : 1 - Math.pow(2, -10 * p)
      setDisplay(from + (value - from) * eased)
      if (p < 1) raf = requestAnimationFrame(tick)
      else fromRef.current = value
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value, duration])

  return (
    <span className={className}>
      {display.toLocaleString('zh-CN', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })}
    </span>
  )
}
