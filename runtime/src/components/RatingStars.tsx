import { useState } from 'react'
import { Star, StarHalf } from 'lucide-react'
import { cn } from '@/lib/utils'

interface RatingStarsProps {
  rating: number
  className?: string
  showValue?: boolean
}

export default function RatingStars({ rating, className, showValue = true }: RatingStarsProps) {
  const [hover, setHover] = useState(false)
  const full = Math.floor(rating)
  const half = rating - full >= 0.5

  return (
    <span
      className={cn('relative inline-flex items-center gap-0.5', className)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {Array.from({ length: 5 }).map((_, i) => {
        if (i < full) return <Star key={i} className="h-3.5 w-3.5 fill-forge-amber text-forge-amber" />
        if (i === full && half) {
          return (
            <span key={i} className="relative inline-flex">
              <Star className="h-3.5 w-3.5 text-ink-faint/50" />
              <StarHalf className="absolute inset-0 h-3.5 w-3.5 fill-forge-amber text-forge-amber" />
            </span>
          )
        }
        return <Star key={i} className="h-3.5 w-3.5 text-ink-faint/50" />
      })}
      {showValue && <span className="ml-1 font-grotesk text-xs text-ink-secondary">{rating.toFixed(1)}</span>}
      {hover && (
        <span className="absolute -top-7 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md glass-panel px-2 py-0.5 font-mono text-[10px] text-forge-amber">
          {rating.toFixed(2)} / 5.0
        </span>
      )}
    </span>
  )
}
