/**
 * EnterpriseRegisterForm —— 企业注册分步向导（M7-a 重写，门户 Login 与工作台 WbLogin 双端复用）。
 *
 * 三步：① 企业信息（名称/行业/细分/规模/信用代码/联系人/手机/密码×2）
 *       ② 组织架构（动态行 ≥1，行业切换自动预填推荐部门，保留手动「按行业填充」）
 *       ③ 确认提交（信息汇总 + 《服务协议》《隐私政策》勾选，未勾选不可提交）
 * 提交成功 → 内嵌 OnboardCeremony 建军过场（真实调 orgAutoSetup）→ 完成才走 onSuccess。
 *
 * 保留：?claim=PKG-XXX 深链自动认领（失败不影响注册）；?industry= 深链预选行业。
 * 调 agentic.authRegisterEnterprise（token 在请求体，响应重颁 nt_ token）。
 */
import { useMemo, useState, type FormEvent } from 'react'
import { ArrowLeft, ArrowRight, BadgeCheck, Building2, Check, Loader2, Plus, Sparkles, Trash2 } from 'lucide-react'
import { INDUSTRY_GROUPS } from '@/lib/industries'
import { templateFor } from '@/lib/wbTemplates'
import { wbMutation, wbErrorMessage, type WbSession } from '@/lib/wbSession'
import { SmsCodeRow } from '@/components/auth/SmsCodeRow'
import { codeValid, phoneValid } from '@/lib/wbSms'
import { INVITE_CODE_RE } from '@/lib/wbInvites'
import { cn } from '@/lib/utils'
import { WbError, wbInputCls, wbLabelCls } from '@/components/wb/ui'
import DigitalGuide from './DigitalGuide'
import OnboardCeremony from './OnboardCeremony'
import { ENTERPRISE_STEP_GUIDES } from './guideCopy'

const HEADCOUNTS = ['1-50 人', '51-200 人', '201-500 人', '500 人以上']
const STEP_TITLES = ['企业信息', '组织架构', '确认建军']

interface DeptRow {
  name: string
  headcount: string
  duty: string
}

