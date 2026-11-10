import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Play } from 'lucide-react'
import { cn } from '@/lib/utils'
import { WIDE_CONTAINER_CLASS } from '@/lib/layout'
import GlowButton from '@/components/GlowButton'
import HudCorner from '@/components/HudCorner'
import HeroArtisanCards from '@/components/home/HeroArtisanCards'
import { useCountUp } from '@/hooks/useCountUp'
import { phoneValid, codeValid } from '@/lib/wbSms' // 校验单源（主线①搬链——门户仓惯例面同 ApplyBeta/SmsCodeRow）
import { DailyCodeCard } from '@/components/home/DailyCodeCard' // 每日口令卡（彭总 2026-10-23 令——口令造势面挂首页）
import { wbMutation, wbErrorMessage } from '@/lib/wbSession'
import { SmsCodeRow } from '@/components/auth/SmsCodeRow' // OTP 行共享件（罚单归一：ApplyBeta/Login 同引——发送+冷却+换号守卫内化）
import type { BetaKind } from '@contracts/betaKinds' // 报名身份枚举跨栈单源（wb#77 票面门户仓同构）

const Starfield = lazy(() => import('@/components/home/Starfield'))

// 2026-09-05 脱假（彭总令）：首页数字改真实口径——在架工匠读真库，
// 任务/成功率/评分在真实成交积累前一律显示「开业首月 · 数据累计中」，不摆假数
const STATS = [
  { value: 47, label: '在架数字工匠（真实在编）', decimals: 0 },
  { value: 0, label: '真实成交单（开业首月累计中）', decimals: 0 },
  { value: 0, label: '任务成功率（真实样本累计中）', decimals: 0 },
  { value: 0, label: '雇主评分（真实评价累计中）', decimals: 0 },
]

/** 报名身份型（null=未选——门户仓无 app 下载钮=无「双版本入口强制选」面；来路判别锚=下载钮 target） */
type ApplyKind = BetaKind | null


/** 身份选项单源（按钮列+守卫文案同派生——四处字面复刻漂移面封死） */
const APPLY_KIND_OPTIONS: Array<{ kind: NonNullable<ApplyKind>; label: string; icon: string }> = [
  { kind: 'personal', label: '我是个人', icon: '👤' },
  { kind: 'enterprise', label: '我是企业', icon: '🏢' },
]

/** 在飞禁用类名单源（禁态观感一处调全跟） */
const LOCK_CLS = 'disabled:cursor-not-allowed disabled:opacity-40'

function StatCell({ value, label, decimals }: { value: number; label: string; decimals: number }) {
  const text = useCountUp(value, { duration: 1.6, delay: 1.2, decimals })
  return (
    <div className="flex flex-col items-center gap-1 px-4 py-4 md:py-5">
      <span className="font-grotesk text-2xl font-bold tabular-nums text-ink-primary md:text-[32px]">{text}</span>
      <span className="text-[13px] text-ink-faint">{label}</span>
    </div>
  )
}

/** rotating compass ring decoration, 60s linear */
function CompassRing() {
  return (
    <svg
      viewBox="0 0 120 120"
      className="h-[120px] w-[120px] opacity-30"
      style={{ animation: 'spin 60s linear infinite' }}
      aria-hidden
    >
      <circle cx="60" cy="60" r="54" fill="none" stroke="#7C8CDE" strokeWidth="0.6" />
      <circle cx="60" cy="60" r="42" fill="none" stroke="#7C8CDE" strokeWidth="0.4" strokeDasharray="2 4" />
      {Array.from({ length: 24 }).map((_, i) => {
        const a = (i * 15 * Math.PI) / 180
        const long = i % 6 === 0
        const r1 = long ? 46 : 50
        return (
          <line
            key={i}
            x1={60 + r1 * Math.cos(a)}
            y1={60 + r1 * Math.sin(a)}
            x2={60 + 54 * Math.cos(a)}
            y2={60 + 54 * Math.sin(a)}
            stroke={long ? '#22D3EE' : '#7C8CDE'}
            strokeWidth={long ? 1 : 0.5}
          />
        )
      })}
      <line x1="60" y1="18" x2="60" y2="30" stroke="#F5A524" strokeWidth="1.4" />
    </svg>
  )
}

