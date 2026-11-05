/**
 * NumX Max 智能客服 —— 全局悬浮客服组件。
 *
 * 合规与真实性约束：
 * - 回答由后端生成：优先四大模型联网生成（标注 AI生成），失败回退确定性意图路由（标注 确定性回答）；
 *   语音朗读（speechSynthesis）与语音输入（SpeechRecognition）均为浏览器能力，
 *   UI 文案明确标注；外部 TTS 未接入，如实声明。
 * - token 仅放请求体：从 localStorage("nebula_auth") 读取会话，无会话则匿名调用。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router'
import {
  Loader2,
  Mic,
  Send,
  UserRoundCheck,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
// iter95：3D 数字人（three ~880KB）下线，改用灵枢 IP 静态形象（/ip/*.png）；SpeechBubble 为纯 DOM，保留
import { SpeechBubble } from '@/components/digitalhuman/SpeechBubble'
import { trpc } from '@/providers/trpc'
import { loadWbSession } from '@/lib/wbSession'

// ─── 浏览器语音识别类型（TS DOM lib 未内置，最小化声明）───────────────────────
interface SpeechRecognitionResultList {
  readonly length: number
  [index: number]: {
    readonly length: number
    isFinal?: boolean
    [index: number]: { transcript: string }
  }
}
interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((ev: { resultIndex?: number; results: SpeechRecognitionResultList }) => void) | null
  onend: (() => void) | null
  onerror: ((ev?: { error?: string }) => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as Record<string, unknown>
  const ctor = (w.SpeechRecognition ?? w.webkitSpeechRecognition) as SpeechRecognitionCtor | undefined
  return typeof ctor === 'function' ? ctor : null
}

// ─── 消息模型 ────────────────────────────────────────────────────────────────
interface ChatLink {
  label: string
  to: string
}
interface ChatMessage {
  id: number
  role: 'user' | 'assistant'
  text: string
  suggestions?: string[]
  links?: ChatLink[]
  /** 生成来源标记（仅 ask 回答设置；欢迎/引导/人工接管消息不展示） */
  llmUsed?: boolean
  generatedBy?: { provider: string; label: string; model: string } | null
}

/** 合规快捷提问：后端 quickPrompts 基础上兜底补齐（后端文案不改动） */
const REQUIRED_PROMPTS = [
  'NumX Max 是做什么的？',
  '新用户怎么开始？',
  '怎么跳智能工作台？',
  '30 秒人工确认是什么？',
] as const

// ─── 访客会话 ID（localStorage 'nebula_cs_sid'，16 位随机串，迭代 28）──────────
const CS_SID_KEY = 'nebula_cs_sid'

function getCsSessionId(): string {
  try {
    const existing = localStorage.getItem(CS_SID_KEY)
    if (existing && /^[a-z0-9]{16}$/i.test(existing)) return existing
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
    const buf = new Uint8Array(16)
    crypto.getRandomValues(buf)
    const sid = Array.from(buf, (b) => chars[b % chars.length]).join('')
    localStorage.setItem(CS_SID_KEY, sid)
    return sid
  } catch {
    return ''
  }
}

// ─── 灵枢 IP 形象（M15 Q版3D熊猫 /ip/m15/*.png，加载失败静默降级：隐藏 img，保留底色容器）──────
const LINGSHU = {
  wave: '/ip/m15/lingshu-wave.png',
  think: '/ip/m15/lingshu-think.png',
} as const

