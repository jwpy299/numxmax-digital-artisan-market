/**
 * VoiceBuddy —— 工作台右下角语音助手（iter93）。
 *
 * - 悬浮入口：M13.5 大号立绘按钮（当前人格 wave 姿势；灵枢=温暖连接者 / 星云=沉稳守护者，面板内可切换人格）；
 * - 聊天面板：人格切换 Tab + 人格说明、消息列表、输入框、情感小标签、播报开关；
 * - 发送 → trpc voiceBuddy.chat / 面板打开 → voiceBuddy.greet（按小时选 scene）；
 * - 语音播报：Web Speech API（zh-CN，rate/pitch 直接用后端返回值），不可用时静默降级只显示文字；
 * - 后端 voiceBuddy 路由并行开发中：此处用本地接口 + 类型断言兜底，构建不依赖后端类型导出。
 */
import { useEffect, useRef, useState } from 'react'
import { Activity, Loader2, Mic, MicOff, Send, Snowflake, Volume2, VolumeX, Waves, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { trpc } from '@/providers/trpc'
import { callWb, useWbQuery, useWbSession } from '@/lib/wbSession'
import {
  normalizeVoiceAttachment,
  safeVoiceFileUrl,
  voiceAttachmentName,
  type VoiceSkillAttachment,
} from '@/lib/voiceAttachment'
import {
  createBargeInDetector,
  createPreParseGate,
  prejudgeUtterance,
  transition,
} from './voiceDuplex'
import type { DuplexEffect, DuplexEvent, DuplexState } from './voiceDuplex'

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
    chat: VoiceMutationHook<{ token: string; persona: Persona; message: string }>
    greet: VoiceMutationHook<{ token: string; persona: Persona; scene: GreetScene }>
  }
}

/** 组织实况速览（与后端 voiceBuddy.contextBrief 对齐，iter95） */
interface OrgBrief {
  todayIntents: number
  pendingConfirms: number
  executedTotal: number
  frozen: boolean
  deptCount: number
  roleCount: number
  isNewbie: boolean
  hasSandboxDispatch: boolean
}

// ---------- M7-c：语音入口 V1（voice 路由，冻结契约外的新接口，untyped 调用） ----------
interface VoiceSessionStartResp {
  sessionId: number
  persona: Persona
  greeting: string
}

interface VoiceUtteranceResp {
  kind: 'chat' | 'action' | 'recite' | 'reject' | 'skill'
  reply: string
  sessionId: number
  pendingConfirm?: boolean
  intentId?: number
  status?: string
  /** M20 波 3：kind='skill' 且执行成功时携带（原始不可信字段，渲染前必过 normalizeVoiceAttachment） */
  ok?: boolean
  attachment?: unknown
}

interface VoiceConfirmResp {
  ok: boolean
  reply: string
  cancelled?: boolean
  intentId?: number
}

interface VoiceBroadcast {
  id: number
  level: string
  persona: Persona
  text: string
}

/** 浏览器语音识别（Web Speech API），不可用时返回 null */
function createRecognizer(
  onFinal: (text: string, confidence: number) => void,
  onEnd: () => void,
): { start: () => void; stop: () => void } | null {
  try {
    const w = window as unknown as {
      SpeechRecognition?: new () => any
      webkitSpeechRecognition?: new () => any
    }
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition
    if (!Ctor) return null
    const rec = new Ctor()
    rec.lang = 'zh-CN'
    rec.interimResults = false
    rec.maxAlternatives = 1
    rec.onresult = (e: any) => {
      const r = e.results?.[0]?.[0]
      if (r?.transcript) onFinal(String(r.transcript), typeof r.confidence === 'number' ? r.confidence : 1)
    }
    rec.onerror = () => onEnd()
    rec.onend = () => onEnd()
    return { start: () => rec.start(), stop: () => rec.stop() }
  } catch {
    return null
  }
}

// ---------- M9-b：全双工持续识别（continuous + interimResults，供五态机驱动） ----------
interface ContinuousRecognizer {
  start: () => void
  stop: () => void
}

/** 持续识别器：interim/final 分路上抛；不可用时返回 null（优雅回退文本模式） */
function createContinuousRecognizer(handlers: {
  onInterim: (text: string) => void
  onFinal: (text: string, confidence: number) => void
  onError: (kind: 'fatal' | 'recoverable') => void
  onEnd: () => void
}): ContinuousRecognizer | null {
  try {
    const w = window as unknown as {
      SpeechRecognition?: new () => any
      webkitSpeechRecognition?: new () => any
    }
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition
    if (!Ctor) return null
    const rec = new Ctor()
    rec.lang = 'zh-CN'
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 1
    rec.onresult = (e: any) => {
      let interim = ''
      for (let i = e.resultIndex ?? 0; i < (e.results?.length ?? 0); i++) {
        const r = e.results[i]
        const alt = r?.[0]
        if (!alt?.transcript) continue
        if (r.isFinal) {
          handlers.onFinal(String(alt.transcript), typeof alt.confidence === 'number' ? alt.confidence : 1)
        } else {
          interim += String(alt.transcript)
        }
      }
      if (interim.trim()) handlers.onInterim(interim)
    }
    rec.onerror = (e: any) => {
      const fatal = e?.error === 'not-allowed' || e?.error === 'service-not-allowed'
      handlers.onError(fatal ? 'fatal' : 'recoverable')
    }
    rec.onend = () => handlers.onEnd()
    return {
      start: () => {
        try {
          rec.start()
        } catch {
          // InvalidStateError（重复 start）静默忽略
        }
      },
      stop: () => {
        try {
          rec.stop()
        } catch {
          // ignore
        }
      },
    }
  } catch {
    return null
  }
}

