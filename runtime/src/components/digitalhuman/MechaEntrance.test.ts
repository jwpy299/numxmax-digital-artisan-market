import { describe, expect, it } from 'vitest'
import {
  buildOpenBuddyDetail,
  pickMechaEntrance,
  resolveMechaEntranceChoice,
} from './MechaEntrance'

describe('M13.5 共享 MechaEntrance 纯逻辑（选人/声线/detail 构造）', () => {
  it('按时段选人：<12 灵枢，≥18 星云，午后随机可注入', () => {
    expect(pickMechaEntrance(8).persona).toBe('lingshu')
    expect(pickMechaEntrance(19).persona).toBe('xingyun')
    expect(pickMechaEntrance(14, () => 0.2).persona).toBe('lingshu')
    expect(pickMechaEntrance(14, () => 0.8).persona).toBe('xingyun')
  })

  it('声线区分：灵枢 1.0/1.0，星云 0.95/0.9', () => {
    expect([pickMechaEntrance(9).rate, pickMechaEntrance(9).pitch]).toEqual([1.0, 1.0])
    expect([pickMechaEntrance(20).rate, pickMechaEntrance(20).pitch]).toEqual([0.95, 0.9])
  })

  it('resolveMechaEntranceChoice：固定人格时忽略时段与随机源', () => {
    const c = resolveMechaEntranceChoice(20, { persona: 'lingshu' })
    expect(c.persona).toBe('lingshu')
    expect(c.line).toContain('我是灵枢')
    expect(c.video).toBe('/ip/video/m15-lingshu-greet.mp4')
    expect(c.hero).toBe('/ip/m15/lingshu-hero.png')
  })

  it('resolveMechaEntranceChoice：welcomeText 覆盖文案但声线仍随人格', () => {
    const c = resolveMechaEntranceChoice(9, {
      persona: 'lingshu',
      welcomeText: '自定义欢迎语',
    })
    expect(c.line).toBe('自定义欢迎语')
    expect([c.rate, c.pitch]).toEqual([1.0, 1.0])
    const x = resolveMechaEntranceChoice(20, { welcomeText: '自定义欢迎语' })
    expect(x.persona).toBe('xingyun')
    expect(x.line).toBe('自定义欢迎语')
    expect([x.rate, x.pitch]).toEqual([0.95, 0.9])
  })

  it('buildOpenBuddyDetail：携带 persona 且 speakGreeting 恒为 false（防截断入场欢迎语）', () => {
    expect(buildOpenBuddyDetail(resolveMechaEntranceChoice(9, { persona: 'lingshu' }))).toEqual({
      persona: 'lingshu',
      speakGreeting: false,
    })
  })
})
