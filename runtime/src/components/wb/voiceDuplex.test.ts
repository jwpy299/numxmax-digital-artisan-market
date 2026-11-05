/**
 * voiceDuplex 状态机单测（M9-b 全双工语音）。
 * 覆盖：完整迁移表、barge-in 停播、预解析 500ms 防抖、confirming 只被显式口令迁出、ASR 回退。
 */
import { describe, expect, it } from 'vitest'
import {
  createBargeInDetector,
  createPreParseGate,
  normalizeUtterance,
  prejudgeUtterance,
  transition,
} from './voiceDuplex'
import type { DuplexEvent, DuplexEventType, DuplexState } from './voiceDuplex'

const STATES: DuplexState[] = ['idle', 'listening', 'recognizing', 'speaking', 'confirming']
const EVENTS: DuplexEventType[] = [
  'WAKE', 'EXIT', 'ASR_INTERIM', 'ASR_FINAL', 'ASR_ERROR',
  'ACTION_READY', 'REPLY_START', 'REPLY_END', 'BARGE_IN', 'CONFIRM', 'CANCEL', 'TIMEOUT',
]

const effectTypes = (r: { effects: { type: string }[] }) => r.effects.map((e) => e.type)

// ─── 完整迁移表：每个 event × state 组合行为明确 ─────────────────────────────

