import type { Skill, TaskStep, TaskReport } from "@db/schema";
import { createRng, hashString } from "./random";

// ─── 任务执行引擎（确定性规则解析，非真实 LLM）─────────────────────────────
// 输入雇主自然语言任务 + Agent 技能清单，产出：
// 意图解析 → 子任务拆解 → 技能链调度 → 执行日志 → 交叉验证 → 结构化报告。

interface Scenario {
  key: string;
  intent: string; // 意图名称
  keywords: string[]; // 触发关键词（命中任务文本）
  skillHints: string[]; // 优先匹配的技能名片段
  subtasks: string[];
  findings: (device: string) => string[];
  suggestions: (device: string) => string[];
  logs: string[];
  verifyNote: (device: string) => string;
  reportTitle: (device: string) => string;
  confidenceBase: number;
}

const SCENARIOS: Scenario[] = [
  {
    key: "vibration",
    intent: "振动异常诊断",
    keywords: ["振动", "频谱", "共振", "动平衡", "轴承"],
    skillHints: ["频谱", "FFT", "振动", "轴承", "平衡", "对比"],
    subtasks: [
      "采集目标设备各测点振动信号",
      "对信号做 FFT 频谱特征提取",
      "比对轴承故障特征频率库",
      "与历史工况基线交叉验证",
    ],
    findings: (d) => [
      `${d} 轴承内圈特征频率幅值超出基线 34%，与早期剥落特征吻合`,
      "1X 转频幅值 4.6 mm/s，环比上升 34%，存在轻微不对中迹象",
      "历史数据显示同类工况下劣化周期约 23 天，建议提前介入",
    ],
    suggestions: (d) => [
      `建议 7-10 天内安排 ${d} 检修，准备轴承备件`,
      "检修前将负载降至额定 80% 以下运行，避免共振区间 4200rpm",
    ],
    logs: [
      "采集通道 CH2 · 采样率 25.6kHz … OK",
      "Hanning 窗 · 频谱分辨率 0.5Hz … OK",
      "特征频率匹配：BPFI 162Hz · 置信度 0.91",
      "历史基线对比：1X 幅值 +34%",
    ],
    verifyNote: (d) => `与 ${d} 历史基线对比：1X 频幅值 +34%，异常峰确认`,
    reportTitle: (d) => `${d} 振动异常诊断报告`,
    confidenceBase: 0.9,
  },
  {
    key: "acoustic",
    intent: "声学异音检测",
    keywords: ["声音", "声学", "异音", "异响", "噪声", "泄漏", "听诊"],
    skillHints: ["声学", "异音", "听诊", "泄漏", "频谱", "定位"],
    subtasks: [
      "采集设备运行声纹信号",
      "分离背景噪声并提取异音特征",
      "比对异音样本库进行定位",
      "输出泄漏/松动点位置评估",
    ],
    findings: (d) => [
      `${d} 在 2.4kHz 频段检出周期性异音成分，声压级 +9dB`,
      "异音源定位于设备北侧轴承座附近，疑似保持架磨损",
      "异音出现频次与负载正相关，空载状态下不可复现",
    ],
    suggestions: (d) => [
      `建议停机检查 ${d} 轴承座紧固力矩与润滑状态`,
      "连续监测 72 小时，若声压级继续上升超过 15dB 则立即检修",
    ],
    logs: [
      "麦克风阵列 4 通道同步采集 … OK",
      "谱减法降噪 · 信噪比提升 12dB … OK",
      "异音特征匹配：保持架缺陷样本相似度 0.87",
    ],
    verifyNote: (d) => `${d} 异音特征与样本库保持架缺陷模式相似度 0.87`,
    reportTitle: (d) => `${d} 声学异音检测报告`,
    confidenceBase: 0.87,
  },
  {
    key: "welding",
    intent: "焊缝质量检测",
    keywords: ["焊", "焊缝", "缺陷", "气孔", "夹渣", "裂纹"],
    skillHints: ["焊缝", "缺陷", "质检", "评级", "视觉", "工艺"],
    subtasks: [
      "采集焊缝表面视觉图像",
      "识别并分类缺陷类型（气孔/夹渣/裂纹）",
      "按工艺标准对焊缝评级",
      "生成返修优先级清单",
    ],
    findings: (d) => [
      `${d} 第 3 道焊缝检出直径 1.8mm 气孔 2 处，超出 II 级验收标准`,
      "焊缝余高不均，最大偏差 0.9mm，与送丝速度波动相关",
      "近 30 天同类缺陷发生率 2.1%，处于受控区间上限",
    ],
    suggestions: (d) => [
      `对 ${d} 第 3 道焊缝标记返修，优先级 P1`,
      "将送丝速度波动纳入焊接参数 SPC 管控，控制限收紧 10%",
    ],
    logs: [
      "工业相机 2400 万像素 · 帧率 30fps … OK",
      "缺陷候选区域检出 7 处，复核确认 2 处",
      "按 GB/T 3323 评级：III 级 → 需返修",
    ],
    verifyNote: (d) => `${d} 缺陷复核：人工抽检一致率 96%`,
    reportTitle: (d) => `${d} 焊缝质量检测报告`,
    confidenceBase: 0.88,
  },
  {
    key: "thermal",
    intent: "热处理工艺分析",
    keywords: ["温度", "温升", "炉温", "淬火", "热处理", "回火", "曲线"],
    skillHints: ["炉温", "曲线", "淬火", "热处理", "变形", "金相", "工艺"],
    subtasks: [
      "调取加热炉各温区实时曲线",
      "校验升温/保温/冷却速率是否合符工艺卡",
      "评估工件变形与硬度风险",
      "输出工艺参数优化建议",
    ],
    findings: (d) => [
      `${d} 3 区保温段温度偏低 12°C，保温有效时间缩短约 8 分钟`,
      "冷却段速率 42°C/s，高于工艺上限 35°C/s，存在开裂风险",
      "近 5 炉次同位置温差呈扩大趋势，疑似热电偶漂移",
    ],
    suggestions: (d) => [
      `校准 ${d} 3 区热电偶，并将保温段时间补偿 +10 分钟`,
      "冷却介质流量下调 15%，将冷速控制在 35°C/s 以内",
    ],
    logs: [
      "读取 6 温区热电偶数据 · 采样 1Hz … OK",
      "工艺卡比对：3 项参数偏差超限",
      "硬度风险模型评估：HRC 波动 ±1.2",
    ],
    verifyNote: (d) => `${d} 工艺卡比对：保温温度偏差 -12°C，冷速超限确认`,
    reportTitle: (d) => `${d} 热处理工艺分析报告`,
    confidenceBase: 0.86,
  },
  {
    key: "measure",
    intent: "精密测量与公差分析",
    keywords: ["测量", "公差", "尺寸", "精度", "校准", "SPC", "spc"],
    skillHints: ["测量", "公差", "校准", "SPC", "精度"],
    subtasks: [
      "采集关键尺寸测量数据",
      "计算 Cpk/Ppk 过程能力指数",
      "分析公差链累积偏差",
      "输出量具校准与管控建议",
    ],
    findings: (d) => [
      `${d} 关键尺寸 Ø25h7 的 Cpk 由 1.67 降至 1.21，过程能力趋紧`,
      "尺寸分布中心偏移 +4.2μm，与刀具磨损曲线高度相关",
      "量具 R&R 占比 9.8%，测量系统处于可接受区间",
    ],
    suggestions: (d) => [
      `对 ${d} 加工参数做 +2μm 补偿，并加密首件检验频次至 1/20 件`,
      "安排该工位千分表周期校准，维持测量系统稳定",
    ],
    logs: [
      "导入测量数据 120 组 · 无缺失 … OK",
      "X-bar/R 控制图：2 点超出警戒限",
      "公差链仿真：累计偏差 68μm / 上限 80μm",
    ],
    verifyNote: (d) => `${d} 控制图复核：偏移趋势与刀具磨损记录一致`,
    reportTitle: (d) => `${d} 精密测量分析报告`,
    confidenceBase: 0.89,
  },
  {
    key: "inspection",
    intent: "产线巡检与异常排查",
    keywords: ["巡检", "产线", "节拍", "工单", "异常上报", "稼动", "产线管理"],
    skillHints: ["巡检", "节拍", "工单", "上报", "调度"],
    subtasks: [
      "按巡检路线采集各工位状态",
      "比对标准节拍识别瓶颈工位",
      "汇总异常项并分级",
      "生成工单派发建议",
    ],
    findings: (d) => [
      `${d} 所在产线 5 号工位节拍超出标准 18%，为当前瓶颈`,
      "巡检共发现异常 3 项：1 项设备类、2 项物料类",
      "全线稼动率 86.4%，较上周下降 2.1 个百分点",
    ],
    suggestions: (d) => [
      `为 ${d} 瓶颈工位生成 P1 工单并派发至设备组`,
      "物料类异常同步仓储组复核安全库存水位",
    ],
    logs: [
      "巡检路线 12 个工位 · 全部打卡 … OK",
      "节拍分析：5 号工位 42s / 标准 35s",
      "异常分级完成：P1×1 · P2×2",
    ],
    verifyNote: (d) => `${d} 节拍数据与 MES 记录交叉验证一致`,
    reportTitle: (d) => `${d} 产线巡检报告`,
    confidenceBase: 0.85,
  },
];

