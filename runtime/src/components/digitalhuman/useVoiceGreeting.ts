import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export interface VoiceGreeting {
  speak: (text: string) => void
  speaking: boolean
  supported: boolean
  stop: () => void
}

const RATE = 1.0
const PITCH = 1.1

function pickChineseFemaleVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | undefined {
  const zh = voices.filter((v) => v.lang.toLowerCase().startsWith('zh'))
  if (zh.length === 0) return undefined
  // Prefer mainland zh-CN female voices by common vendor naming.
  const female = zh.find((v) => /xiaoxiao|xiaoyi|female|女|ting|hui|mei/i.test(v.name))
  return female ?? zh.find((v) => v.lang === 'zh-CN') ?? zh[0]
}

/**
 * Speech-synthesis greeting hook. Degrades gracefully when the
 * browser lacks support (supported=false; callers show a text bubble).
 */
export function useVoiceGreeting(): VoiceGreeting {
  const supported = useMemo(
    () => typeof window !== 'undefined' && 'speechSynthesis' in window,
    [],
  )
  const [speaking, setSpeaking] = useState(false)
  const utterRef = useRef<SpeechSynthesisUtterance | null>(null)

  // Cancel any in-flight utterance on unmount.
  useEffect(() => {
    if (!supported) return
    return () => {
      window.speechSynthesis.cancel()
    }
  }, [supported])

  const speak = useCallback(
    (text: string) => {
      if (!supported || !text) return
      const synth = window.speechSynthesis
      synth.cancel()

      const utter = new SpeechSynthesisUtterance(text)
      utter.lang = 'zh-CN'
      utter.rate = RATE
      utter.pitch = PITCH

      const applyVoice = () => {
        const voice = pickChineseFemaleVoice(synth.getVoices())
        if (voice) utter.voice = voice
      }
      applyVoice()
      // Some browsers load the voice list asynchronously.
      if (synth.getVoices().length === 0) {
        synth.addEventListener('voiceschanged', applyVoice, { once: true })
      }

      utter.onstart = () => setSpeaking(true)
      utter.onend = () => setSpeaking(false)
      utter.onerror = () => setSpeaking(false)

      utterRef.current = utter
      synth.speak(utter)
    },
    [supported],
  )

  const stop = useCallback(() => {
    if (!supported) return
    window.speechSynthesis.cancel()
    utterRef.current = null
    setSpeaking(false)
  }, [supported])

  return { speak, speaking, supported, stop }
}

export default useVoiceGreeting
