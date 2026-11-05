import { describe, expect, it } from 'vitest'
import { poseByEmotion, resolveOpenBuddyDetail } from './VoiceBuddy'

describe('M13.5 resolveOpenBuddyDetail（wb:open-buddy 事件 detail 解析）', () => {
  it('detail 为空 / 未携带时：默认灵枢且照常播报开场', () => {
    expect(resolveOpenBuddyDetail(undefined)).toEqual({ persona: 'lingshu', silentGreeting: false })
    expect(resolveOpenBuddyDetail(null)).toEqual({ persona: 'lingshu', silentGreeting: false })
    expect(resolveOpenBuddyDetail({})).toEqual({ persona: 'lingshu', silentGreeting: false })
  })

  it('入场层唤起 { persona, speakGreeting: false }：随人走且本轮开场静默（只上屏不 TTS）', () => {
    expect(resolveOpenBuddyDetail({ persona: 'lingshu', speakGreeting: false })).toEqual({
      persona: 'lingshu',
      silentGreeting: true,
    })
    expect(resolveOpenBuddyDetail({ persona: 'xingyun', speakGreeting: false })).toEqual({
      persona: 'xingyun',
      silentGreeting: true,
    })
  })

  it('仅显式 false 才静默：true / 其它 falsy 值不影响默认播报行为（手动打开面板仍播报）', () => {
    expect(resolveOpenBuddyDetail({ persona: 'xingyun' }).silentGreeting).toBe(false)
    expect(resolveOpenBuddyDetail({ speakGreeting: true }).silentGreeting).toBe(false)
    expect(resolveOpenBuddyDetail({ speakGreeting: 0 }).silentGreeting).toBe(false)
    expect(resolveOpenBuddyDetail({ speakGreeting: 'false' }).silentGreeting).toBe(false)
  })

  it('persona 非法值回退灵枢', () => {
    expect(resolveOpenBuddyDetail({ persona: 'panda' }).persona).toBe('lingshu')
    expect(resolveOpenBuddyDetail({ persona: 42 }).persona).toBe('lingshu')
  })
})

describe('M15 二期 poseByEmotion speak 帧接线（播报中→speak）', () => {
  it('播报中优先返回 speak（加载中 think 优先级更高）', () => {
    expect(poseByEmotion('lingshu', null, false, true)).toBe('speak')
    expect(poseByEmotion('xingyun', 'joy', false, true)).toBe('speak')
    expect(poseByEmotion('xingyun', 'urgent', false, true)).toBe('speak')
    expect(poseByEmotion('lingshu', null, true, true)).toBe('think')
  })
  it('未播报时保持原映射（回归）', () => {
    expect(poseByEmotion('lingshu', null, false)).toBe('wave')
    expect(poseByEmotion('xingyun', 'urgent', false)).toBe('guard')
    expect(poseByEmotion('xingyun', 'joy', false)).toBe('wave')
  })
})
