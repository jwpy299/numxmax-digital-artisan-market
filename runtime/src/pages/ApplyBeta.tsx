/**
 * ApplyBeta（/apply）—— 邀请内测报名通道（彭总 2026-10-01 令）。
 * 表单：企业名/联系人/手机号（短信验证码验真）/行业/规模/一句话需求 → betaApply.submit 落台账 pending；
 * 超终审批（/admin/beta）批准即签 iv_ 码——短信通知挂账 P-SMS-TPL（模板审批在途）。
 */
import { useState, type FormEvent } from 'react'
import { phoneValid, codeValid } from '@/lib/wbSms'
import { SmsCodeRow } from '@/components/auth/SmsCodeRow'
import { wbMutation } from '@/lib/wbSession'
import { Link } from 'react-router'
import { Loader2, Send, CheckCircle2 } from 'lucide-react'
import HudCorner from '@/components/HudCorner'
import { cn } from '@/lib/utils'

const INDUSTRY_OPTIONS = [
  '工业制造', '跨境电商', '设计创意', '财税服务', '软件服务', '通用经营',
  '法律合规', '教育培训', '医疗健康', '农业服务', '建筑工程', '物流供应链', '其他（科技类企业）',
] as const
const HEADCOUNT_OPTIONS = ['1-9 人', '10-49 人', '50-199 人', '200-499 人', '500 人以上'] as const

const inputCls =
  'w-full rounded-[10px] border border-line-subtle bg-panel/60 px-3.5 py-2.5 text-sm text-ink-primary placeholder:text-ink-faint'
const labelCls = 'mb-1.5 block text-xs font-medium text-ink-secondary'

export default function ApplyBeta() {
  const [form, setForm] = useState({
    enterpriseName: '', contactName: '', phone: '', code: '', industry: '', headcount: '', need: '',
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const canSubmit =
    form.enterpriseName.trim().length >= 2 && form.contactName.trim().length >= 1 &&
    phoneValid(form.phone) && codeValid(form.code) &&
    form.industry !== '' && form.headcount !== '' && form.need.trim().length >= 1

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!canSubmit || busy) return
    setBusy(true)
    setErr(null)
    try {
      await wbMutation('betaApply.submit', {
        enterpriseName: form.enterpriseName.trim(), contactName: form.contactName.trim(),
        phone: form.phone.trim(), code: form.code.trim(),
        industry: form.industry, headcount: form.headcount, need: form.need.trim(),
      })
      setDone(true)
    } catch (error) {
      setErr(error instanceof Error ? error.message : '提交失败，稍后再试')
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <div className="flex min-h-[70vh] items-center justify-center px-4">
        <div className="cyber-glow-card relative w-full max-w-md rounded-2xl bg-zinc-950/85 p-8 text-center">
          <HudCorner />
          <CheckCircle2 className="mx-auto h-12 w-12 text-jade-green" />
          <p className="mt-4 text-lg font-semibold text-ink-primary">报名已收到</p>
          <p className="mt-2 text-sm leading-relaxed text-ink-secondary">
            首批 100 家工厂内测通道——我们会在 1-2 个工作日内完成审核，
            通过后内测邀请码（iv_ 开头）将短信发放到你手机。
          </p>
          {/* 彭总 2026-10-02 令链路：门户报名→短信拿邀测码→电脑下载桌面工作台→注册填码→登录后扫码下载 APP（桌面端先行，APP 靠扫码） */}
          <div className="mt-5 rounded-xl border border-line-subtle bg-black/30 p-4 text-left">
            <p className="text-xs font-semibold text-ink-primary">拿到邀测码后的三步：</p>
            <ol className="mt-2 list-inside list-decimal space-y-1.5 text-xs leading-relaxed text-ink-secondary">
              <li>电脑访问本门户，下载桌面智能工作台（Windows 版安装程序）</li>
              <li>安装后注册——注册面填你的邀测码（iv_ 开头）</li>
              <li>登录进工作台后，微信或手机相机扫工作台里的二维码下载手机 APP</li>
            </ol>
          </div>
          <div className="mt-4 space-y-2.5">
            <a href="https://downloads.example.invalid/?from=apply#download"
              className="block rounded-[10px] bg-amber-gradient px-8 py-3 text-center text-sm font-semibold text-[#1A1206]">
              电脑端去门户下载桌面工作台
            </a>
            <Link to="/" className="block text-center text-xs text-ink-faint hover:text-ink-secondary">回门户首页</Link>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-xl px-5 pb-[72px] pt-12 md:px-8">
      <p className="hud-label text-forge-amber/80">CLOSED BETA · 首批 100 家</p>
      <h1 className="mt-2 font-display text-3xl font-bold text-ink-primary">申请内测资格</h1>
      <p className="mt-2 text-sm leading-relaxed text-ink-secondary">
        首批 100 家工厂内测通道开放中——首月雇佣费 5 折。填表+手机验真即报，
        审核通过发内测邀请码（1-2 个工作日）。
      </p>

      <form onSubmit={submit} className="cyber-glow-card relative mt-8 space-y-4 rounded-2xl bg-zinc-950/80 p-6 text-left">
        <HudCorner />
        <div>
          <label className={labelCls}>企业名称</label>
          <input className={inputCls} value={form.enterpriseName} maxLength={64} required
            onChange={(e) => setForm({ ...form, enterpriseName: e.target.value })} placeholder="如：星云智造示范工厂" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>联系人</label>
            <input className={inputCls} value={form.contactName} maxLength={32} required
              onChange={(e) => setForm({ ...form, contactName: e.target.value })} placeholder="负责人姓名" />
          </div>
          <div>
            <label className={labelCls}>手机号</label>
            <input className={inputCls} value={form.phone} inputMode="numeric" maxLength={11} required
              onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="接收内测码用" autoComplete="tel" />
          </div>
        </div>
        <SmsCodeRow phone={form.phone} purpose="beta_apply" code={form.code} onCodeChange={(v) => setForm({ ...form, code: v })} />
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>所属行业</label>
            <select className={cn(inputCls, 'appearance-none')} value={form.industry} required
              onChange={(e) => setForm({ ...form, industry: e.target.value })}>
              <option value="" disabled>选择行业</option>
              {INDUSTRY_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>人员规模</label>
            <select className={cn(inputCls, 'appearance-none')} value={form.headcount} required
              onChange={(e) => setForm({ ...form, headcount: e.target.value })}>
              <option value="" disabled>选择规模</option>
              {HEADCOUNT_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>
        </div>
        <div>
          <label className={labelCls}>你最想数字员工干什么（一句话）</label>
          <textarea className={cn(inputCls, 'min-h-[84px]')} value={form.need} maxLength={500} required
            onChange={(e) => setForm({ ...form, need: e.target.value })}
            placeholder="如：帮我们把财务月底结账从 3 天压到半天" />
        </div>
        {err && <p className="text-sm text-ember-red">{err}</p>}
        <button type="submit" disabled={!canSubmit || busy}
          className="flex w-full items-center justify-center gap-2 rounded-[10px] bg-amber-gradient py-3 text-base font-semibold text-[#1A1206] disabled:opacity-40">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          提交内测申请
        </button>
        <p className="text-center text-[11px] text-ink-faint">
          提交即同意《用户协议》与《隐私政策》· 同号重报自动更新不重复开单
        </p>
      </form>
    </div>
  )
}
