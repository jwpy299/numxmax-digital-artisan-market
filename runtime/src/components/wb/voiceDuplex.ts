/**
 * voiceDuplex —— M9-b 全双工语音的纯逻辑五态机（与 React 解耦，便于单测）。
 *
 * 状态机（贾维斯式持续对话）：
 *
 *   idle ──WAKE──▶ listening ──ASR_INTERIM(非空)──▶ recognizing
 *    ▲               │                                │ ASR_FINAL
 *    │               │                                ▼
 *    │               │                          recognizing ──SUBMIT_UTTERANCE(副作用)
 *    │               │                                │ ACTION_READY
 *    │               │                                ├─ needsConfirm=false ─▶ speaking ──SPEAK
 *    │               │                                └─ needsConfirm=true  ─▶ confirming ──SPEAK(复述)
 *    │               │                                                   │ 仅 CONFIRM / CANCEL 迁出
 *    │               │                                                   ▼
 *    │               │                              speaking ──CONFIRM_ACTION(过闸原链路)
 *    │               │                                │ REPLY_END ──▶ listening
 *    │               │                                │ BARGE_IN(连续2帧人声) ──STOP_SPEAK──▶ listening
 *    │               └──EXIT──▶ idle（退回文本模式）
 *    └──────ASR_ERROR（权限被拒/不可用，confirming 除外——绝不静默丢弃待确认上下文）
 *
 * 安全语义红线（与原单次 mic 完全一致）：
 * - 动作执行只走 voice.utterance / voice.intentConfirm 原链路，本模块不新增任何执行路径；
 * - C 级意图永远需要显式 CONFIRM/CANCEL（按钮或语音口令），TIMEOUT 不会迁出 confirming、绝不自动执行；
 * - 预解析只做本地关键词预判（不调服务端、不产生执行），供 UI 提示与 final 复用，省一次本地计算。
 */

// ─── 状态与事件 ──────────────────────────────────────────────────────────────

export type DuplexState = 'idle' | 'listening' | 'recognizing' | 'speaking' | 'confirming'

export type DuplexEventType =
  | 'WAKE' // 用户开启全双工
  | 'EXIT' // 用户退回文本模式
  | 'ASR_INTERIM' // 识别中间结果（text 非空为有效人声帧）
  | 'ASR_FINAL' // 识别最终结果
  | 'ASR_ERROR' // ASR 不可用 / 麦克风权限被拒
  | 'ACTION_READY' // voice.utterance 应答到达
  | 'REPLY_START' // TTS 开始播报
  | 'REPLY_END' // TTS 播报完毕
  | 'BARGE_IN' // 播报期间检测到连续人声 → 打断
  | 'CONFIRM' // C 级确认（按钮或语音"确认"）
  | 'CANCEL' // C 级取消（按钮或语音"取消"）
  | 'TIMEOUT' // 识别停滞超时（recognizing 兜底回 listening；confirming 不响应）

export interface DuplexEvent {
  type: DuplexEventType
  /** ASR_INTERIM / ASR_FINAL 的识别文本 */
  text?: string
  /** ASR_FINAL 的置信度 */
  confidence?: number
  /** ACTION_READY：是否为 C 级复述待确认 */
  needsConfirm?: boolean
  /** ACTION_READY：要播报的应答文本 */
  reply?: string
}

/** 副作用指令：状态机只描述"该发生什么"，由 React 层执行（可测试、可替换） */
export type DuplexEffect =
  | { type: 'START_LISTENING' } // 启动持续识别（continuous + interimResults）
  | { type: 'STOP_LISTENING' } // 停止识别
  | { type: 'SUBMIT_UTTERANCE'; text: string; confidence: number } // final → voice.utterance
  | { type: 'SPEAK'; text: string } // TTS 播报
  | { type: 'STOP_SPEAK' } // 打断播报
  | { type: 'CONFIRM_ACTION'; decision: 'confirm' | 'cancel' } // voice.intentConfirm 原链路

export interface TransitionResult {
  state: DuplexState
  effects: DuplexEffect[]
}

