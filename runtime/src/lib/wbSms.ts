import { useCallback, useEffect, useState } from 'react'

/**
 * wbSms —— M25 短信验证码注册/登录·前端纯逻辑层（工作台 WbLogin / 匠市门户 Login 双端复用，与 UI 解耦可单测）。
 *
 * 后端契约（并行开发中，以任务契约文档为准）：
 * - sms.sendCode {phone, purpose:'register'|'login'} → {ok:true, ttlSeconds:300}
 *   （dev 环境可能带 devCode——仅 import.meta.env.DEV 展示，生产隐藏）；
 * - sms.registerByPhone {phone, code, password(min8), realName?, inviteCode?} → SessionInfo；
 * - sms.loginByPhone {phone, code} → SessionInfo。
 * 三者为 public mutation（公开口无 token 概念），调用走 wbMutation（token 只 body 的红线不受影响）。
 * 红线：验证码输入 6 位数字；验证码/devCode/token 只存内存态，不打日志、不持久化。
 */

/** 手机号格式：1 开头 + 第二位 3-9 + 共 11 位数字（与既有门户注册 pattern 同口径） */
export const SMS_PHONE_RE = /^1[3-9]\d{9}$/

/** 短信验证码格式：6 位数字 */
export const SMS_CODE_RE = /^\d{6}$/

/** 发送冷却时长（秒）：发送成功后 60s 内禁止重复发送 */
export const SMS_SEND_COOLDOWN_SECONDS = 60

/** 短信验证码用途（sms.sendCode purpose 枚举） */
export type SmsPurpose = 'register' | 'login' | 'beta_apply'

/** sms.sendCode 响应（devCode 仅 dev 环境携带，前端生产隐藏） */
export interface SmsSendCodeResult {
  ok: true
  ttlSeconds: number
  devCode?: string
}

export function phoneValid(input: string | null | undefined): boolean {
  return typeof input === 'string' && SMS_PHONE_RE.test(input.trim())
}

export function codeValid(input: string | null | undefined): boolean {
  return typeof input === 'string' && SMS_CODE_RE.test(input.trim())
}

/** 发送冷却状态：remaining=0 即空闲可发送 */
export interface SmsCooldown {
  remaining: number
}

/** 空闲态（初始 / 倒计时归零） */
export const SMS_COOLDOWN_IDLE: SmsCooldown = { remaining: 0 }

/** 发送成功后调用：启动 60s 冷却 */
export function startSmsCooldown(): SmsCooldown {
  return { remaining: SMS_SEND_COOLDOWN_SECONDS }
}

/** 每秒 tick：剩余秒数递减，下限 0（不会变负） */
export function tickSmsCooldown(state: SmsCooldown): SmsCooldown {
  return { remaining: Math.max(0, state.remaining - 1) }
}

/** 是否可发送（冷却归零才可再次点击，防重复点击） */
export function canSendSmsCode(state: SmsCooldown): boolean {
  return state.remaining <= 0
}

/** 发送按钮文案：空闲「发送验证码」，冷却中「Ns 后重发」 */
export function smsCountdownText(state: SmsCooldown): string {
  return state.remaining <= 0 ? '发送验证码' : `${state.remaining}s 后重发`
}

/**
 * devCode 可见性：仅开发环境（import.meta.env.DEV）且响应确实携带 devCode 时展示。
 * 生产环境一律隐藏（后端生产也不会下发，此处做前端兜底红线）。
 */
export function smsDevCodeVisible(isDev: boolean, devCode?: string | null): boolean {
  return isDev === true && typeof devCode === 'string' && devCode.length > 0
}

/**
 * React 冷却 hook（页面复用）：start() 启动 60s 倒计时，每秒 tick 递减，归零自动停。
 * 返回 { cooldown, start }——按钮 disabled 用 canSendSmsCode(cooldown)，文案用 smsCountdownText(cooldown)。
 */
export function useSmsCooldown() {
  const [cooldown, setCooldown] = useState<SmsCooldown>(SMS_COOLDOWN_IDLE)
  useEffect(() => {
    if (cooldown.remaining <= 0) return
    const timer = setTimeout(() => setCooldown((c) => tickSmsCooldown(c)), 1000)
    return () => clearTimeout(timer)
  }, [cooldown])
  // reset 面（门禁票：换号冷却重置用）——useCallback 稳定引用（effect deps 不抖动）
  const reset = useCallback(() => setCooldown(SMS_COOLDOWN_IDLE), [])
  return { cooldown, start: () => setCooldown(startSmsCooldown()), reset }
}
