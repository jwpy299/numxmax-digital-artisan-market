/**
 * MechaEntrance —— M13.5「数字人具身」共享入场层（门户 / 工作台 / 超级终端三端复用）。
 *
 * 核心逻辑与 s2 工作台 WbMechaEntrance 一致：
 * - 每浏览器会话一次（sessionStorage: storageKey），挂载即触发；
 * - 全屏遮罩：大形象 9:16 问候视频（按时段选人，<12 灵枢 / ≥18 星云 / 其它随机），
 *   muted autoplay playsInline，视频加载失败降级为 /ip/m15/<persona>-hero.png 立绘；
 * - 视频下方打字机效果欢迎语气泡；
 * - 主按钮（用户手势内）：speechSynthesis 朗读欢迎语
 *   （灵枢 pitch 1.0 / rate 1.0；星云 pitch 0.9 / rate 0.95，区分声线）→ 遮罩立即关闭，
 *   待 utter.onend/onerror（欢迎语完整播完）后才 dispatch openEventName
 *   （detail: { persona, speakGreeting: false }）——欢迎语不被 buddy 内 synth.cancel 截断；
 *   不支持 TTS 时立即唤起；
 * - 次按钮纯关层，不触发语音/开面板；60 秒无操作自动按次按钮处理；Escape 等价；
 * - 浏览器不支持 speechSynthesis 时不朗读，静默降级。
 *
 * 三端差异全部由 props 注入：
 * - storageKey：会话去重键（wb_mecha_entered / portal_mecha_entered / admin_mecha_entered）；
 * - openEventName：唤起 buddy 的事件名（wb:open-buddy / portal:open-buddy / admin:open-buddy）；
 * - enterLabel：主按钮文案；skipLabel：次按钮文案（默认「先进去看看」）；
 * - persona：固定人格（如门户统一灵枢）；缺省按时段选人；
 * - welcomeText：覆盖欢迎语文案（声线 rate/pitch 仍随最终人格走）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

const AUTO_DISMISS_MS = 60_000
const TYPE_INTERVAL_MS = 55
/** 欢迎语 end 事件丢失兜底：超过该时长仍未 onend/onerror 也强制唤起 buddy（> 正常播报时长） */
const SPEAK_FALLBACK_MS = 20_000

export type MechaPersona = 'lingshu' | 'xingyun'

export interface MechaEntranceChoice {
  persona: MechaPersona
  name: string
  video: string
  hero: string
  rate: number
  pitch: number
  line: string
}

const MECHA_META: Record<MechaPersona, { name: string; rate: number; pitch: number }> = {
  lingshu: { name: '灵枢', rate: 1.0, pitch: 1.0 },
  xingyun: { name: '星云', rate: 0.95, pitch: 0.9 },
}

function buildChoice(persona: MechaPersona, line?: string): MechaEntranceChoice {
  const meta = MECHA_META[persona]
  return {
    persona,
    ...meta,
    video: `/ip/video/m15-${persona}-greet.mp4`,
    hero: `/ip/m15/${persona}-hero.png`,
    line:
      line ??
      `老板，欢迎回来！我是${meta.name}，你的赛博同事。点击下方按钮进来，我随时听你差遣。`,
  }
}

/** 按时段选数字人：<12 灵枢晨迎，≥18 星云守夜，其它时段随机（沿用 iter94 口径） */
export function pickMechaEntrance(
  hour: number,
  rand: () => number = Math.random,
): MechaEntranceChoice {
  const persona: MechaPersona =
    hour < 12 ? 'lingshu' : hour >= 18 ? 'xingyun' : rand() < 0.5 ? 'lingshu' : 'xingyun'
  return buildChoice(persona)
}

/**
 * 解析最终入场选择：persona 传入时固定人格（声线/素材随人走），
 * welcomeText 覆盖欢迎语文案（不覆盖声线）。
 */
export function resolveMechaEntranceChoice(
  hour: number,
  opts: { persona?: MechaPersona; welcomeText?: string; rand?: () => number } = {},
): MechaEntranceChoice {
  const base = opts.persona
    ? buildChoice(opts.persona)
    : pickMechaEntrance(hour, opts.rand ?? Math.random)
  if (opts.welcomeText === undefined) return base
  return { ...base, line: opts.welcomeText }
}

/** M13.5 唤起 buddy 的事件 detail：speakGreeting=false 表示本轮 buddy 开场白只上屏不播报
 * （此时入场欢迎语刚播完/仍在收尾，buddy speak 内的 synth.cancel 会把它截断） */
export function buildOpenBuddyDetail(choice: MechaEntranceChoice) {
  return { persona: choice.persona, speakGreeting: false as const }
}

/**
 * 朗读欢迎语（须在用户手势内调用才不被自动播放策略拦截）；
 * 播完/出错（含兜底超时）时恰好回调一次 onEnd；不支持时返回 false 由调用方立即推进
 */
function speakLine(choice: MechaEntranceChoice, onEnd: () => void): boolean {
  try {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return false
    const synth = window.speechSynthesis
    const utter = new SpeechSynthesisUtterance(choice.line)
    utter.lang = 'zh-CN'
    utter.rate = choice.rate
    utter.pitch = choice.pitch
    const zhVoice = synth.getVoices().find((v) => v.lang?.startsWith('zh'))
    if (zhVoice) utter.voice = zhVoice
    let done = false
    const finish = () => {
      if (done) return
      done = true
      onEnd()
    }
    utter.onend = finish
    utter.onerror = finish
    synth.cancel()
    synth.speak(utter)
    // 个别浏览器偶发丢失 end 事件：超时强制推进，保证 buddy 最终会被唤起
    window.setTimeout(finish, SPEAK_FALLBACK_MS)
    return true
  } catch {
    // 播报失败静默，遮罩照常关闭
    return false
  }
}