describe('五态机迁移表', () => {
  it('全矩阵 60 组合均有定义且落回合法状态', () => {
    for (const s of STATES) {
      for (const t of EVENTS) {
        const r = transition(s, { type: t, text: '冻结产线', confidence: 0.9, reply: '好的', needsConfirm: false })
        expect(STATES).toContain(r.state)
        expect(Array.isArray(r.effects)).toBe(true)
      }
    }
  })

  describe('idle', () => {
    it('WAKE → listening + START_LISTENING', () => {
      const r = transition('idle', { type: 'WAKE' })
      expect(r.state).toBe('listening')
      expect(effectTypes(r)).toEqual(['START_LISTENING'])
    })
    it.each(EVENTS.filter((e) => e !== 'WAKE'))('%s → 停留 idle 无副作用', (t) => {
      const r = transition('idle', { type: t, text: '你好', reply: '嗯', needsConfirm: true })
      expect(r.state).toBe('idle')
      expect(r.effects).toEqual([])
    })
  })

  describe('listening', () => {
    it('ASR_INTERIM 非空 → recognizing', () => {
      expect(transition('listening', { type: 'ASR_INTERIM', text: '帮我' }).state).toBe('recognizing')
    })
    it('ASR_INTERIM 空文本 → 停留 listening', () => {
      expect(transition('listening', { type: 'ASR_INTERIM', text: '  ' }).state).toBe('listening')
    })
    it('ASR_FINAL → recognizing + SUBMIT_UTTERANCE（无 interim 直出 final 也提交）', () => {
      const r = transition('listening', { type: 'ASR_FINAL', text: '今天怎么样', confidence: 0.8 })
      expect(r.state).toBe('recognizing')
      expect(r.effects).toEqual([{ type: 'SUBMIT_UTTERANCE', text: '今天怎么样', confidence: 0.8 }])
    })
    it('EXIT → idle + 停识别停播报', () => {
      const r = transition('listening', { type: 'EXIT' })
      expect(r.state).toBe('idle')
      expect(effectTypes(r)).toEqual(['STOP_LISTENING', 'STOP_SPEAK'])
    })
    it('ASR_ERROR → idle + STOP_LISTENING（回退文本模式）', () => {
      const r = transition('listening', { type: 'ASR_ERROR' })
      expect(r.state).toBe('idle')
      expect(effectTypes(r)).toEqual(['STOP_LISTENING'])
    })
    it('迟到的 ACTION_READY 仍播报', () => {
      const r = transition('listening', { type: 'ACTION_READY', reply: '应答', needsConfirm: false })
      expect(r.state).toBe('speaking')
      expect(r.effects).toEqual([{ type: 'SPEAK', text: '应答' }])
    })
    it('REPLY_END/BARGE_IN/CONFIRM/CANCEL/TIMEOUT → 停留', () => {
      for (const t of ['REPLY_START', 'REPLY_END', 'BARGE_IN', 'CONFIRM', 'CANCEL', 'TIMEOUT'] as const) {
        const r = transition('listening', { type: t })
        expect(r.state).toBe('listening')
        expect(r.effects).toEqual([])
      }
    })
  })

  describe('recognizing', () => {
    it('ASR_INTERIM → 停留（不重复提交）', () => {
      const r = transition('recognizing', { type: 'ASR_INTERIM', text: '帮我冻结' })
      expect(r.state).toBe('recognizing')
      expect(r.effects).toEqual([])
    })
    it('ASR_FINAL → 停留 recognizing + SUBMIT_UTTERANCE 等应答', () => {
      const r = transition('recognizing', { type: 'ASR_FINAL', text: '冻结一号线', confidence: 0.95 })
      expect(r.state).toBe('recognizing')
      expect(r.effects).toEqual([{ type: 'SUBMIT_UTTERANCE', text: '冻结一号线', confidence: 0.95 }])
    })
    it('ASR_FINAL 空 → 回 listening 不提交', () => {
      const r = transition('recognizing', { type: 'ASR_FINAL', text: '' })
      expect(r.state).toBe('listening')
      expect(r.effects).toEqual([])
    })
    it('ACTION_READY 非确认 → speaking + SPEAK', () => {
      const r = transition('recognizing', { type: 'ACTION_READY', reply: '今天 3 条意图', needsConfirm: false })
      expect(r.state).toBe('speaking')
      expect(r.effects).toEqual([{ type: 'SPEAK', text: '今天 3 条意图' }])
    })
    it('ACTION_READY C 级复述 → confirming + SPEAK 复述', () => {
      const r = transition('recognizing', { type: 'ACTION_READY', reply: '复述：冻结一号线，确认吗', needsConfirm: true })
      expect(r.state).toBe('confirming')
      expect(r.effects).toEqual([{ type: 'SPEAK', text: '复述：冻结一号线，确认吗' }])
    })
    it('TIMEOUT → listening（识别停滞兜底，不提交）', () => {
      const r = transition('recognizing', { type: 'TIMEOUT' })
      expect(r.state).toBe('listening')
      expect(r.effects).toEqual([])
    })
    it('ASR_ERROR → idle + STOP_LISTENING', () => {
      const r = transition('recognizing', { type: 'ASR_ERROR' })
      expect(r.state).toBe('idle')
      expect(effectTypes(r)).toEqual(['STOP_LISTENING'])
    })
  })

  describe('speaking', () => {
    it('BARGE_IN → listening + STOP_SPEAK（interrupted→listening）', () => {
      const r = transition('speaking', { type: 'BARGE_IN' })
      expect(r.state).toBe('listening')
      expect(effectTypes(r)).toEqual(['STOP_SPEAK'])
    })
    it('REPLY_END → listening 无副作用（识别器全程未关）', () => {
      const r = transition('speaking', { type: 'REPLY_END' })
      expect(r.state).toBe('listening')
      expect(r.effects).toEqual([])
    })
    it('REPLY_START → 停留 speaking', () => {
      expect(transition('speaking', { type: 'REPLY_START' }).state).toBe('speaking')
    })
    it('播报中 ASR 帧不改状态（人声计数交给 BargeInDetector）', () => {
      expect(transition('speaking', { type: 'ASR_INTERIM', text: '等等' }).state).toBe('speaking')
      expect(transition('speaking', { type: 'ASR_FINAL', text: '等等' }).state).toBe('speaking')
    })
    it('流水线重叠：播报中新 ACTION_READY → 截旧播新', () => {
      const r = transition('speaking', { type: 'ACTION_READY', reply: '新回复', needsConfirm: false })
      expect(r.state).toBe('speaking')
      expect(r.effects).toEqual([{ type: 'SPEAK', text: '新回复' }])
    })
    it('EXIT → idle + 停识别停播报', () => {
      const r = transition('speaking', { type: 'EXIT' })
      expect(r.state).toBe('idle')
      expect(effectTypes(r)).toEqual(['STOP_LISTENING', 'STOP_SPEAK'])
    })
    it('ASR_ERROR → idle 回退', () => {
      const r = transition('speaking', { type: 'ASR_ERROR' })
      expect(r.state).toBe('idle')
      expect(effectTypes(r)).toEqual(['STOP_LISTENING', 'STOP_SPEAK'])
    })
    it('CONFIRM/CANCEL/TIMEOUT 在 speaking 无效', () => {
      for (const t of ['CONFIRM', 'CANCEL', 'TIMEOUT'] as const) {
        expect(transition('speaking', { type: t }).state).toBe('speaking')
      }
    })
  })

  describe('confirming（C 级复述：只被显式口令迁出）', () => {
    it('CONFIRM → speaking + CONFIRM_ACTION(confirm)', () => {
      const r = transition('confirming', { type: 'CONFIRM' })
      expect(r.state).toBe('speaking')
      expect(r.effects).toEqual([{ type: 'CONFIRM_ACTION', decision: 'confirm' }])
    })
    it('CANCEL → speaking + CONFIRM_ACTION(cancel)', () => {
      const r = transition('confirming', { type: 'CANCEL' })
      expect(r.state).toBe('speaking')
      expect(r.effects).toEqual([{ type: 'CONFIRM_ACTION', decision: 'cancel' }])
    })
    it('TIMEOUT 绝不迁出（C 级永不自动执行、永不超时放行）', () => {
      const r = transition('confirming', { type: 'TIMEOUT' })
      expect(r.state).toBe('confirming')
      expect(r.effects).toEqual([])
    })
    it('ASR_FINAL/ASR_INTERIM/ACTION_READY/REPLY_*/BARGE_IN/WAKE 全部停留', () => {
      const stuck: DuplexEvent[] = [
        { type: 'ASR_FINAL', text: '随便说点别的' },
        { type: 'ASR_FINAL', text: '确认' }, // 原始 final 不直接确认，须经组件口令预判映射为 CONFIRM
        { type: 'ASR_INTERIM', text: '嗯' },
        { type: 'ACTION_READY', reply: 'x', needsConfirm: false },
        { type: 'REPLY_START' },
        { type: 'REPLY_END' },
        { type: 'BARGE_IN' },
        { type: 'WAKE' },
      ]
      for (const ev of stuck) {
        const r = transition('confirming', ev)
        expect(r.state).toBe('confirming')
        expect(r.effects).toEqual([])
      }
    })
    it('ASR_ERROR → 停留 confirming + STOP_LISTENING（保住待确认上下文，按钮兜底）', () => {
      const r = transition('confirming', { type: 'ASR_ERROR' })
      expect(r.state).toBe('confirming')
      expect(effectTypes(r)).toEqual(['STOP_LISTENING'])
    })
    it('EXIT → idle（用户主动退回文本模式）', () => {
      const r = transition('confirming', { type: 'EXIT' })
      expect(r.state).toBe('idle')
      expect(effectTypes(r)).toEqual(['STOP_LISTENING', 'STOP_SPEAK'])
    })
  })
})

