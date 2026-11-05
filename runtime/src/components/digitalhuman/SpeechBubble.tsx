import { useEffect, useRef, useState } from 'react'

export interface SpeechBubbleProps {
  text: string
  visible: boolean
  className?: string
}

const TYPE_INTERVAL_MS = 36

/**
 * Dark glassmorphism speech/text bubble with a typewriter reveal.
 * Falls back gracefully: renders nothing while not visible.
 */
export function SpeechBubble({ text, visible, className }: SpeechBubbleProps) {
  const [shown, setShown] = useState('')
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Reset the typewriter when text/visibility changes (adjust-during-render
  // pattern, avoids synchronous setState inside effects).
  const [prevKey, setPrevKey] = useState({ text, visible })
  if (prevKey.text !== text || prevKey.visible !== visible) {
    setPrevKey({ text, visible })
    setShown('')
  }

  useEffect(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    if (!visible) return
    let i = 0
    timerRef.current = setInterval(() => {
      i += 1
      setShown(text.slice(0, i))
      if (i >= text.length && timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }, TYPE_INTERVAL_MS)
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
  }, [text, visible])

  if (!visible) return null

  const typing = shown.length < text.length

  return (
    <div
      role="status"
      aria-live="polite"
      className={[
        'relative max-w-xs rounded-2xl border border-forge-amber/50',
        'bg-void/70 px-4 py-3 backdrop-blur-md',
        'shadow-[0_0_24px_rgba(245,165,36,0.18)]',
        'text-sm leading-relaxed text-amber-50/90',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {/* bubble tail */}
      <span
        aria-hidden
        className="absolute -bottom-2 left-8 h-4 w-4 rotate-45 border-b border-r border-forge-amber/50 bg-void/70 backdrop-blur-md"
      />
      <span className="mr-2 inline-block h-1.5 w-1.5 rounded-full bg-pulse-cyan align-middle shadow-[0_0_8px_rgba(34,211,238,0.9)]" />
      {shown}
      {typing && (
        <span aria-hidden className="ml-0.5 inline-block h-3.5 w-[2px] animate-pulse bg-forge-amber align-middle" />
      )}
      {/* AI 生成内容标识（合规要求） */}
      <span className="pointer-events-none absolute bottom-1 right-2 text-[10px] text-amber-50/60 opacity-50">
        AI 生成
      </span>
    </div>
  )
}

export default SpeechBubble
