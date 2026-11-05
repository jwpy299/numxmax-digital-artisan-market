/**
 * PortalRegisterForms —— 门户注册双表单（波四·注册归位 2026-10-01）。
 *
 * 企业注册（简化建厂接引）：企业名/行业/规模三问 + 账号密码 → agentic.authRegister
 *   （默认六部 bootstrapped+DSH 部门台配置自动生成）→ 成功页接桌面端下载；
 * 个人注册（M25 短信链）：手机号+验证码+密码（姓名/邀请码可选）→ sms.registerByPhone → 成功页双下载位。
 *
 * 纪律：
 * - 成功页下载位不再过内测闸（注册用户=已入驻身份，beta 闸只拦游客）；
 * - APP 通道双轨保留（小字提示，不阻断网页注册——彭总 9-30 口径：桌面端 PC 先行）；
 * - 数字全从真接口出（deptCount 用 authRegister 返回真值，不写死）。
 */
import { PKG_DL_ORG as PKG_ORG } from '@contracts/portal' // portal#108 散挂面收口
import { useState, type FormEvent, type ReactElement } from 'react'
import { Loader2, Building2, UserRound, CheckCircle2, Download } from 'lucide-react'
import { wbMutation, wbErrorMessage, type WbSession } from '@/lib/wbSession'
import { wbInputCls, wbLabelCls } from '@/components/wb/ui'
import { cn } from '@/lib/utils'

/** 行业选项（对齐花名册 12 馆+其他自填） */
const INDUSTRY_OPTIONS = [
  '工业制造', '跨境电商', '设计创意', '财税服务', '软件服务', '通用经营',
  '法律合规', '教育培训', '医疗健康', '农业服务', '建筑工程', '物流供应链', '其他',
] as const

const HEADCOUNT_OPTIONS = ['1-9 人', '10-49 人', '50-199 人', '200-499 人', '500 人以上'] as const

/** APP 下载（读发布通道 json 后跳真包——与首页同链） */
function downloadApp() {
  fetch('/app-release.json', { cache: 'no-store' }) // portal#112：同律——注册面 APP 链也绕启发式缓存
    .then((r) => r.json())
    .then((d) => { if (d?.url) window.location.href = d.url })
    .catch(() => {})
}

/** 成功视图（两表单共用）：下载位+继续钮 */
function RegisterDone({
  title,
  lines,
  downloads,
  onContinue,
  continueText,
}: {
  title: string
  lines: string[]
  downloads: { label: string; href?: string; onClick?: () => void }[]
  onContinue: () => void
  continueText: string
}) {
  return (
    <div className="space-y-5 text-center">
      <CheckCircle2 className="mx-auto h-12 w-12 text-jade-green" />
      <div>
        <p className="text-lg font-semibold text-ink-primary">{title}</p>
        {lines.map((l) => (
          <p key={l} className="mt-1.5 text-sm text-ink-secondary">{l}</p>
        ))}
      </div>
      <div className="space-y-2.5 rounded-[14px] border border-amber-400/25 bg-amber-400/[0.05] p-4">
        <p className="text-xs text-ink-faint">装机开工（桌面端 PC 先行）</p>
        {downloads.map((d) => (
          <button
            key={d.label}
            onClick={d.onClick ?? (() => { if (d.href) window.location.href = d.href! })}
            className="flex w-full items-center justify-center gap-2 rounded-[10px] border border-jade-green/40 bg-jade-green/[0.08] px-4 py-2.5 text-sm font-medium text-jade-green transition-colors hover:bg-jade-green/[0.15]"
          >
            <Download className="h-4 w-4" /> {d.label}
          </button>
        ))}
        <button
          onClick={downloadApp}
          className="flex w-full items-center justify-center gap-1.5 rounded-[10px] px-4 py-2 text-xs text-ink-faint transition-colors hover:text-pulse-cyan"
        >
          <Download className="h-3.5 w-3.5" /> 或在手机装 NumX Max APP（企业版/个人版自动适配）
        </button>
      </div>
      <button
        onClick={onContinue}
        className="w-full rounded-[10px] bg-amber-400 py-3 text-base font-semibold text-zinc-950 transition-colors hover:bg-amber-300"
      >
        {continueText}
      </button>
    </div>
  )
}

