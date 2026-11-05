/**
 * wbSms 纯逻辑用例（M25）：手机号/验证码校验、60s 发送冷却状态机、devCode 可见性。
 * 工作台 WbLogin 短信登录 Tab 与匠市门户 Login 短信注册/登录共用同一套口径。
 */
import { describe, expect, it } from 'vitest'
import {
  SMS_COOLDOWN_IDLE,
  SMS_SEND_COOLDOWN_SECONDS,
  canSendSmsCode,
  codeValid,
  phoneValid,
  smsCountdownText,
  smsDevCodeVisible,
  startSmsCooldown,
  tickSmsCooldown,
} from './wbSms'

describe('phoneValid（^1[3-9]\\d{9}$）', () => {
  it('接受合法手机号（宽容 trim）', () => {
    expect(phoneValid('13812345678')).toBe(true)
    expect(phoneValid('19900001111')).toBe(true)
    expect(phoneValid('  13712345678 ')).toBe(true)
  })
  it('拒绝非法手机号（号段/长度/非数字/空）', () => {
    expect(phoneValid('12812345678')).toBe(false) // 第二位 2 不在 3-9
    expect(phoneValid('1381234567')).toBe(false) // 10 位
    expect(phoneValid('138123456789')).toBe(false) // 12 位
    expect(phoneValid('1381234567a')).toBe(false)
    expect(phoneValid('')).toBe(false)
    expect(phoneValid(null)).toBe(false)
    expect(phoneValid(undefined)).toBe(false)
  })
})

describe('codeValid（6 位数字）', () => {
  it('接受 6 位数字验证码', () => {
    expect(codeValid('123456')).toBe(true)
    expect(codeValid('000000')).toBe(true)
    expect(codeValid(' 654321 ')).toBe(true)
  })
  it('拒绝非 6 位数字（长度/字母/空）', () => {
    expect(codeValid('12345')).toBe(false)
    expect(codeValid('1234567')).toBe(false)
    expect(codeValid('12a456')).toBe(false)
    expect(codeValid('')).toBe(false)
    expect(codeValid(null)).toBe(false)
    expect(codeValid(undefined)).toBe(false)
  })
})

describe('发送冷却状态机（60s 倒计时）', () => {
  it('发送成功后启动 60s 冷却，冷却中不可再发', () => {
    const cd = startSmsCooldown()
    expect(cd.remaining).toBe(SMS_SEND_COOLDOWN_SECONDS)
    expect(SMS_SEND_COOLDOWN_SECONDS).toBe(60)
    expect(canSendSmsCode(cd)).toBe(false)
  })
  it('tick 每秒递减，归零后回到可发送态', () => {
    let cd = startSmsCooldown()
    cd = tickSmsCooldown(cd)
    expect(cd.remaining).toBe(SMS_SEND_COOLDOWN_SECONDS - 1)
    for (let i = 0; i < SMS_SEND_COOLDOWN_SECONDS; i += 1) cd = tickSmsCooldown(cd)
    expect(cd.remaining).toBe(0)
    expect(canSendSmsCode(cd)).toBe(true)
  })
  it('tick 不会变负（空闲态 tick 仍为 0）', () => {
    expect(tickSmsCooldown(SMS_COOLDOWN_IDLE).remaining).toBe(0)
  })
})

describe('smsCountdownText 按钮文案', () => {
  it('空闲态显示「发送验证码」', () => {
    expect(smsCountdownText(SMS_COOLDOWN_IDLE)).toBe('发送验证码')
  })
  it('冷却中显示剩余秒数', () => {
    expect(smsCountdownText(startSmsCooldown())).toBe('60s 后重发')
    expect(smsCountdownText({ remaining: 1 })).toBe('1s 后重发')
  })
})

describe('smsDevCodeVisible（devCode 仅开发环境展示）', () => {
  it('开发环境且携带 devCode → 可见', () => {
    expect(smsDevCodeVisible(true, '123456')).toBe(true)
  })
  it('生产环境一律隐藏（即使响应带 devCode）', () => {
    expect(smsDevCodeVisible(false, '123456')).toBe(false)
  })
  it('开发环境但无 devCode → 不展示', () => {
    expect(smsDevCodeVisible(true, undefined)).toBe(false)
    expect(smsDevCodeVisible(true, null)).toBe(false)
    expect(smsDevCodeVisible(true, '')).toBe(false)
  })
})
