/**
 * AdminBuddy —— 超级终端（/admin）右下角语音助手（iter96-S3）。
 *
 * 复刻工作台 VoiceBuddy 的核心体验，面向平台管理员调整：
 * - 默认人格为星云（守护者：为 admin 保驾护航），开场白 scene 固定 'welcome'；
 * - 双人格灵枢/星云切换、真实 IP 头像 + 微光描边、聊天面板、情绪中文标签、播报开关；
 * - 语音播报：Web Speech API（zh-CN，rate/pitch 直接用后端返回值），不可用静默降级；
 * - loading → think 姿势，星云 urgent/anxious → guard 姿势；
 * - 鉴权：admin 会话与工作台同源（localStorage("nebula_auth")，agentic.authLogin 签发的
 *   wb token，token 在请求体）。voiceBuddy.chat/greet 复用 sessionMe(token) 校验，因此
 *   常规 admin token 直接兼容；但「委派管理员」回退路径（staff.login 签发的 staff token）
 *   不是 wb_users token，sessionMe 会拒绝 —— 此时组件静默降级为静态问候面板（不报错、
 *   不红屏），输入仍可浏览但发送只给静态答复。
 * - 后端 voiceBuddy 路由并行开发中：本地接口 + 类型断言兜底，构建不依赖后端类型导出。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Mic, MicOff, Send, ShieldCheck, Volume2, VolumeX, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { trpc } from '@/providers/trpc'
import { useWbSession } from '@/lib/wbSession'

// ---------- 浏览器语音识别类型（TS DOM lib 未内置，最小化声明；M13.5 持续聆听） ----------
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

// ---------- 冻结契约（本地类型兜底） ----------
type Persona = 'lingshu' | 'xingyun'
type Emotion = 'joy' | 'calm' | 'anxious' | 'frustrated' | 'urgent'
type GreetScene = 'morning' | 'evening' | 'task_done' | 'alert' | 'welcome'

interface VoiceBuddyResp {
  reply: string
  emotion: Emotion
  rate: number
  pitch: number
}

interface VoiceMutationHook<I> {
  useMutation: (opts?: {
    onSuccess?: (data: VoiceBuddyResp) => void
    onError?: () => void
  }) => {
    mutate: (input: I) => void
    isPending: boolean
  }
}

const voiceBuddyTrpc = trpc as unknown as {
  voiceBuddy: {
    chat: VoiceMutationHook<{ persona: Persona; message: string; token: string }>
    greet: VoiceMutationHook<{ persona: Persona; scene: GreetScene; token: string }>
  }
}

// ---------- 展示映射 ----------
const PERSONAS: Record<
  Persona,
  { name: string; role: string; badgeClass: string; glowClass: string; desc: string }
> = {
  lingshu: {
    name: '灵枢',
    role: '温暖连接者',
    badgeClass: 'bg-pulse-cyan/20 border-pulse-cyan/50',
    glowClass:
      'border-pulse-cyan/50 shadow-[0_0_12px_rgba(56,189,248,0.25)] hover:border-pulse-cyan/70 hover:shadow-[0_0_16px_rgba(56,189,248,0.35)]',
    desc: '灵枢是温暖的连接者，擅长倾听与共情，陪管理员把繁杂事务理顺心。',
  },
  xingyun: {
    name: '星云',
    role: '沉稳守护者',
    badgeClass: 'bg-forge-amber/15 border-forge-amber/40',
    glowClass:
      'border-forge-amber/50 shadow-[0_0_12px_rgba(245,158,11,0.22)] hover:border-forge-amber/70 hover:shadow-[0_0_16px_rgba(245,158,11,0.32)]',
    desc: '星云是沉稳的守护者，关注风险与底线，为平台管理员保驾护航。',
  },
}

// 熊猫 IP 形象（public/ip 直出，透明底 1:1）
// M15：切换 Q版3D熊猫新形象（/ip/m15/，彭总 2026-08-08 钦定方案）；旧形象保留，回退只需改回路径
type Pose = 'wave' | 'think' | 'work' | 'guard' | 'speak'
const POSE_SRC: Record<Persona, Record<Pose, string>> = {
  lingshu: {
    wave: '/ip/m15/lingshu-wave.png',
    think: '/ip/m15/lingshu-think.png',
    work: '/ip/m15/lingshu-hero.png',
    guard: '/ip/m15/lingshu-hero.png',
    speak: '/ip/m15/lingshu-speak.png',
  },
  xingyun: {
    wave: '/ip/m15/xingyun-wave.png',
    think: '/ip/m15/xingyun-hero.png',
    work: '/ip/m15/xingyun-hero.png',
    guard: '/ip/m15/xingyun-hero.png',
    speak: '/ip/m15/xingyun-speak.png',
  },
}

function poseByEmotion(persona: Persona, emotion: Emotion | null, loading: boolean, speaking = false): Pose {
  if (loading) return 'think'
  if (speaking) return 'speak'
  if (!emotion) return 'wave'
  if (emotion === 'joy') return 'wave'
  if ((emotion === 'urgent' || emotion === 'anxious') && persona === 'xingyun') return 'guard'
  return 'wave'
}

const EMOTION_META: Record<Emotion, { label: string; dot: string }> = {
  joy: { label: '喜悦', dot: 'bg-jade-green' },
  calm: { label: '平静', dot: 'bg-pulse-cyan' },
  anxious: { label: '焦虑', dot: 'bg-forge-amber' },
  frustrated: { label: '沮丧', dot: 'bg-nebula-violet' },
  urgent: { label: '急切', dot: 'bg-ember-red' },
}

interface Msg {
  role: 'user' | 'assistant'
  text: string
  emotion?: Emotion
}

/** 静态降级问候（token 不兼容 wb 鉴权 / 后端不可用时展示，不报错） */
const STATIC_GREETING: Record<Persona, string> = {
  lingshu: '管理员您好，灵枢在这儿陪着您。今天平台的一切事务，咱们慢慢理，一件件来。',
  xingyun: '管理员您好，星云已就位。平台底线有我守着，您放心处理手头的事。',
}

