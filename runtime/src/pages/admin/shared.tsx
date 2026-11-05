/**
 * 超级终端（/admin/*）共享助手与小组件。
 * 文案口径：Token 只用「结算/兑换/计量」；操作均为两段式措辞——
 * 「提交后由系统执行，页面刷新后生效」，不承诺即时生效。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { WbButton } from '@/components/wb/ui'

/** 所有变更类操作的统一两段式提示 */
export const ADMIN_EFFECT_HINT = '提交后由系统执行，页面刷新后生效'

/** 操作二次确认（window.confirm 即可） */
export function adminConfirm(action: string): boolean {
  return window.confirm(`确认${action}？\n${ADMIN_EFFECT_HINT}。`)
}

/** 时间戳格式化（Date / string / null 兼容） */
export function fmtTime(value: unknown): string {
  if (!value) return '—'
  const d = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(d.getTime())) return '—'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 分页条 */
export function AdminPager({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number
  pageSize: number
  total: number
  onPage: (page: number) => void
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  if (pages <= 1) return null
  return (
    <div className="mt-4 flex items-center justify-between text-xs text-ink-secondary">
      <span>
        共 {total} 条 · 第 {page}/{pages} 页
      </span>
      <div className="flex gap-2">
        <WbButton variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          上一页
        </WbButton>
        <WbButton variant="secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          下一页
        </WbButton>
      </div>
    </div>
  )
}

/** 表格容器（统一暗色工业风） */
export function AdminTable({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-line-subtle text-left">
            {head.map((h, i) => (
              <th key={i} className="px-3 py-2.5 font-mono text-[11px] font-medium tracking-wider text-ink-faint">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line-subtle/60">{children}</tbody>
      </table>
    </div>
  )
}

export const adminTdCls = 'px-3 py-2.5 align-middle text-ink-secondary'

/**
 * 驻部智能体静态名册（与 db/sync-terminal.mts 种子一致）：
 * 当 st_agents 尚未种子化 / departments 查询失败时，用于聊天与会议室的头像、职位展示兜底。
 */
export const AGENT_STATIC_META: Record<string, { name: string; title: string; avatarEmoji: string }> = {
  lingsCe: { name: '灵策', title: 'COO 运营官', avatarEmoji: '🧭' },
  lingsMou: { name: '灵眸', title: 'CMO 市场官', avatarEmoji: '👁️' },
  lingsZhu: { name: '灵筑', title: 'CTO 技术官', avatarEmoji: '🛠️' },
  lingsHeng: { name: '灵衡', title: '首席法务官', avatarEmoji: '⚖️' },
  lingsSuan: { name: '灵算', title: '首席财务官', avatarEmoji: '🧮' },
}

/**
 * LLM 回复来源标记（迭代 18 灵智枢智能运营）：
 * 成功时标注 provider/模型；降级时标注「规则降级」（大模型暂不可用，规则生成）。
 */
export function ProviderTag({
  provider,
  model,
  degraded,
  className,
}: {
  provider?: string | null
  model?: string | null
  degraded?: boolean
  className?: string
}) {
  if (degraded) {
    return (
      <span
        className={`inline-flex items-center rounded-full border border-forge-amber/40 bg-forge-amber/10 px-2 py-0.5 font-mono text-[10px] text-forge-amber ${className ?? ''}`}
      >
        模板应答 · 非 AI 生成
      </span>
    )
  }
  if (!provider) return null
  return (
    <span
      className={`inline-flex items-center rounded-full border border-pulse-cyan/40 bg-pulse-cyan/10 px-2 py-0.5 font-mono text-[10px] text-pulse-cyan ${className ?? ''}`}
    >
      {provider}
      {model ? ` · ${model}` : ''}
    </span>
  )
}

// ─── C1 等待感治理：发送中动态阶段文案 + 秒数计时（非死转圈）──────────────────
const SEND_STAGES = ['正在理解你的需求', '正在匹配岗位技能', '正在调用模型生成', '正在整理产出物']

export function SendingIndicator({ avatar, name }: { avatar?: string; name: string }) {
  const [sec, setSec] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setSec((x) => x + 1), 1000)
    return () => clearInterval(t)
  }, [])
  const stage = SEND_STAGES[Math.min(SEND_STAGES.length - 1, Math.floor(sec / 6))]
  return (
    <div className="flex justify-start">
      <div className="rounded-xl border border-pulse-cyan/25 bg-panel/70 px-3.5 py-2.5 text-xs text-ink-secondary">
        <span className="mr-1.5 inline-block h-2 w-2 animate-pulse rounded-full bg-pulse-cyan" />
        {avatar ? `${avatar} ` : ''}{name} {stage}…
        <span className="ml-2 font-mono text-[10px] text-ink-faint">{sec}s</span>
        <span className="ml-2 text-[10px] text-ink-faint">（生成文档类产出约需 1-2 分钟）</span>
      </div>
    </div>
  )
}
