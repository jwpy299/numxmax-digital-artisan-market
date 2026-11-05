/**
 * 全行业覆盖矩阵 · 前端常量（迭代 13 多行业扩展）。
 * - INDUSTRY_GROUPS：12 大行业全部开放（2026-09-05 彭总令）；空馆如实显示「虚位以待」招募位（plannedRoles 保留作空缺公示）；
 *   accent 与视觉规范一致：工业制造=amber / 跨境=cyan / 设计=violet / 财税=emerald。
 * - INDUSTRY_AGENT_METAS：3 大新行业馆 18 位数字员工的角色定位与一句话描述
 *   （后端 agents 接口未提供角色文案，由前端维护，规则同 flagship.ts）。
 * - metasForGroup：按行业大类取该馆员工 meta；LIVE_GROUPS：已上线的 4 个馆。
 */

export interface IndustryGroupMeta {
  /** 行业大类名，与 agents.industryGroup 一致，如「跨境电商」 */
  key: string
  /** 一句话定位 */
  tagline: string
  status: 'live' | 'planned'
  /** 主视觉色：工业制造=amber 跨境=cyan 设计=violet 财税=emerald */
  accent: 'amber' | 'cyan' | 'violet' | 'emerald'
  /** planned 时的 3 个未来岗位示例 */
  plannedRoles?: string[]
}

export const INDUSTRY_GROUPS: IndustryGroupMeta[] = [
  { key: '工业制造', tagline: '产线 · 设备 · 工艺的全栈数字劳动力', status: 'live', accent: 'amber' },
  { key: '跨境电商', tagline: '选品 · Listing · 物流 · 合规的出海护航编队', status: 'live', accent: 'cyan' },
  { key: '设计创意', tagline: '平面 · 品牌 · UI · 工业的创意生产力', status: 'live', accent: 'violet' },
  { key: '财税服务', tagline: '记账 · 筹划 · 审计 · 汇算的合规管家团队', status: 'live', accent: 'emerald' },
  {
    key: '医疗健康', tagline: '分诊 · 病案 · 随访的医护数字助手', status: 'live', accent: 'cyan',
    plannedRoles: ['问诊分诊Agent', '病案管理Agent', '随访关怀Agent'],
  },
  {
    key: '教育培训', tagline: '教研 · 命题 · 学情的教学搭档', status: 'live', accent: 'violet',
    plannedRoles: ['教研备课Agent', '题库命题Agent', '学情分析Agent'],
  },
  {
    key: '法律合规', tagline: '合同 · 法规 · 文书的合规参谋', status: 'live', accent: 'emerald',
    plannedRoles: ['合同审阅Agent', '法规检索Agent', '文书起草Agent'],
  },
  {
    key: '建筑工程', tagline: '造价 · 审图 · 监理的工地智囊', status: 'live', accent: 'amber',
    plannedRoles: ['造价测算Agent', '图纸审查Agent', '进度监理Agent'],
  },
  {
    key: '农业科技', tagline: '植保 · 墒情 · 采收的田间管家', status: 'live', accent: 'emerald',
    plannedRoles: ['植保诊断Agent', '墒情监测Agent', '采收规划Agent'],
  },
  {
    key: '文化传媒', tagline: '编导 · 文案 · 美编的内容工坊', status: 'live', accent: 'violet',
    plannedRoles: ['短视频编导Agent', '文案策划Agent', '排版美编Agent'],
  },
  {
    key: '现代物流', tagline: '调度 · 路径 · 仓储的运输中枢', status: 'live', accent: 'cyan',
    plannedRoles: ['运输调度Agent', '路径优化Agent', '仓储盘点Agent'],
  },
  {
    key: '餐饮零售', tagline: '选址 · 菜单 · 巡店的门店参谋', status: 'live', accent: 'amber',
    plannedRoles: ['选址评估Agent', '菜单工程Agent', '巡店质检Agent'],
  },
]

/** 已上线的 4 个行业馆 */
export const LIVE_GROUPS = INDUSTRY_GROUPS.filter((g) => g.status === 'live')

/** 行业馆员工展示 meta：角色定位 + 一句话描述（slug 与后端 agents.slug 对齐） */
export interface IndustryAgentMeta {
  slug: string
  name: string
  /** 角色定位短标签，如「跨境运营总管 · 店长Agent」 */
  role: string
  /** 一句话职能描述 */
  desc: string
  avatar: string
  /** 所属行业大类，与 agents.industryGroup 一致 */
  group: string
}

