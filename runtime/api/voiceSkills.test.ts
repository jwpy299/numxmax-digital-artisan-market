/**
 * M20 波 1 语音技能路由层验收单测：
 * 1. 技能句识别 kind=skill（prompt 注入可见技能清单，封顶 12 条）。
 * 2. 闲聊不误判（清单注入下 LLM 返回 chat → 原样 chat）。
 * 3. 不可见 skillKey → 服务端二次校验降级 chat 人话说明，绝不执行。
 * 4. 执行成功 → reply 人话摘要 + attachment（/files/ 48hex 链接，文件真实落盘）。
 * 5. 执行失败 → 兜底道歉文案（ok=false，已记 failed）。
 * 6. 记账写入 st_skill_calls（skill_key/price/status 正确）。
 * 7. 熔断：当日计数 ≥ SKILL_DAILY_BUDGET → 不执行、不记账、TOO_MANY 风格回复。
 * 8. loadVisibleSkills：基础包 18（语音剔除 claw_browser_task 后 17）全员可见
 *    + 已雇佣 Agent 技能（agent_skill_ 前缀）。
 * 9. 文件投递 lazy 清理：24h 前文件被删除。
 * 10. prompt 注入分槽：基础包前 8 + 雇佣前 4（雇佣排前），agent_skill_* 不被挤占。
 * 11. skill 分支 ASR 置信度闸：< 0.6 不执行、不记账，回复与 action 分支同款口径。
 */
import { describe, expect, it, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { TRPCError } from "@trpc/server";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const chatMock = vi.fn();
const execGenericMock = vi.fn();

vi.mock("./routers/modelGateway", () => ({
  callSlotChat: (...args: unknown[]) => chatMock(...args),
  callSlotChatFast: vi.fn(async () => {
    throw new Error("fast lane disabled in tests");
  }),
  callModelChat: (...args: unknown[]) => chatMock(...args),
}));

vi.mock("./routers/skillExecutor", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./routers/skillExecutor")>();
  return { ...orig, executeGenericSkill: (...args: unknown[]) => execGenericMock(...args) };
});

vi.mock("./routers/wbSession", () => ({
  sessionMe: async (token: string) => {
    if (token !== "TEST_wb") throw new TRPCError({ code: "UNAUTHORIZED", message: "会话无效" });
    return { user: { username: "TEST_boss", role: "owner" }, factory: { id: 10 } };
  },
}));

vi.mock("./routers/voiceBuddy", () => ({
  buildOrgBrief: async () => ({
    todayIntents: 0,
    pendingConfirms: 0,
    executedTotal: 0,
    deptCount: 0,
    roleCount: 0,
    frozen: false,
  }),
}));

vi.mock("./routers/gate", () => ({
  submitIntent: vi.fn(async () => ({ status: "executed", intentId: 1 })),
}));

// ─── 状态ful 假 DB ───────────────────────────────────────────────────────────

interface VoiceSessionRow {
  id: number;
  factoryId: number;
  user: string;
  persona: string;
  pendingAction: string | null;
  lastActivityAt: string;
  status: string;
}

let voiceSessions: VoiceSessionRow[];
let skillCallInserts: Array<Record<string, unknown>>;
let skillCallCountToday: number;

const TEST_PROTOCOLS = [{ code: "sandbox_dispatch", name: "沙箱训练派单", level: "B" }];

const ST_SKILL_ROWS = [
  {
    skill_key: "weekly_report",
    name: "周报生成",
    description: "汇总一周工作生成结构化周报",
    category: "办公",
    slot: "chat",
    trigger_hints: '["周报"]',
    flow_steps: '["收集素材","成稿"]',
    output_template: "【周报】{内容}",
    quality_checklist: '["结构完整"]',
  },
];

const HIRED_SKILL_ROWS = [
  { id: 77, name: "振动频谱分析", description: "分析设备振动频谱判断故障", pricePerCall: 300 },
];

/** M38：evo 提案批准落生的技能行（layer='evo' 段查询专用返回） */
const EVO_SKILL_ROWS = [
  { skill_key: "shift_handover_note", name: "交接班纪要", description: "生成交接班纪要文书" },
];

