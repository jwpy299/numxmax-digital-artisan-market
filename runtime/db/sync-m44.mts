/**
 * M44 种子「数字员工超市第一批 IP 产品」（幂等）：
 * 灵枢＆星云 IP 七职业智能体——每个都挂【真实可执行技能】（skills 行，价格 Token 计量，
 * 雇佣后立即可用 agent_skill_* 通道执行，全链已有实证：M38 雇佣即挂载 / M34 原子扣账）。
 *
 * 幂等口径：agents.code / skills(agentId,name) 查重后插入。
 * 用法：set -a && . ./.env && set +a && npx tsx db/sync-m44.mts
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Conn = { query: (q: string, params?: unknown[]) => Promise<unknown>; end?: () => Promise<void> };

const PRODUCTS: Array<{
  code: string; name: string; title: string; industry: string; tags: string[];
  monthlyPrice: number; suggestedPrice: number; avatar: string;
  skills: Array<{ name: string; description: string; price: number }>;
}> = [
  {
    code: "OCC-0001", name: "财务智能体·灵算师", title: "财务报表与财税文书专员", industry: "工业制造",
    tags: ["财务", "报表", "税务"], monthlyPrice: 9900, suggestedPrice: 9900, avatar: "/avatar-occ-finance.png",
    skills: [
      { name: "财务报表分析", description: "录入或口述关键经营数据，产出结构化财务分析（毛利/费用/现金流口径）", price: 120 },
      { name: "财税文书起草", description: "起草税务说明、财务制度、报销规范等正式文书", price: 100 },
      { name: "月度结账周报", description: "汇总本周收付/应收应付，生成结账进度周报", price: 100 },
    ],
  },
  {
    code: "OCC-0002", name: "客户管理智能体·聆商", title: "客户跟进与营销文案专员", industry: "工业制造",
    tags: ["客户", "营销", "跟单"], monthlyPrice: 8900, suggestedPrice: 8900, avatar: "/avatar-occ-customer.png",
    skills: [
      { name: "客户跟进话术", description: "按客户阶段产出跟进话术与异议应对脚本", price: 100 },
      { name: "营销文案", description: "朋友圈/展会/新品上市的成套营销文案", price: 100 },
      { name: "客户画像分析", description: "按行业/规模/历史订单归纳客户画像与突破口", price: 120 },
    ],
  },
  {
    code: "OCC-0003", name: "仓储订单智能体·仓策", title: "仓储单据与盘点专员", industry: "工业制造",
    tags: ["仓储", "出入库", "盘点"], monthlyPrice: 7900, suggestedPrice: 7900, avatar: "/avatar-occ-warehouse.png",
    skills: [
      { name: "出入库单制作", description: "口述收发存信息，产出规范出入库单据", price: 80 },
      { name: "库存盘点分析", description: "按账面与实存差异产出盘点差异分析", price: 120 },
      { name: "仓储点检表", description: "生成库房安全/5S/消防设施班次点检表", price: 80 },
    ],
  },
  {
    code: "OCC-0004", name: "订单管理智能体·单衡", title: "订单排程与交付专员", industry: "工业制造",
    tags: ["订单", "排程", "交付"], monthlyPrice: 8900, suggestedPrice: 8900, avatar: "/avatar-occ-order.png",
    skills: [
      { name: "订单排程表", description: "按交期/产能/物料约束产出订单排程建议表", price: 120 },
      { name: "订单交付周报", description: "汇总在制/逾期/风险订单，生成交付周报", price: 100 },
      { name: "订单风险分析", description: "识别逾期/变更/回款风险并给出处置建议", price: 120 },
    ],
  },
  {
    code: "OCC-0005", name: "研发智能体·创衡", title: "技术方案与竞品调研专员", industry: "工业制造",
    tags: ["研发", "方案", "调研"], monthlyPrice: 10900, suggestedPrice: 10900, avatar: "/avatar-occ-rnd.png",
    skills: [
      { name: "技术方案书", description: "按需求要点产出结构完整的技术方案书", price: 150 },
      { name: "竞品调研", description: "按给定竞品方向产出对比调研分析", price: 150 },
      { name: "项目周报", description: "汇总研发里程碑/风险/下周计划成项目周报", price: 100 },
    ],
  },
  {
    code: "OCC-0006", name: "能耗管理智能体·节衡", title: "能耗分析与节能专员", industry: "工业制造",
    tags: ["能耗", "节能", "双碳"], monthlyPrice: 7900, suggestedPrice: 7900, avatar: "/avatar-occ-energy.png",
    skills: [
      { name: "能耗分析月报", description: "按水电气数据产出能耗结构与同比分析月报", price: 120 },
      { name: "节能改造建议书", description: "按设备清单与负载特征产出节能改造建议", price: 120 },
      { name: "能耗异常通报", description: "产出能耗异常时段/设备的事实通报与处置建议", price: 100 },
    ],
  },
  {
    code: "OCC-0007", name: "设备管理智能体·械衡", title: "设备点检与维保专员", industry: "工业制造",
    tags: ["设备", "点检", "维保"], monthlyPrice: 8900, suggestedPrice: 8900, avatar: "/avatar-occ-device.png",
    skills: [
      { name: "设备点检表", description: "按设备清单生成班次点检项/标准值/实测栏点检表", price: 80 },
      { name: "设备故障分析报告", description: "按故障现象与历史产出故障树分析报告", price: 150 },
      { name: "保养计划编制", description: "按设备台账与运行时长编排月度保养计划", price: 100 },
    ],
  },
];

async function main(conn: Conn): Promise<void> {
  // 平台官方 master（幂等）
  const m = (await conn.query(`SELECT id FROM masters WHERE name = '灵枢星云官方' LIMIT 1`)) as unknown;
  let masterId = 0;
  const mRows = (Array.isArray(m) && Array.isArray(m[0]) ? m[0] : m) as Array<Record<string, unknown>>;
  if (mRows.length > 0) {
    masterId = Number(mRows[0]!.id);
  } else {
    await conn.query(
      `INSERT INTO masters (name, signature, specialty, yearsExperience, title, reputation)
       VALUES ('灵枢星云官方', '灵枢星云官方出品 · 平台直营', '工业数字劳动力', 0, '平台官方', 95)`,
    );
    const idr = (await conn.query(`SELECT LAST_INSERT_ID() AS id`)) as unknown;
    masterId = Number(((Array.isArray(idr) && Array.isArray(idr[0]) ? idr[0] : idr) as Array<Record<string, unknown>>)[0]!.id);
    console.log("masters: 灵枢星云官方 inserted, id", masterId);
  }

  for (const p of PRODUCTS) {
    const exist = (await conn.query(`SELECT id FROM agents WHERE code = ? LIMIT 1`, [p.code])) as unknown;
    const existRows = (Array.isArray(exist) && Array.isArray(exist[0]) ? exist[0] : exist) as Array<Record<string, unknown>>;
    let agentId: number;
    if (existRows.length > 0) {
      agentId = Number(existRows[0]!.id);
      console.log(`${p.code} ${p.name}: exists, agentId=${agentId}`);
    } else {
      await conn.query(
        `INSERT INTO agents (slug, code, name, avatar, industry, industryGroup, capabilityTags, masterId,
                             status, monthlyPrice, suggestedPrice, tasksCompleted, successRate, avgRating,
                             ratingCount, experienceMonths, skillCount, memoryCount, weeklyHires, weeklyHireTrend, recommended)
         VALUES (?, ?, ?, ?, ?, '工业制造', ?, ?, 'active', ?, ?, 0, 100.0, 5.0, 0, 0, 0, 0, 0, '[]', 1)`,
        [p.code.toLowerCase(), p.code, p.name, p.avatar, p.industry, JSON.stringify(p.tags), masterId, p.monthlyPrice, p.suggestedPrice],
      );
      const idr = (await conn.query(`SELECT LAST_INSERT_ID() AS id`)) as unknown;
      agentId = Number(((Array.isArray(idr) && Array.isArray(idr[0]) ? idr[0] : idr) as Array<Record<string, unknown>>)[0]!.id);
      console.log(`${p.code} ${p.name}: inserted, agentId=${agentId}`);
    }
    for (const s of p.skills) {
      const sk = (await conn.query(`SELECT id FROM skills WHERE agentId = ? AND name = ? LIMIT 1`, [agentId, s.name])) as unknown;
      const skRows = (Array.isArray(sk) && Array.isArray(sk[0]) ? sk[0] : sk) as Array<Record<string, unknown>>;
      if (skRows.length > 0) continue;
      await conn.query(
        `INSERT INTO skills (agentId, name, description, pricePerCall, type, complexity, executor, executorKind)
         VALUES (?, ?, ?, ?, 'V', 2, 'llm_analysis', 'generic')`,
        [agentId, s.name, s.description, s.price],
      );
    }
    // skillCount 校正
    await conn.query(`UPDATE agents SET skillCount = (SELECT COUNT(*) FROM skills WHERE agentId = ?) WHERE id = ?`, [agentId, agentId]);
  }
  console.log("M44 seed done:", PRODUCTS.length, "products");
}

const isDirectRun =
  process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (isDirectRun) {
  if (process.env.DRY_RUN === "1") {
    console.log("DRY_RUN ok: syntax parsed");
    process.exit(0);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL 未配置");
    process.exit(1);
  }
  const { createConnection } = await import("mysql2/promise");
  const u = new URL(url);
  const conn = await createConnection({
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.slice(1),
  });
  try {
    await main(conn as unknown as Conn);
  } finally {
    await conn.end();
  }
}
