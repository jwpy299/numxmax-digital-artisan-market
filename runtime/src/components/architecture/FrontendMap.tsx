import { motion } from 'framer-motion'
import { Link } from 'react-router'
import { ArrowUpRight } from 'lucide-react'
import SectionHeader from '@/components/SectionHeader'

const ROWS = [
  { module: '数字匠市', feature: '搜索、浏览、筛选 Agent', page: 'Skill Hub 商城首页', to: '/market', route: '/market' },
  { module: 'Agent 详情页', feature: '查看能力、技能、评价、价格', page: 'Skill Hub 商城', to: '/market/agent/zhenheng', route: '/market/agent/:id' },
  { module: '我的数字员工', feature: '已雇佣 Agent 管理、任务分发', page: '智能工作台', to: '/workbench', route: '/workbench' },
  { module: 'Agent 工作台', feature: 'Agent 执行任务的状态监控', page: '智能工作台', to: '/workbench', route: '/workbench' },
]

export default function FrontendMap() {
  return (
    <section className="relative bg-void">
      <div className="mx-auto max-w-site px-5 py-[72px] md:px-12 md:py-[120px]">
        <SectionHeader
          hud="FRONTEND MAPPING"
          title="前端功能模块映射"
          subtitle="后端服务能力的每一个出口，都对应本站一个可交互的真实页面。"
        />

        <motion.div
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          className="glass-panel mt-14 overflow-hidden rounded-2xl"
        >
          {/* header */}
          <div className="grid grid-cols-[1fr_1.4fr_1.4fr] gap-4 border-b border-line-subtle px-6 py-4 md:px-8">
            <span className="hud-label text-[10px] text-ink-faint">模块</span>
            <span className="hud-label text-[10px] text-ink-faint">功能</span>
            <span className="hud-label text-[10px] text-ink-faint">对应页面</span>
          </div>
          {ROWS.map((r, i) => (
            <motion.div
              key={r.module}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-40px' }}
              transition={{ duration: 0.5, delay: 0.1 + i * 0.1, ease: [0.16, 1, 0.3, 1] }}
              className="grid grid-cols-[1fr_1.4fr_1.4fr] items-center gap-4 border-b border-line-subtle px-6 py-5 transition-colors duration-300 last:border-b-0 hover:bg-pulse-cyan/[0.04] md:px-8"
            >
              <span className="text-sm font-bold text-ink-primary">{r.module}</span>
              <span className="text-[13px] leading-relaxed text-ink-secondary">{r.feature}</span>
              <span>
                <Link
                  to={r.to}
                  className="group inline-flex items-center gap-1.5 text-[13px] text-pulse-cyan transition-colors hover:text-ink-primary"
                >
                  {r.page}
                  <span className="font-mono text-[10px] text-ink-faint">（本站 {r.route}）</span>
                  <ArrowUpRight className="h-3.5 w-3.5 transition-transform duration-300 group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                </Link>
              </span>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  )
}
