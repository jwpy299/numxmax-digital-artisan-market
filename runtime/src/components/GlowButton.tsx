import { motion } from 'framer-motion'
import { Link } from 'react-router'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface GlowButtonProps {
  children: ReactNode
  to?: string
  href?: string
  variant?: 'primary' | 'secondary'
  className?: string
  onClick?: () => void
}

/** primary: amber gradient + hover glow sweep; secondary: outline + hover fill 8% */
export default function GlowButton({ children, to, href, variant = 'primary', className, onClick }: GlowButtonProps) {
  const inner = (
    <>
      {variant === 'primary' && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/30 to-transparent transition-transform duration-700 ease-out group-hover:translate-x-full"
        />
      )}
      <span className="relative z-10 inline-flex items-center gap-2">{children}</span>
    </>
  )

  const classes = cn(
    'group relative inline-flex items-center justify-center overflow-hidden rounded-[10px] px-6 py-3 text-sm font-medium transition-shadow duration-300',
    variant === 'primary'
      ? 'bg-amber-gradient text-[#1A1206] hover:shadow-[0_0_28px_rgba(245,165,36,0.45)]'
      : 'border border-line-subtle text-ink-primary hover:border-pulse-cyan/50 hover:bg-pulse-cyan/[0.08]',
    className,
  )

  const motionProps = {
    whileHover: { scale: 1.03 },
    whileTap: { scale: 0.97 },
    transition: { type: 'spring' as const, stiffness: 400, damping: 22 },
    className: classes,
    onClick,
  }

  if (to) {
    return (
      <motion.div {...motionProps} className={cn(classes, 'p-0')}>
        <Link to={to} className="relative flex w-full items-center justify-center overflow-hidden rounded-[10px] px-6 py-3">
          {inner}
        </Link>
      </motion.div>
    )
  }
  if (href) {
    return (
      <motion.a href={href} {...motionProps}>
        {inner}
      </motion.a>
    )
  }
  return <motion.button {...motionProps}>{inner}</motion.button>
}