/** 企业注册表单（简化建厂接引） */
export function EntRegisterForm({ onSuccess }: { onSuccess: (s: WbSession) => void }) {
  const [form, setForm] = useState({
    enterpriseName: '', industry: '', industryText: '', headcount: '',
    username: '', password: '', displayName: '', betaCode: '', // portal#116：邀测码栏（彭总令——authRegister 闸真化随迁；门户口令卡兑码同页链）
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState<{ session: WbSession; deptCount: number } | null>(null)

  const industryFinal = form.industry === '其他' ? form.industryText.trim() : form.industry
  const canSubmit =
    form.enterpriseName.trim().length >= 2 && industryFinal.length >= 1 &&
    form.headcount !== '' && form.username.trim().length >= 2 && form.password.length >= 6 &&
    /^iv_[0-9a-f]{48}$/.test(form.betaCode.trim()) // 邀测码闸（格式前置——服务端验真消费面在 wb#144）

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!canSubmit || busy) return
    setBusy(true)
    setErr(null)
    try {
      const res = await wbMutation<WbSession & { deptCount?: number }>('agentic.authRegister', {
        username: form.username.trim(),
        password: form.password,
        enterpriseName: form.enterpriseName.trim(),
        industry: industryFinal,
        ...(form.industry === '其他' ? {} : { industryText: form.industry }),
        headcount: form.headcount,
        betaCode: form.betaCode.trim(),
        ...(form.displayName.trim() ? { displayName: form.displayName.trim() } : {}),
      })
      setDone({ session: res, deptCount: res.deptCount ?? 6 })
    } catch (error) {
      setErr(wbErrorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <RegisterDone
        title={`「${form.enterpriseName.trim()}」建厂完成`}
        lines={[
          `智能工作台已生成：${done.deptCount} 个部门台开箱即用（可后续调整）`,
          '下载桌面端，用刚注册的账号登录即开工',
        ]}
        downloads={[{ label: '⬇ 组织智能体运行时 Windows 版（安装程序）', href: PKG_ORG }]} // portal#108：散挂面收口——企业面挂组织运行时包（彭总令面）
        onContinue={() => onSuccess(done.session)}
        continueText="直接进入工作台 →"
      />
    )
  }

  return (
    <form onSubmit={submit} className="space-y-4 text-left">
      <div className="flex items-center gap-2 text-sm font-medium text-ink-primary">
        <Building2 className="h-4 w-4 text-amber-400" /> 企业建厂三问（其余后面补，不拦路）
      </div>
      <div>
        <label className={wbLabelCls}>企业名称</label>
        <input className={wbInputCls} value={form.enterpriseName} maxLength={64} required
          onChange={(e) => setForm({ ...form, enterpriseName: e.target.value })}
          placeholder="如：星云智造示范工厂" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={wbLabelCls}>所属行业</label>
          <select className={cn(wbInputCls, 'appearance-none')} value={form.industry} required
            onChange={(e) => setForm({ ...form, industry: e.target.value })}>
            <option value="" disabled>选择行业</option>
            {INDUSTRY_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
        <div>
          <label className={wbLabelCls}>人员规模</label>
          <select className={cn(wbInputCls, 'appearance-none')} value={form.headcount} required
            onChange={(e) => setForm({ ...form, headcount: e.target.value })}>
            <option value="" disabled>选择规模</option>
            {HEADCOUNT_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label className={wbLabelCls}>内测邀测码</label>
        <input
          className={wbInputCls}
          value={form.betaCode}
          onChange={(e) => setForm({ ...form, betaCode: e.target.value })}
          placeholder="iv_ 开头——上方口令卡可兑今日专属码"
          required
        />
      </div>
      {form.industry === '其他' && (
        <div>
          <label className={wbLabelCls}>行业说明</label>
          <input className={wbInputCls} value={form.industryText} maxLength={64} required
            onChange={(e) => setForm({ ...form, industryText: e.target.value })}
            placeholder="一句话说清你的行业" />
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={wbLabelCls}>登录账号</label>
          <input className={wbInputCls} value={form.username} maxLength={64} required
            onChange={(e) => setForm({ ...form, username: e.target.value })}
            placeholder="管理员账号" autoComplete="username" />
        </div>
        <div>
          <label className={wbLabelCls}>登录密码</label>
          <input className={wbInputCls} type="password" value={form.password} minLength={6} maxLength={64} required
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            placeholder="至少 6 位" autoComplete="new-password" />
        </div>
      </div>
      <div>
        <label className={wbLabelCls}>你的称呼（可选）</label>
        <input className={wbInputCls} value={form.displayName} maxLength={32}
          onChange={(e) => setForm({ ...form, displayName: e.target.value })}
          placeholder="如：彭总" />
      </div>
      {err && <p className="text-sm text-ember-red">{err}</p>}
      <button type="submit" disabled={!canSubmit || busy}
        className="flex w-full items-center justify-center gap-2 rounded-[10px] bg-amber-400 py-3 text-base font-semibold text-zinc-950 transition-colors hover:bg-amber-300 disabled:opacity-40">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Building2 className="h-4 w-4" />}
        建厂并生成我的智能工作台
      </button>
      <p className="text-center text-xs text-ink-faint">
        建厂即生成部门台（管理/销售/采购/生产/财务/行政）· 也可在 NumX Max APP 企业版由数字人「星云」接引建厂
      </p>
    </form>
  )
}

/** 个人注册表单（M25 短信链） */
export function PersonRegisterForm({
  onSuccess,
  smsCodeRow,
}: {
  onSuccess: (s: WbSession) => void
  /** Login.tsx 的 SmsCodeRow 复用件（发送验证码+冷却+devCode） */
  smsCodeRow: (props: { phone: string; code: string; onCodeChange: (v: string) => void }) => ReactElement
}) {
  const [form, setForm] = useState({ phone: '', code: '', password: '', realName: '', inviteCode: '', referrerPhone: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState<WbSession | null>(null)

  const canSubmit = /^1\d{10}$/.test(form.phone.trim()) && form.code.trim().length === 6 && form.password.length >= 8

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!canSubmit || busy) return
    setBusy(true)
    setErr(null)
    try {
      const res = await wbMutation<WbSession>('sms.registerByPhone', {
        phone: form.phone.trim(),
        code: form.code.trim(),
        password: form.password,
        ...(form.realName.trim() ? { realName: form.realName.trim() } : {}),
        ...(form.inviteCode.trim() ? { inviteCode: form.inviteCode.trim() } : {}),
      ...(form.referrerPhone.trim() ? { referrerPhone: form.referrerPhone.trim() } : {}),
      })
      setDone(res)
    } catch (error) {
      setErr(wbErrorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <RegisterDone
        title="个人账号开通完成"
        lines={['数字人「灵枢」全程自然语言交互——派活、购物、设备联动一句话搞定']}
        downloads={[

          { label: '⬇ NumX Max APP（手机随身）', onClick: downloadApp },
        ]}
        onContinue={() => onSuccess(done)}
        continueText="开始逛数字匠市 →"
      />
    )
  }

  return (
    <form onSubmit={submit} className="space-y-4 text-left">
      <div className="flex items-center gap-2 text-sm font-medium text-ink-primary">
        <UserRound className="h-4 w-4 text-pulse-cyan" /> 手机即账号（短信验证即注册）
      </div>
      <div>
        <label className={wbLabelCls}>手机号</label>
        <input className={wbInputCls} value={form.phone} inputMode="numeric" maxLength={11} required
          onChange={(e) => setForm({ ...form, phone: e.target.value })}
          placeholder="11 位手机号" autoComplete="tel" />
      </div>
      {smsCodeRow({ phone: form.phone, code: form.code, onCodeChange: (v) => setForm({ ...form, code: v }) })}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={wbLabelCls}>登录密码</label>
          <input className={wbInputCls} type="password" value={form.password} minLength={8} maxLength={64} required
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            placeholder="至少 8 位" autoComplete="new-password" />
        </div>
        <div>
          <label className={wbLabelCls}>姓名（可选）</label>
          <input className={wbInputCls} value={form.realName} maxLength={32}
            onChange={(e) => setForm({ ...form, realName: e.target.value })}
            placeholder="真实姓名" />
        </div>
      </div>
      <div>
        <label className={wbLabelCls}>邀请码（可选）</label>
        <input className={wbInputCls} value={form.inviteCode} maxLength={64}
          onChange={(e) => setForm({ ...form, inviteCode: e.target.value })}
          placeholder="有邀请码就填，没有留空" />
      </div>
      <div>
        <label className={wbLabelCls}>推荐人手机号（可选）</label>
        <input className={wbInputCls} value={form.referrerPhone} inputMode="numeric" maxLength={11}
          onChange={(e) => setForm({ ...form, referrerPhone: e.target.value })}
          placeholder="谁推荐你来的？填 TA 的手机号（TA 拿 5% 返佣）" />
      </div>
      {err && <p className="text-sm text-ember-red">{err}</p>}
      <button type="submit" disabled={!canSubmit || busy}
        className="flex w-full items-center justify-center gap-2 rounded-[10px] bg-amber-400 py-3 text-base font-semibold text-zinc-950 transition-colors hover:bg-amber-300 disabled:opacity-40">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserRound className="h-4 w-4" />}
        验证并开通个人账号
      </button>
      <p className="text-center text-xs text-ink-faint">
        也可在 NumX Max APP 个人版由数字人「灵枢」接引注册——账号互通
      </p>
    </form>
  )
}
