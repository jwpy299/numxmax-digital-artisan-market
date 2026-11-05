import { motion } from 'framer-motion'
import { BadgeCheck, Sparkles, TrendingUp } from 'lucide-react'
import SectionHeader from '@/components/SectionHeader'

const MASTERS = [
  {
    name: '振衡',
    avatar: '/avatar-zhenheng.png',
    master: '陈国栋 · 32年数控经验',
    field: '振动诊断 / 动平衡',
  },
  {
    name: '炽眸',
    avatar: '/avatar-chimou.png',
    master: '赵云霞 · 29年焊接工艺',
    field: '焊缝质检 / 缺陷识别',
  },
  {
    name: '策炉',
    avatar: '/avatar-celu.png',
    master: '霍炎彬 · 30年热处理',
    field: '热处理曲线 / 淬火控制',
  },
]

const POINTS = [
  {
    icon: BadgeCheck,
    title: '严选首批老师傅',
    text: '从首批内测工厂中选择 3–5 位经验丰富的老师傅，优先封装其 Agent，确保第一批工匠就能打。',
  },
  {
    icon: Sparkles,
    title: '「市场推荐」流量扶持',
    text: '平台给予首批 Agent「市场推荐」标签与流量加权，让优质经验第一时间被工厂看见。',
  },
  {
    icon: TrendingUp,
    title: '平台建议价 + 渐进放开',
    text: '首批定价由平台给出建议价、老师傅确认；积累真实雇佣数据后，逐步放开价格浮动。',
  },
]

function MasterCard({ m, index }: { m: (typeof MASTERS)[number]; index: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 50, rotate: 2 }}
      whileInView={{ opacity: 1, y: 0, rotate: 0 }}
      viewport={{ once: true, margin: '-80px' }}
      transition={{ duration: 0.7, delay: 0.2 + index * 0.12, ease: [0.16, 1, 0.3, 1] }}
      whileHover={{ y: -6 }}
      className="glass-panel relative flex items-center gap-4 rounded-2xl p-4 transition-shadow duration-300 hover:shadow-[0_0_24px_rgba(124,92,255,0.35)]"
    >
      <img src={m.avatar} alt={m.name} className="h-16 w-16 rounded-xl border border-line-subtle object-cover" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-display text-lg font-bold text-ink-primary">{m.name}</span>
          <span className="animate-rec-badge rounded-full border border-forge-amber/50 bg-forge-amber/10 px-2 py-0.5 text-[10px] font-medium text-forge-amber">
            市场推荐
          </span>
        </div>
        <p className="mt-1 truncate font-mono text-[10px] text-ink-faint">{m.master}</p>
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <span className="truncate text-[11px] text-ink-secondary">{m.field}</span>
          <span className="shrink-0 animate-pulse font-mono text-[10px] text-nebula-violet">首批扶持 · 流量加权 ×3</span>
        </div>
      </div>
    </motion.div>
  )
}

export default function ColdStart() {
  return (
    <section className="relative bg-deep">
      <div className="mx-auto max-w-site px-5 py-[72px] md:px-12 md:py-[120px]">
        <SectionHeader
          hud="COLD START"
          title="冷启动 — 首批 Agent 上线计划"
          align="left"
        />
        <div className="mt-14 grid items-start gap-12 lg:grid-cols-[45%_55%] lg:gap-10">
          {/* left copy */}
          <div className="space-y-8">
            {POINTS.map((p, i) => (
              <motion.div
                key={p.title}
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-60px' }}
                transition={{ duration: 0.6, delay: i * 0.1, ease: [0.16, 1, 0.3, 1] }}
                className="flex gap-4"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-nebula-violet/40 bg-nebula-violet/10">
                  <p.icon className="h-4 w-4 text-nebula-violet" />
                </span>
                <div>
                  <h3 className="text-base font-bold text-ink-primary md:text-lg">{p.title}</h3>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-ink-secondary md:text-sm">{p.text}</p>
                </div>
              </motion.div>
            ))}
          </div>

          {/* right: first-batch artisan mini cards with violet light beams */}
          <div className="relative">
            <div
              aria-hidden
              className="pointer-events-none absolute -inset-8 opacity-70"
              style={{
                background:
                  'radial-gradient(ellipse at 30% 20%, rgba(124,92,255,0.25), transparent 60%), radial-gradient(ellipse at 80% 80%, rgba(180,76,255,0.18), transparent 60%)',
              }}
            />
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-gradient-to-b from-transparent via-nebula-violet/40 to-transparent"
            />
            <div className="relative space-y-5">
              {MASTERS.map((m, i) => (
                <div key={m.name} className={i === 1 ? 'md:ml-10' : i === 2 ? 'md:ml-20' : ''}>
                  <MasterCard m={m} index={i} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