/** M43：进化按厂开关测试旗标（beforeEach 归位 false） */
let evoOptOutFlag = false;

function resetTables() {
  voiceSessions = [
    {
      id: 1,
      factoryId: 10,
      user: "TEST_boss",
      persona: "lingshu",
      pendingAction: null,
      lastActivityAt: new Date().toISOString(),
      status: "active",
    },
  ];
  skillCallInserts = [];
  skillCallCountToday = 0;
}

function route(text: string, params: unknown[]): unknown {
  if (text.includes("FROM st_voice_sessions") && text.includes("SELECT")) {
    const id = Number(params[0]);
    const s = voiceSessions.find((x) => x.id === id);
    return [s ? [{ ...s }] : []];
  }
  if (text.includes("UPDATE st_voice_sessions")) {
    const id = Number(params[params.length - 1]);
    const s = voiceSessions.find((x) => x.id === id);
    if (!s) return [{ affectedRows: 0 }];
    if (text.includes("last_activity_at")) s.lastActivityAt = new Date().toISOString();
    return [{ affectedRows: 1 }];
  }
  if (text.includes("INSERT INTO st_voice_utterances")) return [[]];
  if (text.includes("FROM st_protocols")) return [TEST_PROTOCOLS.map((p) => ({ ...p }))];
  // M43：进化按厂开关（默认 0 接收；测试可翻转）
  if (text.includes("FROM wb_factories")) return [[{ v: evoOptOutFlag ? 1 : 0 }]];
  if (text.includes("FROM st_skills") && text.includes("layer = 'evo'")) return [EVO_SKILL_ROWS.map((r) => ({ ...r }))];
  if (text.includes("FROM st_skills")) return [ST_SKILL_ROWS.map((r) => ({ ...r }))];
  if (text.includes("FROM skills s") && text.includes("agent_hire_records")) {
    return [HIRED_SKILL_ROWS.map((r) => ({ ...r }))];
  }
  if (text.includes("FROM st_skill_calls") && text.includes("COUNT")) {
    return [[{ c: skillCallCountToday }]];
  }
  if (text.includes("INSERT INTO st_skill_calls")) {
    const [factoryId, sessionId, user, skillKey, skillName, price, status, note] = params as [
      number, number, string, string, string, number, string, string,
    ];
    skillCallInserts.push({ factoryId, sessionId, user, skillKey, skillName, price, status, note });
    return [[]];
  }
  return [[]];
}

vi.mock("./queries/connection", async () => {
  const { MySqlDialect } = await import("drizzle-orm/mysql-core");
  const dialect = new MySqlDialect();
  return {
    getDb: () => ({
      execute: async (stmt: unknown) => {
        const q = dialect.sqlToQuery(stmt as never);
        return route(q.sql, q.params);
      },
    }),
  };
});

import { parseUtterance, voiceRouter } from "./routers/voice";
import { loadVisibleSkills, deliverArtifactFile } from "./routers/voiceSkills";
import { SKILL_EXECUTOR_MAP } from "./routers/skillExecutor";

const caller = voiceRouter.createCaller({} as never);

let artifactDir: string;
let filesDir: string;

beforeAll(async () => {
  artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "m20-artifacts-"));
  filesDir = await fs.mkdtemp(path.join(os.tmpdir(), "m20-files-"));
  process.env.ST_ARTIFACT_DIR = artifactDir;
  process.env.VOICE_FILES_DIR = filesDir;
});

afterAll(async () => {
  delete process.env.ST_ARTIFACT_DIR;
  delete process.env.VOICE_FILES_DIR;
  await fs.rm(artifactDir, { recursive: true, force: true });
  await fs.rm(filesDir, { recursive: true, force: true });
});

beforeEach(() => {
  chatMock.mockReset();
  execGenericMock.mockReset();
  resetTables();
  evoOptOutFlag = false;
});

// ─── ① 技能可见集 ────────────────────────────────────────────────────────────

