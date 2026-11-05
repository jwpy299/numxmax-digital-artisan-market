import { Link } from 'react-router'
import { ArrowRight, FileCheck2, FlaskConical, ScrollText, Stamp } from 'lucide-react'
import HudCorner from '@/components/HudCorner'

/** shared glass stage shell: 16:10 panel with HUD corners */
function StageShell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="glass-panel relative flex aspect-[16/10] w-full flex-col overflow-hidden rounded-2xl p-5 md:p-7">
      <HudCorner />
      <p className="hud-label absolute right-4 top-4 text-ink-faint/70">{label}</p>
      {children}
    </div>
  )
}

const SKILL_ORBS = ['振动诊断', '动平衡校正', '频谱分析', '故障预测', '温度补偿', '轴承听诊', '趋势外推', '阈值判定', '报告生成']

/* ─── 第一幕 · 孵化 ─────────────────────────────────────────────── */
export function IncubateStage() {
  return (
    <StageShell label="INCUBATION LAB">
      <div className="flex h-full items-center justify-between gap-3 pt-4">
        {/* 老师傅 */}
        <div className="st1-master w-[24%] shrink-0">
          <div className="overflow-hidden rounded-xl border border-line-subtle">
            <img src="/master-portrait.png" alt="老师傅陈国栋" className="aspect-[4/5] w-full object-cover" />
          </div>
          <p className="mt-2 text-center font-mono text-[10px] text-ink-faint">陈国栋 · 32年数控经验</p>
        </div>

        {/* 发光流水线 + 封装核心 */}
        <div className="relative flex h-full flex-1 items-center justify-center">
          <svg viewBox="0 0 200 120" className="absolute inset-0 h-full w-full" fill="none" aria-hidden>
            <path
              className="st1-flow"
              d="M4 60 H78"
              stroke="#22D3EE"
              strokeWidth="1.4"
              strokeDasharray="6 6"
              pathLength={1}
            />
            <path className="st1-flow" d="M122 60 H196" stroke="#7C5CFF" strokeWidth="1.4" strokeDasharray="6 6" pathLength={1} />
            {/* rotating octahedron wireframe */}
            <g className="st1-core" style={{ transformOrigin: '100px 60px', animation: 'spin 14s linear infinite' }}>
              <polygon points="100,34 122,60 100,86 78,60" stroke="#22D3EE" strokeWidth="1.2" fill="rgba(34,211,238,0.08)" />
              <polygon points="100,42 114,60 100,78 86,60" stroke="#7C5CFF" strokeWidth="1" fill="none" />
              <line x1="100" y1="34" x2="100" y2="86" stroke="#7C8CDE" strokeWidth="0.5" />
              <line x1="78" y1="60" x2="122" y2="60" stroke="#7C8CDE" strokeWidth="0.5" />
            </g>
          </svg>
          {/* 技能小球 */}
          <div className="absolute inset-0" aria-hidden>
            {SKILL_ORBS.map((s, i) => {
              const angle = (i / SKILL_ORBS.length) * Math.PI * 2 - Math.PI / 2
              const x = 50 + Math.cos(angle) * 33
              const y = 50 + Math.sin(angle) * 34
              return (
                <span
                  key={s}
                  className="st1-orb absolute flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-pulse-cyan/40 bg-panel/90 shadow-[0_0_12px_rgba(34,211,238,0.25)]"
                  style={{ left: `${x}%`, top: `${y}%` }}
                  title={s}
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-pulse-cyan" />
                </span>
              )
            })}
          </div>
        </div>

        {/* Agent 雏形卡 */}
        <div className="st1-agent w-[26%] shrink-0 rounded-xl border border-nebula-violet/40 bg-panel/80 p-3 shadow-[0_0_24px_rgba(124,92,255,0.25)]">
          <div className="flex items-center gap-2">
            <img src="/avatar-zhenheng.png" alt="振衡" className="h-10 w-10 rounded-full border border-line-subtle object-cover" />
            <div>
              <p className="text-sm font-bold text-ink-primary">振衡</p>
              <p className="font-mono text-[10px] text-pulse-cyan">ART-0007</p>
            </div>
          </div>
          <div className="mt-3 space-y-1.5">
            {['振动诊断', '动平衡校正', '故障预测'].map((t) => (
              <span key={t} className="mr-1 inline-block rounded-full border border-pulse-cyan/30 px-2 py-0.5 text-[10px] text-pulse-cyan/90">
                {t}
              </span>
            ))}
          </div>
          <p className="mt-3 border-t border-line-subtle pt-2 font-mono text-[11px] text-forge-amber">初始身价 980 Token/月</p>
        </div>
      </div>
    </StageShell>
  )
}

