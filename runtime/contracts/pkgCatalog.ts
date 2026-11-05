/**
 * pkgCatalog —— 数字员工订阅包体系种子目录单源（彭总《数字员工订阅包体系》V1.0 NEBULA-DE-SUB-001 落地件）。
 *
 * 按文档第三章（部门订阅包清单：13 部门×子包）+第四章（跨部门协同包 5 个）+第五章（企业全域包 2 个）+
 * 第六章（定价体系：基础包 ¥2800/季、管理包 ¥3800/季、战略包 ¥4800/季；多部门折扣+子包折扣）落。
 *
 * 双层架构（文档 2.1）：执行层岗位 Agent+复核层部门复核 Agent 标配——teamSpec.lead=复核 Agent，
 * members=岗位 Agent 清单。
 *
 * adminSeed 改读本件（packages.ts 的 SEED_PACKAGES 旧规模包面退役挂账——彭总拍板保留或摘）。
 */
import type { DeptTeamSpec } from "@contracts/deptTeamSpec";

/** 子包级字面联合（文档第六章定价体系——编译期钉死拼写漂移[OCR wb#81 maint 票]） */
export const PKG_TIERS = ["basic", "management", "strategic", "synergy", "global"] as const;
export type PkgTier = (typeof PKG_TIERS)[number];

/** 文档第三章 13 部门键体系（包域键单源——deptConsole 工作台 6 舱键[DEPT_CODES]是舱域面两体系不混；
 *  13 键→舱归因对齐挂账 P-DEPT-MAP-UNIFY[owner=DSH，ETA=门户部门包页重写 PR 同收]） */
export const PKG_DEPT_KEYS = ["finance", "sales", "production", "procurement", "quality", "hr", "research", "warehouse", "it", "legal", "admin", "cs", "marketing"] as const;
export type PkgDeptKey = (typeof PKG_DEPT_KEYS)[number];

/** 海报图资产常量单点（拼写漂移/改名面封死[OCR wb#81 maint 票]） */
const POSTER_PKG_DEPT = "/pkg/pkg-dept.png";
const POSTER_PKG_GLOBAL = "/pkg/pkg-global.png";
const POSTER_PKG_ASSET = "/pkg/pkg-asset.png";

/** 订阅包种子型（文档体系落地件——periodLabel 展示面与 periodMonths 机器语义分家[NumX wb#81 断根]） */
export interface PkgSeed {
  key: string;
  name: string;
  priceYuan: number;
  periodLabel: string; // 展示面文案（机器语义时长走 periodMonths——文案调整不影响权益）
  periodMonths: number; // 机器语义时长（月——claim 权益发放只读本字段；全目录钉逼出=正整数）
  agentsCount: number;
  scopeLabel: string;
  synergyLabel: string;
  monetizeLabel: string;
  scaleLabel: string;
  posterUrl: string;
  features: string[];
  sortOrder: number;
  deptCode?: PkgDeptKey; // 部门键（字面联合钉——文档 13 部门键体系单源）
  packageTier?: PkgTier; // 子包级（字面联合钉——basic 基础/management 管理/strategic 战略/synergy 协同/global 全域）
  teamSpec?: DeptTeamSpec; // 双层架构（岗位 Agent 清单+复核 Agent 标配）
}

/** 复核 Agent 标配生成面（文档 2.1——每部门标配一名部门复核 Agent：审核输出+拦截高风险+汇总状态+协调协同） */
function reviewLead(deptKey: string, deptName: string): DeptTeamSpec["lead"] {
  return {
    role: "co",
    deptKey,
    duty: `${deptName}复核Agent：审核输出+拦截高风险操作+汇总部门状态+协调跨部门协同`,
    skillHints: ["复核", "终审", "协同", "风险拦截"],
  };
}

/** 岗位 Agent 成员生成面（执行层） */
function ex(deptKey: string, duty: string, hints: string[] = []): DeptTeamSpec["members"][number] {
  return { role: "ex", deptKey, duty: `${duty}Agent`, skillHints: hints.length > 0 ? hints : [duty] };
}

// ═══ 第三章 部门订阅包清单（13 部门×子包） ═══