describe("loadVisibleSkills（技能可见集）", () => {
  it("基础包 18 个执行器技能（语音剔除 claw_browser_task 后 17）+ 已雇佣 Agent 技能带 agent_skill_ 前缀与定价", async () => {
    const visible = await loadVisibleSkills(10);
    const keys = visible.map((s) => s.skillKey);
    expect(keys).toContain("weekly_report");
    expect(keys).toContain("doc_write");
    expect(keys).toContain("tax_notice");
    // 语音可见集剔除 claw_browser_task：浏览器任务虽只读但资源开销大，不适合语音免确认触发
    expect(keys).not.toContain("claw_browser_task");
    // 语音基础包数量 = SKILL_EXECUTOR_MAP 全量 key（18）- 剔除的 claw_browser_task（1）
    // + M38 evo 段（layer='evo' 的落生技能，本夹具 1 条）
    const baseCount = visible.filter((s) => !s.skillKey.startsWith("agent_skill_")).length;
    expect(baseCount).toBe(Object.keys(SKILL_EXECUTOR_MAP).length - 1 + EVO_SKILL_ROWS.length);
    // 雇佣技能：名字/描述/价格透传
    const hired = visible.find((s) => s.skillKey === "agent_skill_77");
    expect(hired?.name).toBe("振动频谱分析");
    expect(hired?.pricePerCall).toBe(300);
    // 周报名字取自 st_skills
    expect(visible.find((s) => s.skillKey === "weekly_report")?.name).toBe("周报生成");
  });

  it("M38 自进化段：layer='evo' 技能入可见集且不与基础包重复计数", async () => {
    const visible = await loadVisibleSkills(10);
    // evo 落生技能可见（批准即上架）
    const evo = visible.find((s) => s.skillKey === "shift_handover_note");
    expect(evo?.name).toBe("交接班纪要");
    // 基础包计数不受 evo 段影响（weekly_report 已在基础包，evo 段去重）
    const baseCount = visible.filter((s) => !s.skillKey.startsWith("agent_skill_")).length;
    expect(baseCount).toBe(Object.keys(SKILL_EXECUTOR_MAP).length - 1 + EVO_SKILL_ROWS.length);
  });

  it("M43 进化按厂开关：evo_opt_out=1 时进化段整体消失，基础包不受影响", async () => {
    evoOptOutFlag = true;
    const visible = await loadVisibleSkills(10);
    expect(visible.find((s) => s.skillKey === "shift_handover_note")).toBeUndefined();
    expect(visible.map((s) => s.skillKey)).toContain("weekly_report"); // 基础包不动
  });
});

// ─── ② parseUtterance 扩展 ──────────────────────────────────────────────────