/* ─── 第二幕 · 上架 ─────────────────────────────────────────────── */
export function ListingStage() {
  return (
    <StageShell label="REVIEW & LISTING">
      <div className="flex h-full items-center gap-4 pt-4">
        {/* 评审队列 */}
        <div className="relative h-[70%] w-[22%] shrink-0">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="absolute inset-x-0 top-0 h-[70%] rounded-xl border border-line-subtle bg-panel/70"
              style={{ transform: `translateY(${i * 14}px) rotate(${i % 2 === 0 ? -3 : 3}deg)`, opacity: 1 - i * 0.25 }}
            >
              <div className="flex h-full flex-col items-center justify-center gap-2 p-3">
                <div className="h-8 w-8 rounded-full bg-muted" />
                <div className="h-2 w-3/4 rounded bg-muted" />
                <div className="h-2 w-1/2 rounded bg-muted/70" />
              </div>
            </div>
          ))}
          <p className="absolute -bottom-6 w-full text-center font-mono text-[10px] text-ink-faint">评审队列 · 3</p>
        </div>

        {/* 通过卡 */}
        <div className="st2-card relative flex-1 rounded-xl border border-line-subtle bg-panel/90 p-4 md:p-5">
          <div className="st2-stamp absolute -right-2 -top-3 z-10 flex items-center gap-1 rounded-lg border-2 border-jade-green px-2.5 py-1 text-[12px] font-bold text-jade-green shadow-[0_0_16px_rgba(52,211,153,0.4)]" style={{ transform: 'rotate(6deg)' }}>
            <Stamp className="h-3.5 w-3.5" />
            审核通过
          </div>
          <div className="st2-block flex items-center gap-3">
            <img src="/avatar-zhenheng.png" alt="振衡" className="h-12 w-12 rounded-full border border-line-subtle object-cover" />
            <div>
              <p className="text-base font-bold text-ink-primary">振衡 <span className="ml-1 font-mono text-[10px] font-normal text-pulse-cyan">ART-0007</span></p>
              <p className="text-[11px] text-ink-faint">陈国栋 · 32年数控经验 · 装备制造</p>
            </div>
          </div>
          <div className="st2-block mt-3 flex flex-wrap gap-1.5">
            {['振动诊断', '动平衡校正', '故障预测'].map((t) => (
              <span key={t} className="rounded-full border border-pulse-cyan/30 px-2 py-0.5 text-[10px] text-pulse-cyan/90">{t}</span>
            ))}
          </div>
          <div className="st2-block mt-3 grid grid-cols-3 gap-2 border-t border-line-subtle pt-3 text-center">
            <div><p className="font-grotesk text-sm font-bold text-ink-primary">9</p><p className="text-[10px] text-ink-faint">技能清单</p></div>
            <div><p className="font-grotesk text-sm font-bold text-ink-primary">4.9★</p><p className="text-[10px] text-ink-faint">雇主评价</p></div>
            <div><p className="font-grotesk text-sm font-bold text-ink-primary">1,842</p><p className="text-[10px] text-ink-faint">历史任务</p></div>
          </div>
          <div className="st2-block mt-3 flex items-center justify-between rounded-lg border border-forge-amber/30 bg-forge-amber/5 px-3 py-2">
            <span className="text-[11px] text-ink-secondary">平台建议价 + 老师傅调整</span>
            <span className="font-mono text-sm font-bold text-forge-amber">1,280 Token/月</span>
          </div>
        </div>
      </div>
    </StageShell>
  )
}