// ─── Barge-in：连续 2 帧人声才打断 ──────────────────────────────────────────

describe('BargeInDetector', () => {
  it('单帧人声不打断，连续 2 帧触发', () => {
    const d = createBargeInDetector(2)
    expect(d.feed(true)).toBe(false)
    expect(d.feed(true)).toBe(true)
  })
  it('中间夹静音帧则重新计数', () => {
    const d = createBargeInDetector(2)
    expect(d.feed(true)).toBe(false)
    expect(d.feed(false)).toBe(false) // 重置
    expect(d.streak).toBe(0)
    expect(d.feed(true)).toBe(false)
    expect(d.feed(true)).toBe(true)
  })
  it('reset 后需重新累计', () => {
    const d = createBargeInDetector(2)
    d.feed(true)
    d.feed(true)
    d.reset()
    expect(d.streak).toBe(0)
    expect(d.feed(true)).toBe(false)
  })
  it('打断链路：speaking + 2 帧人声（检测器）→ BARGE_IN → listening + STOP_SPEAK', () => {
    const d = createBargeInDetector(2)
    let state: DuplexState = 'speaking'
    // 第 1 帧：检测器未触发，状态机停留
    if (d.feed(true)) state = transition(state, { type: 'BARGE_IN' }).state
    expect(state).toBe('speaking')
    // 第 2 帧：触发打断
    if (d.feed(true)) {
      const r = transition(state, { type: 'BARGE_IN' })
      state = r.state
      expect(effectTypes(r)).toEqual(['STOP_SPEAK'])
    }
    expect(state).toBe('listening')
  })
})