describe("parseUtterance 技能识别", () => {
  const visible = [
    { skillKey: "weekly_report", name: "周报生成", description: "汇总一周工作生成结构化周报", pricePerCall: 100 },
  ];

  it("技能句 → kind=skill + skillKey，system prompt 注入技能清单（名字+描述）", async () => {
    chatMock.mockResolvedValue({
      ok: true,
      content: '{"kind":"skill","skillKey":"weekly_report","reply":"好，我来写周报"}',
    });
    const r = await parseUtterance("lingshu", "帮我写一份本周周报", [], "【实况】", visible);
    expect(r.kind).toBe("skill");
    expect(r.skillKey).toBe("weekly_report");
    const sys = String(chatMock.mock.calls[0][1].messages[0].content);
    expect(sys).toContain("可办技能清单");
    expect(sys).toContain("weekly_report（周报生成）");
    expect(sys).toContain('"skill"');
  });

  it("技能清单分槽封顶：纯基础包只取前 8 条（防 prompt 膨胀）", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      skillKey: `sk_${i}`,
      name: `技能${i}`,
      description: `描述${i}`,
      pricePerCall: 100,
    }));
    chatMock.mockResolvedValue({ ok: true, content: '{"kind":"chat","reply":"好"}' });
    await parseUtterance("lingshu", "你好", [], "", many);
    const sys = String(chatMock.mock.calls[0][1].messages[0].content);
    expect(sys).toContain("sk_7");
    expect(sys).not.toContain("sk_8");
  });

  it("分槽注入：18 条基础包在前也不挤占，雇佣技能（agent_skill_*）出现在注入清单且排前", async () => {
    const base = Array.from({ length: 18 }, (_, i) => ({
      skillKey: `base_${i}`,
      name: `基础${i}`,
      description: `基础描述${i}`,
      pricePerCall: 100,
    }));
    const hired = Array.from({ length: 6 }, (_, i) => ({
      skillKey: `agent_skill_${100 + i}`,
      name: `雇佣${i}`,
      description: `雇佣描述${i}`,
      pricePerCall: 300,
    }));
    chatMock.mockResolvedValue({ ok: true, content: '{"kind":"chat","reply":"好"}' });
    await parseUtterance("lingshu", "你好", [], "", [...base, ...hired]);
    const sys = String(chatMock.mock.calls[0][1].messages[0].content);
    // 雇佣技能可达：前 4 条注入，且排在基础包之前（雇佣优先排前）
    for (const k of ["agent_skill_100", "agent_skill_101", "agent_skill_102", "agent_skill_103"]) {
      expect(sys).toContain(k);
    }
    expect(sys).not.toContain("agent_skill_104"); // 雇佣槽只取前 4
    expect(sys.indexOf("agent_skill_100")).toBeLessThan(sys.indexOf("base_0"));
    // 基础槽前 8 + 雇佣槽前 4 = 12 条封顶
    expect(sys).toContain("base_7");
    expect(sys).not.toContain("base_8");
    const lineCount = sys.split("\n").filter((l) => l.startsWith("- ")).length;
    expect(lineCount).toBe(12);
  });

  it("闲聊不误判：清单注入下 LLM 返回 chat → 原样 chat，无 skillKey", async () => {
    chatMock.mockResolvedValue({ ok: true, content: '{"kind":"chat","reply":"今天军团在线。"}' });
    const r = await parseUtterance("xingyun", "今天怎么样", [], "【实况】", visible);
    expect(r.kind).toBe("chat");
    expect(r.skillKey).toBeUndefined();
  });
});

// ─── ③ 技能路由（utterance 全链路 mock）──────────────────────────────────────