// ── 3.1 财务部（4 子包：基础/管理/战略/数字资产） ──
export const FINANCE_PKG: PkgSeed[] = [
  {
    key: "fin_basic", name: "财务基础包", priceYuan: 2800, periodLabel: "季度", periodMonths: 3, agentsCount: 7,
    scopeLabel: "财务基础流程", synergyLabel: "财务复核Agent标配", monetizeLabel: "无", scaleLabel: "所有企业",
    posterUrl: POSTER_PKG_DEPT,
    features: ["总账/应收/应付/出纳/费用报销/固定资产 Agent", "财务复核Agent标配随包提供"],
    sortOrder: 101, deptCode: "finance", packageTier: "basic",
    teamSpec: { lead: reviewLead("finance", "财务"), members: [
      ex("finance", "总账"), ex("finance", "应收"), ex("finance", "应付"), ex("finance", "出纳"), ex("finance", "费用报销"), ex("finance", "固定资产"),
    ] },
  },
  {
    key: "fin_mgmt", name: "财务管理包", priceYuan: 3800, periodLabel: "季度", periodMonths: 3, agentsCount: 6,
    scopeLabel: "管理会计流程", synergyLabel: "财务复核Agent标配", monetizeLabel: "无", scaleLabel: "有管理会计需求的企业",
    posterUrl: POSTER_PKG_DEPT,
    features: ["成本核算/成本分析/预算/经营分析/存货核算 Agent", "财务复核Agent标配随包提供"],
    sortOrder: 102, deptCode: "finance", packageTier: "management",
    teamSpec: { lead: reviewLead("finance", "财务"), members: [
      ex("finance", "成本核算"), ex("finance", "成本分析"), ex("finance", "预算"), ex("finance", "经营分析"), ex("finance", "存货核算"),
    ] },
  },
  {
    key: "fin_strategic", name: "财务战略包", priceYuan: 4800, periodLabel: "季度", periodMonths: 3, agentsCount: 9,
    scopeLabel: "财务战略流程", synergyLabel: "财务复核Agent标配", monetizeLabel: "无", scaleLabel: "中大型企业",
    posterUrl: POSTER_PKG_DEPT,
    features: ["税务申报/发票管理/税务筹划/合规审查/资金管理/融资/外汇/信用管理 Agent", "财务复核Agent标配随包提供"],
    sortOrder: 103, deptCode: "finance", packageTier: "strategic",
    teamSpec: { lead: reviewLead("finance", "财务"), members: [
      ex("finance", "税务申报"), ex("finance", "发票管理"), ex("finance", "税务筹划"), ex("finance", "合规审查"),
      ex("finance", "资金管理"), ex("finance", "融资"), ex("finance", "外汇"), ex("finance", "信用管理"),
    ] },
  },
  {
    key: "fin_digital", name: "数字资产包", priceYuan: 4800, periodLabel: "季度", periodMonths: 3, agentsCount: 5,
    scopeLabel: "数字资产流程", synergyLabel: "财务复核Agent标配", monetizeLabel: "数字资产变现", scaleLabel: "使用灵枢数字员工体系的企业",
    posterUrl: POSTER_PKG_DEPT,
    features: ["Token结算/数字员工薪酬/技能交易税务/数字资产估值 Agent", "财务复核Agent标配随包提供"],
    sortOrder: 104, deptCode: "finance", packageTier: "strategic",
    teamSpec: { lead: reviewLead("finance", "财务"), members: [
      ex("finance", "Token结算"), ex("finance", "数字员工薪酬"), ex("finance", "技能交易税务"), ex("finance", "数字资产估值"),
    ] },
  },
];

