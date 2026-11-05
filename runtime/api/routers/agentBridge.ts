/**
 * agentBridge —— M28 灵枢数字人 ↔ 智能工作台驻部智能体桥。
 *
 * 定位：灵枢语音数字人在门户侧「点名派单」给工作台的驻部智能体（生产/法务/财务…），
 * 复用工作台同一条智能体管线（同代码包、同统一库、同模型网关槽位），产出物入同一台账。
 *
 * 设计决策（为什么是进程内桥而不是 HTTP 服务间调用）：
 * - 三端同一 boot.js、同一 MySQL（隧道同库），驻部智能体数据与技能执行器门户侧本就地可用；
 * - 零新增攻击面（不开服务间 token 端点）、零网络跳点（与提速目标一致）；
 * - 单一事实源：st_agents / st_skills / st_agent_artifacts 全部同表同口径。
 *
 * 安全红线（与 voice 路由一致）：
 * - agentCode 必须 ∈ 花名册（st_agents.status='active'），调用方二次校验，宁漏判不误判；
 * - ASR 置信度闸由 voice 路由层执行，本模块不再重复；
 * - 回复一律经 stripSecrets 过滤敏感串（由调用方执行）；
 * - 产出物 channel='voice'，actor=voice:<username>，与文本通道审计可区分。
 */
import { sql } from "drizzle-orm";
import {
  buildContextDigest,
  findAgentByCode,
  llmReplyOrDegraded,
  stQuery,
} from "./terminal";
import {
  buildMemoryBlock,
  buildSkillPromptBlock,
  executeSkillTool,
  getAgentMemories,
  matchDeptSkills,
  resolveSkillExecutor,
  type ArtifactInfo,
} from "./agentTools";
import { executeGenericSkill, isGenericExecutorKind, searchKbSnippets } from "./skillExecutor";
import { extractAndSaveMemories } from "./agentTools";
import type { LlmMessage } from "./modelGateway";
import { callDsh } from "./dshClient";

/** 语音派单花名册条目（注入解析 prompt 的最小信息） */
export interface VoiceAgentRosterEntry {
  code: string;
  name: string;
  title: string;
  deptCode: string;
}

/** 花名册上限：防 prompt 膨胀（与可见技能 12 条口径一致） */
const ROSTER_CAP = 12;

/**
 * 语音派单花名册：在役驻部智能体（status='active'），按部门序稳定输出。
 * 任何 DB 故障返回空数组——花名册为空时解析层自然不会有 agent 类输出（fail-safe）。
 */
export async function listVoiceAgentRoster(): Promise<VoiceAgentRosterEntry[]> {
  try {
    const rows = await stQuery(
      sql`SELECT code, name, title, deptCode FROM st_agents
          WHERE status = 'active' ORDER BY deptCode ASC, id ASC LIMIT ${ROSTER_CAP}`,
    );
    return rows.map((r) => ({
      code: String(r.code),
      name: String(r.name),
      title: String(r.title),
      deptCode: String(r.deptCode),
    }));
  } catch {
    return [];
  }
}

/** 花名册 prompt 块（名字+职务+部门，一行一个，封顶 ROSTER_CAP） */
export function buildAgentRosterBlock(roster: VoiceAgentRosterEntry[]): string {
  if (roster.length === 0) return "";
  const lines = roster.map((a) => `- ${a.code}：${a.name}（${a.title}，部门 ${a.deptCode}）`).join("\n");
  return `可点名的驻部智能体花名册（只有名册内的 code 才能派单）：\n${lines}\n`;
}

export interface AgentTaskResult {
  ok: boolean;
  agentCode: string;
  agentName: string;
  agentTitle: string;
  /** 播报口径回复（已约束 ≤80 字先说结论；工具路径为执行简报） */
  reply: string;
  artifacts: ArtifactInfo[];
  usedSkills: string[];
  degraded: boolean;
}

