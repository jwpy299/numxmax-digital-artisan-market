/**
 * NumX Max 熊猫 IP 3D 形象（iter96）——数字匠市 Agent 统一形象层。
 *
 * 五个角色化 3D 渲染图（/ip/agent-*.png，透明底，皮克斯级 3D 渲染）：
 * - agent-co  军团连长（指挥）
 * - agent-ex  执行专员（执行）
 * - agent-va  质检官（质检/品控）
 * - agent-ev  进化官（数据/优化/进化）
 * - agent-guide 门户导购（营销/客服/导购）
 *
 * 按 Agent 能力标签确定性匹配角色（同 Agent 永远同形象）；加载失败静默回退原头像。
 */

const ROLE_IMAGES = {
  co: '/ip/agent-co.png',
  ex: '/ip/agent-ex.png',
  va: '/ip/agent-va.png',
  ev: '/ip/agent-ev.png',
  guide: '/ip/agent-guide.png',
} as const

/** M44：IP 职业套装（灵枢＆星云 ip设计方案 V1.0.01）——七职业智能体确定性直配 */
const OCC_IMAGES: Record<string, string> = {
  'OCC-0001': '/ip/m44/occ-finance.png',
  'OCC-0002': '/ip/m44/occ-customer.png',
  'OCC-0003': '/ip/m44/occ-warehouse.png',
  'OCC-0004': '/ip/m44/occ-order.png',
  'OCC-0005': '/ip/m44/occ-rnd.png',
  'OCC-0006': '/ip/m44/occ-energy.png',
  'OCC-0007': '/ip/m44/occ-device.png',
} as const

type Role = keyof typeof ROLE_IMAGES

/** 能力标签 → 角色（确定性：优先级命中制，标签缺省按 code 哈希兜底） */
export function pickAgentRole(tags: string[], code?: string): Role {
  const text = tags.join(' ')
  if (/质检|品控|检测|质量|va/i.test(text)) return 'va'
  if (/数据|分析|优化|进化|预测|ev/i.test(text)) return 'ev'
  if (/导购|营销|客服|销售|品牌|推广/i.test(text)) return 'guide'
  if (/调度|管理|协调|排产|计划|指挥|co/i.test(text)) return 'co'
  if (/执行|运维|操作|巡检|维修|物流|装配|ex/i.test(text)) return 'ex'
  // 兜底：按 code 稳定哈希分配，保证同 Agent 形象恒定
  const seedStr = code ?? text ?? 'agent'
  let h = 0
  for (let i = 0; i < seedStr.length; i++) h = (h * 31 + seedStr.charCodeAt(i)) >>> 0
  const order: Role[] = ['ex', 'co', 'va', 'ev', 'guide']
  return order[h % order.length]
}

export function agentIpImage(tags: string[], code?: string): string {
  // M44：IP 职业装优先（code 直配），命中不了再走五角色标签映射
  if (code && OCC_IMAGES[code]) return OCC_IMAGES[code]
  return ROLE_IMAGES[pickAgentRole(tags, code)]
}

interface AgentIpImageProps {
  tags: string[]
  code?: string
  alt: string
  className?: string
  /** 加载失败回退图（原 avatar 路径） */
  fallback?: string
}

export default function AgentIpImage({ tags, code, alt, className, fallback }: AgentIpImageProps) {
  return (
    <img
      src={agentIpImage(tags, code)}
      alt={alt}
      loading="lazy"
      className={className}
      onError={(e) => {
        const img = e.currentTarget
        if (fallback && img.src !== fallback) img.src = fallback
        else img.style.display = 'none'
      }}
    />
  )
}