const stay = (state: DuplexState): TransitionResult => ({ state, effects: [] })
const to = (state: DuplexState, effects: DuplexEffect[] = []): TransitionResult => ({ state, effects })

/** 五态机迁移函数（纯函数，全表语义明确；未列组合一律 no-op 停留原态） */
export function transition(state: DuplexState, event: DuplexEvent): TransitionResult {
  const text = (event.text ?? '').trim()

  switch (state) {
    case 'idle':
      if (event.type === 'WAKE') return to('listening', [{ type: 'START_LISTENING' }])
      return stay('idle')

    case 'listening':
      switch (event.type) {
        case 'EXIT':
          return to('idle', [{ type: 'STOP_LISTENING' }, { type: 'STOP_SPEAK' }])
        case 'ASR_INTERIM':
          // 非空 interim = 用户开始说话
          return text ? to('recognizing') : stay('listening')
        case 'ASR_FINAL':
          // 无 interim 直接出 final（部分浏览器行为）：照常提交
          return text
            ? to('recognizing', [{ type: 'SUBMIT_UTTERANCE', text, confidence: event.confidence ?? 1 }])
            : stay('listening')
        case 'ACTION_READY':
          // 迟到的应答（例如上一轮提交缓慢）：照常播报，不丢回复
          return actionReady(event)
        case 'ASR_ERROR':
          return to('idle', [{ type: 'STOP_LISTENING' }])
        default:
          return stay('listening')
      }

    case 'recognizing':
      switch (event.type) {
        case 'EXIT':
          return to('idle', [{ type: 'STOP_LISTENING' }, { type: 'STOP_SPEAK' }])
        case 'ASR_INTERIM':
          return stay('recognizing') // 持续收音，防抖预解析由 PreParseGate 负责
        case 'ASR_FINAL':
          return text
            ? to('recognizing', [{ type: 'SUBMIT_UTTERANCE', text, confidence: event.confidence ?? 1 }])
            : to('listening') // 空 final = 一句话结束但无内容，回聆听
        case 'ACTION_READY':
          return actionReady(event)
        case 'TIMEOUT':
          return to('listening') // 识别停滞兜底：不提交、不丢会话
        case 'ASR_ERROR':
          return to('idle', [{ type: 'STOP_LISTENING' }])
        default:
          return stay('recognizing')
      }

    case 'speaking':
      switch (event.type) {
        case 'EXIT':
          return to('idle', [{ type: 'STOP_LISTENING' }, { type: 'STOP_SPEAK' }])
        case 'REPLY_START':
          return stay('speaking') // TTS 真正起播（组件据此开 barge-in 宽限窗）
        case 'BARGE_IN':
          // 连续 2 帧非静音人声 → 停播回聆听（interrupted → listening）
          return to('listening', [{ type: 'STOP_SPEAK' }])
        case 'REPLY_END':
          return to('listening') // 播报自然结束，识别器全程未关
        case 'ACTION_READY':
          // 流水线重叠：上一条还在播，新应答已到 → 截断旧播报、播新回复
          return actionReady(event)
        case 'ASR_INTERIM':
        case 'ASR_FINAL':
          return stay('speaking') // 人声帧由 BargeInDetector 计数，状态机只认 BARGE_IN
        case 'ASR_ERROR':
          return to('idle', [{ type: 'STOP_LISTENING' }, { type: 'STOP_SPEAK' }])
        default:
          return stay('speaking')
      }

    case 'confirming':
      switch (event.type) {
        case 'CONFIRM':
          return to('speaking', [{ type: 'CONFIRM_ACTION', decision: 'confirm' }])
        case 'CANCEL':
          return to('speaking', [{ type: 'CONFIRM_ACTION', decision: 'cancel' }])
        case 'EXIT':
          return to('idle', [{ type: 'STOP_LISTENING' }, { type: 'STOP_SPEAK' }])
        case 'ASR_ERROR':
          // 权限丢失也要保住待确认上下文：停在 confirming，确认条仍可用按钮兜底
          return to('confirming', [{ type: 'STOP_LISTENING' }])
        // ASR_INTERIM / ASR_FINAL / ACTION_READY / REPLY_* / TIMEOUT / WAKE：
        // 一律停留——confirming 只被显式 CONFIRM/CANCEL/EXIT 迁出，绝不自动执行、绝不超时放行
        default:
          return stay('confirming')
      }
  }
}