export default function HeroSection() {
  // 内测闸状态（邀请制灰度）：target=app|workbench|personal
  const [betaGate, setBetaGate] = useState<{ target: 'workbench' | 'personal' } | null>(null)
  // ?beta=open 自动开层（彭总 2026-10-20 令「下载注册中心」回跳动线——中心页申请链回本页报名面直接开[不搬状态机面]）
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('beta') === 'open') {
      resetApplyFields()
      setBetaGate({ target: 'workbench' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // 内测报名（自动颁码链——主线①搬链门户仓落地：公网首页报名面）
  const [applyPhone, setApplyPhone] = useState('')
  const [applyKind, setApplyKind] = useState<ApplyKind>(null) // null=未选（提交闸必选——不静默预置错发面封死）
  const [applyCode, setApplyCode] = useState('')
  const [applyBusy, setApplyBusy] = useState(false)
  const [applyErr, setApplyErr] = useState<string | null>(null)
  const [applyDone, setApplyDone] = useState(false) // 完成态布尔（不存码明文——iv_ 只走短信通道=凭证纪律）
  const applyPhoneRef = useRef(applyPhone) // 手机号活值镜像（portal#56 复审 bug·med 票：闭包冻结比对=恒假死守卫面封死——
  // 快照比对须读 ref 活值[SmsCodeRow prevPhoneRef 同律]；渲染体直写幂等[StrictMode 双渲同值]）
  // 在飞谓词派生单点（五处复刻漂移面封死——一处派生全引用）
  applyPhoneRef.current = applyPhone // 活值镜像同步（渲染体直写幂等——StrictMode 双渲同值）
  /** 报名面字段复位单点（申请/返回/知道了/关层四处同引——部分复位漂移面封死；applyKind 同清=身份残留错发面封死） */
  const resetApplyFields = () => {
    setApplyDone(false)
    setApplyErr(null)
    setApplyCode('')
    setApplyKind(null)
  }
  // 关层单点（残留=再开层跳预置静默错发码面封死——复位后下次开层按来路重预置；applyPhone 有意保留=换号免重输便利面）
  const closeBetaGate = () => {
    setBetaGate(null)
    resetApplyFields()
  }
  // 波一钉：在架数读库（agents.list total——台账诚实面，不写死）
  const [listedCount, setListedCount] = useState(47)
  useEffect(() => {
    fetch('/api/trpc/agents.list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ json: { limit: 1 } }) })
      .then((r) => r.json())
      .then((d) => { const n = d?.result?.data?.json?.total; if (typeof n === 'number' && n > 0) setListedCount(n) })
      .catch(() => {})
  }, [])

  // 报名领码（sms.betaApply——验码→自动颁 iv_→翼讯通短信下发；响应不返明文=iv_ 只走短信通道）
  const betaApply = async () => {
    if (applyBusy) return // 在飞闸（验码面摘后=单闸面——applyBusy 单闸）
    if (!applyKind) { setApplyErr('请先选择报名身份（个人/企业）'); return } // 身份必选闸（不静默错发面封死）
    if (!phoneValid(applyPhone)) { setApplyErr('手机号格式不正确'); return } // 校验前置（单源 phoneValid）
    if (!codeValid(applyCode)) { setApplyErr('验证码格式不正确'); return } // 校验前置（单源 codeValid）
    setApplyBusy(true)
    setApplyErr(null)
    const applyFor = applyPhone.trim() // 快照——在飞期间换号=成功/错误不挂新号面
    try {
      await wbMutation('sms.betaApply', { phone: applyFor, code: applyCode.trim(), kind: applyKind }) // 身份下行（彭总链路钉：码带身份——个人码/企业码分流）
      if (applyPhoneRef.current.trim() !== applyFor) return // 已换号——旧号结果不落（ref 活值比对=真可达[portal#56 复审 bug·med 票：闭包冻结恒假死守卫面封死]）
      setApplyDone(true) // 响应 ok=true 即码已下发（不落明文——凭证纪律）
    } catch (e) {
      if (applyPhoneRef.current.trim() !== applyFor) return // 已换号——旧号错误不落（ref 活值同上钉）
      setApplyErr(wbErrorMessage(e)) // 收口单源
    } finally {
      setApplyBusy(false)
    }
  }

  const scope = useRef<HTMLElement>(null)

  useEffect(() => {
    const node = scope.current
    if (!node) return
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          node.classList.add('hero-inview')
          observer.disconnect()
        }
      }
    }, { threshold: 0.12 })
    observer.observe(node)

    let frame = 0
    const update = () => {
      frame = 0
      const rect = node.getBoundingClientRect()
      const total = Math.max(1, rect.height + window.innerHeight)
      const progress = Math.max(0, Math.min(1, (window.innerHeight - rect.top) / total))
      const bg = node.querySelector<HTMLElement>('.hero-bg')
      if (bg) bg.style.transform = `translateY(${progress * 15}%)`
      const content = node.querySelector<HTMLElement>('.hero-content')
      if (content) {
        content.style.transform = `translateY(${-progress * 30}%)`
        content.style.opacity = String(1 - progress)
      }
    }
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    update()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      observer.disconnect()
      window.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [])

  return (
    <section ref={scope} className="relative flex min-h-[calc(100dvh-4rem)] flex-col overflow-hidden">
      <style>{`
        .hero-title-line{display:block;transform-origin:50% 100%;animation:hero-title-in .8s cubic-bezier(.2,.7,.2,1) both}
        .hero-hud-sub{animation:hero-hud-in 1s ease .15s both}
        .hero-fade{animation:hero-fade-in .6s ease .35s both}
        .hero-fade:nth-child(2n){animation-delay:.45s}.hero-fade:nth-child(3n){animation-delay:.55s}
        .hero-stats{animation:hero-stats-in .7s ease .65s both}
        .hero-hud-corner{animation:hero-fade-in .8s ease .2s both}
        @keyframes hero-title-in{from{opacity:0;transform:translateY(48px) rotateX(-25deg)}to{opacity:1;transform:translateY(0) rotateX(0)}}
        @keyframes hero-hud-in{from{opacity:0;letter-spacing:.34em}to{opacity:1;letter-spacing:.18em}}
        @keyframes hero-fade-in{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:translateY(0)}}
        @keyframes hero-stats-in{from{opacity:0;transform:translateY(32px)}to{opacity:1;transform:translateY(0)}}
        @media (prefers-reduced-motion:reduce){.hero-title-line,.hero-hud-sub,.hero-fade,.hero-stats,.hero-hud-corner{animation:none!important}}
      `}</style>
      {/* background */}
      <div className="hero-bg absolute inset-0 -z-10">
        <img src="/hero-nebula.png" alt="" className="h-[115%] w-full object-cover" style={{ filter: "sepia(0.3) saturate(0.85) hue-rotate(-10deg)" }} />
        <div className="absolute inset-0 bg-void/60" />
        <div className="absolute inset-x-0 bottom-0 h-48 bg-gradient-to-t from-deep to-transparent" />
      </div>
      <div className="absolute inset-0 -z-10">
        <Suspense fallback={null}>
          <Starfield />
        </Suspense>
      </div>

      {/* HUD corner labels */}
      <div className="hero-hud-corner pointer-events-none absolute left-5 top-6 md:left-12 md:top-8">
        <p className="hud-label text-ink-secondary">NUMX MAX DIGITAL ARTISAN MARKET</p>
        <p className="mt-1.5 flex items-center gap-2 font-mono text-[11px] tracking-[0.18em] text-pulse-cyan">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-pulse-cyan opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-pulse-cyan" />
          </span>
          SYS.STATUS: ONLINE
        </p>
      </div>
      <div className="hero-hud-corner pointer-events-none absolute bottom-8 right-5 hidden md:right-12 md:block">
        <CompassRing />
      </div>

      {/* content */}
      <div className={cn('hero-content mx-auto flex w-full max-w-site flex-1 flex-col lg:flex-row lg:items-center lg:gap-8 justify-center px-5 pb-16 pt-24 md:px-12', WIDE_CONTAINER_CLASS)}>
        <div className="flex-1">
        <h1 className="font-display text-[40px] font-black leading-[1.1] tracking-[0.02em] text-ink-primary md:text-[72px]">
          <span className="hero-title-line block">
            中国式<span className="text-brand-gradient">数字员工</span>生态
          </span>
        </h1>
        <p className="hero-hud-sub mt-6 font-mono text-[11px] uppercase text-ink-faint" style={{ letterSpacing: '0.18em' }}>
          CHINA'S DIGITAL WORKFORCE ECOSYSTEM
        </p>
        <p className="hero-fade mt-6 max-w-[560px] text-base leading-[1.75] text-ink-secondary md:text-lg">
          {listedCount} 位持证数字工匠在架 · 先对话试岗，按 Token 计量结算——从经营参谋到成本会计，
          一句话派活，代码留在你自己的边缘节点。
        </p>
        <p className="hero-fade mt-4 text-[13px] text-ink-faint">
          <span className="text-forge-amber">◆</span> NumX Max 智造研究院认证发行 · 持证上岗 · 身份可验 · 随时解约
        </p>
        <div className="hero-fade mt-9 flex flex-wrap items-center gap-4">
          <GlowButton to="/market" variant="primary" className="px-8 py-3.5 text-base">
            进入数字匠市
          </GlowButton>
          <GlowButton to="/lifecycle" variant="secondary" className="px-8 py-3.5 text-base">
            <Play className="h-4 w-4" /> 了解生命周期
          </GlowButton>
          {/* APP 下载钮已退役（彭总 2026-10-02 令：APP 下载收口工作台扫码——个人台「装 APP」卡+企业台手机中心，
              /get-app 落地页保留为扫码落点；封闭内测期不再门户直挂） */}
          {/* 下载钮已收口（彭总 2026-10-20 令：下载面全收进「下载注册中心」[/get-desktop 导航项]——首页不再直挂安装包） */}
          {/* 每日邀测口令卡（彭总 2026-10-23 令：每天 10-20 家企业名额——口令公开抢，兑专属码开户；与报名审核链并行不替） */}
          <DailyCodeCard />

          {/* 内测申请入口（彭总链路钉：报名→下载→进入——门禁摘后申请面挪下载区独立入口） */}
          <button
            onClick={() => {
              resetApplyFields() // 字段复位单点（残 OTP/旧红错/身份残留同清）
              setBetaGate({ target: 'workbench' }) // 开层旗（target 死面——输码面摘后不再消费=挂账清）
            }}
            className="text-xs text-jade-green underline underline-offset-4 transition-colors hover:text-jade-green/80"
          >
            没有账号？申请内测资格（名额有限，先到先得）→
          </button>
          {/* 网页版工作台钮已摘（彭总 2026-10-20 令：工作台入口全收「下载注册中心」——首页只留报名动线；/workbench 中转页直链仍可达） */}
        </div>

        {/* stats bar */}
        <div className="hero-stats relative mt-16 max-w-3xl rounded-2xl glass-panel">
          <HudCorner />
          <div className="grid grid-cols-2 divide-x divide-line-subtle md:grid-cols-4">
            {STATS.map((s) => (
              <StatCell key={s.label} {...s} value={s.label.startsWith('在架') ? listedCount : s.value} />
            ))}
          </div>
        </div>
        </div>
        <HeroArtisanCards />
      </div>

      {/* 内测闸弹层（邀请制灰度，彭总 2026-09-05 令）+报名颁码面（主线①搬链 2026-10-15——公网首页自动颁码链；
          审批流入口留=彭总拍板：BetaCta/ApplyBeta 审批面不动，本弹层自动颁码面并存） */}
      {betaGate && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4"
          onClick={closeBetaGate} // 遮罩在飞可关（portal#56 复审 bug 票：门户仓无超时锁+在飞全锁=请求挂死即困死弹层面封死——
          // 留逃生口[门户仓无超时锁明态]；关层复位契约已清字段+晚到响应落不可见面=无害[finally 清 busy 可重开]）
        >
          <div
            className="w-full max-w-md rounded-2xl border border-jade-green/30 bg-[#101828] p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-bold text-white">封闭内测中</h3>
            {!applyDone && (
              <>
                <p className="mt-2 text-sm leading-relaxed text-zinc-400">
                  输手机号收验证码，验证后自动签发内测邀测码短信下发（30 天有效）：
                </p>
                <div className="mt-4 grid grid-cols-2 gap-2" role="radiogroup" aria-label="报名身份">
                  {APPLY_KIND_OPTIONS.map(({ kind: k, label, icon }) => (
                    // 原生 radio（方向键/焦点模型白拿——button 伪 radio 无键盘模型=语义宣称≠行为面封死；样式挂 label）
                    <label
                      key={k}
                      className={`flex cursor-pointer items-center justify-center rounded-lg border px-3 py-2.5 text-sm font-bold transition-colors has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-40 ${
                        applyKind === k
                          ? 'border-jade-green bg-jade-green/15 text-jade-green'
                          : 'border-zinc-700 bg-black/40 text-zinc-400 hover:border-zinc-500'
                      }`}
                    >
                      <input
                        type="radio"
                        name="applyKind"
                        className="sr-only"
                        checked={applyKind === k}
                        disabled={applyBusy} // 在飞禁切（在飞期间发码 kind 已定，切换=UI 与实发身份不符面封死；禁身份钮不困死弹层=可无旗）
                        onChange={() => { setApplyKind(k); setApplyErr(null) }} // 切身份清旧错（已选身份仍红字矛盾态封死）
                      />
                      {icon} {label}
                    </label>
                  ))}
                </div>
                <input
                  value={applyPhone}
                  onChange={(e) => setApplyPhone(e.target.value)}
                  placeholder="手机号（邀测码短信下发）"
                  type="tel"
                  inputMode="tel"
                  maxLength={11}
                  className="mt-3 w-full rounded-lg border border-zinc-700 bg-black/40 px-3 py-2.5 text-sm text-white outline-none focus:border-jade-green"
                />
                <div className="mt-3">
                  <SmsCodeRow phone={applyPhone} purpose="register" code={applyCode} onCodeChange={setApplyCode} />
                </div>
                {applyErr && <p className="mt-2 text-xs text-red-400">{applyErr}</p>}
                <div className="mt-4 flex gap-3">
                  <button
                    onClick={() => void betaApply()}
                    disabled={applyBusy || !applyCode.trim()} // !applyKind 不搁 disabled（disabled 使守卫文案死码——点击见「请先选择报名身份」可达）
                    className="rounded-lg bg-jade-green px-5 py-2.5 text-sm font-bold text-black disabled:opacity-50"
                  >
                    {applyBusy ? '签发中…' : '立即领取邀测码'}
                  </button>
                  <button
                    onClick={() => { closeBetaGate() }} // 关层走单点（输码面已摘——返回面=取消关层）
                    className={`rounded-lg border border-zinc-600 px-5 py-2.5 text-sm text-zinc-300 ${LOCK_CLS}`}
                  >
                    取消
                  </button>
                </div>
              </>
            )}
            {applyDone && (
              <>
                <p className="mt-2 text-sm text-jade-green">✅ 内测邀测码已短信下发到你的手机，请查收（30 天有效）</p>
                <p className="mt-2 text-xs text-zinc-400">注册时连同本手机号一起输入邀测码——码明文不落本页（凭证纪律：iv_ 只走短信通道）。没收到可 60 秒后重发验证码重新报名。</p>
                <div className="mt-4 flex gap-3">
                  <button
                    onClick={() => { closeBetaGate() }} // 关层走单点
                    className="rounded-lg bg-jade-green px-5 py-2.5 text-sm font-bold text-black"
                  >
                    知道了
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
