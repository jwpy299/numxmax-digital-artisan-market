import { motion } from 'framer-motion'
import { ArrowUpRight, CloudOff } from 'lucide-react'
import SectionHeader from '@/components/SectionHeader'
import HudCorner from '@/components/HudCorner'
import { loadWbSession, useWbQuery } from '@/lib/wbSession'
import type { WbHireRow } from '@/lib/wbTypes'
import { NEBULA_WORKBENCH_URL } from '@/config/workbench'

interface EmployeeCardData {
  key: string
  name: string
  avatar: string
  status: 'active' | 'trial'
  monthlyPrice: number
}

/** 接口失败时的静态示例（与种子数据对齐） */
const FALLBACK_EMPLOYEES: EmployeeCardData[] = [
  { key: 'zhenheng', name: '振衡', avatar: '/avatar-zhenheng.png', status: 'active', monthlyPrice: 12800 },
  { key: 'chimou', name: '炽眸', avatar: '/avatar-chimou.png', status: 'active', monthlyPrice: 11200 },
  { key: 'tingtao', name: '听涛', avatar: '/avatar-tingtao.png', status: 'trial', monthlyPrice: 9600 },
]

const STATUS_META = {
  active: { label: '已雇佣 · 服务中', cls: 'border-jade-green/40 bg-jade-green/10 text-jade-green' },
  trial: { label: '试用中', cls: 'border-forge-amber/40 bg-forge-amber/10 text-forge-amber' },
} as const

/**
 * 我的数字员工速览：读取真实雇佣记录，失败时优雅降级为静态示例。
 * M22 F1 起 hire.list 需登录态（token 在请求体，仅本企业可见）：
 * 本页为公开门户页，本机有工作台会话时按会话企业拉取，否则直接展示静态示例。
 * 调用走 wb 封装层（useWbQuery，methodOverride:'POST'），token 只进请求体不进 URL。
 */
export default function EmployeePreview() {
  const session = loadWbSession()
  const authed = !!session?.token && typeof session.factoryId === 'number'
  const hiresQuery = useWbQuery<WbHireRow[]>(
    'hire.list',
    session,
    authed ? { enterpriseId: session!.factoryId } : undefined,
    { enabled: authed },
  )

  const degraded = !authed || !!hiresQuery.error

  const employees: EmployeeCardData[] | null = hiresQuery.data !== null
    ? hiresQuery.data
        .filter((h) => h.agent && (h.status === 'active' || h.status === 'trial'))
        .map((h) => ({
          key: String(h.id),
          name: h.agent!.name,
          avatar: h.agent!.avatar,
          status: h.status as 'active' | 'trial',
          monthlyPrice: h.monthlyPrice,
        }))
    : degraded
      ? FALLBACK_EMPLOYEES
      : null

  return (
    <section className="relative bg-deep">
      <div className="mx-auto max-w-site px-5 py-16 md:px-12 md:py-24">
        <SectionHeader
          hud="MY DIGITAL WORKFORCE"
          title="我的数字员工速览"
          subtitle="华辰精工当前在职的数字工匠——他们已在星云智能工作台待命。"
        />

        {degraded && (
          <motion.p
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            className="mx-auto mt-8 flex max-w-xl items-center justify-center gap-2 rounded-xl border border-forge-amber/30 bg-forge-amber/[0.06] px-4 py-3 text-center text-xs text-forge-amber"
          >
            <CloudOff className="h-4 w-4 shrink-0" />
            实时雇佣数据暂时不可用，以下为静态示例。恢复后将自动展示最新数字员工清单。
          </motion.p>
        )}

        <div className="mt-12 grid gap-6 md:grid-cols-3">
          {employees === null &&
            Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="glass-panel h-64 animate-pulse rounded-2xl" />
            ))}

          {employees?.map((emp, i) => {
            const meta = STATUS_META[emp.status]
            return (
              <motion.div
                key={emp.key}
                initial={{ opacity: 0, y: 40 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-80px' }}
                transition={{ duration: 0.7, delay: i * 0.1, ease: [0.16, 1, 0.3, 1] }}
                whileHover={{ y: -6 }}
                className="glass-panel group relative rounded-2xl p-7 transition-shadow duration-300 hover:shadow-[0_0_24px_rgba(124,92,255,0.35)]"
              >
                <HudCorner />
                <div className="flex items-center gap-4">
                  <img
                    src={emp.avatar}
                    alt={emp.name}
                    className="h-16 w-16 rounded-xl border border-line-subtle object-cover"
                  />
                  <div>
                    <h3 className="text-lg font-bold text-ink-primary">{emp.name}</h3>
                    <span className={`mt-1.5 inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs ${meta.cls}`}>
                      {meta.label}
                    </span>
                  </div>
                </div>

                <div className="mt-6 flex items-end justify-between border-t border-line-subtle pt-5">
                  <div>
                    <p className="hud-label">月薪</p>
                    <p className="mt-1 font-grotesk text-2xl font-bold text-amber-gradient">
                      {emp.monthlyPrice.toLocaleString()}
                      <span className="ml-1 text-xs font-medium text-ink-faint">Token/月</span>
                    </p>
                  </div>
                  <a
                    href={NEBULA_WORKBENCH_URL}
                    className="inline-flex items-center gap-1.5 rounded-[10px] border border-line-subtle px-4 py-2 text-sm text-ink-primary transition-colors duration-300 hover:border-pulse-cyan/50 hover:bg-pulse-cyan/[0.08]"
                  >
                    去工作台使用
                    <ArrowUpRight className="h-4 w-4" />
                  </a>
                </div>
              </motion.div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
