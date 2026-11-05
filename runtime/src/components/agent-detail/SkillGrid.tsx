import { motion } from 'framer-motion'
import type { DetailData } from '@/components/agent-detail/detail-data'
import SectionHeader from '@/components/SectionHeader'
import CountUp from '@/components/market/CountUp'
import BaseSkillBadges from '@/components/market/BaseSkillBadges'
import { cn } from '@/lib/utils'

interface SkillGridProps {
  skills: DetailData['skills']
}

/** 技能清单：标配办公技能（全员工出生自带）+ V=动作类（violet）/ U=判断类（cyan） */
export default function SkillGrid({ skills }: SkillGridProps) {
  return (
    <section className="bg-deep py-[72px] md:py-[120px]">
      <div className="mx-auto max-w-site px-5 md:px-12">
        <SectionHeader
          hud="SKILL MANIFEST"
          title="技能清单"
          subtitle="标配 = 全员自带基础办公技能 · V = 动作类技能 · U = 判断类技能"
        />

        {/* iter97 基础教育包：标配四件套徽章 */}
        <BaseSkillBadges className="mt-8" />

        {skills.length === 0 ? (
          <p className="mt-12 text-center text-sm text-ink-faint">技能清单数据暂不可用</p>
        ) : (
          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {skills.map((s, i) => {
              const isV = s.type === 'V'
              return (
                <motion.div
                  key={s.id}
                  initial={{ opacity: 0, y: 40 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, margin: '-60px' }}
                  transition={{ delay: (i % 3) * 0.06, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                  className="group relative rounded-2xl glass-panel p-6 transition-shadow duration-300 hover:shadow-[0_0_20px_rgba(34,211,238,0.25)]"
                >
                  {/* V/U corner badge */}
                  <span
                    className={cn(
                      'absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-lg border font-grotesk text-sm font-bold transition-transform duration-300 group-hover:rotate-12',
                      isV
                        ? 'border-nebula-violet/60 bg-nebula-violet/15 text-nebula-violet'
                        : 'border-pulse-cyan/60 bg-pulse-cyan/15 text-pulse-cyan',
                    )}
                  >
                    {s.type}
                  </span>

                  <h3 className="pr-10 font-sans text-lg font-bold text-ink-primary">{s.name}</h3>
                  <p className="mt-1 text-[11px] text-ink-faint">
                    {isV ? '动作类 · 演示操作捕获' : '判断类 · 决策逻辑捕获'}
                  </p>
                  {/* Harness H1 技能真实化徽标：⚡ 真执行器（玉绿）/ ✨ 生成式（灰） */}
                  {s.badge && (
                    <p className="mt-2">
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px]',
                          s.badge === 'real'
                            ? 'border-jade-green/50 bg-jade-green/10 text-jade-green'
                            : 'border-line-subtle text-ink-faint',
                        )}
                      >
                        {s.badge === 'real' ? '⚡ 真执行器' : '✨ 生成式'}
                      </span>
                    </p>
                  )}

                  <div className="mt-5 flex items-end justify-between border-t border-line-subtle pt-4">
                    <div>
                      <p className="font-grotesk text-xl font-bold text-ink-primary">
                        <CountUp value={s.callCount} />
                      </p>
                      <p className="mt-0.5 text-[11px] text-ink-faint">被调用次数</p>
                    </div>
                    <div className="text-right">
                      {/* H1 起切换口径：不再展示种子 successRate（默认 98 为种子数据）；
                          展示近 90 天真实调用成功率，样本不足 5 次显示「样本不足」 */}
                      {s.realSuccessRate != null ? (
                        <>
                          <p className="font-grotesk text-xl font-bold text-jade-green">
                            <CountUp value={s.realSuccessRate} decimals={1} duration={900} />%
                          </p>
                          <p className="mt-0.5 text-[11px] text-ink-faint">成功率 · 真实统计</p>
                        </>
                      ) : (
                        <>
                          <p className="font-grotesk text-sm font-bold text-ink-faint">样本不足</p>
                          <p className="mt-0.5 text-[11px] text-ink-faint">成功率（近 90 天）</p>
                        </>
                      )}
                    </div>
                  </div>
                </motion.div>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}