/**
 * runWorkbenchAgentTask —— 语音派单执行：
 * 管线与工作台 agentChatSend 同源：技能匹配注入 → 个体记忆 → 实时数据摘要 →
 * 命中可执行技能走工具管线（真文件产出）→ 否则 chat 槽 LLM（失败确定性降级）。
 * 差异点仅在：无线程落库（语音审计走 st_voice_utterances）、播报长度约束、channel='voice'。
 *
 * M44：runtime='dsh' 时任务交给 DSH 底座执行（人格注入 + 本厂 MCP 工具面 +
 * bwrap 沙箱多步工具循环）——智能体从此具备 DSH 的编排/沙箱/插件能力。
 * 语音热链默认 bridge（时延纪律）；工作台/DAG/深度任务可显式走 dsh。
 */
export async function runWorkbenchAgentTask(opts: {
  agentCode: string;
  task: string;
  username: string;
  /** M44：bridge（默认，进程内管线）/ dsh（DSH 底座执行） */
  runtime?: "bridge" | "dsh";
  /** dsh 轨必带：MCP 工具面按厂隔离的厂上下文 */
  factoryId?: number;
}): Promise<AgentTaskResult | null> {
  const agent = await findAgentByCode(opts.agentCode);
  if (!agent || agent.status !== "active") return null;

  // M44 DSH 轨：人格+纪律注入 → DSH 多步执行（工具面自动可见）→ 归一回 AgentTaskResult
  if (opts.runtime === "dsh") {
    const task = opts.task.trim().slice(0, 2000);
    if (!task) return null;
    // M55：知识库接地（所有部门工作统一调企业知识库）
    const kbBits = await searchKbSnippets(task).catch(() => []);
    // v2.9.11 养料回灌（彭总令：三师蒸馏全系统应用）——驻官答题时先调阅蒸馏库最近经验
    let lessonBits: string[] = [];
    try {
      const db = (await import("../queries/connection")).getDb();
      const rows = await db.execute(
        (await import("drizzle-orm")).sql`SELECT id, LEFT(solution,220) AS s FROM st_evolve_lessons WHERE topic NOT LIKE 'retired:%' ORDER BY id DESC LIMIT 2`,
      );
      const list = (rows as unknown as Array<Array<{ id: number; s: string }>>)[0] ?? [];
      lessonBits = list.map((r) => r.s);
      if (list.length) {
        void import("./evolvePost").then((m) => m.markLessonUsage(list.map((r) => r.id), "dept_agent")).catch(() => {});
      }
    } catch { /* 静默 */ }
    const kbBlock =
      kbBits.length > 0
        ? "\n【企业知识库接地（回答须优先依据以下条目，不得与其冲突）】\n" +
          kbBits.map((b) => `·《${b.title}》：${b.text}`).join("\n")
        : "";
    const lessonBlock =
      lessonBits.length > 0
        ? "\n【蒸馏养料（系统踩坑经验，优先参考）】\n" + lessonBits.map((b) => `· ${b}`).join("\n")
        : "";
    const personaPrompt =
      `你现在是「${agent.name}」（${agent.title}，${agent.deptCode} 部门驻部数字员工）。` + kbBlock + lessonBlock +
      `纪律：先说结论再给依据；可调用你可用的设备/技能工具（read_*/run_*）取真实数据，绝不编造数字；` +
      `你没有 C 级控制权限，遇到要控制设备/动钱的请求就明说「这要走闸口双签」。\n` +
      `任务：${task}`;
    // M79：部门适配首选模型随任务下行（DSH 工位独立 HOME 换模型，无配置走默认 kimi-k3）
    const { deptPrimaryModelOf } = await import("./deptConsole");
    const deptModel = await deptPrimaryModelOf(agent.deptCode);
    const r = await callDsh(personaPrompt, 300, opts.factoryId, deptModel ?? undefined);
    if (!r.ok) {
      // 确定性降级：DSH 不可用 → 明说不猜（不落 bridge 防双轨语义漂移）
      return {
        ok: false,
        agentCode: agent.code,
        agentName: agent.name,
        agentTitle: agent.title,
        reply: `${agent.name}的深度引擎此刻不可用（${r.error ?? "未知"}），请重试或改走快速通道。`,
        artifacts: [],
        usedSkills: [],
        degraded: true,
      };
    }
    return {
      ok: true,
      agentCode: agent.code,
      agentName: agent.name,
      agentTitle: agent.title,
      reply: String(r.answer ?? "").slice(0, 4000),
      artifacts: [],
      usedSkills: ["dsh-runtime"],
      degraded: false,
    };
  }

  const actor = `voice:${opts.username}`;
  const task = opts.task.trim().slice(0, 2000);
  if (!task) return null;

  // 1) 技能匹配（与工作台同款：trigger_hints 命中 → 五件套注入）
  const matchedSkills = await matchDeptSkills(task, agent.code);
  const skillBlock = buildSkillPromptBlock(matchedSkills);
  // 2) 个体记忆（读路径注入 ≤5 条；失败静默由 agentTools 内部兜底）
  const memories = await getAgentMemories(agent.code, actor);
  const memoryBlock = buildMemoryBlock(memories);
  // 3) 实时数据摘要（与工作台同源同口径）
  const digest = await buildContextDigest();

  // 4) 命中可执行技能 → 工具管线（docx/xlsx/pptx/数据/联网调研真产出）
  const toolSkill = matchedSkills.find((s) => resolveSkillExecutor(s.skillKey)) ?? null;
  if (toolSkill) {
    const ctx = { agentCode: agent.code, threadId: null, actor, channel: "voice" as const };
    const kind = resolveSkillExecutor(toolSkill.skillKey);
    let toolRun: { artifacts: ArtifactInfo[]; brief: string; degraded?: boolean } | null = null;
    if (kind && !isGenericExecutorKind(kind)) {
      toolRun = await executeSkillTool(toolSkill, task, ctx);
    } else if (kind) {
      const g = await executeGenericSkill({
        skill: toolSkill,
        content: task,
        agentName: agent.name,
        agentCode: agent.code,
        ctx,
      });
      toolRun = { artifacts: g.artifact ? [g.artifact] : [], brief: g.text, degraded: g.degraded ?? false };
    }
    if (toolRun) {
      const reply = toolRun.brief;
      void extractAndSaveMemories(agent.code, actor, task, reply);
      return {
        ok: true,
        agentCode: agent.code,
        agentName: agent.name,
        agentTitle: agent.title,
        reply,
        artifacts: toolRun.artifacts,
        usedSkills: matchedSkills.map((s) => s.name),
        degraded: toolRun.degraded === true,
      };
    }
  }

  // 5) chat 槽 LLM（播报约束：≤80 字先说结论；失败 → 确定性降级文本）
  // M55：知识库接地（所有部门工作统一调企业知识库）
  const kbBitsPlain = await searchKbSnippets(task).catch(() => []);
  const kbBlockPlain =
    kbBitsPlain.length > 0
      ? "\n【企业知识库接地（回答须优先依据以下条目，不得与其冲突）】\n" +
        kbBitsPlain.map((b) => `·《${b.title}》：${b.text}`).join("\n")
      : "";
  const messages: LlmMessage[] = [
    {
      role: "system",
      content:
        `${agent.systemPrompt}\n\n【两系统实时数据摘要】\n${digest}${skillBlock}${memoryBlock}${kbBlockPlain}\n` +
        `【播报约束】本次回答经语音播报：口语化、不超过 80 字、先说结论；不喊口号、不堆形容词。`,
    },
    { role: "user", content: task },
  ];
  const degradedText =
    `${agent.name}（${agent.title}）暂时线路繁忙，基于规则给出参考：` +
    `就「${task.slice(0, 40)}」一事，建议先明确目标与责任边界，再拆为本周可执行的三步动作；` +
    `需要文件类产出时，请在工作台直接对话该智能体补齐细节。`;
  // M79：部门适配首选模型（彭总 2026-08-24 指派令）——有配置即用部门首选，缺席走槽位默认
  const { deptPrimaryModelOf } = await import("./deptConsole");
  const deptModel = await deptPrimaryModelOf(agent.deptCode);
  const reply = await llmReplyOrDegraded(messages, degradedText, 400, 45_000, "chat", deptModel ?? undefined);

  void extractAndSaveMemories(agent.code, actor, task, reply.content);
  return {
    ok: true,
    agentCode: agent.code,
    agentName: agent.name,
    agentTitle: agent.title,
    reply: reply.content,
    artifacts: [],
    usedSkills: matchedSkills.map((s) => s.name),
    degraded: reply.degraded,
  };
}