/** TTS 播报（带起播/结束回调，全双工用）；返回 false 表示不可用，调用方自行推进状态机 */
function speakWithEnd(
  text: string,
  rate: number,
  pitch: number,
  onStart: () => void,
  onEnd: () => void,
): boolean {
  try {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return false
    const synth = window.speechSynthesis
    const utter = new SpeechSynthesisUtterance(text)
    utter.lang = 'zh-CN'
    utter.rate = rate
    utter.pitch = pitch
    const zhVoice = synth.getVoices().find((v) => v.lang?.startsWith('zh'))
    if (zhVoice) utter.voice = zhVoice
    utter.onstart = () => {
      window.dispatchEvent(new CustomEvent('buddy:speaking', { detail: true }))
      onStart()
    }
    utter.onend = () => {
      window.dispatchEvent(new CustomEvent('buddy:speaking', { detail: false }))
      onEnd()
    }
    utter.onerror = () => {
      window.dispatchEvent(new CustomEvent('buddy:speaking', { detail: false }))
      onEnd()
    }
    synth.cancel()
    synth.speak(utter)
    return true
  } catch {
    return false
  }
}

/** 全双工状态 → 状态条文案 */
const DUPLEX_STATUS: Record<DuplexState, string> = {
  idle: '',
  listening: '持续聆听中，直接说…',
  recognizing: '识别中…',
  speaking: '播报中（开口即可打断）',
  confirming: 'C 级待确认：说"确认"/"取消"，或点下方按钮',
}

/** 播报起播后的 barge-in 宽限窗（防 TTS 回声立刻自打断） */
const BARGE_IN_GRACE_MS = 800

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
    desc: '灵枢是温暖的连接者，擅长倾听与共情，陪你把每一天的工作理顺心。',
  },
  xingyun: {
    name: '星云',
    role: '沉稳守护者',
    badgeClass: 'bg-forge-amber/15 border-forge-amber/40',
    glowClass:
      'border-forge-amber/50 shadow-[0_0_12px_rgba(245,158,11,0.22)] hover:border-forge-amber/70 hover:shadow-[0_0_16px_rgba(245,158,11,0.32)]',
    desc: '星云是沉稳的守护者，关注风险与节奏，默默为你守住底线。',
  },
}

// iter94：熊猫 IP 形象（public/ip 直出，透明底 1:1）
// M15：切换 Q版3D熊猫新形象（/ip/m15/，彭总 2026-08-08 钦定方案）；旧形象保留在 /ip/ 根，回退只需改回路径
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
    think: '/ip/m15/xingyun-think.png',
    work: '/ip/m15/xingyun-hero.png',
    guard: '/ip/m15/xingyun-hero.png',
    speak: '/ip/m15/xingyun-speak.png',
  },
}

// #14 情绪姿势映射（彭总令 2026-09-02）：喜悦→wave开心，平静→wave，焦虑→think沉思，
// 受挫→guard守护，急切→guard戒备，播报中→speak开口，加载中→think思考
export function poseByEmotion(_persona: Persona, emotion: Emotion | null, loading: boolean, speaking = false): Pose {
  if (loading) return 'think'
  if (speaking) return 'speak'
  if (!emotion) return 'wave'
  if (emotion === 'joy') return 'wave'
  if (emotion === 'anxious') return 'think'
  if (emotion === 'frustrated') return 'guard'
  if (emotion === 'urgent') return 'guard'
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
  /** M20 波 3：技能产出物附件（已归一化/白名单校验，仅 assistant 气泡携带） */
  attachment?: VoiceSkillAttachment
}

function sceneByHour(): GreetScene {
  const h = new Date().getHours()
  if (h < 12) return 'morning'
  if (h >= 18) return 'evening'
  return 'welcome'
}

/**
 * 解析 'wb:open-buddy' 事件 detail（M13.5）：
 * persona 缺省/非法值回退 lingshu；silentGreeting 仅当显式 speakGreeting===false 时为 true
 * （本轮 buddy 开场白只上屏不播报——入场层欢迎语尚未播完，speak 内 synth.cancel 会截断它；
 * 手动打开面板不带该标记，默认照常播报）。
 */