/* ─── 第三幕 · 定价 ─────────────────────────────────────────────── */
const PRICE_PATH = 'M0 92 C30 90 50 84 80 78 S130 70 160 64 S230 58 260 50 S320 44 350 36 S420 30 470 24 S540 18 600 12'
const PRICE_EVENTS = [
  { x: '27%', y: '38%', label: '+12% 供不应求' },
  { x: '55%', y: '26%', label: '+8% 评分溢价' },
  { x: '80%', y: '14%', label: '+6% 经验增值' },
]

export function PricingStage() {
  return (
    <StageShell label="DYNAMIC PRICING">
      <div className="flex h-full flex-col pt-4">
        <div className="flex items-baseline justify-center gap-2">
          <span className="font-grotesk text-4xl font-bold tabular-nums text-forge-amber md:text-5xl">1,280</span>
          <span className="font-mono text-xs text-ink-faint">Token/月 · 当前身价</span>
        </div>

        {/* 90 天价格曲线 */}
        <div className="relative mt-2 flex-1">
          <svg viewBox="0 0 600 110" className="h-full w-full" fill="none" preserveAspectRatio="none" aria-hidden>
            <defs>
              <linearGradient id="lcPriceFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#F5A524" stopOpacity="0.25" />
                <stop offset="100%" stopColor="#F5A524" stopOpacity="0" />
              </linearGradient>
            </defs>
            {[22, 48, 74, 100].map((y) => (
              <line key={y} x1="0" y1={y} x2="600" y2={y} stroke="rgba(124,140,222,0.12)" strokeWidth="0.5" />
            ))}
            <path d={`${PRICE_PATH} L600 110 L0 110 Z`} fill="url(#lcPriceFill)" stroke="none" className="st3-area" />
            <path className="st3-curve" d={PRICE_PATH} stroke="#F5A524" strokeWidth="2" pathLength={1} style={{ strokeDasharray: 1 }} />
          </svg>
          {PRICE_EVENTS.map((e) => (
            <span
              key={e.label}
              className="st3-event absolute -translate-x-1/2 rounded-full border border-pulse-cyan/40 bg-void/90 px-2 py-0.5 font-mono text-[10px] text-pulse-cyan shadow-[0_0_12px_rgba(34,211,238,0.3)]"
              style={{ left: e.x, top: e.y }}
            >
              {e.label}
            </span>
          ))}
        </div>

        {/* 供需天平 */}
        <div className="mt-1 flex flex-col items-center">
          <div className="st3-beam flex w-56 items-center justify-between" style={{ transformOrigin: 'center center' }}>
            <span className="rounded border border-jade-green/40 px-2 py-0.5 text-[10px] text-jade-green">需求 ↑</span>
            <span className="h-px w-16 bg-ink-faint" />
            <span className="rounded border border-line-subtle px-2 py-0.5 text-[10px] text-ink-faint">供给</span>
          </div>
          <div className="mt-0.5 h-3 w-px bg-ink-faint" />
          <p className="font-mono text-[10px] text-ink-faint">需求端下沉 → 价格上浮通道开启</p>
        </div>
      </div>
    </StageShell>
  )
}

/* ─── 第四幕 · 雇佣 ─────────────────────────────────────────────── */
const HIRE_STEPS = [
  { icon: FlaskConical, title: '试用申请', desc: '7 天沙箱试用' },
  { icon: FileCheck2, title: '评估报告', desc: '适配度 A- · 92 分' },
  { icon: ScrollText, title: '智能合约', desc: '周期与月薪上链' },
]

