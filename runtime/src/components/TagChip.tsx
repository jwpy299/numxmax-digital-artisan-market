import { cn } from '@/lib/utils'

interface TagChipProps {
  label: string
  className?: string
}

export default function TagChip({ label, className }: TagChipProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border border-pulse-cyan/40 px-3 py-1 text-xs text-pulse-cyan',
        'transition-colors duration-300 hover:bg-pulse-cyan/15 cursor-default',
        className,
      )}
    >
      {label}
    </span>
  )
}
