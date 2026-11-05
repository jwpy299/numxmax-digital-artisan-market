import { motion } from 'framer-motion'
import { ClipboardList, FileBarChart2, Boxes } from 'lucide-react'
import SectionHeader from '@/components/SectionHeader'
import HudCorner from '@/components/HudCorner'

const STEPS = [
  {
    icon: ClipboardList,
    title: '申请试用',
    desc: '填写产线基本信息，10 秒完成。',
  },
  {
    icon: Boxes,
    title: '沙箱执行',
    desc: 'Agent 在隔离沙箱中接入脱敏数据，技能调用费照常计收（每次 100 Token，平台抽 20%）。',
  },
  {
    icon: FileBarChart2,
    title: '评估报告',
    desc: '试用结束自动生成报告：任务完成度、诊断准确率、响应时延、置信度评分、雇佣建议。',
  },
]

/** 7 天沙箱试用说明：3 步流程 + 报告样例 */
export default function TrialSection() {
  return (
    <section id="trial" className="bg-void py-[72px] md:py-[120px]">
      <div className="mx-auto max-w-site px-5 md:px-12">
        <SectionHeader
          hud="7-DAY SANDBOX TRIAL"
          title="7 天沙箱试用"
          subtitle="先试用，再签约。用真实的脱敏产线数据，验证这位工匠值不值得长期雇佣。"
        />

        <div className="mt-14 grid items-start gap-10 lg:grid-cols-[1fr_360px]">
          {/* 3-step flow */}
          <div className="relative grid gap-6 md:grid-cols-3">
            <span
              aria-hidden
              className="absolute left-[16%] right-[16%] top-10 hidden border-t border-dashed border-pulse-cyan/30 md:block"
            />
            {STEPS.map((s, i) => (
              <motion.div
                key={s.title}
                initial={{ opacity: 0, y: 50 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-60px' }}
                transition={{ delay: i * 0.12, duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
                className="relative rounded-2xl glass-panel p-6 text-center"
              >
                <div className="relative mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-pulse-cyan/40 bg-pulse-cyan/10">
                  <s.icon className="h-6 w-6 text-pulse-cyan" />
                  <span className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-brand-gradient font-grotesk text-[10px] font-bold text-white">
                    {i + 1}
                  </span>
                </div>
                <h3 className="mt-4 font-sans text-lg font-bold text-ink-primary">{s.title}</h3>
                <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">{s.desc}</p>
              </motion.div>
            ))}
          </div>

          {/* sample report card */}
          <motion.div
            initial={{ opacity: 0, y: 40, rotate: 2 }}
            whileInView={{ opacity: 1, y: 0, rotate: 0 }}
            viewport={{ once: true, margin: '-60px' }}
            transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
            className="relative rounded-2xl glass-panel p-7"
          >
            <HudCorner />
            <div className="flex items-start justify-between">
              <div>
                <p className="hud-label text-pulse-cyan/80">SAMPLE REPORT</p>
                <h3 className="mt-2 font-display text-lg font-bold text-ink-primary">试用评估报告 · 样例</h3>
              </div>
              <motion.span
                animate={{ boxShadow: ['0 0 8px rgba(245,165,36,0.25)', '0 0 24px rgba(245,165,36,0.6)', '0 0 8px rgba(245,165,36,0.25)'] }}
                transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
                className="flex h-12 w-12 items-center justify-center rounded-xl bg-forge-amber/15 font-grotesk text-xl font-bold text-forge-amber"
              >
                A-
              </motion.span>
            </div>
            <div className="mt-5 space-y-3 font-mono text-[13px]">
              <p className="flex justify-between text-ink-secondary">
                <span>诊断准确率</span>
                <span className="text-pulse-cyan">96.8%</span>
              </p>
              <p className="flex justify-between text-ink-secondary">
                <span>平均响应</span>
                <span className="text-pulse-cyan">4.2s</span>
              </p>
              <p className="flex justify-between text-ink-secondary">
                <span>综合置信度</span>
                <span className="text-forge-amber">A-</span>
              </p>
              <p className="flex justify-between border-t border-line-subtle pt-3 text-ink-secondary">
                <span>平台建议</span>
                <span className="text-jade-green">正式雇佣</span>
              </p>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  )
}
