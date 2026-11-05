import { Link } from 'react-router'
import { motion } from 'framer-motion'
import { ArrowRight, BrainCircuit, Database, Radar, Workflow } from 'lucide-react'

const CARDS = [
  {
    icon: BrainCircuit,
    title: '意图解析',
    en: 'INTENT PARSING',
    desc: '自然语言 → 结构化任务树，自动识别目标设备与诊断场景。',
  },
  {
    icon: Workflow,
    title: '技能调度',
    en: 'SKILL DISPATCH',
    desc: '从工匠技能清单中选择最优技能链，按调用量与成功率排序。',
  },
  {
    icon: Radar,
    title: '执行监控',
    en: 'OPENCLAW RUNTIME',
    desc: 'OpenClaw 运行时逐技能执行，日志流实时回传、全程可追溯。',
  },
  {
    icon: Database,
    title: '记忆沉淀',
    en: 'MEMORY RETENTION',
    desc: '每次任务的经验写入向量记忆，下次任务自动调用历史基线。',
  },
]

export default function EngineStrip() {
  return (
    <section className="bg-void py-16 md:py-20">
      <div className="mx-auto max-w-site px-5 md:px-12">
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          className="text-center"
        >
          <p className="hud-label text-pulse-cyan/80">BEHIND THE EXECUTION ENGINE</p>
          <h2 className="mt-2 font-display text-[22px] font-bold text-ink-primary md:text-2xl">执行引擎背后</h2>
        </motion.div>

        <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {CARDS.map((c, i) => (
            <motion.div
              key={c.title}
              initial={{ opacity: 0, y: 40 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-60px' }}
              transition={{ delay: 0.1 * i, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
              whileHover={{ y: -6 }}
              className="glass-panel group rounded-2xl p-6 transition-shadow duration-300 hover:shadow-[0_0_24px_rgba(124,92,255,0.3)]"
            >
              <motion.span
                className="pulse-halo inline-flex h-11 w-11 items-center justify-center rounded-xl border border-pulse-cyan/30 bg-pulse-cyan/10 text-pulse-cyan"
              >
                <c.icon className="h-5 w-5 transition-transform duration-500 group-hover:rotate-12" />
              </motion.span>
              <h3 className="mt-4 font-bold text-ink-primary">{c.title}</h3>
              <p className="mt-0.5 font-mono text-[9px] uppercase tracking-[0.18em] text-ink-faint">{c.en}</p>
              <p className="mt-3 text-[13px] leading-relaxed text-ink-secondary">{c.desc}</p>
            </motion.div>
          ))}
        </div>

        <div className="mt-10 text-center">
          <Link
            to="/architecture"
            className="group inline-flex items-center gap-2 text-sm text-pulse-cyan transition-colors hover:text-ink-primary"
          >
            查看完整技术架构
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
          </Link>
        </div>
      </div>
    </section>
  )
}
