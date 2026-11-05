/**
 * WorkcardBits —— 工牌卡共享小件（波二·门户 UI 改造，按彭总已批设计稿）。
 *
 * CertBadge：智造研究院认证标（certified=1 才显——IdentityCard 体系同源）；
 * HireCtas：卡底固定「雇佣 / 先试岗」双钮（雇佣琥珀实心、试岗描边——设计稿形态；
 *           hover overlay 时代退役，按钮常驻不藏）。
 */
import { Link } from 'react-router'
import { BadgeCheck, FlaskConical } from 'lucide-react'
import { cn } from '@/lib/utils'

/** 认证标：NumX Max 智造研究院 认证 */
export function CertBadge({ certified, className }: { certified?: boolean; className?: string }) {
  if (!certified) return null
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border border-forge-amber/40 bg-forge-amber/10 px-2 py-0.5 text-[10.5px] font-medium text-forge-amber',
        className,
      )}
    >
      <BadgeCheck className="h-3 w-3" />
      智造研究院 认证
    </span>
  )
}

/** 雇佣/先试岗双钮（卡底固定） */
export function HireCtas({ routeId, compact }: { routeId: string; compact?: boolean }) {
  const h = compact ? 'h-10' : 'h-11'
  return (
    <div className="mt-4 flex gap-2">
      <Link
        to={`/market/agent/${routeId}#hire`}
        className={cn(
          'flex flex-1 items-center justify-center rounded-[10px] bg-amber-gradient text-sm font-semibold text-[#1A1206] transition-transform hover:scale-[1.02]',
          h,
        )}
      >
        雇佣
      </Link>
      <Link
        to={`/market/agent/${routeId}#trial`}
        className={cn(
          'flex flex-1 items-center justify-center gap-1.5 rounded-[10px] border border-forge-amber/50 bg-forge-amber/[0.06] text-sm font-semibold text-forge-amber transition-colors hover:bg-forge-amber/[0.12]',
          h,
        )}
      >
        <FlaskConical className="h-4 w-4" /> 先试岗
      </Link>
    </div>
  )
}
