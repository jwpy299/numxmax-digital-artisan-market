import { motion } from 'framer-motion'
import { KeyRound, ShieldCheck, ListChecks } from 'lucide-react'
import SectionHeader from '@/components/SectionHeader'
import HudCorner from '@/components/HudCorner'

const SSO_FLOW_EXAMPLE = `// 有 token（localStorage("nebula_auth")）
nebulaLink.createWorkbenchTicket({ token, target: "/dept", source: "craftsman-market" })
// → { ticket: "st_<48 hex>", entryUrl: "/bridge?ticket=<urlencoded>", expiresAt, factoryId, enterpriseName }
window.location.href = entryUrl   // 工作台 /bridge 页 consumeWorkbenchTicket 原子核销，重颁 nt_ 会话 token`

const FLOW = [
  {
    icon: KeyRound,
    title: '两段式 SSO 已打通',
    desc: 'createWorkbenchTicket 签发一次性 ticket（st_ 前缀）→ 整页跳转 entryUrl（/bridge?ticket=...）→ 工作台 consumeWorkbenchTicket 原子核销并重颁 nt_ 会话 token。',
  },
  {
    icon: ShieldCheck,
    title: '一次性明文 · 安全约束',
    desc: 'ticket 明文仅签发响应返回一次（库只存 sha256），TTL 300 秒，不落库、不写日志；token 单点有效，一律放在请求体字段，不放 header。',
  },
  {
    icon: ListChecks,
    title: '两段式业务口径',
    desc: '上架（publish → certify）、招募合同（hire → decide）、展厅（learning → pending_confirm → published）均为「提交 pending + 人工确认」，不承诺即时生效。',
  },
]

/** 面向开发者的 API 集成说明卡：已按官方工作台 API 文档实现 */
export default function ApiIntegration() {
  return (
    <section className="relative bg-void">
      <div className="mx-auto max-w-site px-5 py-16 md:px-12 md:py-24">
        <SectionHeader
          hud="API INTEGRATION · IMPLEMENTED"
          title="API 集成说明"
          subtitle="面向开发者：市场与工作台的对接已按官方《NumX Max 智能工作台 API 文档》实现，以下为已核实的对接事实。"
        />

        <motion.div
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          className="glass-panel relative mx-auto mt-12 max-w-3xl rounded-2xl p-7 md:p-10"
        >
          <HudCorner />

          <div className="grid gap-6 md:grid-cols-3">
            {FLOW.map((item) => (
              <div key={item.title}>
                <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-nebula-violet/30 bg-nebula-violet/10">
                  <item.icon className="h-5 w-5 text-nebula-violet" />
                </div>
                <h3 className="mt-4 text-sm font-bold text-ink-primary">{item.title}</h3>
                <p className="mt-2 text-xs leading-relaxed text-ink-secondary">{item.desc}</p>
              </div>
            ))}
          </div>

          {/* 两段式 SSO 跳转链路示例（依据官方文档 3.2 节已核实行为） */}
          <div className="mt-8 rounded-xl border border-line-subtle bg-void/70 p-5">
            <p className="hud-label mb-3">SSO BRIDGE FLOW · VERIFIED</p>
            <pre className="block overflow-x-auto font-mono text-[12px] leading-relaxed text-pulse-cyan whitespace-pre">
              {SSO_FLOW_EXAMPLE}
            </pre>
          </div>

          <p className="mt-4 text-center text-xs text-ink-faint">
            服务端协议：tRPC（/api/trpc，superjson transformer）；token 在请求体字段；ticket 一次性、TTL 300 秒。
          </p>
        </motion.div>
      </div>
    </section>
  )
}
