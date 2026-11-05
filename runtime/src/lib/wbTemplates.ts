/**
 * 行业版工作台模板（迭代 14）：按企业 industryGroup 实时生成工作台首页区块。
 * - 4 个已上线行业（工业制造/跨境电商/设计创意/财税服务）live=true，
 *   KPI 与快捷入口有行业感；其余 8 大行业给通用模板 + live=false
 *  （渲染「行业版建模中 · 未来开放」徽标）。
 * - templateFor(group)：未知/空 → 通用模板（工业制造兜底展示，live=false）。
 */

export interface WbIndustryTemplate {
  /** 12 大类 key */
  group: string
  /** 如「跨境电商版 · v1.0」 */
  versionName: string
  /** 4 已上线行业 true，其余 false（渲染「行业版建模中」徽标） */
  live: boolean
  /** 3-4 个行业化 KPI 展示位 */
  kpis: { label: string; value: string; trend?: string }[]
  /** 3-4 个快捷入口，指向 /wb/* 现有路由 */
  quickActions: { label: string; to: string; desc: string }[]
  /** 推荐数字员工的 industryGroup（一般=自身行业） */
  recommendedGroups: string[]
  /** 注册页「按行业填充」预设部门 4-6 个 */
  defaultDepartments: { name: string; duty: string }[]
}

const TEMPLATES: Record<string, WbIndustryTemplate> = {
  工业制造: {
    group: '工业制造',
    versionName: '工业制造版 · v1.0',
    live: true,
    kpis: [
      { label: '设备综合效率 OEE', value: '86.4%', trend: '+2.1%' },
      { label: '在制工单', value: '37 张', trend: '+5' },
      { label: '质检一次通过率', value: '98.2%', trend: '+0.4%' },
      { label: '本月非计划停机', value: '3.5 h', trend: '-1.2h' },
    ],
    quickActions: [
      { label: '部门工作区', to: '/wb/dept', desc: '按部门进入数字工位，派发今日任务' },
      { label: '任务执行台', to: '/wb/tasks', desc: '下达巡检 / 诊断 / 排产指令并追踪步骤' },
      { label: '组织管理', to: '/wb/org', desc: '维护组织成员与部门负责人编制' },
      { label: '技能商城', to: '/wb/skillmall', desc: '为车间补齐设备诊断、质检等技能' },
    ],
    recommendedGroups: ['工业制造'],
    defaultDepartments: [
      { name: '生产部', duty: '产线排产与现场执行' },
      { name: '设备部', duty: '设备点检、保养与故障诊断' },
      { name: '质检部', duty: '来料 / 过程 / 出厂检验' },
      { name: '工艺技术部', duty: '工艺参数维护与持续改进' },
      { name: '仓储物流部', duty: '原料与成品出入库管理' },
    ],
  },
  跨境电商: {
    group: '跨境电商',
    versionName: '跨境电商版 · v1.0',
    live: true,
    kpis: [
      { label: '在售 Listing 数', value: '1,286', trend: '+42' },
      { label: '在途包裹', value: '3,412', trend: '+8.6%' },
      { label: '广告 ACOS', value: '18.4%', trend: '-1.7%' },
      { label: '海外仓库存', value: '52,300 件', trend: '-3.1%' },
    ],
    quickActions: [
      { label: '部门工作区', to: '/wb/dept', desc: '运营 / 物流 / 合规部门数字工位' },
      { label: '任务执行台', to: '/wb/tasks', desc: 'Listing 优化、补货测算一键下发' },
      { label: '工作台市场', to: '/wb/market', desc: '招募选品、广告投手数字员工' },
      { label: '数据看板', to: '/wb/dashboard', desc: '店铺经营与合同执行总览' },
    ],
    recommendedGroups: ['跨境电商'],
    defaultDepartments: [
      { name: '平台运营部', duty: '多平台店铺运营与 Listing 管理' },
      { name: '选品采购部', duty: '选品调研与供应链采购' },
      { name: '物流仓储部', duty: '头程、海外仓与尾程履约' },
      { name: '广告投放部', duty: '站内外广告投放与 ACOS 优化' },
      { name: '合规风控部', duty: '知识产权与平台规则合规' },
    ],
  },
  设计创意: {
    group: '设计创意',
    versionName: '设计创意版 · v1.0',
    live: true,
    kpis: [
      { label: '进行中项目', value: '23 个', trend: '+4' },
      { label: '本周交付稿件', value: '61 件', trend: '+12%' },
      { label: '客户一次通过率', value: '87.5%', trend: '+3.2%' },
      { label: '平均改稿轮次', value: '1.8 轮', trend: '-0.3' },
    ],
    quickActions: [
      { label: '部门工作区', to: '/wb/dept', desc: '平面 / 品牌 / UI 团队数字工位' },
      { label: '任务执行台', to: '/wb/tasks', desc: '从需求简报到初稿产出全链路追踪' },
      { label: '工作台市场', to: '/wb/market', desc: '招募包装、空间设计数字员工' },
      { label: '企业展厅', to: '/wb/showroom', desc: '对外展示设计服务能力与案例' },
    ],
    recommendedGroups: ['设计创意'],
    defaultDepartments: [
      { name: '平面设计部', duty: '海报 KV 与 VI 物料设计' },
      { name: '品牌策略部', duty: '品牌定位与视觉系统' },
      { name: 'UI/UX 设计部', duty: '界面设计与交互原型' },
      { name: '客户成功部', duty: '需求对接与交付管理' },
    ],
  },
  财税服务: {
    group: '财税服务',
    versionName: '财税服务版 · v1.0',
    live: true,
    kpis: [
      { label: '待审凭证', value: '146 张', trend: '-28' },
      { label: '申报倒计时', value: '6 天', trend: '征期内' },
      { label: '异常发票', value: '3 张', trend: '-5' },
      { label: '账期进度', value: '82%', trend: '+9%' },
    ],
    quickActions: [
      { label: '部门工作区', to: '/wb/dept', desc: '记账 / 审计 / 合规筹划数字工位' },
      { label: '任务执行台', to: '/wb/tasks', desc: '凭证生成、申报校验任务下发' },
      { label: '工作台市场', to: '/wb/market', desc: '招募记账、发票管理数字员工' },
      { label: '数据看板', to: '/wb/dashboard', desc: '代账客户与合同执行总览' },
    ],
    recommendedGroups: ['财税服务'],
    defaultDepartments: [
      { name: '记账核算部', duty: '凭证生成与账簿管理' },
      { name: '税务合规部', duty: '申报管理与合规筹划' },
      { name: '审计风控部', duty: '凭证风险扫描与底稿' },
      { name: '客户服务部', duty: '代账客户对接与答疑' },
    ],
  },
}