// ── 3.2 销售部（3 子包：基础/管理/战略） ──
export const SALES_PKG: PkgSeed[] = [
  {
    key: "sales_basic", name: "销售基础包", priceYuan: 2800, periodLabel: "季度", periodMonths: 3, agentsCount: 7,
    scopeLabel: "销售基础流程", synergyLabel: "销售复核Agent标配", monetizeLabel: "无", scaleLabel: "所有企业",
    posterUrl: POSTER_PKG_DEPT,
    features: ["客户管理/线索跟进/报价/合同/订单/回款 Agent", "销售复核Agent标配随包提供"],
    sortOrder: 111, deptCode: "sales", packageTier: "basic",
    teamSpec: { lead: reviewLead("sales", "销售"), members: [
      ex("sales", "客户管理"), ex("sales", "线索跟进"), ex("sales", "报价"), ex("sales", "合同"), ex("sales", "订单"), ex("sales", "回款"),
    ] },
  },
  {
    key: "sales_mgmt", name: "销售管理包", priceYuan: 3800, periodLabel: "季度", periodMonths: 3, agentsCount: 6,
    scopeLabel: "销售管理流程", synergyLabel: "销售复核Agent标配", monetizeLabel: "无", scaleLabel: "有管理需求的企业",
    posterUrl: POSTER_PKG_DEPT,
    features: ["渠道管理/售后/销售预测/销售分析/价格策略 Agent", "销售复核Agent标配随包提供"],
    sortOrder: 112, deptCode: "sales", packageTier: "management",
    teamSpec: { lead: reviewLead("sales", "销售"), members: [
      ex("sales", "渠道管理"), ex("sales", "售后"), ex("sales", "销售预测"), ex("sales", "销售分析"), ex("sales", "价格策略"),
    ] },
  },
  {
    key: "sales_strategic", name: "销售战略包", priceYuan: 4800, periodLabel: "季度", periodMonths: 3, agentsCount: 3,
    scopeLabel: "销售战略流程", synergyLabel: "销售复核Agent标配", monetizeLabel: "无", scaleLabel: "中大型企业",
    posterUrl: POSTER_PKG_DEPT,
    features: ["大客户/数字员工销售 Agent", "销售复核Agent标配随包提供"],
    sortOrder: 113, deptCode: "sales", packageTier: "strategic",
    teamSpec: { lead: reviewLead("sales", "销售"), members: [
      ex("sales", "大客户"), ex("sales", "数字员工销售"),
    ] },
  },
];

// ── 3.3 生产部（3 子包：基础/管理/战略） ──
export const PRODUCTION_PKG: PkgSeed[] = [
  {
    key: "prod_basic", name: "生产基础包", priceYuan: 2800, periodLabel: "季度", periodMonths: 3, agentsCount: 9,
    scopeLabel: "生产基础流程", synergyLabel: "生产复核Agent标配", monetizeLabel: "无", scaleLabel: "所有制造企业",
    posterUrl: POSTER_PKG_DEPT,
    features: ["生产计划/排产/设备监控/工艺参数/异常处理/能耗管理/安全管理/5S管理 Agent", "生产复核Agent标配随包提供"],
    sortOrder: 121, deptCode: "production", packageTier: "basic",
    teamSpec: { lead: reviewLead("production", "生产"), members: [
      ex("production", "生产计划"), ex("production", "排产"), ex("production", "设备监控"), ex("production", "工艺参数"),
      ex("production", "异常处理"), ex("production", "能耗管理"), ex("production", "安全管理"), ex("production", "5S管理"),
    ] },
  },
  {
    key: "prod_mgmt", name: "生产管理包", priceYuan: 3800, periodLabel: "季度", periodMonths: 3, agentsCount: 4,
    scopeLabel: "生产管理流程", synergyLabel: "生产复核Agent标配", monetizeLabel: "无", scaleLabel: "有精益管理需求的企业",
    posterUrl: POSTER_PKG_DEPT,
    features: ["生产分析/精益改善/模具管理 Agent", "生产复核Agent标配随包提供"],
    sortOrder: 122, deptCode: "production", packageTier: "management",
    teamSpec: { lead: reviewLead("production", "生产"), members: [
      ex("production", "生产分析"), ex("production", "精益改善"), ex("production", "模具管理"),
    ] },
  },
  {
    key: "prod_strategic", name: "生产战略包", priceYuan: 4800, periodLabel: "季度", periodMonths: 3, agentsCount: 3,
    scopeLabel: "生产战略流程", synergyLabel: "生产复核Agent标配", monetizeLabel: "无", scaleLabel: "中大型企业",
    posterUrl: POSTER_PKG_DEPT,
    features: ["产能规划/数字员工协同 Agent", "生产复核Agent标配随包提供"],
    sortOrder: 123, deptCode: "production", packageTier: "strategic",
    teamSpec: { lead: reviewLead("production", "生产"), members: [
      ex("production", "产能规划"), ex("production", "数字员工协同"),
    ] },
  },
];

