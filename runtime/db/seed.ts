import "dotenv/config";
import { getDb } from "../api/queries/connection";
import {
  masters,
  enterprises,
  agents,
  skills,
  agentHireRecords,
  trials,
  tasks,
  agentMemories,
  reviews,
  tokenTransactions,
} from "./schema";
import { generateTask } from "../api/lib/taskEngine";
import { eq, sql } from "drizzle-orm";

// ─── 工具 ────────────────────────────────────────────────────────────────────
const DAY = 86400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);
const daysFromNow = (n: number) => new Date(Date.now() + n * DAY);

async function seed() {
  const db = getDb();
  console.log("Seeding database...");

  // ── 幂等：按外键依赖顺序清空 ──────────────────────────────────────────────
  await db.delete(tokenTransactions);
  await db.delete(agentMemories);
  await db.delete(reviews);
  await db.delete(tasks);
  await db.delete(trials);
  await db.delete(agentHireRecords);
  await db.delete(skills);
  await db.delete(agents);
  await db.delete(enterprises);
  await db.delete(masters);

  // ── 老师傅（6 位，与 src/data/agents.ts 对齐）─────────────────────────────
  await db.insert(masters).values([
    { name: "陈国栋", signature: "陈国栋 · 32年数控经验", specialty: "数控设备", yearsExperience: 32, title: "某重工集团高级技师", reputation: 92 },
    { name: "林慧敏", signature: "林慧敏 · 27年声学检测", specialty: "声学检测", yearsExperience: 27, title: "国家级声学检测工程师", reputation: 88 },
    { name: "赵云霞", signature: "赵云霞 · 29年焊接工艺", specialty: "焊接工艺", yearsExperience: 29, title: "国际焊接工程师(IWE)", reputation: 90 },
    { name: "周守拙", signature: "周守拙 · 35年精密测量", specialty: "精密测量", yearsExperience: 35, title: "一级计量师", reputation: 95 },
    { name: "霍炎彬", signature: "霍炎彬 · 30年热处理", specialty: "热处理", yearsExperience: 30, title: "热处理工艺总师", reputation: 86 },
    { name: "秦望舒", signature: "秦望舒 · 24年产线管理", specialty: "产线管理", yearsExperience: 24, title: "精益生产黑带", reputation: 82 },
  ]);
  const masterRows = await db.select().from(masters);
  const masterByName = Object.fromEntries(masterRows.map((m) => [m.name, m]));

  // ── 企业（1 个示范企业 + 3 个评价来源企业）───────────────────────────────
  await db.insert(enterprises).values([
    { name: "华辰精工股份有限公司", industry: "机械制造", contactName: "李工", contactTitle: "设备总监", tokenBalance: 50000 },
    { name: "恒力精密机械厂", industry: "精密仪器", contactName: "王厂长", contactTitle: "厂长", tokenBalance: 32000 },
    { name: "海川汽车部件有限公司", industry: "汽车零部件", contactName: "张工", contactTitle: "设备总监", tokenBalance: 41000 },
    { name: "天工航空配套厂", industry: "航空配套", contactName: "陈主管", contactTitle: "工艺主管", tokenBalance: 28000 },
  ]);
  const entRows = await db.select().from(enterprises);
  const [demoEnt, ent2, ent3, ent4] = entRows;

  // ── Agent（6 位数字工匠，价格/评分/任务数对齐 src/data/agents.ts）─────────
  await db.insert(agents).values([
    {
      slug: "zhenheng", code: "ART-0007", name: "振衡", avatar: "/avatar-zhenheng.png",
      industry: "装备制造", capabilityTags: ["振动诊断", "动平衡校正", "故障预测"],
      masterId: masterByName["陈国栋"].id, status: "active", recommended: true,
      monthlyPrice: 12800, suggestedPrice: 12720, tasksCompleted: 1842,
      successRate: 98.2, avgRating: 4.9, ratingCount: 48, experienceMonths: 14,
      skillCount: 12, memoryCount: 12408, weeklyHires: 9,
      weeklyHireTrend: [3, 5, 4, 6, 7, 9, 9], listedAt: daysAgo(420),
    },
    {
      slug: "tingtao", code: "ART-0012", name: "听涛", avatar: "/avatar-tingtao.png",
      industry: "汽车零部件", capabilityTags: ["声学检测", "异音定位", "频谱分析"],
      masterId: masterByName["林慧敏"].id, status: "active", recommended: false,
      monthlyPrice: 9600, suggestedPrice: 9540, tasksCompleted: 1204,
      successRate: 97.5, avgRating: 4.8, ratingCount: 36, experienceMonths: 11,
      skillCount: 9, memoryCount: 8360, weeklyHires: 6,
      weeklyHireTrend: [2, 3, 3, 4, 5, 5, 6], listedAt: daysAgo(330),
    },
    {
      slug: "chimou", code: "ART-0019", name: "炽眸", avatar: "/avatar-chimou.png",
      industry: "压力容器", capabilityTags: ["焊缝质检", "缺陷识别", "工艺优化"],
      masterId: masterByName["赵云霞"].id, status: "active", recommended: true,
      monthlyPrice: 11200, suggestedPrice: 11150, tasksCompleted: 1567,
      successRate: 98.0, avgRating: 4.9, ratingCount: 41, experienceMonths: 12,
      skillCount: 10, memoryCount: 9710, weeklyHires: 8,
      weeklyHireTrend: [3, 4, 5, 5, 6, 7, 8], listedAt: daysAgo(365),
    },
    {
      slug: "hengzhun", code: "ART-0025", name: "衡准", avatar: "/avatar-hengzhun.png",
      industry: "精密仪器", capabilityTags: ["精密测量", "公差分析", "SPC 管控"],
      masterId: masterByName["周守拙"].id, status: "active", recommended: true,
      monthlyPrice: 13500, suggestedPrice: 13400, tasksCompleted: 2103,
      successRate: 99.1, avgRating: 5.0, ratingCount: 52, experienceMonths: 16,
      skillCount: 9, memoryCount: 15230, weeklyHires: 7,
      weeklyHireTrend: [2, 4, 4, 5, 6, 6, 7], listedAt: daysAgo(480),
    },
    {
      slug: "celu", code: "ART-0031", name: "策炉", avatar: "/avatar-celu.png",
      industry: "模具钢加工", capabilityTags: ["热处理曲线", "淬火控制", "金相分析"],
      masterId: masterByName["霍炎彬"].id, status: "active", recommended: false,
      monthlyPrice: 10800, suggestedPrice: 10760, tasksCompleted: 986,
      successRate: 96.8, avgRating: 4.7, ratingCount: 29, experienceMonths: 9,
      skillCount: 10, memoryCount: 6480, weeklyHires: 5,
      weeklyHireTrend: [1, 2, 3, 3, 4, 5, 5], listedAt: daysAgo(270),
    },
    {
      slug: "xunxian", code: "ART-0038", name: "巡线", avatar: "/avatar-xunxian.png",
      industry: "电子装配", capabilityTags: ["产线巡检", "节拍优化", "异常上报"],
      masterId: masterByName["秦望舒"].id, status: "active", recommended: false,
      monthlyPrice: 8400, suggestedPrice: 8380, tasksCompleted: 1730,
      successRate: 96.2, avgRating: 4.6, ratingCount: 33, experienceMonths: 8,
      skillCount: 9, memoryCount: 7820, weeklyHires: 11,
      weeklyHireTrend: [4, 5, 6, 7, 8, 10, 11], listedAt: daysAgo(3),
    },
  ]);
  const agentRows = await db.select().from(agents);
  const agentBySlug = Object.fromEntries(agentRows.map((a) => [a.slug, a]));
  console.log(`  agents: ${agentRows.length}, masters: ${masterRows.length}, enterprises: ${entRows.length}`);

  // ── 技能（每人 9-12 项）───────────────────────────────────────────────────
  type SkillSeed = [string, "V" | "U", number, number, number, number, string?];
  // [名称, 类型, 复杂度, 单价, 调用次数, 成功率, 描述?]
  const skillSeeds: Record<string, SkillSeed[]> = {
    zhenheng: [
      ["振动频谱采集", "V", 3, 100, 1842, 99.1, "多通道振动信号同步采集"],
      ["FFT频谱特征提取", "U", 4, 120, 1796, 98.7, "频域特征提取与边带识别"],
      ["轴承故障特征识别", "U", 5, 150, 964, 97.4, "BPFO/BPFI 特征频率匹配"],
      ["主轴动平衡评估", "U", 4, 120, 588, 96.9],
      ["刀具磨损趋势预测", "U", 4, 120, 742, 95.8],
      ["异常共振点定位", "U", 5, 150, 433, 97.2],
      ["测点布置建议", "V", 2, 80, 312, 99.4],
      ["历史工况对比分析", "U", 3, 100, 655, 98.3],
      ["诊断报告自动生成", "V", 2, 80, 327, 99.8],
      ["温度场联合分析", "U", 3, 100, 286, 96.5],
      ["振动报警阈值整定", "U", 2, 80, 254, 98.9],
      ["设备健康指数计算", "U", 3, 100, 498, 98.1],
    ],
    tingtao: [
      ["声纹信号采集", "V", 3, 100, 980, 99.0],
      ["背景噪声分离", "U", 4, 120, 864, 97.8],
      ["异音特征识别", "U", 5, 150, 733, 97.1],
      ["泄漏声源定位", "U", 4, 120, 512, 96.4],
      ["轴承听诊分析", "U", 4, 120, 645, 97.6],
      ["泵阀汽蚀识别", "U", 4, 120, 388, 96.2],
      ["声学频谱分析", "U", 3, 100, 702, 98.2],
      ["巡检录音归档", "V", 1, 60, 421, 99.7],
      ["声学诊断报告生成", "V", 2, 80, 268, 99.5],
    ],
    chimou: [
      ["焊缝图像采集", "V", 3, 100, 1102, 99.2],
      ["焊缝缺陷识别", "U", 5, 150, 987, 97.9],
      ["气孔夹渣分类", "U", 4, 120, 764, 97.3],
      ["焊缝等级评定", "U", 4, 120, 689, 98.4],
      ["焊接工艺参数优化", "U", 5, 150, 512, 96.6],
      ["熔池温度监测", "V", 3, 100, 438, 97.8],
      ["缺陷复验调度", "V", 2, 80, 356, 99.1],
      ["质检报告生成", "V", 2, 80, 402, 99.6],
      ["焊接缺陷SPC分析", "U", 3, 100, 298, 97.0],
      ["返修优先级排序", "U", 2, 80, 271, 98.6],
    ],
    hengzhun: [
      ["精密尺寸测量", "V", 4, 120, 1420, 99.5],
      ["公差链分析", "U", 5, 150, 1103, 98.8],
      ["量具校准管理", "V", 2, 80, 876, 99.7],
      ["SPC过程管控", "U", 4, 120, 1230, 99.0],
      ["Cpk能力评估", "U", 4, 120, 1088, 99.2],
      ["测量系统分析", "U", 4, 120, 743, 98.5],
      ["三坐标测量规划", "V", 3, 100, 654, 99.3],
      ["首件检验审核", "U", 3, 100, 590, 99.1],
      ["测量报告生成", "V", 2, 80, 512, 99.8],
    ],
    celu: [
      ["炉温曲线采集", "V", 3, 100, 780, 99.0],
      ["热处理工艺卡比对", "U", 4, 120, 702, 98.1],
      ["淬火冷速控制", "U", 5, 150, 588, 96.4],
      ["回火温度优化", "U", 4, 120, 466, 96.9],
      ["金相组织分析", "U", 5, 150, 402, 96.1],
      ["变形风险评估", "U", 4, 120, 377, 96.6],
      ["热电偶漂移校正", "U", 3, 100, 312, 97.7],
      ["硬度预测模型", "U", 4, 120, 341, 96.3],
      ["工艺参数寻优", "U", 4, 120, 290, 97.2],
      ["热处理报告生成", "V", 2, 80, 264, 99.4],
    ],
    xunxian: [
      ["产线巡检执行", "V", 2, 80, 1320, 99.3],
      ["节拍时间分析", "U", 3, 100, 1105, 97.9],
      ["瓶颈工位识别", "U", 4, 120, 886, 97.2],
      ["异常分级上报", "V", 2, 80, 964, 98.6],
      ["工单智能派发", "V", 3, 100, 745, 98.1],
      ["稼动率统计", "U", 2, 80, 690, 98.8],
      ["物料齐套检查", "U", 2, 80, 588, 97.5],
      ["巡检路线规划", "V", 3, 100, 466, 98.4],
      ["产线日报生成", "V", 1, 60, 512, 99.6],
    ],
  };
  for (const [slug, list] of Object.entries(skillSeeds)) {
    await db.insert(skills).values(
      list.map(([name, type, complexity, pricePerCall, callCount, successRate, description]) => ({
        agentId: agentBySlug[slug].id,
        name, type, complexity, pricePerCall, callCount, successRate,
        description,
      })),
    );
  }
  const skillRows = await db.select().from(skills);
  console.log(`  skills: ${skillRows.length}`);

  // ── 雇佣记录（示范企业 3 条：active×2 + trial×1；历史记录带评价）──────────
  type HireSeed = {
    slug: string; entId: number; period: number; price: number;
    status: "trial" | "active" | "expired" | "cancelled";
    startDaysAgo: number; tasks: number; rating?: number; review?: string;
  };
  const hireSeeds: HireSeed[] = [
    { slug: "zhenheng", entId: demoEnt.id, period: 12, price: 12800, status: "active", startDaysAgo: 185, tasks: 86,
      rating: 5, review: "振衡上岗第三周就提前 11 天预警了主轴轴承内圈剥落，避免了一次整线停机。" },
    { slug: "chimou", entId: demoEnt.id, period: 6, price: 11200, status: "active", startDaysAgo: 62, tasks: 34,
      rating: 5, review: "焊缝缺陷检出率比人工目检提升明显，返修率下降了 40%。" },
    { slug: "tingtao", entId: demoEnt.id, period: 1, price: 9600, status: "trial", startDaysAgo: 4, tasks: 6 },
    { slug: "zhenheng", entId: ent2.id, period: 6, price: 12400, status: "expired", startDaysAgo: 320, tasks: 210,
      rating: 5, review: "报告很专业，刚开始不熟悉我们厂的老机床，一个月后比新入职的设备工程师还懂。" },
    { slug: "zhenheng", entId: ent4.id, period: 2, price: 12100, status: "expired", startDaysAgo: 90, tasks: 58,
      rating: 4, review: "试用期的评估报告数据翔实，签约后响应速度一直在提升。" },
    { slug: "hengzhun", entId: ent3.id, period: 12, price: 13500, status: "active", startDaysAgo: 240, tasks: 412,
      rating: 5, review: "Cpk 管控上线后，我们的关键尺寸不良率从 800ppm 降到 120ppm。" },
    { slug: "hengzhun", entId: ent2.id, period: 6, price: 13200, status: "expired", startDaysAgo: 400, tasks: 305,
      rating: 5, review: "周老师傅的计量功底确实扎实，量具周期校准管理帮我们通过了 IATF 审核。" },
    { slug: "celu", entId: ent2.id, period: 6, price: 10800, status: "expired", startDaysAgo: 260, tasks: 144,
      rating: 4, review: "炉温曲线比对很实用，淬裂废品率降了一半。希望报告能支持更多自定义模板。" },
    { slug: "xunxian", entId: ent3.id, period: 3, price: 8400, status: "expired", startDaysAgo: 120, tasks: 96,
      rating: 4, review: "巡检自动化省了两个班组长的人力，节拍分析找出了我们一直忽视的瓶颈工位。" },
    { slug: "tingtao", entId: ent3.id, period: 6, price: 9600, status: "cancelled", startDaysAgo: 300, tasks: 45,
      rating: 3, review: "声学检测本身不错，但我们产线噪声环境太复杂，适配成本偏高，协商解约。" },
    { slug: "chimou", entId: ent4.id, period: 12, price: 11000, status: "active", startDaysAgo: 150, tasks: 178,
      rating: 5, review: "航空件焊缝要求极高，炽眸的缺陷分级和复验调度完全满足 AS9100 追溯要求。" },
  ];
  for (const h of hireSeeds) {
    const startedAt = daysAgo(h.startDaysAgo);
    const endsAt = new Date(startedAt);
    endsAt.setMonth(endsAt.getMonth() + h.period);
    await db.insert(agentHireRecords).values({
      agentId: agentBySlug[h.slug].id,
      enterpriseId: h.entId,
      periodMonths: h.period,
      monthlyPrice: h.price,
      status: h.status,
      tasksCompleted: h.tasks,
      rating: h.rating,
      review: h.review,
      startedAt,
      endsAt: h.status === "expired" || h.status === "cancelled" ? endsAt : endsAt,
      createdAt: startedAt,
    });
  }
  const hireRows = await db.select().from(agentHireRecords);
  console.log(`  hire records: ${hireRows.length}`);

  // ── 评价（与雇佣记录关联；外加两条历史评价凑分布）───────────────────────────
  const reviewSeeds: {
    slug: string; entId: number; rating: number; content: string;
    title: string; months: number; daysAgo: number;
  }[] = [
    { slug: "zhenheng", entId: demoEnt.id, rating: 5, content: "振衡上岗第三周就提前 11 天预警了主轴轴承内圈剥落，避免了一次整线停机。", title: "设备总监", months: 6, daysAgo: 20 },
    { slug: "zhenheng", entId: ent2.id, rating: 5, content: "报告很专业，刚开始不熟悉我们厂的老机床，一个月后比新入职的设备工程师还懂。", title: "厂长", months: 4, daysAgo: 130 },
    { slug: "zhenheng", entId: ent4.id, rating: 4, content: "试用期的评估报告数据翔实，签约后响应速度一直在提升。", title: "工艺主管", months: 2, daysAgo: 40 },
    { slug: "chimou", entId: demoEnt.id, rating: 5, content: "焊缝缺陷检出率比人工目检提升明显，返修率下降了 40%。", title: "设备总监", months: 2, daysAgo: 12 },
    { slug: "chimou", entId: ent4.id, rating: 5, content: "航空件焊缝要求极高，炽眸的缺陷分级和复验调度完全满足 AS9100 追溯要求。", title: "工艺主管", months: 5, daysAgo: 30 },
    { slug: "hengzhun", entId: ent3.id, rating: 5, content: "Cpk 管控上线后，我们的关键尺寸不良率从 800ppm 降到 120ppm。", title: "质量部长", months: 8, daysAgo: 45 },
    { slug: "hengzhun", entId: ent2.id, rating: 5, content: "周老师傅的计量功底确实扎实，量具周期校准管理帮我们通过了 IATF 审核。", title: "厂长", months: 6, daysAgo: 150 },
    { slug: "celu", entId: ent2.id, rating: 4, content: "炉温曲线比对很实用，淬裂废品率降了一半。希望报告能支持更多自定义模板。", title: "厂长", months: 6, daysAgo: 70 },
    { slug: "xunxian", entId: ent3.id, rating: 4, content: "巡检自动化省了两个班组长的人力，节拍分析找出了我们一直忽视的瓶颈工位。", title: "生产经理", months: 3, daysAgo: 28 },
    { slug: "tingtao", entId: ent3.id, rating: 3, content: "声学检测本身不错，但我们产线噪声环境太复杂，适配成本偏高，协商解约。", title: "设备经理", months: 2, daysAgo: 200 },
    { slug: "tingtao", entId: demoEnt.id, rating: 5, content: "试用第 5 天就定位了 2 号泵的汽蚀异音，沙箱报告结论和拆检结果一致。", title: "设备总监", months: 1, daysAgo: 1 },
    { slug: "celu", entId: ent4.id, rating: 5, content: "热处理工艺寻优帮我们把模具钢硬度波动从 ±1.8HRC 收窄到 ±0.9HRC。", title: "热处理车间主任", months: 3, daysAgo: 55 },
  ];
  for (const r of reviewSeeds) {
    const hire = hireRows.find(
      (h) => h.agentId === agentBySlug[r.slug].id && h.enterpriseId === r.entId,
    );
    await db.insert(reviews).values({
      agentId: agentBySlug[r.slug].id,
      enterpriseId: r.entId,
      hireRecordId: hire?.id ?? null,
      rating: r.rating,
      content: r.content,
      employerTitle: r.title,
      hireMonths: r.months,
      createdAt: daysAgo(r.daysAgo),
    });
  }
  const reviewRows = await db.select().from(reviews);
  console.log(`  reviews: ${reviewRows.length}`);

  // ── 试用（听涛进行中 D-4；振衡已完成带报告）────────────────────────────────
  await db.insert(trials).values([
    {
      agentId: agentBySlug["tingtao"].id, enterpriseId: demoEnt.id, status: "active",
      productionLine: "泵阀装配线 · 6 台离心泵 · 2 台真空泵",
      skillCalls: 14, tokensSpent: 1540,
      startedAt: daysAgo(4), endsAt: daysFromNow(3),
    },
    {
      agentId: agentBySlug["zhenheng"].id, enterpriseId: demoEnt.id, status: "completed",
      productionLine: "机加车间 · 12 台 CNC",
      skillCalls: 22, tokensSpent: 2460,
      startedAt: daysAgo(192), endsAt: daysAgo(185),
      report: {
        suitabilityScore: 94, diagnosticAccuracy: 96.8, avgResponseSec: 4.2,
        tasksCompleted: 12, confidenceGrade: "A-",
        advice: "建议正式雇佣：适用度优秀，技能链与产线需求高度匹配",
        summary: "7 天沙箱试用期间，「振衡」在脱敏数据环境下完成技能调用 22 次，诊断准确率 96.8%，平均响应 4.2s，综合适用度 94 分（A-）。",
        highlights: ["诊断准确率 96.8%", "平均响应 4.2s", "综合置信度 A-", "建议：正式雇佣"],
      },
    },
  ]);
  const trialRows = await db.select().from(trials);
  console.log(`  trials: ${trialRows.length}`);

  // ── 任务（确定性引擎生成步骤与报告）────────────────────────────────────────
  const skillsByAgent = (slug: string) =>
    skillRows.filter((s) => s.agentId === agentBySlug[slug].id);
  const taskSeeds: { slug: string; entId: number; instruction: string; daysAgo: number; hireSlug?: string }[] = [
    { slug: "zhenheng", entId: demoEnt.id, instruction: "帮我看一下3号CNC的振动频谱有没有异常", daysAgo: 0 },
    { slug: "zhenheng", entId: demoEnt.id, instruction: "评估本月5号加工中心的刀具磨损趋势", daysAgo: 2 },
    { slug: "zhenheng", entId: demoEnt.id, instruction: "对比上周与本周2号CNC的主轴温升情况", daysAgo: 5 },
    { slug: "chimou", entId: demoEnt.id, instruction: "检测7号焊接工位今天的焊缝有没有缺陷", daysAgo: 1 },
    { slug: "tingtao", entId: demoEnt.id, instruction: "检查一下2号泵运行时的异音来源", daysAgo: 1 },
    { slug: "hengzhun", entId: ent3.id, instruction: "分析Ø25轴近一周的SPC数据有没有异常漂移", daysAgo: 3 },
    { slug: "celu", entId: ent2.id, instruction: "帮我看看3号炉昨天的炉温曲线是否符合工艺卡", daysAgo: 4 },
    { slug: "xunxian", entId: ent3.id, instruction: "生成昨天产线巡检报告并找出瓶颈工位", daysAgo: 2 },
  ];
  const seededTasks: { id: number; slug: string; entId: number; gen: ReturnType<typeof generateTask> }[] = [];
  for (const t of taskSeeds) {
    const agent = agentBySlug[t.slug];
    const hire = hireRows.find(
      (h) => h.agentId === agent.id && h.enterpriseId === t.entId,
    );
    const gen = generateTask(t.instruction, agent.name, skillsByAgent(t.slug));
    const [{ id }] = await db
      .insert(tasks)
      .values({
        agentId: agent.id,
        enterpriseId: t.entId,
        hireRecordId: hire?.id ?? null,
        instruction: t.instruction,
        intentSummary: gen.intentSummary,
        targetDevice: gen.targetDevice,
        status: "completed",
        steps: gen.steps,
        report: gen.report,
        confidence: gen.confidence,
        tokenCost: gen.tokenCost,
        durationMs: gen.durationMs,
        memoryWritten: true,
        createdAt: daysAgo(t.daysAgo),
      })
      .$returningId();
    seededTasks.push({ id, slug: t.slug, entId: t.entId, gen });
  }
  console.log(`  tasks: ${seededTasks.length}`);

  // ── 工作记忆（振衡 4 条时间线示例 + 每个任务一条沉淀）────────────────────────
  const memorySeeds = [
    { slug: "zhenheng", category: "设备特征", days: 75, summary: "记住雇主华辰精工的 3 号 CNC 在 4200rpm 存在历史共振峰，后续任务自动规避误判。" },
    { slug: "zhenheng", category: "工艺参数", days: 58, summary: "学会该厂区刀具供应商 B 的磨损曲线偏快特征，预测窗口自动提前 15%。" },
    { slug: "zhenheng", category: "环境补偿", days: 41, summary: "积累冬季低温环境下传感器漂移补偿参数。" },
    { slug: "zhenheng", category: "雇主偏好", days: 19, summary: "识别出雇主偏好「先给结论再给过程」的报告格式，自动调整输出结构。" },
    { slug: "tingtao", category: "设备特征", days: 30, summary: "记录 2 号泵汽蚀异音的声纹指纹，后续巡检自动列入重点监听对象。" },
    { slug: "chimou", category: "工艺参数", days: 22, summary: "沉淀 7 号焊接工位送丝速度波动与气孔缺陷的相关性特征。" },
    { slug: "hengzhun", category: "雇主偏好", days: 15, summary: "雇主要求 SPC 周报固定包含 Cpk 趋势与偏移归因两个小节。" },
    { slug: "celu", category: "环境补偿", days: 26, summary: "积累 3 号炉冬季升温段的环境温度补偿曲线。" },
    { slug: "xunxian", category: "设备特征", days: 12, summary: "标记 5 号工位为长期瓶颈观察对象，节拍基线 35s。" },
  ];
  for (const m of memorySeeds) {
    await db.insert(agentMemories).values({
      agentId: agentBySlug[m.slug].id,
      category: m.category,
      summary: m.summary,
      createdAt: daysAgo(m.days),
    });
  }
  for (const t of seededTasks) {
    await db.insert(agentMemories).values({
      agentId: agentBySlug[t.slug].id,
      taskId: t.id,
      category: "设备特征",
      summary: t.gen.memorySummary,
    });
  }
  const memoryRows = await db.select().from(agentMemories);
  console.log(`  memories: ${memoryRows.length}`);

  // ── Token 流水 ─────────────────────────────────────────────────────────────
  // 1) 雇佣佣金：每条雇佣记录按已过月数生成月度流水（平台 15% / 老师傅 85%）
  let txCount = 0;
  for (const h of hireRows) {
    const elapsed =
      h.status === "active"
        ? Math.max(1, Math.floor((Date.now() - h.startedAt.getTime()) / (30 * DAY)))
        : h.periodMonths;
    const months = Math.min(elapsed, h.periodMonths);
    for (let m = 0; m < months; m++) {
      const at = new Date(h.startedAt);
      at.setMonth(at.getMonth() + m);
      if (at.getTime() > Date.now()) break;
      const fee = Math.round(h.monthlyPrice * 0.15);
      await db.insert(tokenTransactions).values({
        type: "hire_commission",
        amount: h.monthlyPrice,
        platformFee: fee,
        masterShare: h.monthlyPrice - fee,
        agentId: h.agentId,
        enterpriseId: h.enterpriseId,
        hireRecordId: h.id,
        note: `月度雇佣佣金 · 第 ${m + 1} 个月`,
        createdAt: at,
      });
      txCount++;
    }
  }

  // 2) 技能调用：按种子任务的技能链逐次记账（平台 20%）；试用任务记 trial_skill_call
  for (const t of seededTasks) {
    const isTrial = t.slug === "tingtao";
    for (const skill of t.gen.skillChain) {
      const fee = Math.round(skill.pricePerCall * 0.2);
      await db.insert(tokenTransactions).values({
        type: isTrial ? "trial_skill_call" : "skill_call",
        amount: skill.pricePerCall,
        platformFee: fee,
        masterShare: skill.pricePerCall - fee,
        agentId: agentBySlug[t.slug].id,
        enterpriseId: t.entId,
        taskId: t.id,
        note: `技能调用 · ${skill.name}`,
      });
      txCount++;
    }
  }

  // 3) 试用激励：完成试用返还的 Token 补贴
  await db.insert(tokenTransactions).values({
    type: "trial_reward",
    amount: 200,
    platformFee: 0,
    masterShare: 200,
    agentId: agentBySlug["zhenheng"].id,
    enterpriseId: demoEnt.id,
    note: "试用完成激励 · 沙箱评估达标返还",
    createdAt: daysAgo(185),
  });
  txCount++;
  console.log(`  token transactions: ${txCount}`);

  // ── 校验：Agent 冗余计数与实际技能数一致 ─────────────────────────────────
  for (const a of agentRows) {
    const [{ c }] = await db
      .select({ c: sql<number>`count(*)` })
      .from(skills)
      .where(eq(skills.agentId, a.id));
    if (Number(c) !== a.skillCount) {
      await db.update(agents).set({ skillCount: Number(c) }).where(eq(agents.id, a.id));
    }
  }

  console.log("Done.");
  process.exit(0); // close MySQL connection pool
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