export function resolveOpenBuddyDetail(detail: unknown): {
  persona: Persona
  silentGreeting: boolean
} {
  const d = (detail ?? {}) as { persona?: unknown; speakGreeting?: unknown }
  return {
    persona: d.persona === 'xingyun' ? 'xingyun' : 'lingshu',
    silentGreeting: d.speakGreeting === false,
  }
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

/**
 * M20 波 3 技能产出物卡（回复气泡内嵌）：
 * - kind='file'：📎 文件名 + 下载按钮（href 必过 /files/ 白名单 safeVoiceFileUrl，非法不渲染按钮）；
 * - kind='text'：preview 默认折叠，点击展开/收起。
 */
function AttachmentCard({ att }: { att: VoiceSkillAttachment }) {
  const [expanded, setExpanded] = useState(false)
  if (att.kind === 'file') {
    const href = safeVoiceFileUrl(att.url)
    return (
      <div
        data-testid="attachment-card"
        className="mt-2 flex items-center gap-2 rounded-lg border border-[#3A3026] bg-[#1E1913] px-2.5 py-1.5"
      >
        <span className="shrink-0 text-sm">📎</span>
        <span className="min-w-0 flex-1 truncate text-xs text-[#E8DFD1]">{voiceAttachmentName(att)}</span>
        {href && (
          <a
            data-testid="attachment-download"
            href={href}
            download
            className="shrink-0 rounded-md bg-jade-green/20 px-2 py-1 text-[11px] text-jade-green transition-colors hover:bg-jade-green/30"
          >
            下载
          </a>
        )}
      </div>
    )
  }
  return (
    <div
      data-testid="attachment-card"
      className="mt-2 rounded-lg border border-[#3A3026] bg-[#1E1913] px-2.5 py-1.5"
    >
      <button
        type="button"
        data-testid="attachment-preview-toggle"
        onClick={() => setExpanded((v) => !v)}
        className="text-[11px] text-pulse-cyan hover:underline"
      >
        {expanded ? '收起预览 ▲' : '展开预览 ▼'}
      </button>
      {expanded && (
        <p data-testid="attachment-preview" className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-[#A3937B]">
          {att.preview}
        </p>
      )}
    </div>
  )
}

// ---------- 主组件 ----------
export default function VoiceBuddy() {
  const [open, setOpen] = useState(false)
  const [persona, setPersona] = useState<Persona>('lingshu')
  const [muted, setMuted] = useState(false)
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [currentEmotion, setCurrentEmotion] = useState<Emotion | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const greetedRef = useRef<string | null>(null)
  const mutedRef = useRef(muted)
  mutedRef.current = muted
  /** M13.5 入场唤起：本轮开场问候只上屏不播报（入场欢迎语未播完，speak 内 cancel 会截断它） */
  const silentGreetingRef = useRef(false)

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

  const { session } = useWbSession()
  const chat = voiceBuddyTrpc.voiceBuddy.chat.useMutation({ onSuccess: handleReply })
  const greet = voiceBuddyTrpc.voiceBuddy.greet.useMutation({ onSuccess: handleGreetReply })

  // iter95：面板打开时拉取组织实况（今日意图 / 待确认 / 冻结状态）
  const { data: brief } = useWbQuery<OrgBrief>(
    'voiceBuddy.contextBrief',
    session,
    {},
    { enabled: open && !!session?.token },
  )

  // 面板打开时按时段开场问候（同一 persona+scene 只问候一次）
  useEffect(() => {
    if (!open || !session?.token) return
    const key = `${persona}:${sceneByHour()}`
    if (greetedRef.current === key) return
    greetedRef.current = key
    greet.mutate({ token: session.token, persona, scene: sceneByHour() })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, persona, session?.token])

  // 新消息滚动到底部
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages])

  // 关闭面板 / 静音时停止播报
  useEffect(() => {
    if (!open || muted) stopSpeak()
  }, [open, muted])

  const send = () => {
    const text = input.trim()
    if (!text || chat.isPending || !session?.token) return
    setMessages((prev) => [...prev, { role: 'user', text }])
    setInput('')
    chat.mutate({ token: session.token, persona, message: text })
  }

  // ---------- M7-c：语音入口（接 gate 的真实语音链路） ----------
  const [listening, setListening] = useState(false)
  const [voiceBusy, setVoiceBusy] = useState(false)
  const [awaitingConfirm, setAwaitingConfirm] = useState(false)
  const voiceSessionsRef = useRef<Partial<Record<Persona, number>>>({})
  const recognizerRef = useRef<{ start: () => void; stop: () => void } | null>(null)
  const lastBroadcastRef = useRef(0)
  const voiceSupported = typeof window !== 'undefined' &&
    !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)

  const pushAgent = (text: string, p?: Persona, attachment?: VoiceSkillAttachment) => {
    setMessages((prev) => [...prev, { role: 'assistant', text, ...(attachment ? { attachment } : {}) }])
    if (!mutedRef.current) speak(text, p === 'xingyun' ? 1.05 : 0.95, 1)
  }

  /** 确保当前人格有活跃语音会话（无则开会话并播报开场白），返回 sessionId；
   *  silentGreeting 时开场白只上屏不播报（M13.5 入场唤起当轮，防截断入场欢迎语） */
  const ensureVoiceSession = async (
    p: Persona,
    opts?: { silentGreeting?: boolean },
  ): Promise<number | null> => {
    if (!session?.token) return null
    const existing = voiceSessionsRef.current[p]
    if (existing) return existing
    try {
      const r = await callWb<VoiceSessionStartResp>('mutation', 'voice.sessionStart', session, { persona: p })
      voiceSessionsRef.current[p] = r.sessionId
      if (opts?.silentGreeting) {
        setMessages((prev) => [...prev, { role: 'assistant', text: r.greeting }])
      } else {
        pushAgent(r.greeting, p)
      }
      return r.sessionId
    } catch {
      return null
    }
  }

  /** 语音文本 → voice.utterance（人格路由 + 意图判定；C 级返回复述等待确认） */
  const sendVoiceText = async (text: string, confidence: number) => {
    if (!session?.token || voiceBusy) return
    setVoiceBusy(true)
    setMessages((prev) => [...prev, { role: 'user', text: `🎤 ${text}` }])
    try {
      const sid = await ensureVoiceSession(persona)
      if (!sid) {
        pushAgent('语音会话开小差了，请再试一次。', persona)
        return
      }
      const r = await callWb<VoiceUtteranceResp>('mutation', 'voice.utterance', session, {
        sessionId: sid,
        text,
        asrConfidence: confidence,
      })
      pushAgent(r.reply, persona, normalizeVoiceAttachment(r.attachment) ?? undefined)
      setAwaitingConfirm(r.kind === 'recite' && !!r.pendingConfirm)
    } catch {
      pushAgent('刚才那句没传上去，请再说一遍。', persona)
    } finally {
      setVoiceBusy(false)
    }
  }

  /** C 级复述后的语音确认/取消 → voice.intentConfirm（过闸或放弃） */
  const confirmVoice = async (decision: 'confirm' | 'cancel') => {
    const sid = voiceSessionsRef.current[persona]
    if (!session?.token || !sid || voiceBusy) return
    setVoiceBusy(true)
    setMessages((prev) => [...prev, { role: 'user', text: decision === 'confirm' ? '确认' : '取消' }])
    try {
      const r = await callWb<VoiceConfirmResp>('mutation', 'voice.intentConfirm', session, { sessionId: sid, decision })
      pushAgent(r.reply, persona)
    } catch {
      pushAgent('确认指令没送达到中枢，请到组织中枢页手动处理。', persona)
    } finally {
      setAwaitingConfirm(false)
      setVoiceBusy(false)
    }
  }

  /** 按住说话（点击开始/再点停止）；识别完成自动走 voice.utterance */
  const toggleMic = () => {
    if (listening) {
      recognizerRef.current?.stop()
      setListening(false)
      return
    }
    const rec = createRecognizer(
      (text, conf) => {
        setListening(false)
        void sendVoiceText(text, conf)
      },
      () => setListening(false),
    )
    if (!rec) return
    recognizerRef.current = rec
    setListening(true)
    rec.start()
  }

  // ---------- M9-b：全双工持续对话（五态机驱动，安全语义零改变） ----------
  const [duplexOn, setDuplexOn] = useState(false)
  const [duplexState, setDuplexState] = useState<DuplexState>('idle')
  const [prejudgeHint, setPrejudgeHint] = useState<string | null>(null)
  const machineRef = useRef<{ state: DuplexState }>({ state: 'idle' })
  const duplexActiveRef = useRef(false)
  const duplexRecRef = useRef<ContinuousRecognizer | null>(null)
  const preParseGateRef = useRef(createPreParseGate(500))
  const bargeInRef = useRef(createBargeInDetector(2))
  const speakSeqRef = useRef(0)
  const speakStartAtRef = useRef(0)
  const prejudgeCacheRef = useRef<{ text: string; result: ReturnType<typeof prejudgeUtterance> } | null>(null)
  const dispatchRef = useRef<(ev: DuplexEvent) => void>(() => {})

  /** 全双工提交：final 文本 → voice.utterance 原链路（与单次 mic 完全同一过闸路径） */
  const submitDuplex = async (text: string, confidence: number) => {
    // 预解析复用：interim 稳定期已预判过同句则直接复用，否则现场预判（纯本地，零 RTT）
    const cached = prejudgeCacheRef.current
    const pre = cached && cached.text === text ? cached.result : prejudgeUtterance(text)
    setPrejudgeHint(pre.kind === 'action' ? `预判：动作指令（${pre.actionHint}）` : null)
    setMessages((prev) => [...prev, { role: 'user', text: `🎤 ${text}` }])
    if (!session?.token) {
      dispatchRef.current({ type: 'TIMEOUT' }) // 未登录：不提交，回聆听，不卡 recognizing
      return
    }
    try {
      const sid = await ensureVoiceSession(persona)
      if (!sid) {
        dispatchRef.current({ type: 'ACTION_READY', needsConfirm: false, reply: '语音会话开小差了，请再试一次。' })
        return
      }
      const r = await callWb<VoiceUtteranceResp>('mutation', 'voice.utterance', session, {
        sessionId: sid,
        text,
        asrConfidence: confidence,
      })
      const att = normalizeVoiceAttachment(r.attachment) ?? undefined
      setMessages((prev) => [...prev, { role: 'assistant', text: r.reply, ...(att ? { attachment: att } : {}) }])
      const needsConfirm = r.kind === 'recite' && !!r.pendingConfirm
      setAwaitingConfirm(needsConfirm)
      dispatchRef.current({ type: 'ACTION_READY', needsConfirm, reply: r.reply })
    } catch {
      const reply = '刚才那句没传上去，请再说一遍。'
      setMessages((prev) => [...prev, { role: 'assistant', text: reply }])
      dispatchRef.current({ type: 'ACTION_READY', needsConfirm: false, reply })
    }
  }

  /** 全双工 TTS：带起播/结束回调推进状态机；静音或不可用时立即补 REPLY_END 防卡死 */
  const speakDuplex = (text: string) => {
    const seq = ++speakSeqRef.current
    const done = () => {
      if (speakSeqRef.current === seq) dispatchRef.current({ type: 'REPLY_END' })
    }
    const started = () => {
      speakStartAtRef.current = Date.now()
      bargeInRef.current.reset()
      dispatchRef.current({ type: 'REPLY_START' })
    }
    if (mutedRef.current || !speakWithEnd(text, persona === 'xingyun' ? 1.05 : 0.95, 1, started, done)) {
      window.setTimeout(done, 0)
    }
  }

  /** 全双工 C 级确认/取消：voice.intentConfirm 原链路（语音口令与按钮等价） */
  const confirmDuplex = async (decision: 'confirm' | 'cancel') => {
    const sid = voiceSessionsRef.current[persona]
    if (!session?.token || !sid) return
    setMessages((prev) => [...prev, { role: 'user', text: decision === 'confirm' ? '确认' : '取消' }])
    try {
      const r = await callWb<VoiceConfirmResp>('mutation', 'voice.intentConfirm', session, { sessionId: sid, decision })
      setMessages((prev) => [...prev, { role: 'assistant', text: r.reply }])
      speakDuplex(r.reply)
    } catch {
      const reply = '确认指令没送达到中枢，请到组织中枢页手动处理。'
      setMessages((prev) => [...prev, { role: 'assistant', text: reply }])
      speakDuplex(reply)
    } finally {
      setAwaitingConfirm(false)
    }
  }

  const startDuplexRecognizer = () => {
    if (!duplexActiveRef.current) return
    if (!duplexRecRef.current) {
      duplexRecRef.current = createContinuousRecognizer({
        onInterim: (text) => {
          const st = machineRef.current.state
          if (st === 'speaking') {
            // 播报期间识别器保持开启：连续 2 帧非静音人声 → barge-in（宽限窗防 TTS 回声自打断）
            if (Date.now() - speakStartAtRef.current < BARGE_IN_GRACE_MS) return
            if (bargeInRef.current.feed(true)) {
              bargeInRef.current.reset()
              dispatchRef.current({ type: 'BARGE_IN' })
            }
            return
          }
          if (st !== 'listening' && st !== 'recognizing') return
          dispatchRef.current({ type: 'ASR_INTERIM', text })
          // 流水线重叠：interim 稳定 500ms → 本地关键词预判（不调服务端，绝不预执行）
          const fired = preParseGateRef.current.feed(text, Date.now())
          if (fired) {
            const result = prejudgeUtterance(fired)
            prejudgeCacheRef.current = { text: fired, result }
            setPrejudgeHint(
              result.kind === 'action' ? `预判：动作指令（${result.actionHint}）` : '预判：闲聊/查询',
            )
          }
        },
        onFinal: (text, confidence) => {
          preParseGateRef.current.reset()
          prejudgeCacheRef.current = null
          const st = machineRef.current.state
          if (st === 'confirming') {
            // 确认期内：仅保守口令映射为 CONFIRM/CANCEL；其他语句不提交，绝不改写待确认意图
            // L1 修复：复述 TTS 起播后宽限窗内的人声视为回声（防 TTS 结尾"说确认"自触发）
            if (Date.now() - speakStartAtRef.current < BARGE_IN_GRACE_MS) return
            const pre = prejudgeUtterance(text)
            if (pre.kind === 'confirm') dispatchRef.current({ type: 'CONFIRM' })
            else if (pre.kind === 'cancel') dispatchRef.current({ type: 'CANCEL' })
            return
          }
          if (st === 'speaking') {
            // 播报中说出整句：先打断再提交（宽限窗内视为回声，忽略）
            if (Date.now() - speakStartAtRef.current >= BARGE_IN_GRACE_MS) {
              dispatchRef.current({ type: 'BARGE_IN' })
              dispatchRef.current({ type: 'ASR_FINAL', text, confidence })
            }
            return
          }
          dispatchRef.current({ type: 'ASR_FINAL', text, confidence })
        },
        onError: (kind) => {
          if (kind === 'fatal') dispatchRef.current({ type: 'ASR_ERROR' })
          // recoverable（no-speech 等）：交给 onEnd 自动重启
        },
        onEnd: () => {
          // 持续模式兜底：浏览器静音自动断流后重启（confirming/idle 不重启由状态判断）
          if (duplexActiveRef.current && machineRef.current.state !== 'idle') {
            window.setTimeout(() => {
              if (duplexActiveRef.current && machineRef.current.state !== 'idle') {
                duplexRecRef.current?.start()
              }
            }, 250)
          }
        },
      })
    }
    if (!duplexRecRef.current) {
      dispatchRef.current({ type: 'ASR_ERROR' })
      return
    }
    duplexRecRef.current.start()
  }

  const stopDuplexRecognizer = () => {
    duplexRecRef.current?.stop()
  }

  /** 副作用执行器：状态机只产出指令，这里对接真实世界 */
  const runDuplexEffects = (effects: DuplexEffect[]) => {
    for (const e of effects) {
      switch (e.type) {
        case 'START_LISTENING':
          startDuplexRecognizer()
          break
        case 'STOP_LISTENING':
          stopDuplexRecognizer()
          break
        case 'SUBMIT_UTTERANCE':
          void submitDuplex(e.text, e.confidence)
          break
        case 'SPEAK':
          speakDuplex(e.text)
          break
        case 'STOP_SPEAK':
          speakSeqRef.current++ // 作废旧播报的 REPLY_END 回调
          stopSpeak()
          break
        case 'CONFIRM_ACTION':
          void confirmDuplex(e.decision)
          break
      }
    }
  }

  const dispatchDuplex = (ev: DuplexEvent) => {
    const r = transition(machineRef.current.state, ev)
    machineRef.current.state = r.state
    setDuplexState(r.state)
    runDuplexEffects(r.effects)
    if (ev.type === 'ASR_ERROR') {
      // 红线 6：ASR 不可用/权限被拒 → 优雅回退文本 + 单次 mic 模式，页面不崩
      duplexActiveRef.current = false
      setDuplexOn(false)
      setPrejudgeHint(null)
      pushAgent('语音识别不可用或麦克风权限被拒，已退回文本模式。', persona)
    }
  }
  dispatchRef.current = dispatchDuplex

  /** 一键进入/退出全双工（随时可退回文本模式） */
  const toggleDuplex = () => {
    if (duplexOn) {
      duplexActiveRef.current = false
      dispatchDuplex({ type: 'EXIT' })
      setDuplexOn(false)
      setPrejudgeHint(null)
      return
    }
    if (!voiceSupported) return
    if (machineRef.current.state !== 'idle') dispatchDuplex({ type: 'EXIT' }) // 兜底清态
    duplexActiveRef.current = true
    setDuplexOn(true)
    dispatchDuplex({ type: 'WAKE' })
    void ensureVoiceSession(persona)
  }

  // 面板关闭 / 组件卸载：退出全双工并释放识别器
  useEffect(() => {
    if (!open && duplexOn) {
      duplexActiveRef.current = false
      dispatchDuplex({ type: 'EXIT' })
      setDuplexOn(false)
      setPrejudgeHint(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  useEffect(
    () => () => {
      duplexActiveRef.current = false
      duplexRecRef.current?.stop()
    },
    [],
  )

  // 主动播报轮询（面板打开时每 30s 拉一次 C/B 级信号）
  useEffect(() => {
    if (!open || !session?.token) return
    let cancelled = false
    const poll = async () => {
      try {
        const r = await callWb<{ broadcasts: VoiceBroadcast[] }>('query', 'voice.proactive', session, {
          afterId: lastBroadcastRef.current,
        })
        if (cancelled || r.broadcasts.length === 0) return
        for (const b of r.broadcasts) {
          lastBroadcastRef.current = Math.max(lastBroadcastRef.current, b.id)
          const prefix = b.level === 'C' ? '【紧急播报】' : '【播报】'
          pushAgent(`${prefix}${b.text}`, b.persona)
        }
      } catch {
        // 轮询失败静默，下轮重试
      }
    }
    void poll()
    const timer = setInterval(poll, 30_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, session?.token])

  const openWith = (p: Persona) => {
    silentGreetingRef.current = false // 手动打开：开场问候照常播报
    setPersona(p)
    setOpen(true)
  }

  // M13.5：数字人入场层唤起（'wb:open-buddy'，由 WbMechaEntrance 在入场欢迎语播完后 dispatch）。
  // 开面板并直接进入全双工持续聆听（与 toggleDuplex 开启分支同一路径；
  // 安全语义零改变：C 级仍须显式"确认"/按钮过闸）。注：仅开面板不会自动 WAKE，需在此显式启动。
  // detail.speakGreeting===false 时本轮开场（greet/sessionStart）只上屏不播报，
  // 避免 speak 内 synth.cancel 截断尚未播完的入场欢迎语（HIGH-1）。
  const openBuddyHandlerRef = useRef<(e: Event) => void>(() => {})
  openBuddyHandlerRef.current = (e: Event) => {
    const { persona: next, silentGreeting } = resolveOpenBuddyDetail(
      (e as CustomEvent).detail,
    )
    silentGreetingRef.current = silentGreeting
    setPersona(next)
    setOpen(true)
    if (voiceSupported && !duplexActiveRef.current) {
      if (machineRef.current.state !== 'idle') dispatchDuplex({ type: 'EXIT' }) // 兜底清态
      duplexActiveRef.current = true
      setDuplexOn(true)
      dispatchDuplex({ type: 'WAKE' })
      void ensureVoiceSession(next, { silentGreeting })
    }
  }
  useEffect(() => {
    const onOpenBuddy = (e: Event) => openBuddyHandlerRef.current(e)
    window.addEventListener('wb:open-buddy', onOpenBuddy)
    return () => window.removeEventListener('wb:open-buddy', onOpenBuddy)
  }, []) // 稳定挂载一次；handler 经 ref 取最新闭包，session/persona 等始终新鲜

  const pending = chat.isPending || greet.isPending
  const emotionMeta = currentEmotion ? EMOTION_META[currentEmotion] : null
  // M15 二期：播报中切 speak 帧（buddy:speaking 广播由 speak/stopSpeak/speakWithEnd 发出）
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
        <div className="flex h-[480px] w-80 flex-col overflow-hidden rounded-2xl border border-[#4A3F33] bg-[#1E1913]/95 shadow-2xl shadow-black/50 backdrop-blur">
          {/* 头部：人格 Tab + 控件 */}
          <div className="border-b border-[#3A3026] bg-[#26201A] px-4 pb-3 pt-3">
            <div className="flex items-center justify-between">
              <div className="flex gap-1 rounded-full border border-[#4A3F33] bg-[#1E1913] p-0.5">
                {(Object.keys(PERSONAS) as Persona[]).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPersona(p)}
                    className={cn(
                      'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors',
                      persona === p
                        ? 'bg-pulse-cyan/15 text-pulse-cyan'
                        : 'text-[#B8A98F] hover:text-ink-primary',
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
                <button
                  type="button"
                  onClick={() => setMuted((m) => !m)}
                  title={muted ? '开启语音播报' : '关闭语音播报'}
                  className="rounded-lg p-1.5 text-[#B8A98F] transition-colors hover:bg-[#322A21] hover:text-pulse-cyan"
                >
                  {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                </button>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-lg p-1.5 text-[#B8A98F] transition-colors hover:bg-[#322A21] hover:text-ink-primary"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <span className="h-9 w-9 shrink-0 overflow-hidden rounded-full border border-[#3A3026] bg-[#241E18] p-0.5">
                <AvatarImg persona={persona} pose={currentPose} />
              </span>
              <p className="text-[11px] leading-relaxed text-[#A3937B]">
                {PERSONAS[persona].desc}
              </p>
            </div>
            {/* iter95：组织实况 chips（真实数据，来自 voiceBuddy.contextBrief） */}
            {brief && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="inline-flex items-center gap-1 rounded-full border border-[#4A3F33] bg-[#1E1913] px-2 py-0.5 text-[10px] text-[#B8A98F]">
                  <Activity className="h-3 w-3 text-pulse-cyan" />
                  今日意图 {brief.todayIntents}
                </span>
                <span
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px]',
                    brief.pendingConfirms > 0
                      ? 'border-forge-amber/50 bg-forge-amber/10 text-forge-amber'
                      : 'border-[#4A3F33] bg-[#1E1913] text-[#B8A98F]',
                  )}
                >
                  待确认 {brief.pendingConfirms}
                </span>
                <span className="inline-flex items-center gap-1 rounded-full border border-[#4A3F33] bg-[#1E1913] px-2 py-0.5 text-[10px] text-[#B8A98F]">
                  军团 {brief.deptCount}部·{brief.roleCount}员
                </span>
                {brief.frozen && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-ember-red/50 bg-ember-red/10 px-2 py-0.5 text-[10px] text-ember-red">
                    <Snowflake className="h-3 w-3" />
                    已冻结
                  </span>
                )}
              </div>
            )}
          </div>

          {/* 消息列表 */}
          <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {messages.length === 0 && !pending && (
              <p className="mt-8 text-center text-xs text-[#7A6C57]">
                和{PERSONAS[persona].name}聊聊吧，我在听。
              </p>
            )}
            {messages.map((m, i) => (
              <div key={i} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                {m.role === 'assistant' && (
                  <span className="mr-1.5 mt-1 h-6 w-6 shrink-0 overflow-hidden rounded-full border border-[#3A3026] bg-[#241E18] p-0.5">
                    <AvatarImg persona={persona} pose={poseByEmotion(persona, m.emotion ?? null, false)} />
                  </span>
                )}
                <div
                  className={cn(
                    'max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed shadow-sm',
                    m.role === 'user'
                      ? 'rounded-br-md bg-pulse-cyan/15 text-ink-primary'
                      : 'rounded-bl-md border border-[#3A3026] bg-[#2A231C] text-[#E8DFD1]',
                  )}
                >
                  {m.text}
                  {m.attachment && <AttachmentCard att={m.attachment} />}
                </div>
              </div>
            ))}
            {pending && (
              <div className="flex justify-start">
                <span className="mr-1.5 mt-1 h-6 w-6 shrink-0 overflow-hidden rounded-full border border-[#3A3026] bg-[#241E18] p-0.5">
                  <AvatarImg persona={persona} pose="think" />
                </span>
                <div className="flex items-center gap-2 rounded-2xl rounded-bl-md border border-[#3A3026] bg-[#2A231C] px-3 py-2 text-xs text-[#A3937B]">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-pulse-cyan" />
                  {PERSONAS[persona].name}正在想…
                </div>
              </div>
            )}
          </div>

          {/* 情感标签 */}
          {emotionMeta && (
            <div className="flex items-center gap-1.5 border-t border-[#3A3026] px-4 py-1.5">
              <span className={cn('h-2 w-2 rounded-full', emotionMeta.dot)} />
              <span className="text-[11px] text-[#A3937B]">当前情绪：{emotionMeta.label}</span>
            </div>
          )}

          {/* C 级复述确认条（语音入口，M7-c；全双工下语音口令与按钮等价，M9-b） */}
          {awaitingConfirm && (
            <div className="flex items-center gap-2 border-t border-forge-amber/40 bg-forge-amber/10 px-4 py-2">
              <span className="flex-1 text-[11px] text-forge-amber">
                C 级动作等待你确认{duplexOn && '（也可直接说"确认"/"取消"）'}
              </span>
              <button
                type="button"
                onClick={() => (duplexOn ? dispatchDuplex({ type: 'CONFIRM' }) : confirmVoice('confirm'))}
                disabled={voiceBusy}
                className="rounded-lg bg-jade-green/20 px-3 py-1 text-xs text-jade-green transition-colors hover:bg-jade-green/30 disabled:opacity-40"
              >
                确认执行
              </button>
              <button
                type="button"
                onClick={() => (duplexOn ? dispatchDuplex({ type: 'CANCEL' }) : confirmVoice('cancel'))}
                disabled={voiceBusy}
                className="rounded-lg bg-ember-red/15 px-3 py-1 text-xs text-ember-red transition-colors hover:bg-ember-red/25 disabled:opacity-40"
              >
                取消
              </button>
            </div>
          )}

          {/* M9-b：全双工状态条 */}
          {duplexOn && (
            <div className="flex items-center gap-2 border-t border-[#3A3026] bg-[#221C15] px-4 py-1.5">
              <span
                className={cn(
                  'h-2 w-2 shrink-0 rounded-full',
                  duplexState === 'listening' && 'animate-pulse bg-jade-green',
                  duplexState === 'recognizing' && 'animate-pulse bg-nebula-violet',
                  duplexState === 'speaking' && 'animate-pulse bg-pulse-cyan',
                  duplexState === 'confirming' && 'animate-pulse bg-forge-amber',
                  duplexState === 'idle' && 'bg-[#7A6C57]',
                )}
              />
              <span className="text-[11px] text-[#A3937B]">{DUPLEX_STATUS[duplexState]}</span>
              {prejudgeHint && <span className="ml-auto text-[10px] text-pulse-cyan/80">{prejudgeHint}</span>}
            </div>
          )}

          {/* 输入区 */}
          <div className="flex items-center gap-2 border-t border-[#3A3026] bg-[#26201A] px-3 py-2.5">
            {voiceSupported && (
              <button
                type="button"
                onClick={toggleDuplex}
                title={duplexOn ? '退出全双工，回到文本模式' : '开启全双工持续对话（贾维斯模式，动作仍过闸）'}
                className={cn(
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-colors',
                  duplexOn
                    ? 'bg-pulse-cyan/25 text-pulse-cyan ring-1 ring-pulse-cyan/40'
                    : 'bg-[#1E1913] text-[#B8A98F] hover:text-pulse-cyan',
                )}
              >
                <Waves className="h-4 w-4" />
              </button>
            )}
            {voiceSupported && !duplexOn && (
              <button
                type="button"
                onClick={toggleMic}
                disabled={voiceBusy}
                title={listening ? '停止聆听' : '语音指令（接组织中枢，动作过闸）'}
                className={cn(
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-colors disabled:opacity-40',
                  listening
                    ? 'animate-pulse bg-ember-red/20 text-ember-red'
                    : 'bg-[#1E1913] text-[#B8A98F] hover:text-pulse-cyan',
                )}
              >
                {listening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
              </button>
            )}
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') send()
              }}
              placeholder={`对${PERSONAS[persona].name}说点什么…`}
              className="min-w-0 flex-1 rounded-xl border border-[#4A3F33] bg-[#1E1913] px-3 py-2 text-sm text-ink-primary placeholder:text-[#7A6C57] focus:border-pulse-cyan/50 focus:outline-none"
            />
            <button
              type="button"
              onClick={send}
              disabled={pending || !input.trim()}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-pulse-cyan/20 text-pulse-cyan transition-colors hover:bg-pulse-cyan/30 disabled:opacity-40"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* 悬浮入口：M13.5 大号立绘（当前人格 wave 姿势；面板内可切换人格） */}
      <button
        type="button"
        onClick={() => openWith(persona)}
        title={`${PERSONAS[persona].name} · ${PERSONAS[persona].role}`}
        className="group flex flex-col items-center gap-1"
      >
        <span
          className={cn(
            'relative flex h-24 w-16 items-center justify-center transition-transform duration-300 group-hover:-translate-y-1',
            open && duplexOn && 'animate-pulse',
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
        <span className="rounded-full border border-[#4A3F33] bg-[#1E1913]/90 px-2 py-0.5 text-[10px] text-[#B8A98F] transition-colors group-hover:border-pulse-cyan/50 group-hover:text-pulse-cyan">
          点我说话
        </span>
      </button>
    </div>
  )
}
