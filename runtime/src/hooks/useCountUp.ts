import { useEffect, useRef, useState } from 'react'

const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t))

interface CountUpOptions {
  duration?: number
  delay?: number
  decimals?: number
  /** when false, the counter stays at 0 */
  started?: boolean
}

/** count-up with easeOutExpo; returns formatted string */
export function useCountUp(target: number, { duration = 1.6, delay = 0, decimals = 0, started = true }: CountUpOptions = {}) {
  const [value, setValue] = useState(0)
  const rafRef = useRef(0)

  useEffect(() => {
    if (!started) return
    let begin: number | null = null
    const timer = window.setTimeout(() => {
      const step = (now: number) => {
        if (begin === null) begin = now
        const t = Math.min(1, (now - begin) / (duration * 1000))
        setValue(target * easeOutExpo(t))
        if (t < 1) rafRef.current = requestAnimationFrame(step)
      }
      rafRef.current = requestAnimationFrame(step)
    }, delay * 1000)
    return () => {
      clearTimeout(timer)
      cancelAnimationFrame(rafRef.current)
    }
  }, [target, duration, delay, started])

  return value.toLocaleString('zh-CN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}
