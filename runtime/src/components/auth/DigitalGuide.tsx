/**
 * DigitalGuide —— 灵枢/星云数字人接引卡（M7-a）。
 *
 * 按当前步骤展示双人格引导语（自动轮换 + 手动切换），文字接引先行，
 * 为后续语音入口（voice.sessionStart）立人设与文案体系。
 */
import { useEffect, useState } from 'react'
import { Bot, Sparkles } from 'lucide-react'
import { PERSONA_META, type GuideLine } from './guideCopy'
import { cn } from '@/lib/utils'

export default function DigitalGuide({ lines, compact = false }: { lines: GuideLine[]; compact?: boolean }) {
  const [idx, setIdx] = useState(0)
  useEffect(() => {
    setIdx(0)
    if (lines.length <= 1) return
    const t = setInterval(() => setIdx((i) => (i + 1) % lines.length), 6000)
    return () => clearInterval(t)
  }, [lines])
  if (lines.length === 0) return null
  const cur = lines[Math.min(idx, lines.length - 1)]
  const meta = PERSONA_META[cur.persona]
  const isLingshu = cur.persona === 'lingshu'

  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-2xl border px-4 py-3 transition-colors',
        isLingshu ? 'border-pulse-cyan/30 bg-pulse-cyan/[0.05]' : 'border-forge-amber/30 bg-forge-amber/[0.05]',
        compact && 'px-3 py-2.5',
      )}
    >
      <div
        className={cn(
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border',
          isLingshu ? 'border-pulse-cyan/40 bg-pulse-cyan/10 text-pulse-cyan' : 'border-forge-amber/40 bg-forge-amber/10 text-forge-amber',
        )}
      >
        {isLingshu ? <Bot className="h-5 w-5" /> : <Sparkles className="h-5 w-5" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={cn('text-sm font-semibold', isLingshu ? 'text-pulse-cyan' : 'text-forge-amber')}>{meta.name}</span>
          <span className="text-[11px] text-ink-faint">{meta.title}</span>
          {lines.length > 1 && (
            <span className="ml-auto flex gap-1">
              {lines.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  aria-label={`切换到接引语 ${i + 1}`}
                  onClick={() => setIdx(i)}
                  className={cn('h-1.5 w-1.5 rounded-full', i === idx ? 'bg-ink-secondary' : 'bg-ink-faint/40')}
                />
              ))}
            </span>
          )}
        </div>
        <p className={cn('mt-1 leading-relaxed text-ink-secondary', compact ? 'text-xs' : 'text-[13px]')}>{cur.text}</p>
      </div>
    </div>
  )
}