// ─── 预解析 500ms 防抖：同句不重复发 ────────────────────────────────────────

describe('PreParseGate（interim 稳定 500ms 预解析）', () => {
  it('同一文本稳定满 500ms 触发一次', () => {
    const g = createPreParseGate(500)
    expect(g.feed('冻结一号线', 0)).toBeNull() // 首次出现，开始计时
    expect(g.feed('冻结一号线', 300)).toBeNull() // 未满 500ms
    expect(g.feed('冻结一号线', 500)).toBe('冻结一号线') // 触发
  })
  it('触发后同一文本不再重复发', () => {
    const g = createPreParseGate(500)
    g.feed('冻结一号线', 0)
    expect(g.feed('冻结一号线', 600)).toBe('冻结一号线')
    expect(g.feed('冻结一号线', 1200)).toBeNull() // 不重复
    expect(g.feed('冻结一号线', 5000)).toBeNull()
  })
  it('文本变化重置计时（interim 持续增长是常态）', () => {
    const g = createPreParseGate(500)
    g.feed('帮我', 0)
    g.feed('帮我冻结', 300)
    expect(g.feed('帮我冻结', 700)).toBeNull() // 距上次变化仅 400ms
    expect(g.feed('帮我冻结', 800)).toBe('帮我冻结')
  })
  it('空帧忽略且不影响计时', () => {
    const g = createPreParseGate(500)
    g.feed('查询库存', 0)
    expect(g.feed('', 200)).toBeNull()
    expect(g.feed('   ', 400)).toBeNull()
    expect(g.feed('查询库存', 500)).toBe('查询库存')
  })
  it('reset（final 到达）后可对同文本重新计时', () => {
    const g = createPreParseGate(500)
    g.feed('冻结一号线', 0)
    expect(g.feed('冻结一号线', 500)).toBe('冻结一号线')
    g.reset()
    expect(g.feed('冻结一号线', 600)).toBeNull() // 重新计时
    expect(g.feed('冻结一号线', 1100)).toBe('冻结一号线')
  })
})

// ─── 本地关键词预判（保守口令：宁漏不误）──────────────────────────────────────

describe('prejudgeUtterance', () => {
  it('整句短口令 → confirm/cancel', () => {
    expect(prejudgeUtterance('确认')).toEqual({ kind: 'confirm' })
    expect(prejudgeUtterance('确认。')).toEqual({ kind: 'confirm' })
    expect(prejudgeUtterance(' 好的！')).toEqual({ kind: 'confirm' })
    expect(prejudgeUtterance('取消')).toEqual({ kind: 'cancel' })
    expect(prejudgeUtterance('算了')).toEqual({ kind: 'cancel' })
  })
  it('长句含"确认"字样不误判为口令（防误执行 C 级）', () => {
    expect(prejudgeUtterance('帮我确认一下库存').kind).not.toBe('confirm')
    expect(prejudgeUtterance('确认单什么时候出').kind).not.toBe('confirm')
  })
  it('动作关键词预判 + 闲聊兜底', () => {
    expect(prejudgeUtterance('帮我把一号线冻结')).toEqual({ kind: 'action', actionHint: '冻结' })
    expect(prejudgeUtterance('今天心情怎么样')).toEqual({ kind: 'chat' })
    expect(prejudgeUtterance('')).toEqual({ kind: 'chat' })
  })
  it('normalizeUtterance 去句末标点', () => {
    expect(normalizeUtterance('确认！！')).toBe('确认')
    expect(normalizeUtterance(' 取消，')).toBe('取消')
  })
})