export function HireStage() {
  return (
    <StageShell label="TRIAL & CONTRACT">
      <div className="flex h-full flex-col pt-3">
        <div className="grid grid-cols-3 gap-3" style={{ perspective: '800px' }}>
          {HIRE_STEPS.map((s) => (
            <div key={s.title} className="st4-step rounded-xl border border-line-subtle bg-panel/80 p-3 text-center" style={{ transformStyle: 'preserve-3d' }}>
              <s.icon className="mx-auto h-5 w-5 text-pulse-cyan" />
              <p className="mt-2 text-[13px] font-bold text-ink-primary">{s.title}</p>
              <p className="mt-1 text-[10px] leading-snug text-ink-faint">{s.desc}</p>
            </div>
          ))}
        </div>

        {/* 合约卷轴 */}
        <div className="st4-contract relative mt-4 flex-1 rounded-xl border border-nebula-violet/40 bg-gradient-to-b from-panel/90 to-deep/90 p-4" style={{ transformOrigin: 'top center' }}>
          <p className="hud-label text-nebula-violet/80">SMART CONTRACT · 雇佣合约</p>
          <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 font-mono text-[11px] md:text-xs">
            <p className="text-ink-faint">雇主 <span className="ml-2 text-ink-primary">某精密机械厂</span></p>
            <p className="text-ink-faint">工匠 <span className="ml-2 text-ink-primary">振衡 ART-0007</span></p>
            <p className="text-ink-faint">周期 <span className="ml-2 text-ink-primary">12 个月</span></p>
            <p className="text-ink-faint">月薪 <span className="ml-2 text-forge-amber">1,280 Token</span></p>
          </div>
          {/* 链式印章 */}
          <div className="absolute bottom-3 left-4 right-4 flex items-center gap-1.5">
            {[0, 1, 2, 3, 4].map((i) => (
              <span key={i} className="flex items-center gap-1.5">
                <span className="st4-chain block h-4 w-4 rounded-sm border border-pulse-cyan/60 bg-pulse-cyan/20" />
                {i < 4 && <span className="st4-chain block h-px w-4 bg-pulse-cyan/50 md:w-7" />}
              </span>
            ))}
            <span className="ml-2 font-mono text-[9px] text-ink-faint">DECISION CHAIN SEALED</span>
          </div>
        </div>
      </div>
    </StageShell>
  )
}

/* ─── 第五幕 · 执行 ─────────────────────────────────────────────── */
const SKILL_CHAIN = ['振动频谱采集', '特征提取', '异常阈值判定', '诊断报告生成']

export function ExecuteStage() {
  return (
    <StageShell label="TASK EXECUTION">
      <div className="flex h-full flex-col pt-3">
        {/* 意图气泡 */}
        <div className="st5-intent max-w-[85%] rounded-2xl rounded-bl-sm border border-line-subtle bg-panel/90 px-4 py-2.5">
          <p className="text-[12px] leading-snug text-ink-primary md:text-[13px]">帮我看一下 3 号 CNC 的振动频谱有没有异常</p>
          <p className="mt-1 font-mono text-[9px] text-pulse-cyan">意图解析 · 振动异常诊断 → 目标设备：3 号 CNC</p>
        </div>

        {/* 技能链 */}
        <div className="mt-4 flex items-center gap-2">
          {SKILL_CHAIN.map((s, i) => (
            <div key={s} className="flex flex-1 items-center gap-2">
              <div className="st5-node flex-1 rounded-lg border border-line-subtle bg-panel/80 px-2 py-2 text-center">
                <span className="st5-node-dot mx-auto block h-1.5 w-1.5 rounded-full bg-ink-faint" />
                <p className="mt-1.5 text-[10px] leading-tight text-ink-secondary md:text-[11px]">{s}</p>
              </div>
              {i < SKILL_CHAIN.length - 1 && <span className="h-px w-2 shrink-0 bg-line-subtle" />}
            </div>
          ))}
        </div>

        {/* 进度条 */}
        <div className="mt-4">
          <div className="flex justify-between font-mono text-[9px] text-ink-faint">
            <span>EXECUTING</span><span className="st5-pct">100%</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="st5-progress h-full w-full rounded-full bg-gradient-to-r from-nebula-violet to-pulse-cyan" style={{ transformOrigin: 'left center' }} />
          </div>
        </div>

        {/* 报告卡 */}
        <div className="st5-report mt-3 flex flex-1 items-center justify-between rounded-xl border border-jade-green/30 bg-jade-green/5 px-4 py-2.5">
          <div>
            <p className="text-[12px] font-bold text-ink-primary">结构化报告 · 3 号 CNC 振动诊断</p>
            <p className="mt-0.5 text-[10px] text-ink-faint">2 项关键发现 · 3 条建议措施</p>
          </div>
          <div className="text-right">
            <p className="font-grotesk text-xl font-bold text-jade-green">92 · A</p>
            <p className="font-mono text-[9px] text-ink-faint">置信度</p>
          </div>
        </div>

        <Link to="/workbench" className="group mt-2 inline-flex items-center gap-1 self-end text-[11px] text-pulse-cyan/80 transition-colors hover:text-pulse-cyan">
          体验完整工作台
          <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
        </Link>
      </div>
    </StageShell>
  )
}