// ── 3.4 采购部（3 子包：基础/管理/战略） ──
export const PROCUREMENT_PKG: PkgSeed[] = [
  {
    key: "proc_basic", name: "采购基础包", priceYuan: 2800, periodLabel: "季度", periodMonths: 3, agentsCount: 8,
    scopeLabel: "采购基础流程", synergyLabel: "采购复核Agent标配", monetizeLabel: "无", scaleLabel: "所有企业",
    posterUrl: POSTER_PKG_DEPT,
    features: ["采购计划/询价/供应商管理/采购订单/来料跟踪/对账/合同 Agent", "采购复核Agent标配随包提供"],
    sortOrder: 131, deptCode: "procurement", packageTier: "basic",
    teamSpec: { lead: reviewLead("procurement", "采购"), members: [
      ex("procurement", "采购计划"), ex("procurement", "询价"), ex("procurement", "供应商管理"), ex("procurement", "采购订单"),
      ex("procurement", "来料跟踪"), ex("procurement", "对账"), ex("procurement", "合同"),
    ] },
  },
  {
    key: "proc_mgmt", name: "采购管理包", priceYuan: 3800, periodLabel: "季度", periodMonths: 3, agentsCount: 4,
    scopeLabel: "采购管理流程", synergyLabel: "采购复核Agent标配", monetizeLabel: "无", scaleLabel: "有供应链管理需求的企业",
    posterUrl: POSTER_PKG_DEPT,
    features: ["采购分析/库存优化/风险预警 Agent", "采购复核Agent标配随包提供"],
    sortOrder: 132, deptCode: "procurement", packageTier: "management",
    teamSpec: { lead: reviewLead("procurement", "采购"), members: [
      ex("procurement", "采购分析"), ex("procurement", "库存优化"), ex("procurement", "风险预警"),
    ] },
  },
  {
    key: "proc_strategic", name: "采购战略包", priceYuan: 4800, periodLabel: "季度", periodMonths: 3, agentsCount: 2,
    scopeLabel: "采购战略流程", synergyLabel: "采购复核Agent标配", monetizeLabel: "无", scaleLabel: "中大型企业",
    posterUrl: POSTER_PKG_DEPT,
    features: ["战略采购 Agent", "采购复核Agent标配随包提供"],
    sortOrder: 133, deptCode: "procurement", packageTier: "strategic",
    teamSpec: { lead: reviewLead("procurement", "采购"), members: [ex("procurement", "战略采购")] },
  },
];

// ── 3.5 质检部（3 子包：基础/管理/战略） ──
export const QUALITY_PKG: PkgSeed[] = [
  {
    key: "qc_basic", name: "质检基础包", priceYuan: 2800, periodLabel: "季度", periodMonths: 3, agentsCount: 8,
    scopeLabel: "质检基础流程", synergyLabel: "质检复核Agent标配", monetizeLabel: "无", scaleLabel: "所有制造企业",
    posterUrl: POSTER_PKG_DEPT,
    features: ["来料检验/过程检验/成品检验/出货检验/质量追溯/客诉处理/量具管理 Agent", "质检复核Agent标配随包提供"],
    sortOrder: 141, deptCode: "quality", packageTier: "basic",
    teamSpec: { lead: reviewLead("quality", "质检"), members: [
      ex("quality", "来料检验"), ex("quality", "过程检验"), ex("quality", "成品检验"), ex("quality", "出货检验"),
      ex("quality", "质量追溯"), ex("quality", "客诉处理"), ex("quality", "量具管理"),
    ] },
  },
  {
    key: "qc_mgmt", name: "质检管理包", priceYuan: 3800, periodLabel: "季度", periodMonths: 3, agentsCount: 4,
    scopeLabel: "质检管理流程", synergyLabel: "质检复核Agent标配", monetizeLabel: "无", scaleLabel: "有体系认证需求的企业",
    posterUrl: POSTER_PKG_DEPT,
    features: ["质量分析/供应商质量/质量体系 Agent", "质检复核Agent标配随包提供"],
    sortOrder: 142, deptCode: "quality", packageTier: "management",
    teamSpec: { lead: reviewLead("quality", "质检"), members: [
      ex("quality", "质量分析"), ex("quality", "供应商质量"), ex("quality", "质量体系"),
    ] },
  },
  {
    key: "qc_strategic", name: "质检战略包", priceYuan: 4800, periodLabel: "季度", periodMonths: 3, agentsCount: 2,
    scopeLabel: "质检战略流程", synergyLabel: "质检复核Agent标配", monetizeLabel: "无", scaleLabel: "中大型企业",
    posterUrl: POSTER_PKG_DEPT,
    features: ["质量成本 Agent", "质检复核Agent标配随包提供"],
    sortOrder: 143, deptCode: "quality", packageTier: "strategic",
    teamSpec: { lead: reviewLead("quality", "质检"), members: [ex("quality", "质量成本")] },
  },
];

