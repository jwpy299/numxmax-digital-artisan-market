import { cn } from '@/lib/utils'

/** 8px L-shaped HUD corner brackets for instrument-panel feel */
export default function HudCorner({ className }: { className?: string }) {
  const base = 'pointer-events-none absolute h-2 w-2 border-pulse-cyan/60'
  return (
    <span aria-hidden className={cn('pointer-events-none absolute inset-0', className)}>
      <span className={cn(base, 'left-0 top-0 border-l border-t')} />
      <span className={cn(base, 'right-0 top-0 border-r border-t')} />
      <span className={cn(base, 'bottom-0 left-0 border-b border-l')} />
      <span className={cn(base, 'bottom-0 right-0 border-b border-r')} />
    </span>
  )
}
