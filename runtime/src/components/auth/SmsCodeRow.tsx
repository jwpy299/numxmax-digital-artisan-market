/**
 * SmsCodeRow —— 短信验证码行共享件（罚单归一：Login/ApplyBeta 双引，不再复刻）。
 * 从 pages/Login.tsx 抽出（原 M25 面）——逻辑零改：发送验证码+60s 冷却+devCode 回显。
 */
import { useEffect, useRef, useState } from 'react'
import { canSendSmsCode, phoneValid, smsCountdownText, smsDevCodeVisible, useSmsCooldown, type SmsPurpose, type SmsSendCodeResult } from '@/lib/wbSms'
import { wbMutation, wbErrorMessage } from '@/lib/wbSession'
import { cn } from '@/lib/utils'
import { wbInputCls, wbLabelCls } from '@/components/wb/ui'

// ─── 验证码输入行（登录 / 注册两路复用）：数字键盘 + maxLength 6 + 60s 倒计时发送按钮 ───
export function SmsCodeRow({
  phone,
  purpose,
  code,
  onCodeChange,
  codeRequired = true,
}: {
  phone: string
  purpose: SmsPurpose
  code: string
  onCodeChange: (v: string) => void
  /** 复用/恢复面传 false（门禁票：required 原生拦提交=免码分支不可达）——外层 handleSubmit 校验兜底 */
  codeRequired?: boolean
}) {
    const [devCode, setDevCode] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)


  const { cooldown, start, reset } = useSmsCooldown()

  // 换号重置组件内状态（门禁票：key=phone 每击键重挂载雷拆除——内部重置替代）
  const prevPhoneRef = useRef(phone)
  useEffect(() => {
    if (prevPhoneRef.current !== phone) {
      prevPhoneRef.current = phone
      setDevCode(null)
      setSendError(null)
      setSending(false) // 进行中发送作废（门禁票：换号后旧响应不回写新号面——stale race 封堵）
      reset() // 冷却同重置（后端限流按号）
    }
  }, [phone, reset])

  /** 发送验证码：本地先校验手机号，成功启动 60s 冷却（canSendSmsCode+disabled 防重复点击） */
  async function handleSend() {
    setSendError(null)
    const p = phone.trim()
    const sendFor = p // 快照——响应回来时若已换号则不落（stale race 门禁票）
    if (!phoneValid(p)) {
      setSendError('请填写正确的手机号')
      return
    }
    if (!canSendSmsCode(cooldown) || sending) return
    setSending(true)
    try {
      const res = await wbMutation<SmsSendCodeResult>('sms.sendCode', { phone: p, purpose })
      if (prevPhoneRef.current.trim() !== sendFor) return // 已换号——旧号响应丢弃（冷却/devCode 不落）
      start()
      setDevCode(res.devCode ?? null)
    } catch (err) {
      setSendError(wbErrorMessage(err))
    } finally {
      setSending(false)
    }
  }

  return (
    <div>
      <label className={wbLabelCls}>短信验证码</label>
      <div className="flex gap-2">
        <input
          className={cn(wbInputCls, 'flex-1')}
          value={code}
          onChange={(e) => onCodeChange(e.target.value)}
          placeholder="6 位验证码"
          inputMode="numeric"
          maxLength={6}
          required={codeRequired}
        />
        <button
          type="button"
          disabled={!canSendSmsCode(cooldown) || sending}
          onClick={() => void handleSend()}
          className="shrink-0 rounded-[10px] border border-pulse-cyan/40 px-4 text-sm text-pulse-cyan transition-colors hover:bg-pulse-cyan/10 disabled:opacity-40"
        >
          {sending && canSendSmsCode(cooldown) ? '发送中…' : smsCountdownText(cooldown)}
        </button>
      </div>
      {smsDevCodeVisible(import.meta.env.DEV, devCode) && (
        <p className="mt-1.5 text-[11px] text-amber-400/80">开发环境验证码：{devCode}</p>
      )}
      {sendError && <p className="mt-1.5 text-[11px] text-red-400">{sendError}</p>}
    </div>
  )
}