// ── 3.6 人力资源部（3 子包：基础/管理/战略） ──
export const HR_PKG: PkgSeed[] = [
  {
    key: "hr_basic", name: "人力基础包", priceYuan: 2800, periodLabel: "季度", periodMonths: 3, agentsCount: 8,
    scopeLabel: "人力基础流程", synergyLabel: "人力复核Agent标配", monetizeLabel: "无", scaleLabel: "所有企业",
    posterUrl: POSTER_PKG_DEPT,
    features: ["招聘/培训/考勤/薪酬/绩效/员工关系/社保公积金 Agent", "人力复核Agent标配随包提供"],
    sortOrder: 151, deptCode: "hr", packageTier: "basic",
    teamSpec: { lead: reviewLead("hr", "人力"), members: [
      ex("hr", "招聘"), ex("hr", "培训"), ex("hr", "考勤"), ex("hr", "薪酬"), ex("hr", "绩效"), ex("hr", "员工关系"), ex("hr", "社保公积金"),
    ] },
  },
  {
    key: "hr_mgmt", name: "人力管理包", priceYuan: 3800, periodLabel: "季度", periodMonths: 3, agentsCount: 4,
    scopeLabel: "人力管理流程", synergyLabel: "人力复核Agent标配", monetizeLabel: "无", scaleLabel: "有组织发展需求的企业",
    posterUrl: POSTER_PKG_DEPT,
    features: ["人力分析/人才盘点/组织发展 Agent", "人力复核Agent标配随包提供"],
    sortOrder: 152, deptCode: "hr", packageTier: "management",
    teamSpec: { lead: reviewLead("hr", "人力"), members: [
      ex("hr", "人力分析"), ex("hr", "人才盘点"), ex("hr", "组织发展"),
    ] },
  },
  {
    key: "hr_strategic", name: "人力战略包", priceYuan: 4800, periodLabel: "季度", periodMonths: 3, agentsCount: 3,
    scopeLabel: "人力战略流程", synergyLabel: "人力复核Agent标配", monetizeLabel: "无", scaleLabel: "中大型企业",
    posterUrl: POSTER_PKG_DEPT,
    features: ["企业文化/数字员工HR Agent", "人力复核Agent标配随包提供"],
    sortOrder: 153, deptCode: "hr", packageTier: "strategic",
    teamSpec: { lead: reviewLead("hr", "人力"), members: [
      ex("hr", "企业文化"), ex("hr", "数字员工HR"),
    ] },
  },
];

// ── 3.7 研发部（2 子包：基础/管理） ──
export const RESEARCH_PKG: PkgSeed[] = [
  {
    key: "rd_basic", name: "研发基础包", priceYuan: 2800, periodLabel: "季度", periodMonths: 3, agentsCount: 8,
    scopeLabel: "研发基础流程", synergyLabel: "研发复核Agent标配", monetizeLabel: "无", scaleLabel: "有研发能力的企业",
    posterUrl: POSTER_PKG_DEPT,
    features: ["产品设计/工艺设计/项目管理/技术文档/仿真分析/实验管理/BOM管理 Agent", "研发复核Agent标配随包提供"],
    sortOrder: 161, deptCode: "research", packageTier: "basic",
    teamSpec: { lead: reviewLead("research", "研发"), members: [
      ex("research", "产品设计"), ex("research", "工艺设计"), ex("research", "项目管理"), ex("research", "技术文档"),
      ex("research", "仿真分析"), ex("research", "实验管理"), ex("research", "BOM管理"),
    ] },
  },
  {
    key: "rd_mgmt", name: "研发管理包", priceYuan: 3800, periodLabel: "季度", periodMonths: 3, agentsCount: 4,
    scopeLabel: "研发管理流程", synergyLabel: "研发复核Agent标配", monetizeLabel: "无", scaleLabel: "有知识产权需求的企业",
    posterUrl: POSTER_PKG_DEPT,
    features: ["研发分析/专利管理/技术路线 Agent", "研发复核Agent标配随包提供"],
    sortOrder: 162, deptCode: "research", packageTier: "management",
    teamSpec: { lead: reviewLead("research", "研发"), members: [
      ex("research", "研发分析"), ex("research", "专利管理"), ex("research", "技术路线"),
    ] },
  },
];

