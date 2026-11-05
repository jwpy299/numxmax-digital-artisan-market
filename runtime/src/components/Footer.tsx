import { Link } from 'react-router'
import { cn } from '@/lib/utils'
import { WIDE_CONTAINER_CLASS } from '@/lib/layout'

const COLUMNS = [
  {
    title: '平台',
    links: [
      { label: '数字匠市', to: '/market' },
      { label: '智能工作台', to: '/workbench' },
      { label: '定价引擎', to: '/pricing' },
      { label: '记忆服务', to: '/architecture' },
    ],
  },
  {
    title: '资源',
    links: [
      { label: '技术架构', to: '/architecture' },
      { label: '生命周期', to: '/lifecycle' },
      { label: '商业模式', to: '/pricing' },
      { label: '运营策略', to: '/roadmap' },
    ],
  },
]

/** SVG constellation divider */
function ConstellationDivider() {
  const stars: Array<[number, number]> = [
    [4, 18], [16, 8], [30, 20], [45, 10], [58, 22], [72, 8], [86, 18], [96, 10],
  ]
  return (
    <svg viewBox="0 0 100 30" className="h-8 w-full text-nebula-violet/50" preserveAspectRatio="none" aria-hidden>
      <polyline
        points={stars.map(([x, y]) => `${x},${y}`).join(' ')}
        fill="none"
        stroke="currentColor"
        strokeWidth="0.3"
        strokeDasharray="1.5 1.5"
      />
      {stars.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={i % 3 === 0 ? 0.9 : 0.5} fill="currentColor" />
      ))}
    </svg>
  )
}

export default function Footer() {
  return (
    <footer className="relative overflow-hidden border-t border-line-subtle bg-gradient-to-b from-deep to-void">
      <div className="nebula-halo pointer-events-none absolute -top-32 left-1/2 h-64 w-[720px] -translate-x-1/2" />
      <div className={cn('relative mx-auto max-w-site px-5 pb-10 pt-16 md:px-12', WIDE_CONTAINER_CLASS)}>
        <div className="grid gap-10 md:grid-cols-4">
          {/* brand */}
          <div>
            <Link to="/" className="flex items-center gap-3">
              <img src="/logo-mark.png" alt="NumX Max" className="h-9 w-9 object-contain" />
              <span className="leading-tight">
                <span className="block font-display text-lg font-bold text-ink-primary">NumX Max·数字匠市</span>
                <span className="block font-mono text-[9px] uppercase tracking-[0.18em] text-ink-faint">
                  NumX Max Artisan Market
                </span>
              </span>
            </Link>
            <p className="mt-4 text-[13px] leading-relaxed text-ink-secondary">
              数字劳动力交易市场。把老师傅数十年的经验，封装成拥有独立身份、工作记忆与信用档案的数字工匠，按月雇佣，越用越懂你。
            </p>
          </div>

          {COLUMNS.map((col) => (
            <div key={col.title}>
              <h4 className="hud-label">{col.title}</h4>
              <ul className="mt-4 space-y-2.5">
                {col.links.map((l) => (
                  <li key={l.label}>
                    <Link to={l.to} className="text-[13px] text-ink-secondary transition-colors hover:text-pulse-cyan">
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          {/* contact / beta */}
          <div>
            <h4 className="hud-label">联系</h4>
            <p className="mt-4 font-mono text-[11px] text-ink-faint">beta@nebula-artisan.market</p>
          </div>
        </div>

        <div className="mt-12">
          <ConstellationDivider />
          <div className="mt-4 flex flex-col items-center justify-between gap-3 md:flex-row">
            <p className="font-mono text-[11px] tracking-wider text-ink-faint">
              © 2026 NumX Max·数字匠市 NUMX MAX DIGITAL ARTISAN MARKET
            </p>
            {/* ICP 备案号（粤ICP备2026109327号，持证人：广东灵智枢生态科技有限公司） */}
            <a
              href="https://beian.miit.gov.cn"
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[11px] text-ink-faint/80 transition-colors hover:text-pulse-cyan"
            >
              粤ICP备2026109327号
            </a>
            {/* 公安备案号（粤公网安备44060402003434号——合规挂载：警徽图标+查询链接，30 个工作日死线件） */}
            <a
              href="http://www.beian.gov.cn/portal/registerSystemInfo?recordcode=44060402003434"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 font-mono text-[11px] text-ink-faint/80 transition-colors hover:text-pulse-cyan"
            >
              <img src="/gh_icon.png" alt="公安备案" className="h-3.5 w-3.5 object-contain" />
              粤公网安备44060402003434号
            </a>
            <div className="flex items-center gap-2 text-[12px] text-ink-secondary">
              <Link to="/help" className="transition-colors hover:text-pulse-cyan">帮助中心</Link>
              <span className="text-ink-faint/50">·</span>
              <Link to="/certified" className="transition-colors hover:text-pulse-cyan">认证体系</Link>
              <span className="text-ink-faint/50">·</span>
              <Link to="/legal/terms" className="transition-colors hover:text-pulse-cyan">用户协议</Link>
              <span className="text-ink-faint/50">·</span>
              <Link to="/legal/privacy" className="transition-colors hover:text-pulse-cyan">隐私政策</Link>
              <span className="text-ink-faint/50">·</span>
              <Link to="/legal/trade-rules" className="transition-colors hover:text-pulse-cyan">交易规则</Link>
            </div>
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint/70">
              Hire a digital artisan, not just a skill
            </p>
          </div>
        </div>
      </div>
    </footer>
  )
}