export default function EnterpriseRegisterForm({
  onSuccess,
  submitLabel = '注册企业并建军',
}: {
  onSuccess: (session: WbSession) => void
  submitLabel?: string
}) {
  const presetIndustry = (() => {
    try {
      const q = new URLSearchParams(window.location.search).get('industry') || ''
      return INDUSTRY_GROUPS.some((g) => g.key === q && g.status !== 'planned') ? q : ''
    } catch {
      return ''
    }
  })()
  const [form, setForm] = useState({
    enterpriseName: '',
    industryGroup: presetIndustry || INDUSTRY_GROUPS[0].key,
    industryText: '',
    headcount: HEADCOUNTS[0],
    creditCode: '',
    displayName: '',
    phone: '',
    code: '',
    betaCode: '',
    password: '',
    confirmPassword: '',
    painPoints: '',
  })
  const recommended = useMemo(
    () => templateFor(form.industryGroup).defaultDepartments.map((d) => ({ name: d.name, headcount: '', duty: d.duty })),
    [form.industryGroup],
  )
  const [departments, setDepartments] = useState<DeptRow[]>(recommended)
  const [deptTouched, setDeptTouched] = useState(false)
  const [agree, setAgree] = useState(false)
  const [step, setStep] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [session, setSession] = useState<WbSession | null>(null)
  const [claimCode] = useState(() => {
    try {
      return (new URLSearchParams(window.location.search).get('claim') || '').trim()
    } catch {
      return ''
    }
  })
  const [claimNotice, setClaimNotice] = useState<{ ok: boolean; text: string } | null>(null)

  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }))

  function setDept(i: number, patch: Partial<DeptRow>) {
    setDeptTouched(true)
    setDepartments((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }
  function addDept() {
    setDeptTouched(true)
    setDepartments((rows) => (rows.length >= 12 ? rows : [...rows, { name: '', headcount: '', duty: '' }]))
  }
  function removeDept(i: number) {
    setDeptTouched(true)
    setDepartments((rows) => (rows.length <= 1 ? rows : rows.filter((_, idx) => idx !== i)))
  }
  function fillRecommended() {
    setDepartments(recommended)
    setDeptTouched(false)
  }
  /** 行业切换：若用户未手动改过部门，则跟随重填推荐 */
  function changeIndustry(g: string) {
    set({ industryGroup: g })
    if (!deptTouched) {
      setDepartments(templateFor(g).defaultDepartments.map((d) => ({ name: d.name, headcount: '', duty: d.duty })))
    }
  }

  const validDepts = departments
    .map((d) => ({ name: d.name.trim(), headcount: d.headcount.trim(), duty: d.duty.trim() }))
    .filter((d) => d.name)

  function validateStep(s: number): string | null {
    if (s === 0) {
      if (form.enterpriseName.trim().length < 2) return '请填写企业名称（至少 2 字）'
      if (!form.displayName.trim()) return '请填写联系人姓名'
      if (!phoneValid(form.phone.trim())) return '请输入 11 位有效手机号' // phoneValid 单源
      if (!codeValid(form.code)) return '请填写 6 位短信验证码（点「发送验证码」获取）' // 归属验真（门禁票）
      if (!INVITE_CODE_RE.test(form.betaCode.trim())) return '请填写内测邀测码（iv_ 开头——门户报名审核通过后短信发放）' // 封闭内测闸（彭总令）
      if (form.password.length < 8) return '登录密码至少 8 位'
      if (form.password !== form.confirmPassword) return '两次输入的密码不一致'
    }
    if (s === 1 && validDepts.length === 0) return '请至少填写 1 个部门（可使用「按行业填充推荐部门」）'
    if (s === 2 && !agree) return '请先勾选同意《服务协议》与《隐私政策》'
    return null
  }

  function next() {
    const msg = validateStep(step)
    if (msg) {
      setError(msg)
      return
    }
    setError(null)
    setStep((s) => Math.min(s + 1, 2))
  }
  function back() {
    setError(null)
    setStep((s) => Math.max(s - 1, 0))
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const msg = validateStep(2) ?? validateStep(0) ?? validateStep(1)
    if (msg) {
      setError(msg)
      return
    }
    setError(null)
    setPending(true)
    try {
      const s = await wbMutation<WbSession>('agentic.authRegisterEnterprise', {
        phone: form.phone.trim(),
        code: form.code.trim(),
        betaCode: form.betaCode.trim(),
        password: form.password,
        displayName: form.displayName.trim(),
        enterpriseName: form.enterpriseName.trim(),
        industryGroup: form.industryGroup,
        industryText: form.industryText.trim() || undefined,
        headcount: form.headcount,
        creditCode: form.creditCode.trim() || undefined,
        departments: validDepts.map((d) => ({
          name: d.name,
          headcount: d.headcount || undefined,
          duty: d.duty || undefined,
        })),
        painPoints: form.painPoints.trim() || undefined,
      })
      // ?claim= 配置码自动认领（失败静默提示，不影响注册与建军过场）
      if (claimCode) {
        try {
          const res = await wbMutation<{ ok: true; packageName: string }>('packages.claim', {
            token: s.token,
            claimCode,
          })
          setClaimNotice({ ok: true, text: `套餐已认领：${res.packageName}，组织配置已启动。` })
        } catch (claimErr) {
          setClaimNotice({
            ok: false,
            text: `配置码认领失败：${wbErrorMessage(claimErr)}（不影响注册，可登录后在组织页重新认领）`,
          })
        }
      }
      setSession(s)
    } catch (err) {
      setError(wbErrorMessage(err))
    } finally {
      setPending(false)
    }
  }

  // ── 建军过场：注册成功后渲染，完成才回调 onSuccess ─────────────────────
  if (session) {
    return (
      <div className="space-y-4">
        {claimNotice && (
          <p
            className={cn(
              'flex items-start gap-2 rounded-xl border px-4 py-3 text-xs leading-relaxed',
              claimNotice.ok
                ? 'border-jade-green/30 bg-jade-green/[0.06] text-jade-green'
                : 'border-forge-amber/40 bg-forge-amber/[0.06] text-forge-amber',
            )}
          >
            {claimNotice.ok && <BadgeCheck className="mt-0.5 h-4 w-4 shrink-0" />}
            {claimNotice.text}
          </p>
        )}
        <OnboardCeremony session={session} industryHint={form.industryGroup} onEnter={() => onSuccess(session)} />
      </div>
    )
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
      {/* 步骤指示 + 数字人接引 */}
      <div className="flex items-center gap-2">
        {STEP_TITLES.map((t, i) => (
          <div key={t} className="flex flex-1 items-center gap-2">
            <span
              className={cn(
                'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold',
                i < step
                  ? 'border-jade-green/50 bg-jade-green/15 text-jade-green'
                  : i === step
                    ? 'border-forge-amber/60 bg-forge-amber/15 text-forge-amber'
                    : 'border-ink-faint/30 text-ink-faint',
              )}
            >
              {i < step ? <Check className="h-3 w-3" /> : i + 1}
            </span>
            <span className={cn('text-xs', i === step ? 'font-medium text-ink-primary' : 'text-ink-faint')}>{t}</span>
            {i < STEP_TITLES.length - 1 && <span className="h-px flex-1 bg-ink-faint/20" />}
          </div>
        ))}
      </div>
      <DigitalGuide lines={ENTERPRISE_STEP_GUIDES[step]} />

      {/* 第 1 步：企业信息 */}
      {step === 0 && (
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className={wbLabelCls}>企业名称</label>
            <input
              className={wbInputCls}
              value={form.enterpriseName}
              onChange={(e) => set({ enterpriseName: e.target.value })}
              placeholder="如：星云智造示范工厂"
              required
              minLength={2}
            />
          </div>
          <div>
            <label className={wbLabelCls}>所属行业（12 大类）</label>
            <select className={wbInputCls} value={form.industryGroup} onChange={(e) => changeIndustry(e.target.value)}>
              {INDUSTRY_GROUPS.map((g) => (
                <option key={g.key} value={g.key}>
                  {g.key}
                  {g.status === 'planned' ? '（未来开放）' : ''}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={wbLabelCls}>细分行业（选填）</label>
            <input
              className={wbInputCls}
              value={form.industryText}
              onChange={(e) => set({ industryText: e.target.value })}
              placeholder="如：精密零部件加工"
            />
          </div>
          <div>
            <label className={wbLabelCls}>人员规模</label>
            <select className={wbInputCls} value={form.headcount} onChange={(e) => set({ headcount: e.target.value })}>
              {HEADCOUNTS.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={wbLabelCls}>统一社会信用代码（选填）</label>
            <input
              className={wbInputCls}
              value={form.creditCode}
              onChange={(e) => set({ creditCode: e.target.value })}
              placeholder="统一社会信用代码（18 位，选填）"
              maxLength={32}
            />
            <p className="mt-1 text-[11px] text-ink-faint">填写后将对标国家企业信用信息公示系统实时核验</p>
          </div>
          <div>
            <label className={wbLabelCls}>联系人姓名</label>
            <input
              className={wbInputCls}
              value={form.displayName}
              onChange={(e) => set({ displayName: e.target.value })}
              placeholder="企业管理员姓名"
              required
            />
          </div>
          <div>
            <label className={wbLabelCls}>手机号（登录账号）</label>
            <input
              className={wbInputCls}
              value={form.phone}
              onChange={(e) => set({ phone: e.target.value, code: '' })} // 换号清码
              placeholder="11 位手机号"
              required
              maxLength={11}
            />
          </div>
          {/* 归属验真（门禁票：公开注册口必须验码——SmsCodeRow 共享件自带 label） */}
          <SmsCodeRow phone={form.phone} purpose="register" code={form.code} onCodeChange={(v) => set({ code: v })} />
          <div>
            <label className={wbLabelCls}>内测邀测码</label>
            <input
              className={wbInputCls}
              value={form.betaCode}
              onChange={(ev) => set({ betaCode: ev.target.value })}
              placeholder="iv_ 开头——门户报名审核通过后短信发放"
              required
              maxLength={51}
            />
          </div>
          <div>
            <label className={wbLabelCls}>登录密码</label>
            <input
              type="password"
              className={wbInputCls}
              value={form.password}
              onChange={(e) => set({ password: e.target.value })}
              placeholder="至少 8 位"
              required
              minLength={8}
            />
          </div>
          <div>
            <label className={wbLabelCls}>确认密码</label>
            <input
              type="password"
              className={wbInputCls}
              value={form.confirmPassword}
              onChange={(e) => set({ confirmPassword: e.target.value })}
              placeholder="再次输入密码"
              required
              minLength={8}
            />
          </div>
        </div>
      )}

      {/* 第 2 步：组织架构 */}
      {step === 1 && (
        <div className="space-y-4">
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label className="text-xs font-medium text-ink-secondary">部门组织架构（至少 1 行）</label>
              <button
                type="button"
                onClick={fillRecommended}
                className="inline-flex items-center gap-1 rounded-md border border-pulse-cyan/30 px-2 py-1 text-[11px] text-pulse-cyan transition-colors hover:bg-pulse-cyan/[0.08]"
              >
                <Sparkles className="h-3 w-3" />
                按行业填充推荐部门
              </button>
            </div>
            <div className="space-y-2">
              {departments.map((d, i) => (
                <div key={i} className="flex items-start gap-2">
                  <input
                    className={cn(wbInputCls, 'flex-[1.1]')}
                    value={d.name}
                    onChange={(e) => setDept(i, { name: e.target.value })}
                    placeholder="部门名称（2-32 字）"
                    aria-label={`部门 ${i + 1} 名称`}
                  />
                  <input
                    className={cn(wbInputCls, 'w-20 shrink-0')}
                    value={d.headcount}
                    onChange={(e) => setDept(i, { headcount: e.target.value })}
                    placeholder="人数"
                    aria-label={`部门 ${i + 1} 人数（选填）`}
                  />
                  <input
                    className={cn(wbInputCls, 'flex-[1.4]')}
                    value={d.duty}
                    onChange={(e) => setDept(i, { duty: e.target.value })}
                    placeholder="职能（选填）"
                    aria-label={`部门 ${i + 1} 职能（选填）`}
                  />
                  <button
                    type="button"
                    onClick={() => removeDept(i)}
                    disabled={departments.length <= 1}
                    aria-label={`删除部门 ${i + 1}`}
                    className="mt-1.5 rounded-md p-1.5 text-ink-faint transition-colors hover:text-ember-red disabled:opacity-30"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={addDept}
              disabled={departments.length >= 12}
              className="mt-2 inline-flex items-center gap-1 text-xs text-pulse-cyan hover:underline disabled:opacity-40"
            >
              <Plus className="h-3.5 w-3.5" />
              添加部门（{departments.length}/12）
            </button>
          </div>
          <div>
            <label className={wbLabelCls}>经营痛点（选填）</label>
            <textarea
              className={cn(wbInputCls, 'min-h-[72px] resize-y')}
              value={form.painPoints}
              onChange={(e) => set({ painPoints: e.target.value })}
              placeholder="如：设备故障停机频繁、质检人力不足…"
            />
          </div>
        </div>
      )}

      {/* 第 3 步：确认提交 */}
      {step === 2 && (
        <div className="space-y-4">
          <div className="rounded-xl border border-ink-faint/20 bg-ink-faint/[0.03] px-4 py-3 text-[13px] leading-7 text-ink-secondary">
            <p><span className="text-ink-faint">企业名称：</span>{form.enterpriseName}</p>
            <p><span className="text-ink-faint">行业：</span>{form.industryGroup}{form.industryText ? ` · ${form.industryText}` : ''}　<span className="text-ink-faint">规模：</span>{form.headcount}</p>
            <p><span className="text-ink-faint">联系人：</span>{form.displayName}　<span className="text-ink-faint">手机号：</span>{form.phone}</p>
            {form.creditCode && <p><span className="text-ink-faint">信用代码：</span>{form.creditCode}</p>}
            <p><span className="text-ink-faint">部门编制：</span>{validDepts.map((d) => d.name).join(' / ')}</p>
            {form.painPoints && <p><span className="text-ink-faint">经营痛点：</span>{form.painPoints}</p>}
          </div>
          {claimCode && (
            <p className="rounded-xl border border-pulse-cyan/30 bg-pulse-cyan/[0.06] px-4 py-2.5 text-xs text-pulse-cyan">
              检测到套餐配置码 <span className="font-mono font-bold">{claimCode}</span>，注册成功后将自动认领套餐。
            </p>
          )}
          <label className="flex cursor-pointer items-start gap-2 text-xs leading-relaxed text-ink-secondary">
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-0.5" />
            <span>
              我已阅读并同意
              <a href="/legal/terms" target="_blank" rel="noreferrer" className="mx-1 text-pulse-cyan hover:underline">《服务协议》</a>
              与
              <a href="/legal/privacy" target="_blank" rel="noreferrer" className="mx-1 text-pulse-cyan hover:underline">《隐私政策》</a>
              ，理解平台将对组织内一切变更动作进行意图审计。
            </span>
          </label>
        </div>
      )}

      <WbError message={error} />

      {/* 底部按钮区 */}
      <div className="flex gap-3">
        {step > 0 && (
          <button
            type="button"
            onClick={back}
            disabled={pending}
            className="inline-flex items-center gap-1 rounded-[10px] border border-ink-faint/30 px-4 py-2.5 text-sm text-ink-secondary transition-colors hover:bg-ink-faint/[0.06] disabled:opacity-50"
          >
            <ArrowLeft className="h-4 w-4" /> 上一步
          </button>
        )}
        {step < 2 ? (
          <button
            type="button"
            onClick={next}
            className="flex flex-1 items-center justify-center gap-2 rounded-[10px] bg-amber-gradient py-2.5 text-sm font-medium text-[#1A1206] transition-shadow hover:shadow-[0_0_24px_rgba(245,165,36,0.4)]"
          >
            下一步 <ArrowRight className="h-4 w-4" />
          </button>
        ) : (
          <button
            type="submit"
            disabled={pending || !agree}
            className="flex flex-1 items-center justify-center gap-2 rounded-[10px] bg-amber-gradient py-2.5 text-sm font-medium text-[#1A1206] transition-shadow hover:shadow-[0_0_24px_rgba(245,165,36,0.4)] disabled:opacity-50"
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Building2 className="h-4 w-4" />}
            {submitLabel}
          </button>
        )}
      </div>
      <p className="text-center text-xs text-ink-faint">
        注册者即企业管理员（owner）；注册成功即登录，组织中枢将立即为你的企业建军。
      </p>
    </form>
  )
}
