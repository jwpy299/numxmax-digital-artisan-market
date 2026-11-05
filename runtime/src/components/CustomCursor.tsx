import { useEffect, useState } from 'react'
import { motion, useMotionValue, useSpring } from 'framer-motion'

/**
 * Custom cursor (desktop, pointer:fine only):
 * 12px cyan dot follows instantly; 36px ring trails with inertia;
 * ring grows to 56px over interactive elements.
 */
export default function CustomCursor() {
  const [enabled] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches,
  )
  const [hovering, setHovering] = useState(false)
  const [label, setLabel] = useState<string | null>(null)

  const dotX = useMotionValue(-100)
  const dotY = useMotionValue(-100)
  const ringX = useSpring(dotX, { stiffness: 260, damping: 26, mass: 0.6 })
  const ringY = useSpring(dotY, { stiffness: 260, damping: 26, mass: 0.6 })

  useEffect(() => {
    if (!enabled) return
    document.body.classList.add('custom-cursor-active')

    const onMove = (e: MouseEvent) => {
      dotX.set(e.clientX)
      dotY.set(e.clientY)
    }
    const onOver = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      const interactive = t?.closest('a, button, [role="button"], input, textarea, select, [data-cursor]')
      setHovering(!!interactive)
      setLabel(interactive?.getAttribute('data-cursor') ?? null)
    }
    window.addEventListener('mousemove', onMove, { passive: true })
    window.addEventListener('mouseover', onOver, { passive: true })
    return () => {
      document.body.classList.remove('custom-cursor-active')
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseover', onOver)
    }
  }, [enabled, dotX, dotY])

  if (!enabled) return null

  return (
    <>
      <motion.div
        aria-hidden
        className="pointer-events-none fixed left-0 top-0 z-[100] h-3 w-3 rounded-full bg-pulse-cyan"
        style={{ x: dotX, y: dotY, translateX: '-50%', translateY: '-50%' }}
      />
      <motion.div
        aria-hidden
        className="pointer-events-none fixed left-0 top-0 z-[100] flex items-center justify-center rounded-full border border-pulse-cyan/70"
        style={{ x: ringX, y: ringY, translateX: '-50%', translateY: '-50%' }}
        animate={{
          width: hovering ? 56 : 36,
          height: hovering ? 56 : 36,
          backgroundColor: hovering ? 'rgba(34,211,238,0.08)' : 'rgba(34,211,238,0)',
        }}
        transition={{ type: 'spring', stiffness: 350, damping: 24 }}
      >
        {hovering && label && (
          <span className="font-mono text-[9px] tracking-widest text-pulse-cyan">{label}</span>
        )}
      </motion.div>
    </>
  )
}
