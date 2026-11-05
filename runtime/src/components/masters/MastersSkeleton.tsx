import { AlertTriangle, RefreshCcw } from 'lucide-react'

/** 加载骨架屏：脉冲玻璃卡片 */
export function MastersSkeleton({ cards = 6, className }: { cards?: number; className?: string }) {
  return (
    <div className={className ?? 'grid gap-5 md:grid-cols-2 xl:grid-cols-3'}>
      {Array.from({ length: cards }).map((_, i) => (
        <div key={i} className="glass-panel animate-pulse rounded-2xl p-6" style={{ animationDelay: `${i * 90}ms` }}>
          <div className="flex items-center gap-4">
            <div className="h-14 w-14 rounded-2xl bg-panel" />
            <div className="flex-1 space-y-2">
              <div className="h-2.5 w-16 rounded bg-panel" />
              <div className="h-4 w-3/4 rounded bg-panel" />
              <div className="h-3 w-1/2 rounded bg-panel" />
            </div>
          </div>
          <div className="mt-5 grid grid-cols-3 gap-3 border-t border-line-subtle pt-4">
            {[0, 1, 2].map((j) => (
              <div key={j} className="space-y-2">
                <div className="h-2.5 w-10 rounded bg-panel" />
                <div className="h-5 w-14 rounded bg-panel" />
              </div>
            ))}
          </div>
          <div className="mt-4 h-2 w-full rounded-full bg-panel" />
        </div>
      ))}
    </div>
  )
}

/** 看板骨架屏 */
export function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="glass-panel animate-pulse rounded-2xl p-8">
        <div className="flex items-center gap-5">
          <div className="h-20 w-20 rounded-2xl bg-panel" />
          <div className="flex-1 space-y-3">
            <div className="h-2.5 w-24 rounded bg-panel" />
            <div className="h-6 w-64 max-w-full rounded bg-panel" />
            <div className="h-3.5 w-40 rounded bg-panel" />
          </div>
          <div className="hidden space-y-2 md:block">
            <div className="h-2.5 w-20 rounded bg-panel" />
            <div className="h-10 w-40 rounded bg-panel" />
          </div>
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className="glass-panel h-56 animate-pulse rounded-2xl bg-panel/40" style={{ animationDelay: `${i * 120}ms` }} />
        ))}
      </div>
      <MastersSkeleton cards={3} />
    </div>
  )
}

/** 失败降级：错误提示 + 重试 */
export function LoadError({ message, onRetry }: { message?: string; onRetry: () => void }) {
  return (
    <div className="glass-panel flex flex-col items-center gap-4 rounded-2xl border-ember-red/30 px-6 py-14 text-center">
      <AlertTriangle className="h-7 w-7 text-ember-red" />
      <p className="text-sm text-ink-secondary">
        数据接入失败{message ? `：${message}` : '，请稍后重试'}
      </p>
      <button
        onClick={onRetry}
        className="inline-flex items-center gap-2 rounded-full border border-pulse-cyan/40 px-4 py-1.5 text-xs text-pulse-cyan transition-colors hover:bg-pulse-cyan/10"
      >
        <RefreshCcw className="h-3.5 w-3.5" /> 重新加载
      </button>
    </div>
  )
}