/* ─── 第六幕 · 进化 ─────────────────────────────────────────────── */
const GROWTH_TAGS = ['经验值 +12,408', '身价 980 → 1,280 Token', '信用 4.6 → 4.9★']

export function EvolveStage() {
  return (
    <StageShell label="EVOLUTION">
      <div className="relative flex h-full items-center justify-center pt-2">
        {/* 三层螺旋光点 */}
        <div className="st6-stage relative flex h-[86%] aspect-square items-center justify-center">
          {[64, 96, 128].map((r, ring) =>
            Array.from({ length: 10 + ring * 4 }).map((_, i, arr) => {
              const angle = (i / arr.length) * Math.PI * 2 + ring * 0.6
              return (
                <span
                  key={`${ring}-${i}`}
                  className="st6-dot absolute h-1.5 w-1.5 rounded-full"
                  style={{
                    left: `calc(50% + ${Math.cos(angle) * r}px)`,
                    top: `calc(50% + ${Math.sin(angle) * r * 0.82}px)`,
                    backgroundColor: ring === 2 ? '#F5A524' : ring === 1 ? '#7C5CFF' : '#22D3EE',
                    boxShadow: `0 0 8px ${ring === 2 ? 'rgba(245,165,36,0.6)' : ring === 1 ? 'rgba(124,92,255,0.6)' : 'rgba(34,211,238,0.6)'}`,
                    transform: 'translate(-50%, -50%)',
                  }}
                />
              )
            }),
          )}
          <img
            src="/avatar-zhenheng.png"
            alt="振衡"
            className="relative z-10 h-20 w-20 rounded-full border-2 border-nebula-violet/60 object-cover shadow-[0_0_32px_rgba(124,92,255,0.5)] md:h-24 md:w-24"
          />
          {/* 琥珀新技能气泡 */}
          <span className="st6-skill absolute right-[2%] top-[6%] rounded-full border border-forge-amber/50 bg-forge-amber/10 px-2.5 py-1 text-[10px] font-bold text-forge-amber shadow-[0_0_16px_rgba(245,165,36,0.35)]">
            新技能已生效
          </span>
        </div>

        {/* 增长标签 */}
        <div className="absolute bottom-1 left-0 right-0 flex flex-wrap items-center justify-center gap-2">
          {GROWTH_TAGS.map((t) => (
            <span key={t} className="st6-tag rounded-full border border-line-subtle bg-panel/90 px-3 py-1 font-mono text-[10px] text-ink-secondary md:text-[11px]">
              {t}
            </span>
          ))}
        </div>
      </div>
    </StageShell>
  )
}