const STATIC_REPLY: Record<Persona, string> = {
  lingshu: '灵枢现在的连线不太稳，您的话我记下了，稍后再跟我细说。',
  xingyun: '星云这边暂时离线值守，活儿耽误不了，您稍后再说一遍就成。',
}

// ---------- 语音播报（不可用时静默降级） ----------
function speak(text: string, rate: number, pitch: number) {
  try {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return
    const synth = window.speechSynthesis
    const utter = new SpeechSynthesisUtterance(text)
    utter.lang = 'zh-CN'
    utter.rate = rate
    utter.pitch = pitch
    const zhVoice = synth.getVoices().find((v) => v.lang?.startsWith('zh'))
    if (zhVoice) utter.voice = zhVoice
    // M15 二期：speak 帧接线——播报生命周期广播，组件据此切说话帧
    utter.onstart = () => window.dispatchEvent(new CustomEvent('buddy:speaking', { detail: true }))
    const done = () => window.dispatchEvent(new CustomEvent('buddy:speaking', { detail: false }))
    utter.onend = done
    utter.onerror = done
    synth.cancel()
    synth.speak(utter)
  } catch {
    // 播报失败静默，文字回复照常展示
  }
}

function stopSpeak() {
  try {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel()
      window.dispatchEvent(new CustomEvent('buddy:speaking', { detail: false }))
    }
  } catch {
    // ignore
  }
}

// ---------- 头像（真实 IP 透明底 PNG，加载失败静默隐藏只留底色） ----------
function AvatarImg({
  persona,
  pose,
  className,
}: {
  persona: Persona
  pose: Pose
  className?: string
}) {
  const [failed, setFailed] = useState(false)
  const src = POSE_SRC[persona][pose]
  if (failed) return null
  return (
    <img
      src={src}
      alt={PERSONAS[persona].name}
      draggable={false}
      onError={() => setFailed(true)}
      className={cn('h-full w-full object-contain', className)}
    />
  )
}

