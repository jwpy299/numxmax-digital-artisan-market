/**
 * DailyCodeCard —— 今日邀测口令卡（彭总 2026-10-23 令：每日口令造势面——每天 10-20 家企业名额，
 * 口令公开挂门户，口令+手机号+短信验证码 → 自动生成专属邀测码 iv_[enterprise 通道，72h 有效]）。
 *
 * 闭环面：看口令（复制）→ 兑码（手机号+OTP）→ 拿专属码（仅此一次显示）→ 引导注册开户（门户/桌面端同链）。
 * 与下方报名审核链并行不替（定向客户面不动——口令链=公开自助面）。
 * 诚实面：接口未达=卡不显（不装死）；名额完/已兑/口令错=服务端文案原样透出。
 */
import { useEffect, useState } from 'react'
import { wbQuery, wbMutation, wbErrorMessage } from '@/lib/wbSession'
import { phoneValid, codeValid } from '@/lib/wbSms' // 单源校验件（HeroSection/ApplyBeta 同引面）
import { SmsCodeRow } from '@/components/auth/SmsCodeRow'

interface TodayResp { date: string; codeText: string; quota: number; left: number }

export function DailyCodeCard() {
  const [today, setToday] = useState<TodayResp | null>(null)
  const [dead, setDead] = useState(false)
  const [copied, setCopied] = useState(false)

  // 兑码面
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [issued, setIssued] = useState<string | null>(null) // 专属码明文（仅此一次显示——不落库不落日志）

  useEffect(() => {
    wbQuery<TodayResp>('betaDaily.today')
      .then((d) => { if (d?.codeText) setToday(d) })
      .catch(() => setDead(true)) // 未达=卡不显（诚实面——不报红不装空口令）
  }, [])

  if (dead || !today) return null

  const copy = async () => {
    try { await navigator.clipboard.writeText(today.codeText); setCopied(true); setTimeout(() => setCopied(false), 1600) } catch { /* 剪贴板拒=静默 */ }
  }

  const redeem = async () => {
    if (busy) return
    if (!phoneValid(phone)) { setErr('手机号格式不正确'); return }
    if (!codeValid(code)) { setErr('验证码格式不正确'); return }
    setBusy(true); setErr(null)
    try {
      const r = await wbMutation<{ ok: boolean; code: string }>('betaDaily.redeem', { codeText: today.codeText, phone: phone.trim(), smsCode: code.trim() })
      if (r?.ok && r.code) {
        setIssued(r.code)
        setToday((t) => (t ? { ...t, left: Math.max(0, t.left - 1) } : t)) // 余量乐观面（真面在服务端原子扣）
      }
    } catch (e) {
      setErr(wbErrorMessage(e)) // 服务端文案原样透出（口令错/名额完/已兑三面明话）
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto mt-8 max-w-xl rounded-2xl border border-nebula-violet/40 bg-panel/60 p-6 text-left backdrop-blur">
      <div className="flex items-baseline justify-between">
        <p className="hud-label text-nebula-violet/90">今日邀测口令 · 企业内测</p>
        <p className="font-mono text-xs text-ink-secondary">名额余 {today.left}/{today.quota}</p>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <span className="flex-1 rounded-xl border border-dashed border-nebula-violet/50 bg-deep/80 px-4 py-3 text-center font-display text-2xl font-bold tracking-[0.3em] text-ink-primary">
          {today.codeText}
        </span>
        <button
          type="button"
          onClick={() => void copy()}
          className="rounded-lg border border-nebula-violet/50 px-3 py-2 text-xs font-semibold text-nebula-violet transition hover:bg-nebula-violet/10"
        >
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-ink-secondary">
        每日 0 点换新口令、新名额（今日 {today.quota} 家企业）——口令+手机号兑专属邀测码，凭码注册开户（72 小时内有效）。
      </p>

      {!issued ? (
        <div className="mt-4 space-y-3 border-t border-line-subtle pt-4">
          <div>
            <label className="mb-1 block text-xs text-ink-secondary">手机号（专属码绑此号——防转借）</label>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="11 位手机号"
              className="w-full rounded-lg border border-line-subtle bg-deep/70 px-3 py-2 text-sm text-ink-primary outline-none focus:border-nebula-violet"
            />
          </div>
          <SmsCodeRow phone={phone} purpose="register" code={code} onCodeChange={setCode} />
          {err ? <p className="text-xs text-red-400">{err}</p> : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => void redeem()}
            className="w-full rounded-lg bg-gradient-to-r from-nebula-violet to-pulse-cyan px-4 py-2.5 text-sm font-bold text-white transition disabled:opacity-50"
          >
            {busy ? '兑换中…' : '口令兑专属邀测码'}
          </button>
        </div>
      ) : (
        <div className="mt-4 rounded-xl border border-jade-green/50 bg-jade-green/10 p-4">
          <p className="text-xs font-semibold text-jade-green">专属邀测码已生成（仅此一次显示——立即复制保存，72 小时内注册开户有效）</p>
          <p className="mt-2 break-all rounded-lg bg-deep/80 px-3 py-2 font-mono text-sm text-ink-primary">{issued}</p>
          <button
            type="button"
            onClick={() => { void navigator.clipboard.writeText(issued).catch(() => {}) }}
            className="mt-2 rounded-lg border border-jade-green/60 px-3 py-1.5 text-xs font-semibold text-jade-green"
          >
            复制专属码
          </button>
          <p className="mt-3 text-xs leading-relaxed text-ink-secondary">
            下一步：门户右上角「注册」或桌面端「NumX Max 组织智能体运行时」安装包注册屏——邀测码栏填入此码即开户（开户成=行业包自动组建五舱+全员上岗）。
          </p>
        </div>
      )}
    </div>
  )
}