// ── 3.8 仓储物流部（2 子包：基础/管理） ──
export const WAREHOUSE_PKG: PkgSeed[] = [
  {
    key: "wh_basic", name: "仓储基础包", priceYuan: 2800, periodLabel: "季度", periodMonths: 3, agentsCount: 8,
    scopeLabel: "仓储基础流程", synergyLabel: "仓储复核Agent标配", monetizeLabel: "无", scaleLabel: "所有企业",
    posterUrl: POSTER_PKG_DEPT,
    features: ["入库/出库/库存/盘点/配送/物流跟踪/关务 Agent", "仓储复核Agent标配随包提供"],
    sortOrder: 171, deptCode: "warehouse", packageTier: "basic",
    teamSpec: { lead: reviewLead("warehouse", "仓储物流"), members: [
      ex("warehouse", "入库"), ex("warehouse", "出库"), ex("warehouse", "库存"), ex("warehouse", "盘点"),
      ex("warehouse", "配送"), ex("warehouse", "物流跟踪"), ex("warehouse", "关务"),
    ] },
  },
  {
    key: "wh_mgmt", name: "仓储管理包", priceYuan: 3800, periodLabel: "季度", periodMonths: 3, agentsCount: 3,
    scopeLabel: "仓储管理流程", synergyLabel: "仓储复核Agent标配", monetizeLabel: "无", scaleLabel: "有仓储优化需求的企业",
    posterUrl: POSTER_PKG_DEPT,
    features: ["仓储分析/布局优化 Agent", "仓储复核Agent标配随包提供"],
    sortOrder: 172, deptCode: "warehouse", packageTier: "management",
    teamSpec: { lead: reviewLead("warehouse", "仓储物流"), members: [
      ex("warehouse", "仓储分析"), ex("warehouse", "布局优化"),
    ] },
  },
];

// ── 3.9 IT与数字化部（2 子包：基础/管理） ──
export const IT_PKG: PkgSeed[] = [
  {
    key: "it_basic", name: "IT基础包", priceYuan: 2800, periodLabel: "季度", periodMonths: 3, agentsCount: 8,
    scopeLabel: "IT基础流程", synergyLabel: "IT复核Agent标配", monetizeLabel: "无", scaleLabel: "所有企业",
    posterUrl: POSTER_PKG_DEPT,
    features: ["运维/网络安全/系统管理/数据管理/AI模型管理/开发支持/Helpdesk Agent", "IT复核Agent标配随包提供"],
    sortOrder: 181, deptCode: "it", packageTier: "basic",
    teamSpec: { lead: reviewLead("it", "IT与数字化"), members: [
      ex("it", "运维"), ex("it", "网络安全"), ex("it", "系统管理"), ex("it", "数据管理"),
      ex("it", "AI模型管理"), ex("it", "开发支持"), ex("it", "Helpdesk"),
    ] },
  },
  {
    key: "it_mgmt", name: "IT管理包", priceYuan: 3800, periodLabel: "季度", periodMonths: 3, agentsCount: 3,
    scopeLabel: "IT管理流程", synergyLabel: "IT复核Agent标配", monetizeLabel: "无", scaleLabel: "有IT规划需求的企业",
    posterUrl: POSTER_PKG_DEPT,
    features: ["IT规划/数字化推进 Agent", "IT复核Agent标配随包提供"],
    sortOrder: 182, deptCode: "it", packageTier: "management",
    teamSpec: { lead: reviewLead("it", "IT与数字化"), members: [
      ex("it", "IT规划"), ex("it", "数字化推进"),
    ] },
  },
];

// ── 3.10 法务部（2 子包：基础/管理） ──
export const LEGAL_PKG: PkgSeed[] = [
  {
    key: "legal_basic", name: "法务基础包", priceYuan: 2800, periodLabel: "季度", periodMonths: 3, agentsCount: 6,
    scopeLabel: "法务基础流程", synergyLabel: "法务复核Agent标配", monetizeLabel: "无", scaleLabel: "所有企业",
    posterUrl: POSTER_PKG_DEPT,
    features: ["合同审核/知识产权/合规/诉讼/法律咨询 Agent", "法务复核Agent标配随包提供"],
    sortOrder: 191, deptCode: "legal", packageTier: "basic",
    teamSpec: { lead: reviewLead("legal", "法务"), members: [
      ex("legal", "合同审核"), ex("legal", "知识产权"), ex("legal", "合规"), ex("legal", "诉讼"), ex("legal", "法律咨询"),
    ] },
  },
  {
    key: "legal_mgmt", name: "法务管理包", priceYuan: 3800, periodLabel: "季度", periodMonths: 3, agentsCount: 3,
    scopeLabel: "法务管理流程", synergyLabel: "法务复核Agent标配", monetizeLabel: "无", scaleLabel: "中大型企业",
    posterUrl: POSTER_PKG_DEPT,
    features: ["法务分析/数字资产法务 Agent", "法务复核Agent标配随包提供"],
    sortOrder: 192, deptCode: "legal", packageTier: "management",
    teamSpec: { lead: reviewLead("legal", "法务"), members: [
      ex("legal", "法务分析"), ex("legal", "数字资产法务"),
    ] },
  },
];

