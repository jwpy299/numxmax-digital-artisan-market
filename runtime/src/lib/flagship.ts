/**
 * 五大旗舰数字员工 · 前端常量与数字身份工具。
 * - slug → 角色定位映射（后端 agents 列表未提供角色文案，由前端维护）；
 * - DID 规则与后端 evolutionIdentity 路由保持一致：did:nebula:agent-<slug>；
 * - stableHash：按 DID 生成稳定的展示用伪哈希（非链上真实哈希，仅用于「存证哈希」展示位）。
 */

export interface FlagshipMeta {
  slug: string
  name: string
  /** 角色定位短标签，如「工厂数字大脑 · 老板Agent」 */
  role: string
  /** 一句话职能描述 */
  desc: string
  avatar: string
}

export const FLAGSHIP_SLUGS = ['haoshu', 'zizhu', 'qianxun', 'lanyue', 'cuifeng'] as const

/** 兜底编号：agents 接口无 slug 命中时按 code ART-0101~0105 过滤 */
export const FLAGSHIP_CODES = ['ART-0101', 'ART-0102', 'ART-0103', 'ART-0104', 'ART-0105'] as const

export const FLAGSHIP_AGENTS: FlagshipMeta[] = [
  {
    slug: 'haoshu',
    name: '昊枢',
    role: '工厂数字大脑 · 老板Agent',
    desc: '统筹全厂产线、订单与设备的全局调度中枢，为经营者呈现一张实时决策视图。',
    avatar: '/avatar-haoshu.png',
  },
  {
    slug: 'zizhu',
    name: '锱铢',
    role: '财务Agent',
    desc: '成本核算、对账与报价测算分毫必究，让每一笔工费清清楚楚。',
    avatar: '/avatar-zizhu.png',
  },
  {
    slug: 'qianxun',
    name: '千询',
    role: '采购Agent',
    desc: '比价寻源、物料跟单与供应商档案管理，把采购链路压缩到分钟级。',
    avatar: '/avatar-qianxun.png',
  },
  {
    slug: 'lanyue',
    name: '揽月',
    role: '销售Agent',
    desc: '商机跟进、报价单生成与客户回访，让产能转化为稳定的订单流。',
    avatar: '/avatar-lanyue.png',
  },
  {
    slug: 'cuifeng',
    name: '淬锋',
    role: '研发Agent',
    desc: '工艺试制、打样迭代与知识沉淀，把老师傅的经验淬炼成可复用的工艺资产。',
    avatar: '/avatar-cuifeng.png',
  },
]

/** 未来上线的 Agent 剪影占位（不可点击） */
export const UPCOMING_AGENTS = [
  { name: '物流Agent', desc: '运输调度 · 在途追踪 · 签收闭环' },
  { name: '质检Agent', desc: '视觉复检 · 缺陷归档 · 质量追溯' },
  { name: '仓储Agent', desc: '库位优化 · 盘点对账 · 出入库联动' },
] as const

export function didForSlug(slug: string): string {
  return `did:nebula:agent-${slug}`
}

/** 稳定伪哈希：同一输入永远得到同一 64 位十六进制串（展示用） */
export function stableHash(input: string): string {
  // 双种子 FNV-1a 64-bit，循环迭代 4 轮拼出 64 hex
  let out = ''
  for (let round = 0; round < 4; round++) {
    let h = 0xcbf29ce484222325n ^ BigInt(round * 0x9e3779b9 + 1)
    const s = `${input}#${round}`
    for (let i = 0; i < s.length; i++) {
      h ^= BigInt(s.charCodeAt(i))
      h = (h * 0x100000001b3n) & 0xffffffffffffffffn
    }
    // 再扩散一次，保证雪崩
    h ^= h >> 29n
    h = (h * 0xbf58476d1ce4e5b9n) & 0xffffffffffffffffn
    h ^= h >> 32n
    out += h.toString(16).padStart(16, '0')
  }
  return out
}