export interface MechaEntranceProps {
  /** sessionStorage 会话去重键（每端独立） */
  storageKey: string
  /** 欢迎语播完后 dispatch 的事件名（各端 buddy 监听） */
  openEventName: string
  /** 主按钮文案（用户手势内触发朗读） */
  enterLabel: string
  /** 次按钮文案（纯关闭），默认「先进去看看」 */
  skipLabel?: string
  /** 固定人格；缺省按时段选人 */
  persona?: MechaPersona
  /** 覆盖欢迎语文案（声线仍随最终人格） */
  welcomeText?: string
}

export default function MechaEntrance({
  storageKey,
  openEventName,
  enterLabel,
  skipLabel = '先进去看看',
  persona,
  welcomeText,
}: MechaEntranceProps) {
  const [visible, setVisible] = useState(false)
  const [videoOk, setVideoOk] = useState(true)
  const [heroOk, setHeroOk] = useState(true)
  const [typed, setTyped] = useState(0)
  const [choice] = useState(() =>
    resolveMechaEntranceChoice(new Date().getHours(), { persona, welcomeText }),
  )

  // 每浏览器会话一次：未见过则展示并立即写标记（防会话内重挂载/重复触发）
  useEffect(() => {
    try {
      if (sessionStorage.getItem(storageKey)) return
      sessionStorage.setItem(storageKey, '1')
      setVisible(true)
    } catch {
      // sessionStorage 不可用（隐私模式等）时静默跳过
    }
  }, [storageKey])

  // 打字机效果
  useEffect(() => {
    if (!visible) return
    setTyped(0)
    const timer = window.setInterval(() => {
      setTyped((n) => {
        if (n >= choice.line.length) {
          window.clearInterval(timer)
          return n
        }
        return n + 1
      })
    }, TYPE_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [visible, choice.line])

  // 60 秒无操作自动按次按钮处理（纯关闭）
  useEffect(() => {
    if (!visible) return
    const timer = window.setTimeout(() => setVisible(false), AUTO_DISMISS_MS)
    return () => window.clearTimeout(timer)
  }, [visible])

  // Escape 键与次按钮等价（纯关闭，不触发语音/开面板）
  useEffect(() => {
    if (!visible) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setVisible(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [visible])

  // 卸载兜底：若正在朗读则停止，避免离场后继续发声
  const speakingRef = useRef(false)
  useEffect(
    () => () => {
      if (!speakingRef.current) return
      try {
        if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
          window.speechSynthesis.cancel()
        }
      } catch {
        // ignore
      }
    },
    [],
  )

  /**
   * 主按钮：朗读欢迎语 → 遮罩立即关闭（用户先看到页面，声音在后台播完）
   * → 欢迎语播完（onend/onerror）后才唤起 buddy（开面板 + 全双工开麦）。
   * 延后唤起的意义：onend 同步 dispatch → 识别器 start 仍在手势信任窗内；
   * 且开麦时后台已无播报，不会被转写成幻影用户指令；不支持 TTS 时立即唤起。
   */
  const enterWithVoice = useCallback(() => {
    speakingRef.current = true
    setVisible(false)
    const openBuddy = () => {
      window.dispatchEvent(
        new CustomEvent(openEventName, { detail: buildOpenBuddyDetail(choice) }),
      )
    }
    if (!speakLine(choice, openBuddy)) openBuddy()
  }, [choice, openEventName])

  if (!visible) return null

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={`${choice.name}欢迎回来`}
    >
      <div className="flex w-[min(92vw,420px)] flex-col items-center overflow-hidden rounded-2xl border border-line-subtle bg-deep/90 shadow-2xl shadow-black/60">
        {/* 大形象：9:16 问候视频，失败降级立绘；立绘再失败降级纯文本 */}
        <div className="flex w-full items-center justify-center bg-black">
          {videoOk ? (
            <video
              src={choice.video}
              autoPlay
              muted
              playsInline
              preload="metadata"
              className="aspect-[9/16] max-h-[68vh] w-auto max-w-full object-cover"
              onError={() => setVideoOk(false)}
            />
          ) : heroOk ? (
            <img
              src={choice.hero}
              alt={choice.name}
              draggable={false}
              className="aspect-[9/16] max-h-[68vh] w-auto max-w-full object-contain"
              onError={() => setHeroOk(false)}
            />
          ) : (
            <div className="flex aspect-[9/16] max-h-[68vh] w-auto max-w-full items-center justify-center px-10">
              <span className="text-center text-2xl font-semibold text-pulse-cyan">
                {choice.name}
              </span>
            </div>
          )}
        </div>

        {/* 打字机欢迎气泡 */}
        <div className="w-full px-5 pt-4">
          <p className="min-h-[4.5rem] text-sm leading-relaxed text-ink-primary">
            {choice.line.slice(0, typed)}
            {typed < choice.line.length && (
              <span className="animate-pulse text-pulse-cyan">▍</span>
            )}
          </p>
        </div>

        {/* 行动区 */}
        <div className="flex w-full flex-col items-center gap-1.5 px-5 pb-5 pt-1">
          <button
            type="button"
            onClick={enterWithVoice}
            className="w-full rounded-xl border border-pulse-cyan/50 bg-pulse-cyan/20 px-4 py-2.5 text-sm font-medium text-pulse-cyan shadow-[0_0_16px_rgba(56,189,248,0.25)] transition-colors hover:bg-pulse-cyan/30"
          >
            {enterLabel}
          </button>
          <button
            type="button"
            onClick={() => setVisible(false)}
            className="py-1 text-xs text-ink-faint transition-colors hover:text-pulse-cyan"
          >
            {skipLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