function LingshuImg({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return null
  return (
    <img
      src={src}
      alt={alt}
      draggable={false}
      loading="lazy"
      onError={() => setFailed(true)}
      className={className}
    />
  )
}

function mergeQuickPrompts(remote: string[] | undefined): string[] {
  const out: string[] = []
  for (const p of [...REQUIRED_PROMPTS, ...(remote ?? [])]) {
    if (!out.includes(p)) out.push(p)
  }
  return out.slice(0, 8)
}

export default function AssistantWidget() {
  const location = useLocation()
  const path = location.pathname

  const [open, setOpen] = useState(false)
  // 语音朗读默认关闭：仅在用户主动点击喇叭开启后才 speak，避免自动播放骚扰
  const [voiceOn, setVoiceOn] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [listening, setListening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [handoffDone, setHandoffDone] = useState(false)
  // 数字人「小星」：气泡文本（最新一条 AI 回复）+ 说话动画状态
  const [bubbleText, setBubbleText] = useState<string | null>(null)
  const [speaking, setSpeaking] = useState(false)

  const idRef = useRef(1)
  const voiceOnRef = useRef(voiceOn)
  const welcomedRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const pressAtRef = useRef(0)
  const holdStopRef = useRef(false)
  // M13.5 贾维斯模式（持续聆听）：'portal:open-buddy' 唤起后 continuous 识别，
  // 浏览器会话 onend 时若面板仍开且模式仍开则自动重启；final 文本直接走发送链路
  const [jarvis, setJarvis] = useState(false)
  const jarvisRef = useRef(false)
  const openRef = useRef(open)
  /** M13.5 入场唤起：本轮欢迎语只上屏不朗读（入场欢迎语未播完，speak 内 cancel 会截断它） */
  const silentGreetingRef = useRef(false)

  // 同步朗读开关到 ref（speak 回调中读取，避免闭包旧值）；渲染期不写 ref
  useEffect(() => {
    voiceOnRef.current = voiceOn
  }, [voiceOn])

  // 同步面板开关到 ref（识别器 onend 回调中读取，避免闭包旧值）
  useEffect(() => {
    openRef.current = open
  }, [open])

  // token 仅在请求体：从 localStorage("nebula_auth") 读取，无则匿名
  const token = useMemo(() => loadWbSession()?.token, [open, path])
  // 访客会话 ID：首次访问生成并持久化，ask 时随请求体回传用于会话留痕
  const sessionId = useMemo(() => getCsSessionId(), [])

  const speechSupported = typeof window !== 'undefined' && 'speechSynthesis' in window
  const recognitionCtor = useMemo(() => getSpeechRecognitionCtor(), [])

  // ─── 浏览器语音朗读（speechSynthesis，zh-CN；切换/新消息时 cancel 旧朗读）───
  const speak = useCallback(
    (text: string) => {
      if (!speechSupported) return
      window.speechSynthesis.cancel()
      if (!voiceOnRef.current || !text) return
      const utter = new SpeechSynthesisUtterance(text)
      utter.lang = 'zh-CN'
      utter.rate = 1
      utter.pitch = 1
      window.speechSynthesis.speak(utter)
    },
    [speechSupported],
  )

  const stopSpeaking = useCallback(() => {
    if (speechSupported) window.speechSynthesis.cancel()
  }, [speechSupported])

  // ─── 数字人「小星」：AI 回复时驱动说话动画 + 打字机气泡 ───────────────────
  const showBubble = useCallback((text: string) => {
    if (!text) return
    setBubbleText(text)
    setSpeaking(true)
  }, [])

  // 关闭面板 / 组件卸载时停止朗读与识别（含贾维斯持续聆听）
  useEffect(() => {
    if (!open) {
      jarvisRef.current = false
      stopSpeaking()
      recognitionRef.current?.abort()
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 面板关闭是与浏览器识别会话同步的安全网，需兜底重置聆听状态
      setListening(false)
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 同上：随面板关闭退出持续聆听模式
      setJarvis(false)
    }
  }, [open, stopSpeaking])
  useEffect(
    () => () => {
      stopSpeaking()
      recognitionRef.current?.abort()
    },
    [stopSpeaking],
  )

  // ─── 后端契约 ──────────────────────────────────────────────────────────────
  const welcomeQuery = trpc.assistant.welcome.useQuery(
    { token, path },
    { enabled: open, staleTime: 60_000, retry: 1 },
  )
  const askMutation = trpc.assistant.ask.useMutation()
  const handoffMutation = trpc.assistant.handoff.useMutation()

  // 首次打开注入欢迎消息（打开面板是用户手势，此后允许触发浏览器朗读）
  useEffect(() => {
    if (!open || welcomedRef.current || !welcomeQuery.data) return
    welcomedRef.current = true
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 欢迎消息由后端异步返回，属外部系统同步，需注入消息流
    setError(null)
    setMessages([
      {
        id: idRef.current++,
        role: 'assistant',
        text: welcomeQuery.data.welcome,
        suggestions: mergeQuickPrompts(welcomeQuery.data.quickPrompts).slice(0, 4),
        links: welcomeQuery.data.guide.slice(0, 2).map((g) => ({ label: g.title, to: g.to })),
      },
    ])
    // 入场唤起（speakGreeting===false）当轮：欢迎语只上屏不朗读（消费一次性标记），手动打开照常
    if (silentGreetingRef.current) {
      silentGreetingRef.current = false
    } else {
      speak(welcomeQuery.data.welcome)
    }
    showBubble(welcomeQuery.data.welcome)
  }, [open, welcomeQuery.data, speak, showBubble])

  // welcome 查询失败 → 错误条（不静默）
  useEffect(() => {
    if (open && welcomeQuery.error) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 查询错误来自后端异步结果，需同步到错误条
      setError(`客服服务暂时不可用：${welcomeQuery.error.message}`)
    }
  }, [open, welcomeQuery.error])

  // 新消息滚动到底部
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, open])

  const pushMessage = useCallback((msg: Omit<ChatMessage, 'id'>) => {
    setMessages((prev) => [...prev, { ...msg, id: idRef.current++ }])
  }, [])

  useEffect(() => {
    if (!bubbleText) return
    const typeMs = Math.min(bubbleText.length * 40 + 400, 8000)
    const speakTimer = setTimeout(() => setSpeaking(false), typeMs)
    const hideTimer = setTimeout(() => setBubbleText(null), typeMs + 5000)
    return () => {
      clearTimeout(speakTimer)
      clearTimeout(hideTimer)
    }
  }, [bubbleText])

  // 关闭面板：同时收起数字人气泡并停止说话动画（事件处理器中 setState，避免 effect 级联渲染）
  const closePanel = useCallback(() => {
    setOpen(false)
    setBubbleText(null)
    setSpeaking(false)
  }, [])

  // ─── 发送提问（v168 流式优先：SSE 首字 1s 级逐字上屏；EventSource 不可用/建连失败回落原 mutation）──
  const [streaming, setStreaming] = useState(false)
  const sending = askMutation.isPending || streaming
  const sendMessage = useCallback(
    (raw: string) => {
      const message = raw.trim()
      if (!message || sending) return
      setInput('')
      setError(null)
      pushMessage({ role: 'user', text: message })

      const fallbackAsk = () => {
        askMutation.mutate(
          { token, message, path, sessionId } as Parameters<typeof askMutation.mutate>[0],
          {
            onSuccess: (res) => {
              pushMessage({
                role: 'assistant',
                text: res.answer,
                suggestions: res.suggestions,
                links: res.links,
                llmUsed: res.llmUsed,
                generatedBy: res.generatedBy,
              })
              speak(res.speak)
              showBubble(res.answer)
            },
            onError: (err) => {
              setError(`回答失败：${err.message}。请稍后重试或改问其他问题。`)
            },
          },
        )
      }

      if (typeof EventSource === 'undefined') { fallbackAsk(); return }
      // 流式：入参走 query（与 duty-chat 同一例外口径）；delta 帧为增量片段追加到最后一条
      const qs = new URLSearchParams({ message })
      if (token) qs.set('token', token)
      if (path) qs.set('path', path)
      if (sessionId) qs.set('sessionId', sessionId)
      const es = new EventSource(`/api/stream/assistant-ask?${qs.toString()}`)
      setStreaming(true)
      let gotDelta = false
      let opened = false
      es.onopen = () => { opened = true }
      es.addEventListener('delta', (e) => {
        try {
          const { text } = JSON.parse((e as MessageEvent).data) as { text?: string }
          if (!text) return
          if (!gotDelta) {
            gotDelta = true
            pushMessage({ role: 'assistant', text })
          } else {
            setMessages((prev) => prev.map((m, i) => (i === prev.length - 1 && m.role === 'assistant' ? { ...m, text: m.text + text } : m)))
          }
        } catch { /* 坏帧忽略 */ }
      })
      es.addEventListener('done', (e) => {
        es.close()
        setStreaming(false)
        try {
          const res = JSON.parse((e as MessageEvent).data) as {
            answer: string; suggestions?: ChatMessage['suggestions']; links?: ChatMessage['links']
            speak?: string; llmUsed?: boolean; generatedBy?: ChatMessage['generatedBy']
          }
          if (gotDelta) {
            // 流式已上屏：只补建议/链接/朗读
            setMessages((prev) => prev.map((m, i) => (i === prev.length - 1 && m.role === 'assistant' ? { ...m, text: res.answer || m.text, suggestions: res.suggestions, links: res.links, llmUsed: res.llmUsed, generatedBy: res.generatedBy } : m)))
          } else {
            pushMessage({ role: 'assistant', text: res.answer, suggestions: res.suggestions, links: res.links, llmUsed: res.llmUsed, generatedBy: res.generatedBy })
          }
          if (res.speak) speak(res.speak)
          showBubble(res.answer)
        } catch { /* done 帧损坏时 delta 内容已在屏 */ }
      })
      es.addEventListener('error', (e) => {
        const data = (e as MessageEvent).data
        if (typeof data === 'string' && data) return // 服务端 error 帧：done(degraded) 随后收尾
        es.close()
        setStreaming(false)
        if (gotDelta) return // 已上屏内容有效，不扰动
        if (!opened) { fallbackAsk(); return } // 建连失败回落原链路
        setError('回答失败：网络中断。请稍后重试或改问其他问题。')
      })
    },
    [askMutation, path, pushMessage, sending, sessionId, showBubble, speak, token],
  )

  // 识别器回调中读取最新发送链路（避免闭包旧值）；渲染期不写 ref
  const sendMessageRef = useRef(sendMessage)
  useEffect(() => {
    sendMessageRef.current = sendMessage
  }, [sendMessage])

  // ─── M13.5 贾维斯模式：continuous 持续聆听，onend 自动重启，final 文本直接发送 ───

  const startJarvis = useCallback(() => {
    if (!recognitionCtor) return // 不支持识别的浏览器静默降级（面板仍打开，仅无持续聆听）
    jarvisRef.current = true
    setJarvis(true)
    const launch = () => {
      if (!jarvisRef.current || !openRef.current) return
      try {
        recognitionRef.current?.abort()
        const rec = new recognitionCtor()
        rec.lang = 'zh-CN'
        rec.continuous = true
        rec.interimResults = false
        rec.onresult = (ev) => {
          const finals: string[] = []
          const from = ev.resultIndex ?? 0
          for (let i = from; i < ev.results.length; i++) {
            const r = ev.results[i]
            if (r?.isFinal) {
              const t = r[0]?.transcript?.trim()
              if (t) finals.push(t)
            }
          }
          const text = finals.join('').trim()
          if (text) sendMessageRef.current(text)
        }
        rec.onend = () => {
          // 浏览器识别会话结束：面板仍开且贾维斯仍开 → 自动重启（持续聆听）
          if (jarvisRef.current && openRef.current) {
            window.setTimeout(launch, 300)
          } else {
            setListening(false)
          }
        }
        rec.onerror = (ev) => {
          const err = ev?.error
          // 权限/硬件类错误不可恢复：退出贾维斯模式；no-speech 等交给 onend 重启
          if (err === 'not-allowed' || err === 'service-not-allowed' || err === 'audio-capture') {
            jarvisRef.current = false
            setJarvis(false)
            setListening(false)
          }
        }
        recognitionRef.current = rec
        rec.start()
        setListening(true)
      } catch {
        setListening(false)
      }
    }
    launch()
  }, [recognitionCtor])

  // M13.5：数字人入场层唤起（'portal:open-buddy'，入场欢迎语播完后 dispatch）——
  // 开面板 + 开 TTS 播报 + 自动开始贾维斯持续聆听；手动打开面板的既有行为不变
  useEffect(() => {
    const onOpenBuddy = (e: Event) => {
      const detail = (e as CustomEvent).detail as { speakGreeting?: unknown } | undefined
      // speakGreeting===false：本轮欢迎语只上屏不朗读（入场欢迎语未播完，防 speak 内 cancel 截断）
      silentGreetingRef.current = detail?.speakGreeting === false
      openRef.current = true
      setOpen(true)
      setVoiceOn(true)
      startJarvis()
    }
    window.addEventListener('portal:open-buddy', onOpenBuddy)
    return () => window.removeEventListener('portal:open-buddy', onOpenBuddy)
  }, [startJarvis])

  // ─── 人工接管（handoff mutation）──────────────────────────────────────────
  const requestHandoff = useCallback(() => {
    if (handoffMutation.isPending || handoffDone) return
    setError(null)
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    handoffMutation.mutate(
      { token, message: lastUser?.text },
      {
        onSuccess: (res) => {
          setHandoffDone(true)
          pushMessage({
            role: 'assistant',
            text: `${res.message}。登记单号：${res.ticket}。人工专员复核后会跟进处理，你也可以继续向我提问。`,
          })
          speak('已为你登记人工接管，人工专员复核后会跟进处理。')
          showBubble('已为你登记人工接管，人工专员复核后会跟进处理。')
        },
        onError: (err) => {
          setError(`人工接管登记失败：${err.message}。请稍后重试。`)
        },
      },
    )
  }, [handoffMutation, handoffDone, messages, pushMessage, showBubble, speak, token])

  // ─── 语音输入（浏览器 SpeechRecognition，点击切换 / 按住说话）──────────────
  const startListening = useCallback(() => {
    if (!recognitionCtor) return
    // 手动点按/按住说话优先：退出贾维斯持续聆听，回到单次模式
    jarvisRef.current = false
    setJarvis(false)
    try {
      recognitionRef.current?.abort()
      const rec = new recognitionCtor()
      rec.lang = 'zh-CN'
      rec.continuous = false
      rec.interimResults = false
      rec.onresult = (ev) => {
        const transcript = Array.from({ length: ev.results.length })
          .map((_, i) => ev.results[i][0]?.transcript ?? '')
          .join('')
          .trim()
        if (transcript) setInput((prev) => (prev ? `${prev}${transcript}` : transcript))
      }
      rec.onend = () => setListening(false)
      rec.onerror = () => setListening(false)
      recognitionRef.current = rec
      rec.start()
      setListening(true)
    } catch {
      setListening(false)
    }
  }, [recognitionCtor])

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop()
  }, [])

  // 按住说话：pointerup 时若按压超过 350ms 则停止（按住模式）；
  // 短按交给 onClick 切换（点击模式）。
  const onMicPointerDown = () => {
    pressAtRef.current = Date.now()
    holdStopRef.current = false
    if (!listening) startListening()
  }
  const onMicPointerUp = () => {
    if (Date.now() - pressAtRef.current >= 350 && listening) {
      holdStopRef.current = true
      stopListening()
    }
  }
  const onMicClick = () => {
    if (holdStopRef.current) {
      holdStopRef.current = false
      return
    }
    if (listening) stopListening()
  }

  // ─── 语音开关：关闭立即 cancel 当前朗读 ────────────────────────────────────
  const toggleVoice = () => {
    setVoiceOn((v) => {
      if (v) stopSpeaking()
      return !v
    })
  }

  const welcome = welcomeQuery.data
  const quickPrompts = mergeQuickPrompts(welcome?.quickPrompts)
  // 灵枢情绪映射：思考中（连接/回答 loading）→ think；欢迎/回答完成 → wave
  const thinking = sending || welcomeQuery.isPending

  return (
    <>
      {/* 悬浮按钮（右下角，z 高于导航 z-50/移动菜单 z-[60]）：灵枢 IP 头像 */}
      {!open && (
        <button
          type="button"
          onClick={() => {
            silentGreetingRef.current = false // 手动打开：欢迎语照常朗读
            setOpen(true)
          }}
          aria-label="打开 NumX Max 智能客服"
          title="灵枢 · 点我说话"
          className="group fixed bottom-5 right-5 z-[70] flex flex-col items-center gap-1"
        >
          {/* M13.5 大号立绘入口：灵枢 wave + 玉绿光晕（图片加载失败 onError 静默隐藏，仅留文字 chip） */}
          <span className="relative flex h-24 w-16 items-center justify-center transition-transform duration-300 group-hover:-translate-y-1">
            <LingshuImg
              src={LINGSHU.wave}
              alt="灵枢"
              className="pointer-events-none h-full w-full object-contain drop-shadow-[0_0_14px_rgba(52,211,153,0.5)]"
            />
          </span>
          <span className="rounded-full border border-amber-200/20 bg-[#171310]/90 px-2 py-0.5 text-[10px] text-amber-200/70 transition-colors group-hover:border-cyan-300/50 group-hover:text-cyan-200">
            点我说话
          </span>
        </button>
      )}

      {/* 客服面板：固定右下角，移动端宽度自适应，不遮挡主内容区 */}
      {open && (
        <section
          aria-label="NumX Max 智能客服面板"
          className="fixed bottom-4 right-4 z-[70] flex h-[min(70vh,580px)] w-[min(92vw,384px)] flex-col overflow-hidden rounded-2xl border border-amber-200/20 bg-[#171310]/95 shadow-2xl shadow-black/60 backdrop-blur-md"
        >
          {/* 品牌头：灵枢 IP 形象（情绪映射：思考中→think，否则 wave）+ 品牌与能力标记 */}
          <header className="flex items-center justify-between gap-3 border-b border-amber-200/15 bg-gradient-to-r from-[#2a2014] to-[#171310] px-4 py-2.5">
            <div className="flex items-center gap-3">
              <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-2xl border border-cyan-300/25 bg-[#101a1c]">
                {/* 深色主视觉打底（2:3，cover 裁切），透明姿势图叠加在上 */}
                <LingshuImg
                  src="/ip/m15/lingshu-hero.png"
                  alt=""
                  className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-60"
                />
                <LingshuImg
                  src={thinking ? LINGSHU.think : LINGSHU.wave}
                  alt="灵枢"
                  className="pointer-events-none absolute inset-0 h-full w-full object-contain"
                />
                <span
                  aria-hidden
                  className={`absolute bottom-1 right-1 h-2 w-2 rounded-full ${
                    speaking ? 'animate-pulse bg-cyan-300' : 'bg-amber-300/70'
                  }`}
                />
              </div>
              <div>
                <p className="text-sm font-semibold text-amber-50">
                  灵枢 · {welcome?.brand ?? 'NumX Max'}智能客服
                </p>
                <div className="mt-1 flex flex-wrap gap-1">
                  <span className="rounded-full border border-amber-200/20 bg-amber-100/5 px-1.5 py-px text-[10px] leading-4 text-amber-200/70">
                    {welcome?.capabilities?.llmConnected
                      ? `品牌知识库+大模型 · 已联网验证${welcome?.capabilities?.llmVerifiedCount ?? '?'}/${welcome?.capabilities?.llmTotalCount ?? '?'}`
                      : welcome?.capabilities?.llmConfigured
                        ? `品牌知识库 · 模型密钥已配置${welcome?.capabilities?.llmConfiguredCount ?? '?'}/${welcome?.capabilities?.llmTotalCount ?? '?'}(未验证)`
                        : '品牌知识库 · 未配置模型密钥'}
                  </span>
                  <span className="rounded-full border border-amber-200/20 bg-amber-100/5 px-1.5 py-px text-[10px] leading-4 text-amber-200/70">
                    浏览器语音
                  </span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={toggleVoice}
                aria-label={voiceOn ? '关闭语音朗读' : '开启语音朗读'}
                title={voiceOn ? '语音朗读：开（浏览器 speechSynthesis）' : '语音朗读：关'}
                className="rounded-md p-1.5 text-amber-200/70 transition-colors hover:bg-amber-100/10 hover:text-amber-100"
              >
                {voiceOn ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
              </button>
              <button
                type="button"
                onClick={closePanel}
                aria-label="关闭客服面板"
                className="rounded-md p-1.5 text-amber-200/70 transition-colors hover:bg-amber-100/10 hover:text-amber-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </header>

          {/* 错误条（后端失败不静默） */}
          {error && (
            <div className="flex items-center justify-between gap-2 border-b border-red-400/20 bg-red-950/40 px-4 py-2 text-xs text-red-200">
              <span>{error}</span>
              <button
                type="button"
                onClick={() => {
                  setError(null)
                  welcomedRef.current = false
                  void welcomeQuery.refetch()
                }}
                className="shrink-0 rounded border border-red-300/30 px-1.5 py-0.5 text-[11px] hover:bg-red-400/10"
              >
                重试
              </button>
            </div>
          )}

          {/* 消息流 */}
          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {welcomeQuery.isPending && (
              <p className="flex items-center gap-2 text-xs text-amber-200/60">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在连接客服服务…
              </p>
            )}

            {messages.map((m) => (
              <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                {m.role === 'assistant' && (
                  <span className="mr-1.5 mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full border border-cyan-300/30 bg-[#101a1c]">
                    <LingshuImg src={LINGSHU.wave} alt="" className="h-full w-full object-cover" />
                  </span>
                )}
                <div
                  className={
                    m.role === 'user'
                      ? 'max-w-[85%] rounded-2xl rounded-br-sm border border-amber-200/25 bg-[#3a2c1a] px-3 py-2 text-[13px] leading-relaxed text-amber-50'
                      : 'max-w-[92%] rounded-2xl rounded-bl-sm border border-amber-200/15 bg-[#211a12] px-3 py-2 text-[13px] leading-relaxed text-amber-100/90'
                  }
                >
                  <p className="whitespace-pre-wrap">{m.text}</p>

                  {m.role === 'assistant' && m.llmUsed !== undefined && (
                    <p className="mt-1 text-[10px] text-amber-200/50">
                      {m.llmUsed ? `AI生成 · ${m.generatedBy?.label ?? 'LLM'}` : '确定性回答'}
                    </p>
                  )}

                  {m.links && m.links.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {m.links.map((l) => (
                        <Link
                          key={`${l.to}-${l.label}`}
                          to={l.to}
                          onClick={closePanel}
                          className="rounded-full border border-amber-200/30 bg-amber-100/5 px-2 py-0.5 text-[11px] text-amber-200 transition-colors hover:bg-amber-100/15"
                        >
                          {l.label} →
                        </Link>
                      ))}
                    </div>
                  )}

                  {m.suggestions && m.suggestions.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {m.suggestions.map((s) => (
                        <button
                          key={s}
                          type="button"
                          onClick={() => sendMessage(s)}
                          className="rounded-full border border-amber-200/20 px-2 py-0.5 text-left text-[11px] text-amber-200/80 transition-colors hover:bg-amber-100/10"
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {sending && (
              <p className="flex items-center gap-2 text-xs text-amber-200/60">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在检索品牌知识库…
              </p>
            )}

            {/* guide 引导卡片（welcome 注入，Link 跳转） */}
            {welcome && welcome.guide.length > 0 && (
              <div className="space-y-2 border-t border-amber-200/10 pt-3">
                <p className="text-[11px] uppercase tracking-wider text-amber-200/50">新手引导</p>
                {welcome.guide.map((g) => (
                  <Link
                    key={g.to + g.title}
                    to={g.to}
                    onClick={closePanel}
                    className="block rounded-xl border border-amber-200/15 bg-[#1f1811] px-3 py-2 transition-colors hover:border-amber-200/35 hover:bg-[#262015]"
                  >
                    <p className="text-[13px] font-medium text-amber-100">{g.title}</p>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-amber-200/60">{g.desc}</p>
                  </Link>
                ))}
              </div>
            )}

            {/* 快捷提问 chips */}
            {quickPrompts.length > 0 && (
              <div className="flex flex-wrap gap-1.5 border-t border-amber-200/10 pt-3">
                {quickPrompts.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => sendMessage(q)}
                    className="rounded-full border border-amber-200/20 bg-amber-100/5 px-2.5 py-1 text-[11px] text-amber-200/85 transition-colors hover:bg-amber-100/15"
                  >
                    {q}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 数字人「小星」打字机气泡：AI 回复时悬浮在输入区上方 */}
          {bubbleText && (
            <div className="pointer-events-none absolute inset-x-3 bottom-[104px] z-10 flex justify-start">
              <SpeechBubble text={bubbleText} visible className="max-w-[92%] text-amber-50" />
            </div>
          )}

          {/* 底部：人工接管 + 输入区 */}
          <footer className="border-t border-amber-200/15 bg-[#151009] px-3 py-2.5">
            <div className="mb-2 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={requestHandoff}
                disabled={handoffMutation.isPending || handoffDone}
                className="flex items-center gap-1.5 rounded-full border border-amber-200/25 px-2.5 py-1 text-[11px] text-amber-200/85 transition-colors hover:bg-amber-100/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {handoffMutation.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <UserRoundCheck className="h-3 w-3" />
                )}
                {handoffDone ? '已登记人工接管' : '转人工接管'}
              </button>
              <span className="text-[10px] text-amber-200/40">语音为浏览器能力 · 回答由品牌知识库+四大模型联网生成，关键业务仍走确定性流程</span>
            </div>

            {recognitionCtor ? (
              listening && (
                <p className="mb-1.5 flex items-center gap-1.5 text-[11px] text-amber-200/70">
                  <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-300" />
                  {jarvis
                    ? '持续聆听中…识别到完整语句自动发送（关闭面板或点按麦克风退出）'
                    : '正在聆听…请说话（浏览器语音识别，松开或再次点击停止）'}
                </p>
              )
            ) : (
              <p className="mb-1.5 text-[11px] text-amber-200/50">当前浏览器不支持语音输入，已用文字模式</p>
            )}

            <div className="flex items-center gap-2">
              {recognitionCtor && (
                <button
                  type="button"
                  aria-label={listening ? '停止语音输入' : '开始语音输入'}
                  title="点击开始 / 再次点击停止；也可按住说话"
                  onPointerDown={onMicPointerDown}
                  onPointerUp={onMicPointerUp}
                  onPointerLeave={onMicPointerUp}
                  onClick={onMicClick}
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition-colors ${
                    listening
                      ? 'border-amber-300/60 bg-amber-400/20 text-amber-200'
                      : 'border-amber-200/20 bg-amber-100/5 text-amber-200/70 hover:bg-amber-100/10'
                  }`}
                >
                  <Mic className="h-4 w-4" />
                </button>
              )}
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) sendMessage(input)
                }}
                placeholder="输入你的问题，回车发送…"
                maxLength={1000}
                className="h-9 min-w-0 flex-1 rounded-full border border-amber-200/20 bg-[#1f1811] px-3 text-[13px] text-amber-50 placeholder:text-amber-200/35 focus:border-amber-200/45 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => sendMessage(input)}
                disabled={sending || !input.trim()}
                aria-label="发送"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-amber-200/30 bg-gradient-to-br from-[#3a2c1a] to-[#241b10] text-amber-200 transition-colors hover:from-[#4a3822] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
          </footer>
        </section>
      )}
    </>
  )
}