const DEFAULT_SCENARIO = SCENARIOS[0];

/** 提取目标设备，如 "3号CNC" → "3 号 CNC"，"CNC-03" → "CNC-03"，"3号炉" → "3 号 炉" */
export function extractDevice(instruction: string): string {
  // 3号CNC / 3 号 炉 / 7号焊接工位
  const m2 = instruction.match(
    /(\d{1,3})\s*号\s*([A-Za-z][A-Za-z0-9]{0,9}|[一-龥]{0,3}工位|[一-龥]{0,2}?(?:车床|机床|加工中心|机器人|泵|炉|窑|塔|罐|轴|机|床|线))/,
  );
  if (m2) return `${m2[1]} 号 ${m2[2].toUpperCase()}`;
  const m1 = instruction.match(/([A-Za-z]{2,})[-\s]?(\d{1,3})/); // CNC-03 / CNC3
  if (m1) return `${m1[1].toUpperCase()}-${m1[2].padStart(2, "0")}`;
  return "目标设备";
}

function pickScenario(instruction: string): Scenario {
  let best = DEFAULT_SCENARIO;
  let bestScore = 0;
  for (const s of SCENARIOS) {
    const score = s.keywords.reduce(
      (acc, k) => acc + (instruction.includes(k) ? 1 : 0),
      0,
    );
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}

/** 从 Agent 技能清单中选择最匹配的技能链（3-5 个） */
function pickSkillChain(
  scenario: Scenario,
  agentSkills: Skill[],
): Skill[] {
  const scored = agentSkills.map((s) => ({
    skill: s,
    score: scenario.skillHints.reduce(
      (acc, h) => acc + (s.name.includes(h) ? 2 : 0),
      0,
    ),
  }));
  scored.sort((a, b) => b.score - a.score || b.skill.callCount - a.skill.callCount);
  const chain = scored.slice(0, 4).map((x) => x.skill);
  return chain.length >= 3 ? chain : agentSkills.slice(0, 4);
}

export interface GeneratedTask {
  intentSummary: string;
  targetDevice: string;
  steps: TaskStep[];
  report: TaskReport;
  confidence: number;
  tokenCost: number;
  durationMs: number;
  skillChain: Skill[];
  memorySummary: string;
}

export function generateTask(
  instruction: string,
  agentName: string,
  agentSkills: Skill[],
): GeneratedTask {
  const scenario = pickScenario(instruction);
  const device = extractDevice(instruction);
  const rng = createRng(hashString(instruction + agentName));
  const chain = pickSkillChain(scenario, agentSkills);

  const steps: TaskStep[] = [];
  let order = 0;
  let totalMs = 0;
  const push = (s: Omit<TaskStep, "order" | "status">) => {
    steps.push({ ...s, order: ++order, status: "done" });
    totalMs += s.durationMs;
  };

  push({
    kind: "intent",
    title: "意图解析",
    detail: `识别任务：${scenario.intent} · 目标设备：${device}`,
    durationMs: rng.int(600, 1100),
  });
  push({
    kind: "decompose",
    title: "任务拆解",
    detail: `生成 ${scenario.subtasks.length} 个子任务：${scenario.subtasks.join(" → ")}`,
    durationMs: rng.int(800, 1300),
  });

  let tokenCost = 0;
  chain.forEach((skill, i) => {
    const tokens = skill.pricePerCall;
    tokenCost += tokens;
    push({
      kind: "dispatch",
      title: `技能调度 ${i + 1}/${chain.length} · ${skill.name}`,
      detail: `命中技能「${skill.name}」（${skill.type} 类 · 成功率 ${skill.successRate}%）· 调用费 ${tokens} Token`,
      skillName: skill.name,
      tokens,
      durationMs: rng.int(500, 900),
    });
    push({
      kind: "execute",
      title: `执行 · ${skill.name}`,
      detail: scenario.logs[i % scenario.logs.length],
      skillName: skill.name,
      durationMs: rng.int(1200, 2600),
      logs: [
        `[${ts(0)}] ${scenario.logs[i % scenario.logs.length]}`,
        `[${ts(1)}] 结果校验通过 · 写入临时上下文`,
      ],
    });
  });

  push({
    kind: "verify",
    title: "交叉验证",
    detail: scenario.verifyNote(device),
    durationMs: rng.int(700, 1200),
  });
  push({
    kind: "report",
    title: "生成报告",
    detail: "汇总执行过程、关键发现与建议措施，写入工作记忆",
    durationMs: rng.int(600, 1000),
  });

  function ts(offset: number): string {
    const base = new Date();
    return `${String(base.getHours()).padStart(2, "0")}:${String(
      base.getMinutes(),
    ).padStart(2, "0")}:${String((base.getSeconds() + offset * 3) % 60).padStart(2, "0")}`;
  }

  const confidence = Math.min(
    0.97,
    Math.max(0.78, scenario.confidenceBase + rng.between(-0.04, 0.06)),
  );
  const confidenceGrade =
    confidence >= 0.93 ? "A" : confidence >= 0.88 ? "A-" : confidence >= 0.83 ? "B+" : "B";

  const findings = scenario.findings(device);
  const suggestions = scenario.suggestions(device);
  const report: TaskReport = {
    title: scenario.reportTitle(device),
    findings,
    suggestions,
    processSummary: `技能链 ${chain.map((s) => s.name).join(" → ")} · 耗时 ${(
      totalMs / 1000
    ).toFixed(1)}s · 调用费用 ${tokenCost} Token`,
    skillChain: chain.map((s) => s.name),
    confidence: Math.round(confidence * 1000) / 1000,
    confidenceGrade,
    durationMs: totalMs,
    tokenCost,
  };

  const memorySummary = `完成「${scenario.intent}」任务（${device}）：${findings[0]}。经验：${device} 同类工况下建议优先检查 ${chain[0]?.name ?? "关键测点"} 相关参数。`;

  return {
    intentSummary: `${scenario.intent} · 目标设备：${device}`,
    targetDevice: device,
    steps,
    report,
    confidence: report.confidence,
    tokenCost,
    durationMs: totalMs,
    skillChain: chain,
    memorySummary,
  };
}
