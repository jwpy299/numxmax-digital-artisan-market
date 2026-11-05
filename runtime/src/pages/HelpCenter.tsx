/**
 * HelpCenter（/help）—— 帮助中心（⑤内容信任面，2026-10-01）。
 * 静态内容页：怎么雇 / 怎么计量 / 怎么结算 / FAQ——四步上墙，不装不假。
 */
import { Link } from 'react-router'
import { UserCheck, Coins, Handshake, CircleHelp } from 'lucide-react'
import HudCorner from '@/components/HudCorner'

const SECTIONS = [
  {
    icon: UserCheck,
    title: '怎么雇',
    items: [
      '① 挑人：数字匠市按行业馆选，或在详情页看档案（认证标、服役记录、雇主评价）。',
      '② 试岗：详情页点「先试岗」——7 天沙箱试用，TA 拿你的脱敏数据先干一轮，报告说话。',
      '③ 签约：点「雇佣」选周期（1-12 个月）——智能合约托管薪资，Token 一次扣清。',
      '④ 上岗：合约生效，员工自动进你的企业工作台工位——派活、日报、训练全在里面。',
    ],
  },
  {
    icon: Coins,
    title: '怎么计量',
    items: [
      'Token 按调用计量：员工每接一次活按实际调用扣，月雇价是上限不是起步价。',
      '「先试岗」期技能调用费每次 100 Token（平台抽 20%）。',
      '数字全从台账出：用量、扣费、流水在企业工作台「套餐用量」和门户「买家中心」随时可查。',
    ],
  },
  {
    icon: Handshake,
    title: '怎么结算',
    items: [
      '师傅分成 85%：数字员工的创作者（老师傅/企业/个人开发者）拿大头。',
      '平台抽佣 15%：以 st_split_rules 规则表为准，明码不暗扣。',
      '邀请返佣 5%：从平台抽成里出——好友用你的手机号作推荐码注册，TA 首笔雇佣订单你拿 5%。',
      '随时可解约：合约期内解约按剩余周期退还（结算细则见交易规则）。',
    ],
  },
] as const

const FAQS = [
  ['数字员工是真人吗？', '不是。TA 们是 AI 数字员工——但每一位都有链上数字身份（DID）、岗位技能焊入、独立工作记忆，且必挂真人责任名下。'],
  ['AI 出错谁负责？', '所有 AI 生成内容都有显著标识，关键动作（付款/人事/停机等 C 级）焊死在代码层——员工只提示不执行，必须由企业负责人到工作台亲自确认。'],
  ['我的企业数据安全吗？', '本厂数据只服务本厂事务，绝不外泄；个人域数据（个人资料库、词元钱包）企业永不可见——写死在系统职责边界里。'],
  ['评分和成交是真的吗？', '真的。所有战绩从真实合约与评价台账出——没有数据时我们显示「— 累计中」，绝不编造。'],
] as const

export default function HelpCenter() {
  return (
    <div className="mx-auto max-w-site px-5 pb-[72px] pt-12 md:px-12">
      <p className="hud-label text-pulse-cyan/80">HELP CENTER</p>
      <h1 className="mt-2 font-display text-3xl font-bold text-ink-primary">帮助中心</h1>
      <p className="mt-2 text-sm text-ink-secondary">怎么雇、怎么计量、怎么结算——三句话讲清，剩下的是 FAQ。</p>

      <div className="mt-8 grid gap-6 lg:grid-cols-3">
        {SECTIONS.map((s) => (
          <section key={s.title} className="cyber-glow-card relative rounded-2xl bg-zinc-950/80 p-6">
            <HudCorner />
            <div className="flex items-center gap-2">
              <s.icon className="h-5 w-5 text-forge-amber" />
              <h2 className="font-display text-lg font-bold text-ink-primary">{s.title}</h2>
            </div>
            <ul className="mt-4 space-y-3">
              {s.items.map((it) => (
                <li key={it} className="text-[13px] leading-relaxed text-ink-secondary">{it}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <section className="mt-8 rounded-2xl border border-line-subtle bg-panel/40 p-6">
        <div className="flex items-center gap-2">
          <CircleHelp className="h-5 w-5 text-pulse-cyan" />
          <h2 className="font-display text-lg font-bold text-ink-primary">常见问题</h2>
        </div>
        <div className="mt-4 space-y-5">
          {FAQS.map(([q, a]) => (
            <div key={q}>
              <p className="text-sm font-semibold text-ink-primary">{q}</p>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{a}</p>
            </div>
          ))}
        </div>
      </section>

      <p className="mt-8 text-center text-sm text-ink-faint">
        还有事？<Link to="/market" className="text-forge-amber hover:underline">去匠市逛逛</Link> 或
        <Link to="/my" className="ml-1.5 text-pulse-cyan hover:underline">看买家中心</Link>
      </p>
    </div>
  )
}