// ── 3.11 行政部（1 子包：基础） ──
export const ADMIN_PKG: PkgSeed[] = [
  {
    key: "admin_basic", name: "行政基础包", priceYuan: 2800, periodLabel: "季度", periodMonths: 3, agentsCount: 7,
    scopeLabel: "行政基础流程", synergyLabel: "行政复核Agent标配", monetizeLabel: "无", scaleLabel: "所有企业",
    posterUrl: POSTER_PKG_DEPT,
    features: ["办公用品/车辆管理/食堂管理/安保/会议/档案 Agent", "行政复核Agent标配随包提供"],
    sortOrder: 201, deptCode: "admin", packageTier: "basic",
    teamSpec: { lead: reviewLead("admin", "行政"), members: [
      ex("admin", "办公用品"), ex("admin", "车辆管理"), ex("admin", "食堂管理"), ex("admin", "安保"), ex("admin", "会议"), ex("admin", "档案"),
    ] },
  },
];

// ── 3.12 客户服务部（1 子包：基础） ──
export const CS_PKG: PkgSeed[] = [
  {
    key: "cs_basic", name: "客服基础包", priceYuan: 2800, periodLabel: "季度", periodMonths: 3, agentsCount: 6,
    scopeLabel: "客服基础流程", synergyLabel: "客服复核Agent标配", monetizeLabel: "无", scaleLabel: "所有企业",
    posterUrl: POSTER_PKG_DEPT,
    features: ["售前咨询/售后支持/投诉处理/回访/工单 Agent", "客服复核Agent标配随包提供"],
    sortOrder: 211, deptCode: "cs", packageTier: "basic",
    teamSpec: { lead: reviewLead("cs", "客户服务"), members: [
      ex("cs", "售前咨询"), ex("cs", "售后支持"), ex("cs", "投诉处理"), ex("cs", "回访"), ex("cs", "工单"),
    ] },
  },
];

// ── 3.13 市场部（1 子包：基础） ──
export const MARKETING_PKG: PkgSeed[] = [
  {
    key: "mkt_basic", name: "市场基础包", priceYuan: 2800, periodLabel: "季度", periodMonths: 3, agentsCount: 7,
    scopeLabel: "市场基础流程", synergyLabel: "市场复核Agent标配", monetizeLabel: "无", scaleLabel: "有市场推广需求的企业",
    posterUrl: POSTER_PKG_DEPT,
    features: ["品牌/内容/活动/竞品/市场调研/数字展厅 Agent", "市场复核Agent标配随包提供"],
    sortOrder: 221, deptCode: "marketing", packageTier: "basic",
    teamSpec: { lead: reviewLead("marketing", "市场"), members: [
      ex("marketing", "品牌"), ex("marketing", "内容"), ex("marketing", "活动"), ex("marketing", "竞品"), ex("marketing", "市场调研"), ex("marketing", "数字展厅"),
    ] },
  },
];