export const INDUSTRY_AGENT_METAS: IndustryAgentMeta[] = [
  // ── 跨境电商馆 ──
  {
    slug: 'duyang', name: '渡洋', role: '跨境运营总管 · 店长Agent', group: '跨境电商',
    desc: '统筹多平台店铺、库存与利润的经营中枢，让出海生意一盘棋。',
    avatar: '/avatar-duyang.png',
  },
  {
    slug: 'milan', name: '觅澜', role: '选品Agent', group: '跨境电商',
    desc: '捕捉全球趋势与蓝海品类，竞品动态尽收眼底，选品打分有据可依。',
    avatar: '/avatar-milan.png',
  },
  {
    slug: 'yifan', name: '译帆', role: '多语Listing Agent', group: '跨境电商',
    desc: '多语言文案与本地化表达一气呵成，让每一件商品都说当地话。',
    avatar: '/avatar-yifan.png',
  },
  {
    slug: 'tuoling', name: '驼铃', role: '跨境物流Agent', group: '跨境电商',
    desc: '头程比价、海外仓补货与清关追踪，把货物在途的每一步看牢。',
    avatar: '/avatar-tuoling.png',
  },
  {
    slug: 'xingdun', name: '星盾', role: '合规风控Agent', group: '跨境电商',
    desc: '知识产权排查、平台规则巡检与 VAT 合规校验，为店铺撑起防护盾。',
    avatar: '/avatar-xingdun.png',
  },
  {
    slug: 'chaoming', name: '潮鸣', role: '广告投手Agent', group: '跨境电商',
    desc: '站内外投放结构搭建与 ACOS 精细调优，让每一分广告费都听见回响。',
    avatar: '/avatar-chaoming.png',
  },
  // ── 设计创意馆 ──
  {
    slug: 'danqing', name: '丹青', role: '平面设计Agent', group: '设计创意',
    desc: '海报 KV、VI 物料与版式网格，一笔一画皆是品牌气场。',
    avatar: '/avatar-danqing.png',
  },
  {
    slug: 'liubai', name: '留白', role: '品牌设计Agent', group: '设计创意',
    desc: '从品牌定位到视觉系统，留白之处，方显品牌风骨。',
    avatar: '/avatar-liubai.png',
  },
  {
    slug: 'chisu', name: '尺素', role: 'UI/UX设计Agent', group: '设计创意',
    desc: '高保真界面、交互原型与设计系统，让体验顺滑如丝。',
    avatar: '/avatar-chisu.png',
  },
  {
    slug: 'sunmao', name: '榫卯', role: '工业设计Agent', group: '设计创意',
    desc: '外观推演、CMF 搭配与可制造性评审，让好产品内外兼修。',
    avatar: '/avatar-sunmao.png',
  },
  {
    slug: 'qijing', name: '栖境', role: '空间设计Agent', group: '设计创意',
    desc: '户型动线、软装搭配与展陈叙事，营造有温度的栖居之境。',
    avatar: '/avatar-qijing.png',
  },
  {
    slug: 'moyun', name: '墨韵', role: '包装设计Agent', group: '设计创意',
    desc: '包装结构、瓶贴标签与系列插画，让货架成为产品的秀场。',
    avatar: '/avatar-moyun.png',
  },
  // ── 财税服务馆 ──
  {
    slug: 'siku', name: '司库', role: '财税总管Agent', group: '财税服务',
    desc: '全盘账税统筹与资金计划，为企业守住财务中枢。',
    avatar: '/avatar-siku.png',
  },
  {
    slug: 'mingzhang', name: '明账', role: '智能记账Agent', group: '财税服务',
    desc: '凭证生成、流水对账与期末结转，日清月结分毫不差。',
    avatar: '/avatar-mingzhang.png',
  },
  {
    slug: 'chouheng', name: '筹衡', role: '税务筹划Agent', group: '财税服务',
    desc: '优惠政策适配与合规筹划测算，合法边界内精打细算。',
    avatar: '/avatar-chouheng.png',
  },
  {
    slug: 'shenwei', name: '审微', role: '智能审计Agent', group: '财税服务',
    desc: '凭证风险扫描与底稿生成，于细微处见真章。',
    avatar: '/avatar-shenwei.png',
  },
  {
    slug: 'piaoshu', name: '票枢', role: '发票管理Agent', group: '财税服务',
    desc: '进销项匹配、真伪查验与归档同步，发票全生命周期一管到底。',
    avatar: '/avatar-piaoshu.png',
  },
  {
    slug: 'huisuan', name: '汇算', role: '汇算清缴Agent', group: '财税服务',
    desc: '税前扣除校验与年度申报，让年度汇算从容收官。',
    avatar: '/avatar-huisuan.png',
  },
]

/** 按行业大类取该馆员工 meta */
export function metasForGroup(group: string): IndustryAgentMeta[] {
  return INDUSTRY_AGENT_METAS.filter((m) => m.group === group)
}

/** 行业馆 hud-label 英文（馆头展示用） */
export const PAVILION_LABELS: Record<string, string> = {
  跨境电商: 'CROSS-BORDER E-COMMERCE',
  设计创意: 'DESIGN & CREATIVE',
  财税服务: 'FINANCE & TAX COMPLIANCE',
}