function actionReady(event: DuplexEvent): TransitionResult {
  const reply = event.reply ?? ''
  if (event.needsConfirm) {
    // C 级复述：播报复述文本并进入确认等待（确认条沿用 pending_action 链路）
    return to('confirming', reply ? [{ type: 'SPEAK', text: reply }] : [])
  }
  return to('speaking', reply ? [{ type: 'SPEAK', text: reply }] : [])
}

// ─── 预解析防抖门（流水线重叠，纯本地）────────────────────────────────────────

export interface PreParseGate {
  /**
   * 喂入一帧 interim 文本。同一文本稳定满 stableMs 时返回该文本（触发一次预解析），
   * 否则返回 null。同一稳定文本只触发一次；文本变化重置计时。
   */
  feed: (text: string, now: number) => string | null
  reset: () => void
}

export function createPreParseGate(stableMs = 500): PreParseGate {
  let lastText = ''
  let since = 0
  let fired = false
  return {
    feed(text, now) {
      const t = text.trim()
      if (!t) return null
      if (t !== lastText) {
        lastText = t
        since = now
        fired = false
        return null
      }
      if (!fired && now - since >= stableMs) {
        fired = true
        return t
      }
      return null
    },
    reset() {
      lastText = ''
      since = 0
      fired = false
    },
  }
}

// ─── Barge-in 人声检测（连续 N 帧非静音 → 打断）──────────────────────────────

export interface BargeInDetector {
  /** 喂入一帧是否含人声；达到连续阈值返回 true（level 语义，调用方触发后应 reset） */
  feed: (hasVoice: boolean) => boolean
  reset: () => void
  readonly streak: number
}

export function createBargeInDetector(threshold = 2): BargeInDetector {
  let streak = 0
  return {
    feed(hasVoice) {
      streak = hasVoice ? streak + 1 : 0
      return streak >= threshold
    },
    reset() {
      streak = 0
    },
    get streak() {
      return streak
    },
  }
}

// ─── 本地关键词预判（不调服务端、不产生执行，仅 UI 提示 + final 复用）──────────

export type PrejudgeResult =
  | { kind: 'confirm' } // 确认口令（仅在 confirming 态采用）
  | { kind: 'cancel' } // 取消口令（仅在 confirming 态采用）
  | { kind: 'action'; actionHint: string } // 疑似动作指令（命中关键词）
  | { kind: 'chat' } // 闲聊/查询

/** 保守口令表：只收整句短口令。宁可漏判（用户点按钮）不可误判（误执行 C 级） */
const CONFIRM_WORDS = ['确认', '确认执行', '确定', '执行', '好的', '好', '可以', '行', '同意']
const CANCEL_WORDS = ['取消', '算了', '不用了', '不用', '不要', '别', '先不用']

const ACTION_KEYWORDS = [
  '冻结', '解冻', '创建', '新增', '提交', '发布', '派发', '下达', '删除',
  '审批', '通过', '驳回', '排产', '请假', '报销', '采购', '入库', '出库',
  '调价', '关停', '恢复',
]

/** 归一化：去首尾空白与句末语气标点，便于整句口令匹配 */
export function normalizeUtterance(text: string): string {
  return text.trim().replace(/[\s，。！？!?,、…~～.]+$/u, '')
}

export function prejudgeUtterance(text: string): PrejudgeResult {
  const t = normalizeUtterance(text)
  if (!t) return { kind: 'chat' }
  if (CONFIRM_WORDS.includes(t)) return { kind: 'confirm' }
  if (CANCEL_WORDS.includes(t)) return { kind: 'cancel' }
  const hit = ACTION_KEYWORDS.find((k) => t.includes(k))
  if (hit) return { kind: 'action', actionHint: hit }
  return { kind: 'chat' }
}