// ═══ 第四章 跨部门协同包（5 个） ═══
export const SYNERGY_PKG: PkgSeed[] = [
  {
    key: "syn_prod_supply", name: "产供销协同包", priceYuan: 8800, periodLabel: "季度", periodMonths: 3, agentsCount: 3, // 联动部门数真数（生产+采购+仓储物流——0=全岗位重载不适用协同包[OCR wb#81 钉]）
    scopeLabel: "生产部+采购部+仓储物流部", synergyLabel: "订单→排产→采购→入库→发货全链路自动流转", monetizeLabel: "无", scaleLabel: "制造企业",
    posterUrl: POSTER_PKG_DEPT,
    features: ["生产/采购/仓储三部联动", "订单到发货全链路自动流转"],
    sortOrder: 301, packageTier: "synergy",
  },
  {
    key: "syn_sales_fin", name: "业财协同包", priceYuan: 6800, periodLabel: "季度", periodMonths: 3, agentsCount: 2, // 联动部门数真数（销售+财务）
    scopeLabel: "销售部+财务部", synergyLabel: "订单→开票→回款→对账→核算全流程自动", monetizeLabel: "无", scaleLabel: "所有企业",
    posterUrl: POSTER_PKG_DEPT,
    features: ["销售/财务两部联动", "订单到核算全流程自动"],
    sortOrder: 302, packageTier: "synergy",
  },
  {
    key: "syn_quality", name: "质量全链路包", priceYuan: 7800, periodLabel: "季度", periodMonths: 3, agentsCount: 3, // 联动部门数真数（质检+生产+采购）
    scopeLabel: "质检部+生产部+采购部", synergyLabel: "来料→过程→成品→客诉全链路质量追溯", monetizeLabel: "无", scaleLabel: "制造企业",
    posterUrl: POSTER_PKG_DEPT,
    features: ["质检/生产/采购三部联动", "来料到客诉全链路质量追溯"],
    sortOrder: 303, packageTier: "synergy",
  },
  {
    key: "syn_hr_fin", name: "人效协同包", priceYuan: 5800, periodLabel: "季度", periodMonths: 3, agentsCount: 2, // 联动部门数真数（人力+财务）
    scopeLabel: "人力资源部+财务部", synergyLabel: "考勤→薪酬→成本核算自动联动", monetizeLabel: "无", scaleLabel: "所有企业",
    posterUrl: POSTER_PKG_DEPT,
    features: ["人力/财务两部联动", "考勤到成本核算自动联动"],
    sortOrder: 304, packageTier: "synergy",
  },
  {
    key: "syn_digital", name: "数字资产协同包", priceYuan: 6800, periodLabel: "季度", periodMonths: 3, agentsCount: 3, // 联动部门数真数（财务+法务+IT）
    scopeLabel: "财务部+法务部+IT部", synergyLabel: "Token结算/技能交易/数字资产估值与合规", monetizeLabel: "数字资产变现", scaleLabel: "使用灵枢数字员工体系的企业",
    posterUrl: POSTER_PKG_DEPT,
    features: ["财务/法务/IT 三部联动", "Token结算到合规全链"],
    sortOrder: 305, packageTier: "synergy",
  },
];

// ═══ 第五章 企业全域包（2 个） ═══
export const GLOBAL_PKG: PkgSeed[] = [
  {
    key: "global_all", name: "企业全域数字员工包", priceYuan: 58000, periodLabel: "年", periodMonths: 12, agentsCount: 0, // 0=全岗位重载——全域包语义正确面（权益面+前端渲染同口径[OCR wb#81 核]）
    scopeLabel: "全部13个部门所有子包全岗位覆盖", synergyLabel: "含所有复核Agent", monetizeLabel: "无", scaleLabel: "中大型企业",
    posterUrl: POSTER_PKG_GLOBAL,
    features: ["全部 13 部门所有子包", "全岗位覆盖", "含所有复核Agent", "按年付费均价更低"],
    sortOrder: 401, packageTier: "global",
  },
  {
    key: "global_asset", name: "企业全域+资产增值包", priceYuan: 98000, periodLabel: "年", periodMonths: 12, agentsCount: 0, // 0=全岗位重载（同上）
    scopeLabel: "全域包+数字员工对外变现权益", synergyLabel: "一年后可上架数字匠市", monetizeLabel: "数字资产变现", scaleLabel: "有增值需求企业",
    posterUrl: POSTER_PKG_ASSET,
    features: ["全域包全量", "数字员工对外变现权益", "一年后可上架数字匠市"],
    sortOrder: 402, packageTier: "global",
  },
];

/** 全量种子目录（adminSeed 读本件——文档体系全量） */
export const PKG_CATALOG: PkgSeed[] = [
  ...FINANCE_PKG, ...SALES_PKG, ...PRODUCTION_PKG, ...PROCUREMENT_PKG, ...QUALITY_PKG,
  ...HR_PKG, ...RESEARCH_PKG, ...WAREHOUSE_PKG, ...IT_PKG, ...LEGAL_PKG, ...ADMIN_PKG, ...CS_PKG, ...MARKETING_PKG,
  ...SYNERGY_PKG, ...GLOBAL_PKG,
];