// ---------- 主组件 ----------
export default function AdminBuddy() {
  const { session } = useWbSession()
  const token = session?.token ?? null

  const [open, setOpen] = useState(false)
  // admin 端默认星云（守护者为管理员保驾护航）
  const [persona, setPersona] = useState<Persona>('xingyun')
  const [muted, setMuted] = useState(false)
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [currentEmotion, setCurrentEmotion] = useState<Emotion | null>(null)
  // 降级模式：wb token 不可用 / 后端鉴权失败 → 只展示静态问候，不报错
  const [degraded, setDegraded] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const greetedRef = useRef<string | null>(null)
  const mutedRef = useRef(muted)
  mutedRef.current = muted
  // M13.5 持续聆听（贾维斯模式）：'admin:open-buddy' 唤起后 continuous 识别，
  // onend 时若面板仍开且模式仍开则自动重启；final 文本走现有 chat 发送链路（只做问答，不触发写操作）
  const [listening, setListening] = useState(false)
  const jarvisRef = useRef(false)
  const openRef = useRef(open)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  /** M13.5 入场唤起：本轮开场问候只上屏不播报（入场欢迎语未播完，speak 内 cancel 会截断它） */
  const silentGreetingRef = useRef(false)

  // 识别器 onend 回调中读取最新面板开关（避免闭包旧值）；渲染期不写 ref
  useEffect(() => {
    openRef.current = open
  }, [open])

  const handleReply = (data: VoiceBuddyResp) => {
    setMessages((prev) => [...prev, { role: 'assistant', text: data.reply, emotion: data.emotion }])
    setCurrentEmotion(data.emotion)
    if (!mutedRef.current) speak(data.reply, data.rate, data.pitch)
  }

  /** 开场问候专用：入场唤起（speakGreeting===false）当轮仅入消息列表，不 TTS（消费一次性标记） */
  const handleGreetReply = (data: VoiceBuddyResp) => {
    if (silentGreetingRef.current) {
      silentGreetingRef.current = false
      setMessages((prev) => [...prev, { role: 'assistant', text: data.reply, emotion: data.emotion }])
      setCurrentEmotion(data.emotion)
      return
    }
    handleReply(data)
  }

  // 鉴权失败 / 后端不可用 → 静默降级为静态问候面板
  const handleError = () => setDegraded(true)

  const chat = voiceBuddyTrpc.voiceBuddy.chat.useMutation({ onSuccess: handleReply, onError: handleError })
  const greet = voiceBuddyTrpc.voiceBuddy.greet.useMutation({ onSuccess: handleGreetReply, onError: handleError })

  // 面板打开时静态/远程开场问候（scene 固定 welcome；同一 persona 只问候一次）
  useEffect(() => {
    if (!open) return
    const key = persona
    if (greetedRef.current === key) return
    greetedRef.current = key
    if (!token || degraded) {
      setMessages((prev) => [...prev, { role: 'assistant', text: STATIC_GREETING[persona], emotion: 'calm' }])
      return
    }
    greet.mutate({ persona, scene: 'welcome', token })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, persona, token, degraded])

  // 新消息滚动到底部
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages])

  // 关闭面板 / 静音时停止播报；关闭面板同时退出持续聆听
  useEffect(() => {
    if (!open || muted) stopSpeak()
    if (!open) {
      jarvisRef.current = false
      recognitionRef.current?.abort()
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 面板关闭是与浏览器识别会话同步的安全网，需兜底重置聆听状态
      setListening(false)
    }
  }, [open, muted])

  // 组件卸载兜底：停止识别
  useEffect(
    () => () => {
      jarvisRef.current = false
      recognitionRef.current?.abort()
    },
    [],
  )

  // 发送链路：语音 final 文本与手动输入共用（语音仅触发既有 chat 问答，不触发任何写操作）
  const send = (raw?: string) => {
    const text = (raw ?? input).trim()
    if (!text || chat.isPending) return
    setMessages((prev) => [...prev, { role: 'user', text }])
    setInput('')
    if (!token || degraded) {
      // 降级：只给静态答复，不调用后端
      setMessages((prev) => [...prev, { role: 'assistant', text: STATIC_REPLY[persona], emotion: 'calm' }])
      return
    }
    chat.mutate({ persona, message: text, token })
  }
  // 识别器回调中读取最新发送链路（避免闭包旧值；与本文件 mutedRef 同风格）
  const sendRef = useRef(send)
  useEffect(() => {
    sendRef.current = send
  })

  // M13.5 持续聆听：continuous 识别 + onend 自动重启；不支持识别的浏览器静默降级
  const startJarvis = useCallback(() => {
    const ctor = getSpeechRecognitionCtor()
    if (!ctor) return
    jarvisRef.current = true
    setListening(true)
    const launch = () => {
      if (!jarvisRef.current || !openRef.current) return
      try {
        recognitionRef.current?.abort()
        const rec = new ctor()
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
          if (text) sendRef.current(text)
        }
        rec.onend = () => {
          // 浏览器识别会话结束：面板仍开且持续聆听仍开 → 自动重启
          if (jarvisRef.current && openRef.current) {
            window.setTimeout(launch, 300)
          } else {
            setListening(false)
          }
        }
        rec.onerror = (ev) => {
          const err = ev?.error
          // 权限/硬件类错误不可恢复：退出持续聆听；no-speech 等交给 onend 重启
          if (err === 'not-allowed' || err === 'service-not-allowed' || err === 'audio-capture') {
            jarvisRef.current = false
            setListening(false)
          }
        }
        recognitionRef.current = rec
        rec.start()
      } catch {
        // start 抛错（如重复 start / 硬件占用）：退出持续聆听，面板保持打开
        jarvisRef.current = false
        setListening(false)
      }
    }
    launch()
  }, [])

  // 停止持续聆听：面板保持打开（与 AssistantWidget 的退出能力对齐）
  const stopJarvis = useCallback(() => {
    jarvisRef.current = false
    recognitionRef.current?.abort()
    setListening(false)
  }, [])

  // M13.5：数字人入场层唤起（'admin:open-buddy'，入场欢迎语播完后 dispatch）——
  // 开面板 + 开 TTS 播报 + 自动持续聆听；人格随事件 detail（缺省保持当前）；手动打开行为不变
  useEffect(() => {
    const onOpenBuddy = (e: Event) => {
      const detail = (e as CustomEvent).detail as { persona?: unknown; speakGreeting?: unknown } | undefined
      const p: Persona | null =
        detail?.persona === 'lingshu' ? 'lingshu' : detail?.persona === 'xingyun' ? 'xingyun' : null
      if (p) setPersona(p)
      // speakGreeting===false：本轮开场白只上屏不 TTS（入场欢迎语未播完，防 speak 内 cancel 截断）
      silentGreetingRef.current = detail?.speakGreeting === false
      openRef.current = true
      setOpen(true)
      setMuted(false)
      startJarvis()
    }
    window.addEventListener('admin:open-buddy', onOpenBuddy)
    return () => window.removeEventListener('admin:open-buddy', onOpenBuddy)
  }, [startJarvis])

  const openWith = (p: Persona) => {
    silentGreetingRef.current = false // 手动打开：开场问候照常播报
    setPersona(p)
    setOpen(true)
  }

  const pending = chat.isPending || greet.isPending
  const emotionMeta = currentEmotion ? EMOTION_META[currentEmotion] : null
  // M15 二期：播报中切 speak 帧（buddy:speaking 广播由 speak/stopSpeak 发出）
  const [speaking, setSpeaking] = useState(false)
  useEffect(() => {
    const on = (e: Event) => setSpeaking(Boolean((e as CustomEvent).detail))
    window.addEventListener('buddy:speaking', on)
    return () => window.removeEventListener('buddy:speaking', on)
  }, [])
  const currentPose = poseByEmotion(persona, currentEmotion, pending, speaking)

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-3">
      {open && (
        <div className="flex h-[480px] w-80 flex-col overflow-hidden rounded-2xl border border-line-subtle bg-panel/95 shadow-2xl shadow-black/50 backdrop-blur">
          {/* 头部：人格 Tab + 控件 */}
          <div className="border-b border-line-subtle bg-void/60 px-4 pb-3 pt-3">
            <div className="flex items-center justify-between">
              <div className="flex gap-1 rounded-full border border-line-subtle bg-panel p-0.5">
                {(Object.keys(PERSONAS) as Persona[]).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPersona(p)}
                    className={cn(
                      'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors',
                      persona === p
                        ? 'bg-forge-amber/15 text-forge-amber'
                        : 'text-ink-secondary hover:text-ink-primary',
                    )}
                  >
                    <span className="h-4 w-4">
                      <AvatarImg persona={p} pose="wave" />
                    </span>
                    {PERSONAS[p].name}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1">
                {/* 持续聆听开关：开=启动贾维斯持续聆听，关=停止识别但面板保持打开 */}
                <button
                  type="button"
                  onClick={() => (listening ? stopJarvis() : startJarvis())}
                  title={listening ? '停止持续聆听' : '开启持续聆听'}
                  aria-label={listening ? '停止持续聆听' : '开启持续聆听'}
                  className={cn(
                    'rounded-lg p-1.5 transition-colors hover:bg-panel',
                    listening ? 'text-forge-amber' : 'text-ink-secondary hover:text-forge-amber',
                  )}
                >
                  {listening ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
                </button>
                <button
                  type="button"
                  onClick={() => setMuted((m) => !m)}
                  title={muted ? '开启语音播报' : '关闭语音播报'}
                  className="rounded-lg p-1.5 text-ink-secondary transition-colors hover:bg-panel hover:text-forge-amber"
                >
                  {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                </button>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-lg p-1.5 text-ink-secondary transition-colors hover:bg-panel hover:text-ink-primary"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <span className="h-9 w-9 shrink-0 overflow-hidden rounded-full border border-line-subtle bg-panel p-0.5">
                <AvatarImg persona={persona} pose={currentPose} />
              </span>
              <p className="text-[11px] leading-relaxed text-ink-faint">
                {PERSONAS[persona].desc}
              </p>
            </div>
          </div>

          {/* 消息列表 */}
          <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {messages.length === 0 && !pending && (
              <p className="mt-8 text-center text-xs text-ink-faint">
                和{PERSONAS[persona].name}聊聊吧，我在听。
              </p>
            )}
            {messages.map((m, i) => (
              <div key={i} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                {m.role === 'assistant' && (
                  <span className="mr-1.5 mt-1 h-6 w-6 shrink-0 overflow-hidden rounded-full border border-line-subtle bg-panel p-0.5">
                    <AvatarImg persona={persona} pose={poseByEmotion(persona, m.emotion ?? null, false)} />
                  </span>
                )}
                <div
                  className={cn(
                    'max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed shadow-sm',
                    m.role === 'user'
                      ? 'rounded-br-md bg-forge-amber/15 text-ink-primary'
                      : 'rounded-bl-md border border-line-subtle bg-void/60 text-ink-primary',
                  )}
                >
                  {m.text}
                </div>
              </div>
            ))}
            {pending && (
              <div className="flex justify-start">
                <span className="mr-1.5 mt-1 h-6 w-6 shrink-0 overflow-hidden rounded-full border border-line-subtle bg-panel p-0.5">
                  <AvatarImg persona={persona} pose="think" />
                </span>
                <div className="flex items-center gap-2 rounded-2xl rounded-bl-md border border-line-subtle bg-void/60 px-3 py-2 text-xs text-ink-faint">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-forge-amber" />
                  {PERSONAS[persona].name}正在想…
                </div>
              </div>
            )}
          </div>

          {/* 情感标签 / 降级提示 */}
          {emotionMeta && (
            <div className="flex items-center gap-1.5 border-t border-line-subtle px-4 py-1.5">
              <span className={cn('h-2 w-2 rounded-full', emotionMeta.dot)} />
              <span className="text-[11px] text-ink-faint">当前情绪：{emotionMeta.label}</span>
              {degraded && (
                <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-forge-amber/70">
                  <ShieldCheck className="h-3 w-3" />
                  离线值守
                </span>
              )}
            </div>
          )}

          {/* 持续聆听状态条（M13.5：仅入场层唤起后出现；不支持的浏览器静默不显示） */}
          {listening && (
            <div className="flex items-center gap-1.5 border-t border-line-subtle px-4 py-1.5">
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-forge-amber" />
              <span className="text-[11px] text-ink-faint">
                持续聆听中…识别到完整语句自动发送（仅问答对话，点头像旁麦克风或关闭面板退出）
              </span>
            </div>
          )}

          {/* 输入区 */}
          <div className="flex items-center gap-2 border-t border-line-subtle bg-void/60 px-3 py-2.5">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') send()
              }}
              placeholder={`对${PERSONAS[persona].name}说点什么…`}
              className="min-w-0 flex-1 rounded-xl border border-line-subtle bg-panel px-3 py-2 text-sm text-ink-primary placeholder:text-ink-faint focus:border-forge-amber/50 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => send()}
              disabled={pending || !input.trim()}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-forge-amber/20 text-forge-amber transition-colors hover:bg-forge-amber/30 disabled:opacity-40"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* 悬浮入口：M13.5 大号立绘（人格跟随当前 persona，面板内可切换；加载失败静默隐藏留文字 chip） */}
      <button
        type="button"
        onClick={() => openWith(persona)}
        title={`${PERSONAS[persona].name} · ${PERSONAS[persona].role}`}
        className="group flex flex-col items-center gap-1"
      >
        <span
          className={cn(
            'relative flex h-24 w-16 items-center justify-center transition-transform duration-300 group-hover:-translate-y-1',
            open && listening && 'animate-pulse',
          )}
        >
          <AvatarImg
            persona={persona}
            pose="wave"
            className={
              persona === 'lingshu'
                ? 'drop-shadow-[0_0_14px_rgba(56,189,248,0.5)]'
                : 'drop-shadow-[0_0_14px_rgba(245,158,11,0.45)]'
            }
          />
        </span>
        <span className="rounded-full border border-line-subtle bg-panel/90 px-2 py-0.5 text-[10px] text-ink-secondary transition-colors group-hover:border-forge-amber/50 group-hover:text-forge-amber">
          点我说话
        </span>
      </button>
    </div>
  )
}