describe("utterance 技能路由", () => {
  it("不可见 skillKey → 降级 chat 人话说明，绝不执行、不记账", async () => {
    chatMock.mockResolvedValue({
      ok: true,
      content: '{"kind":"skill","skillKey":"nuclear_launch","reply":"好"}',
    });
    const r = await caller.utterance({ token: "TEST_wb", sessionId: 1, text: "帮我发射个啥" });
    expect(r.kind).toBe("chat");
    expect(r.reply).toContain("没有对应的技能");
    expect(execGenericMock).not.toHaveBeenCalled();
    expect(skillCallInserts).toHaveLength(0);
  });

  it("执行成功 → kind=skill + 人话摘要 + /files/ 48hex 附件链接（文件真实落盘）+ 记账 ok", async () => {
    await fs.writeFile(path.join(artifactDir, "weekly.docx"), Buffer.from("fake-docx"));
    execGenericMock.mockResolvedValue({
      text: "本周完成三件大事：……",
      artifact: { id: 1, kind: "docx", title: "本周周报", filename: "weekly.docx", sizeBytes: 9 },
      degraded: false,
    });
    chatMock.mockResolvedValue({
      ok: true,
      content: '{"kind":"skill","skillKey":"weekly_report","reply":"好，我来写"}',
    });
    const r = await caller.utterance({ token: "TEST_wb", sessionId: 1, text: "帮我写一份本周周报" });
    expect(r.kind).toBe("skill");
    expect((r as { ok?: boolean }).ok).toBe(true);
    expect(r.reply).toContain("「周报生成」已办好");
    const att = (r as { attachment?: { kind: string; url?: string; preview: string } }).attachment;
    expect(att?.kind).toBe("file");
    expect(att?.url).toMatch(/^\/files\/[0-9a-f]{48}\.docx$/);
    expect(att?.preview).toBe("本周周报");
    // 文件真实落盘可下载
    const delivered = await fs.readFile(path.join(filesDir, path.basename(att!.url!)));
    expect(delivered.toString()).toBe("fake-docx");
    // 记账：skill_key/price/status
    expect(skillCallInserts).toHaveLength(1);
    expect(skillCallInserts[0]).toMatchObject({ skillKey: "weekly_report", skillName: "周报生成", price: 100, status: "ok" });
    // 执行器收到的 skill 五件套来自 st_skills
    expect(execGenericMock).toHaveBeenCalledTimes(1);
    const callArg = execGenericMock.mock.calls[0][0] as { skill: { skillKey: string; outputTemplate: string } };
    expect(callArg.skill.skillKey).toBe("weekly_report");
    expect(callArg.skill.outputTemplate).toBe("【周报】{内容}");
  });

  it("执行失败 → 兜底道歉文案 ok=false，记 failed", async () => {
    execGenericMock.mockRejectedValue(new Error("boom"));
    chatMock.mockResolvedValue({
      ok: true,
      content: '{"kind":"skill","skillKey":"weekly_report","reply":"好"}',
    });
    const r = await caller.utterance({ token: "TEST_wb", sessionId: 1, text: "写周报" });
    expect(r.kind).toBe("skill");
    expect((r as { ok?: boolean }).ok).toBe(false);
    expect(r.reply).toContain("没办成");
    expect(skillCallInserts).toHaveLength(1);
    expect(skillCallInserts[0]).toMatchObject({ skillKey: "weekly_report", status: "failed" });
  });

  it("ASR 置信度闸：asrConfidence < 0.6 的 skill 指令 → reject 没听清口径，不执行、不记账", async () => {
    execGenericMock.mockResolvedValue({ text: "不应被执行", degraded: false });
    chatMock.mockResolvedValue({
      ok: true,
      content: '{"kind":"skill","skillKey":"weekly_report","reply":"好"}',
    });
    const r = await caller.utterance({ token: "TEST_wb", sessionId: 1, text: "写周报", asrConfidence: 0.4 });
    expect(r.kind).toBe("reject");
    expect(r.reply).toContain("没听清");
    expect(r.reply).toContain("绝不猜测执行");
    expect(execGenericMock).not.toHaveBeenCalled();
    expect(skillCallInserts).toHaveLength(0);
  });

  it("熔断：当日计数 ≥ SKILL_DAILY_BUDGET → 不执行、不记账、额度回复", async () => {
    skillCallCountToday = 500; // 默认预算 500
    chatMock.mockResolvedValue({
      ok: true,
      content: '{"kind":"skill","skillKey":"weekly_report","reply":"好"}',
    });
    const r = await caller.utterance({ token: "TEST_wb", sessionId: 1, text: "写周报" });
    expect(r.kind).toBe("reject");
    expect(r.reply).toContain("今日技能额度已用完");
    expect(execGenericMock).not.toHaveBeenCalled();
    expect(skillCallInserts).toHaveLength(0);
  });
});

// ─── ⑤ 文件投递 lazy 清理 ────────────────────────────────────────────────────

describe("文件投递", () => {
  it("lazy 清理：写入时删除 24h 前的投递文件，新文件 48hex 不可枚举命名", async () => {
    const oldName = `${"a".repeat(48)}.docx`;
    const oldPath = path.join(filesDir, oldName);
    await fs.writeFile(oldPath, "old");
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await fs.utimes(oldPath, old, old);
    await fs.writeFile(path.join(artifactDir, "new.docx"), "new-content");
    const url = await deliverArtifactFile({ id: 2, kind: "docx", title: "新文档", filename: "new.docx", sizeBytes: 11 });
    expect(url).toMatch(/^\/files\/[0-9a-f]{48}\.docx$/);
    expect(url).not.toBe(`/files/${oldName}`);
    await expect(fs.access(oldPath)).rejects.toThrow(); // 旧文件已清理
    await expect(fs.access(path.join(filesDir, path.basename(url!)))).resolves.toBeUndefined();
  });
});
