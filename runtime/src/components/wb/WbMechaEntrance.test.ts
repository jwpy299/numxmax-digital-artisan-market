import { describe, expect, it } from 'vitest'
import { MECHA_SESSION_KEY, buildOpenBuddyDetail, pickMechaEntrance } from './WbMechaEntrance'

describe('M13.5 pickMechaEntrance（按时段选数字人）', () => {
  it('上午（<12）选灵枢', () => {
    for (const h of [0, 5, 11]) {
      expect(pickMechaEntrance(h).persona).toBe('lingshu')
    }
  })

  it('晚间（≥18）选星云', () => {
    for (const h of [18, 21, 23]) {
      expect(pickMechaEntrance(h).persona).toBe('xingyun')
    }
  })

  it('午后时段按随机源选人（可注入，结果确定）', () => {
    expect(pickMechaEntrance(14, () => 0.1).persona).toBe('lingshu')
    expect(pickMechaEntrance(14, () => 0.9).persona).toBe('xingyun')
  })

  it('声线区分：灵枢 1.0/1.0，星云 0.95/0.9（更低更缓）', () => {
    const l = pickMechaEntrance(9)
    const x = pickMechaEntrance(20)
    expect([l.rate, l.pitch]).toEqual([1.0, 1.0])
    expect([x.rate, x.pitch]).toEqual([0.95, 0.9])
  })

  it('文案自称与素材路径随人走', () => {
    const l = pickMechaEntrance(9)
    const x = pickMechaEntrance(20)
    expect(l.line).toContain('我是灵枢')
    expect(x.line).toContain('我是星云')
    expect(l.video).toBe('/ip/video/m15-lingshu-greet.mp4')
    expect(x.video).toBe('/ip/video/m15-xingyun-greet.mp4')
    expect(l.hero).toBe('/ip/m15/lingshu-hero.png')
    expect(x.hero).toBe('/ip/m15/xingyun-hero.png')
  })

  it('会话标记键固定为 wb_mecha_entered', () => {
    expect(MECHA_SESSION_KEY).toBe('wb_mecha_entered')
  })
})

describe('M13.5 buildOpenBuddyDetail（入场唤起 buddy 的事件 detail）', () => {
  it('携带 persona 且 speakGreeting 恒为 false（本轮 buddy 开场只上屏不播报，防截断入场欢迎语）', () => {
    expect(buildOpenBuddyDetail(pickMechaEntrance(9))).toEqual({
      persona: 'lingshu',
      speakGreeting: false,
    })
    expect(buildOpenBuddyDetail(pickMechaEntrance(20))).toEqual({
      persona: 'xingyun',
      speakGreeting: false,
    })
  })
})