/** 通用模板（8 个未来开放行业 + 未知行业兜底） */
function genericTemplate(group: string): WbIndustryTemplate {
  const known = group && group !== '通用' ? group : '通用'
  return {
    group: known,
    versionName: `${known}版 · 建模中`,
    live: false,
    kpis: [
      { label: '组织成员', value: '—', trend: '建模中' },
      { label: '活跃任务', value: '—', trend: '建模中' },
      { label: '数字员工', value: '—', trend: '未来开放' },
      { label: '经营洞察', value: '—', trend: '未来开放' },
    ],
    quickActions: [
      { label: '部门工作区', to: '/wb/dept', desc: '按部门进入数字工位' },
      { label: '任务执行台', to: '/wb/tasks', desc: '下达任务并追踪执行步骤' },
      { label: '组织管理', to: '/wb/org', desc: '维护组织成员与部门编制' },
      { label: '技能商城', to: '/wb/skillmall', desc: '浏览可雇佣的数字技能' },
    ],
    recommendedGroups: ['工业制造'],
    defaultDepartments: [
      { name: '综合管理部', duty: '行政管理与经营统筹' },
      { name: '业务运营部', duty: '一线业务执行与跟进' },
      { name: '市场增长部', duty: '市场推广与客户增长' },
      { name: '客户服务部', duty: '客户对接与售后支持' },
    ],
  }
}

/** 按行业大类取模板；未知/空 → 通用模板（live=false） */
export function templateFor(group?: string | null): WbIndustryTemplate {
  if (group && TEMPLATES[group]) return TEMPLATES[group]
  return genericTemplate(group ?? '通用')
}
