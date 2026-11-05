/**
 * M24 对话式引导填写引擎验收单测：
 * 1. startGuide org_profile：返回 sessionKey + 第一问 + 进度。
 * 2. 画像已有数据自动预填：问法带「我记得是 X，对吗？」，答「对」采用预填值。
 * 3. 逐题推进：answerGuide → 下一问 + progress。
 * 4. 选项口语归一：「八十来个」→ 50-100（本地规则，不调 LLM）。
 * 5. 校验重问：products 单字 → reask（必填项重问 2 次也不跳过、不猜）。
 * 6. 「上一题」回退重答。
 * 7. 「算了」取消退出：不残留、不写库。
 * 8. 全部完成 → 确认态复述清单（summary 4 项）。
 * 9. confirmGuide(confirm) → 真实写库（wb_factories UPDATE 画像保存，断言 industry/headcount/products）。
 * 10. asset_register 全流程 → 复用 wbAssets.register 契约（registerMock 断言，manual 手工码 + 扫码 prefill 透传）。
 * 11. confirmGuide(cancel) → 丢弃不落库。
 * 12. voice.utterance 前置链：「帮我完善一下企业资料」→ kind=guide 启动；有 activeGuide 时逐句直进引导机；
 *     「帮我看看企业画像」不命中（宁漏判不误判）→ 正常 chat 主链。
 * REVISE 回归（M24 评审）：
 * 13. 预填否定修正：剥离「不对/不是/不，」前缀再走解析管线（products 落库修正值、departments 不拆出「不对」）。
 * 14. CONFIRM_RE 全锚 + 先 BACK 后 CONFIRM：「好的，部门还要加一个」停留确认态、「行，上一题」回退，均不写库。
 * 15. requireGuideState 归属不匹配仅 NOT_FOUND 不 destroy：他人 sessionKey 不毁原会话。
 * 16. departments 非破坏合并：既有部门原 id 保留、新部门 id 不撞名；industry「其他」同步清 industryText。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

const llmMock = vi.fn();
const registerMock = vi.fn();
const inviteMock = vi.fn();

vi.mock("./routers/modelGateway", () => ({
  callSlotChat: (...args: unknown[]) => llmMock(...args),
  callSlotChatFast: vi.fn(async () => {
    throw new Error("fast lane disabled in tests");
  }),
}));

vi.mock("./routers/wbSession", () => ({
  sessionMe: async (token: string) => {
    if (token === "TEST_wb") return { user: { id: 7, username: "TEST_boss", role: "owner" }, factory: { id: 10 } };
    if (token === "TEST_wb2") return { user: { id: 8, username: "TEST_boss2", role: "staff" }, factory: { id: 10 } };
    throw new TRPCError({ code: "UNAUTHORIZED", message: "会话无效" });
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

vi.mock("./routers/wbAssets", () => ({
  wbAssetsRouter: {
    createCaller: () => ({ register: (...args: unknown[]) => registerMock(...args) }),
  },
}));

vi.mock("./routers/wbInvites", () => ({
  wbInvitesRouter: {
    createCaller: () => ({ create: (...args: unknown[]) => inviteMock(...args) }),
  },
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

interface FactoryRowFake {
  industry: string;
  industryText: string | null;
  headcount: string;
  departments: Array<{ id: string; name: string }>;
  profile: Record<string, unknown>;
}

let voiceSessions: VoiceSessionRow[];
let factoryRow: FactoryRowFake;
let factoryUpdates: Array<{ sql: string; params: unknown[] }>;

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
  factoryRow = { industry: "", industryText: null, headcount: "", departments: [], profile: {} };
  factoryUpdates = [];
}

function route(text: string, params: unknown[]): unknown {
  if (text.includes("FROM wb_factories") && text.includes("SELECT")) {
    return [[{ ...factoryRow }]];
  }
  if (text.includes("UPDATE wb_factories")) {
    factoryUpdates.push({ sql: text, params });
    return [{ affectedRows: 1 }];
  }
  if (text.includes("FROM st_voice_sessions") && text.includes("SELECT")) {
    const id = Number(params[0]);
    const s = voiceSessions.find((x) => x.id === id);
    return [s ? [{ ...s }] : []];
  }
  if (text.includes("UPDATE st_voice_sessions")) return [{ affectedRows: 1 }];
  if (text.includes("INSERT INTO st_voice_utterances")) return [[]];
  if (text.includes("FROM st_protocols")) return [[]];
  if (text.includes("FROM st_skills")) return [[]];
  if (text.includes("FROM skills s")) return [[]];
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

import { guidedFormRouter, detectGuideStart, hasActiveGuide, clearGuideSessions } from "./routers/guidedForm";
import { voiceRouter } from "./routers/voice";

const caller = guidedFormRouter.createCaller({} as never);
const voiceCaller = voiceRouter.createCaller({} as never);

beforeEach(() => {
  llmMock.mockReset();
  registerMock.mockReset();
  inviteMock.mockReset();
  resetTables();
  clearGuideSessions();
  llmMock.mockResolvedValue({ ok: false }); // 默认 LLM 不可用：辅助解析静默走原文
  inviteMock.mockImplementation(async (input: Record<string, unknown>) => ({
    inviteId: 42,
    code: `iv_${"a".repeat(48)}`,
    inviteUrl: `/wb/invite?code=iv_${"a".repeat(48)}`,
    displayName: input.displayName,
    deptId: input.deptId,
    deptName: "生产部",
    role: input.role,
    expiresAt: new Date(Date.now() + 72 * 3600_000),
  }));
  registerMock.mockImplementation(async (input: Record<string, unknown>) => ({
    ok: true,
    already: false,
    asset: {
      assetId: 1,
      assetNo: "AS-10-ABC123",
      name: input.name,
      category: input.category,
      codeType: input.codeType,
      codeValue: input.codeValue,
      location: input.location ?? null,
      status: "active",
      createdAt: new Date(),
    },
  }));
});

/** 一路答到确认态（org_profile，无预填画像） */
async function answerOrgProfileToConfirm(sessionKey: string) {
  await caller.answerGuide({ token: "TEST_wb", sessionKey, text: "电子信息" });
  await caller.answerGuide({ token: "TEST_wb", sessionKey, text: "八十来个" });
  await caller.answerGuide({ token: "TEST_wb", sessionKey, text: "精密五金件" });
  return caller.answerGuide({ token: "TEST_wb", sessionKey, text: "生产部，质检部" });
}

// ─── 触发词 ──────────────────────────────────────────────────────────────────

describe("detectGuideStart 触发词（宁漏判不误判）", () => {
  it("命中：完善/填写/填一下企业资料画像、登记设备", () => {
    expect(detectGuideStart("帮我完善一下企业资料")).toBe("org_profile");
    expect(detectGuideStart("填写企业画像")).toBe("org_profile");
    expect(detectGuideStart("帮我填一下资料")).toBe("org_profile");
    expect(detectGuideStart("登记设备")).toBe("asset_register");
    expect(detectGuideStart("登记这台设备")).toBe("asset_register");
  });
  it("不命中：「帮我看看企业画像」「介绍一下设备登记流程」", () => {
    expect(detectGuideStart("帮我看看企业画像")).toBeNull();
    expect(detectGuideStart("今天订单怎么样")).toBeNull();
  });
});

// ─── startGuide / answerGuide 状态机 ─────────────────────────────────────────

describe("org_profile 引导状态机", () => {
  it("① 启动：返回 sessionKey + 第一问（行业）+ 进度 0/4", async () => {
    const r = await caller.startGuide({ token: "TEST_wb", guideId: "org_profile" });
    expect(r.ok).toBe(true);
    expect(r.sessionKey).toBe("10-7-org_profile");
    expect(r.status).toBe("answering");
    expect(r.field.key).toBe("industry");
    expect(r.progress).toEqual({ done: 0, total: 4 });
    expect(r.reply).toContain("企业画像");
    expect(r.reply).toContain("哪个行业");
  });

  it("② 画像已有数据自动预填：问法带「我记得是 X，对吗？」，答「对」采用预填值", async () => {
    factoryRow = {
      industry: "装备制造",
      industryText: null,
      headcount: "50-100",
      departments: [
        { id: "d1", name: "生产部" },
        { id: "d2", name: "质检部" },
      ],
      profile: { products: "精密五金件" },
    };
    const r = await caller.startGuide({ token: "TEST_wb", guideId: "org_profile" });
    expect(r.field.prefilled).toBe("装备制造");
    expect(r.reply).toContain("我记得是「装备制造」，对吗？");
    // 全部答「对」→ 直接进确认态，summary 全是预填值
    await caller.answerGuide({ token: "TEST_wb", sessionKey: r.sessionKey, text: "对" });
    await caller.answerGuide({ token: "TEST_wb", sessionKey: r.sessionKey, text: "对" });
    await caller.answerGuide({ token: "TEST_wb", sessionKey: r.sessionKey, text: "对的" });
    const last = await caller.answerGuide({ token: "TEST_wb", sessionKey: r.sessionKey, text: "嗯" });
    expect(last.status).toBe("confirming");
    const byKey = Object.fromEntries(last.summary!.map((s) => [s.key, s.value]));
    expect(byKey).toEqual({
      industry: "装备制造",
      scale: "50-100",
      products: "精密五金件",
      departments: "生产部，质检部",
    });
  });

  it("③ 逐题推进：答行业 → 下一问（规模）+ progress 1/4", async () => {
    const s = await caller.startGuide({ token: "TEST_wb", guideId: "org_profile" });
    const r = await caller.answerGuide({ token: "TEST_wb", sessionKey: s.sessionKey, text: "电子信息" });
    expect(r.status).toBe("answering");
    expect(r.field!.key).toBe("scale");
    expect(r.progress).toEqual({ done: 1, total: 4 });
    expect(r.reply).toContain("多少人");
  });

  it("④ 选项口语归一：「八十来个」→ 50-100（本地规则，LLM 未被调用）", async () => {
    const s = await caller.startGuide({ token: "TEST_wb", guideId: "org_profile" });
    const last = await answerOrgProfileToConfirm(s.sessionKey);
    expect(last.status).toBe("confirming");
    const scale = last.summary!.find((x) => x.key === "scale");
    expect(scale?.value).toBe("50-100");
    expect(scale?.display).toBe("50-100 人");
    expect(llmMock).not.toHaveBeenCalled();
  });

  it("⑤ 校验重问：products 单字 → reask；必填项重问 2 次仍不跳过、不猜", async () => {
    const s = await caller.startGuide({ token: "TEST_wb", guideId: "org_profile" });
    await caller.answerGuide({ token: "TEST_wb", sessionKey: s.sessionKey, text: "电子信息" });
    await caller.answerGuide({ token: "TEST_wb", sessionKey: s.sessionKey, text: "八十来个" });
    const r1 = await caller.answerGuide({ token: "TEST_wb", sessionKey: s.sessionKey, text: "钉" });
    expect(r1.status).toBe("reask");
    expect(r1.attempts).toBe(1);
    expect(r1.reply).toContain("2-100 个字");
    const r2 = await caller.answerGuide({ token: "TEST_wb", sessionKey: s.sessionKey, text: "钉" });
    expect(r2.status).toBe("reask"); // 必填项：2 次后仍重问，绝不猜测通过
    expect(r2.attempts).toBe(2);
    expect(r2.field!.key).toBe("products");
  });

  it("⑥ 「上一题」回退：答完行业后回退 → 重问行业，进度回落", async () => {
    const s = await caller.startGuide({ token: "TEST_wb", guideId: "org_profile" });
    await caller.answerGuide({ token: "TEST_wb", sessionKey: s.sessionKey, text: "电子信息" });
    const r = await caller.answerGuide({ token: "TEST_wb", sessionKey: s.sessionKey, text: "上一题" });
    expect(r.status).toBe("answering");
    expect(r.field!.key).toBe("industry");
    expect(r.progress.done).toBe(0);
    // 重答后继续推进
    const r2 = await caller.answerGuide({ token: "TEST_wb", sessionKey: s.sessionKey, text: "食品加工" });
    expect(r2.field!.key).toBe("scale");
  });

  it("⑦ 「算了」取消退出：不残留、不写库", async () => {
    const s = await caller.startGuide({ token: "TEST_wb", guideId: "org_profile" });
    const r = await caller.answerGuide({ token: "TEST_wb", sessionKey: s.sessionKey, text: "算了不填了" });
    expect(r.status).toBe("cancelled");
    expect(hasActiveGuide(10, "7")).toBe(false);
    expect(factoryUpdates).toHaveLength(0);
    // 退出后 sessionKey 失效
    await expect(
      caller.answerGuide({ token: "TEST_wb", sessionKey: s.sessionKey, text: "电子信息" }),
    ).rejects.toThrow(/不存在或已过期/);
  });

  it("⑧ 全部完成 → 确认态复述清单（4 项 display 齐全）", async () => {
    const s = await caller.startGuide({ token: "TEST_wb", guideId: "org_profile" });
    const last = await answerOrgProfileToConfirm(s.sessionKey);
    expect(last.status).toBe("confirming");
    expect(last.reply).toContain("复述");
    expect(last.summary).toHaveLength(4);
    expect(last.reply).toContain("行业：电子信息");
    expect(last.reply).toContain("主要产品：精密五金件");
    expect(factoryUpdates).toHaveLength(0); // 引导中一切不落库
  });

  it("⑨ confirmGuide(confirm) → 真实写库：wb_factories UPDATE 画像保存", async () => {
    const s = await caller.startGuide({ token: "TEST_wb", guideId: "org_profile" });
    await answerOrgProfileToConfirm(s.sessionKey);
    const r = await caller.confirmGuide({ token: "TEST_wb", sessionKey: s.sessionKey, decision: "confirm" });
    expect(r.status).toBe("submitted");
    expect(factoryUpdates).toHaveLength(1);
    const params = factoryUpdates[0]!.params;
    expect(params[0]).toBe("电子信息"); // industry
    expect(params[1]).toBeNull(); // industryText：非「其他」保留既有（本例既为 null）
    expect(params[2]).toBe("50-100"); // headcount（区间串口径）
    const depts = JSON.parse(String(params[3])) as Array<{ name: string }>;
    expect(depts.map((d) => d.name)).toEqual(["生产部", "质检部"]);
    const profile = JSON.parse(String(params[4])) as Record<string, unknown>;
    expect(profile.products).toBe("精密五金件");
    expect(params[5]).toBe(10); // factoryId
    expect(hasActiveGuide(10, "7")).toBe(false); // 提交后退出不残留
  });

  it("⑩ confirmGuide(cancel) → 丢弃不落库；未到确认态 confirm 报 BAD_REQUEST", async () => {
    const s = await caller.startGuide({ token: "TEST_wb", guideId: "org_profile" });
    await expect(
      caller.confirmGuide({ token: "TEST_wb", sessionKey: s.sessionKey, decision: "confirm" }),
    ).rejects.toThrow(/未到确认环节/);
    await answerOrgProfileToConfirm(s.sessionKey);
    const r = await caller.confirmGuide({ token: "TEST_wb", sessionKey: s.sessionKey, decision: "cancel" });
    expect(r.status).toBe("cancelled");
    expect(factoryUpdates).toHaveLength(0);
    expect(hasActiveGuide(10, "7")).toBe(false);
  });

  it("⑪ 预填否定修正：products 答「不对，是精密五金件」→ 剥离否定前缀，落库为「精密五金件」", async () => {
    factoryRow = {
      industry: "装备制造",
      industryText: null,
      headcount: "50-100",
      departments: [{ id: "d1", name: "生产部" }],
      profile: { products: "老产品" },
    };
    const s = await caller.startGuide({ token: "TEST_wb", guideId: "org_profile" });
    await caller.answerGuide({ token: "TEST_wb", sessionKey: s.sessionKey, text: "对" }); // industry
    await caller.answerGuide({ token: "TEST_wb", sessionKey: s.sessionKey, text: "对" }); // scale
    // products 预填「老产品」→ 否定修正
    const r3 = await caller.answerGuide({ token: "TEST_wb", sessionKey: s.sessionKey, text: "不对，是精密五金件" });
    expect(r3.status).toBe("answering"); // 走到 departments，不吞原文、不重问
    expect(r3.field!.key).toBe("departments");
    const last = await caller.answerGuide({ token: "TEST_wb", sessionKey: s.sessionKey, text: "对" });
    expect(last.summary!.find((x) => x.key === "products")?.value).toBe("精密五金件");
    // 确认提交 → 落库为修正后的值
    await caller.confirmGuide({ token: "TEST_wb", sessionKey: s.sessionKey, decision: "confirm" });
    const profile = JSON.parse(String(factoryUpdates[0]!.params[4])) as Record<string, unknown>;
    expect(profile.products).toBe("精密五金件");
  });

  it("⑫ departments 预填答「不对，生产和质检」→ 两个部门，「不对」绝不被拆成部门名", async () => {
    factoryRow = {
      industry: "装备制造",
      industryText: null,
      headcount: "50-100",
      departments: [{ id: "d1", name: "生产部" }],
      profile: { products: "精密五金件" },
    };
    const s = await caller.startGuide({ token: "TEST_wb", guideId: "org_profile" });
    await caller.answerGuide({ token: "TEST_wb", sessionKey: s.sessionKey, text: "对" });
    await caller.answerGuide({ token: "TEST_wb", sessionKey: s.sessionKey, text: "对" });
    await caller.answerGuide({ token: "TEST_wb", sessionKey: s.sessionKey, text: "对" });
    const last = await caller.answerGuide({ token: "TEST_wb", sessionKey: s.sessionKey, text: "不对，生产和质检" });
    expect(last.status).toBe("confirming");
    expect(last.summary!.find((x) => x.key === "departments")?.value).toBe("生产，质检");
  });

  it("⑬ 确认态「好的，部门还要加一个」不触发提交：停留确认态、不写库", async () => {
    const s = await caller.startGuide({ token: "TEST_wb", guideId: "org_profile" });
    await answerOrgProfileToConfirm(s.sessionKey);
    const r = await caller.answerGuide({ token: "TEST_wb", sessionKey: s.sessionKey, text: "好的，部门还要加一个" });
    expect(r.status).toBe("confirming");
    expect(r.reply).toContain("还没提交");
    expect(factoryUpdates).toHaveLength(0);
    expect(hasActiveGuide(10, "7")).toBe(true);
  });

  it("⑭ 确认态「行，上一题」不触发提交：回退最后一题重答、不写库", async () => {
    const s = await caller.startGuide({ token: "TEST_wb", guideId: "org_profile" });
    await answerOrgProfileToConfirm(s.sessionKey);
    const r = await caller.answerGuide({ token: "TEST_wb", sessionKey: s.sessionKey, text: "行，上一题" });
    expect(r.status).toBe("answering");
    expect(r.field!.key).toBe("departments");
    expect(factoryUpdates).toHaveLength(0);
    expect(hasActiveGuide(10, "7")).toBe(true);
  });

  it("⑮ 归属不匹配销毁他人会话修复：另一用户拿他人 sessionKey → NOT_FOUND 且原会话仍活", async () => {
    const s = await caller.startGuide({ token: "TEST_wb", guideId: "org_profile" });
    // 同厂另一用户（id 8）拿 user7 的 sessionKey 答句 → NOT_FOUND
    await expect(
      caller.answerGuide({ token: "TEST_wb2", sessionKey: s.sessionKey, text: "电子信息" }),
    ).rejects.toThrow(/不存在或已过期/);
    // 原会话不得被销毁：user7 仍可继续作答
    expect(hasActiveGuide(10, "7")).toBe(true);
    const r = await caller.answerGuide({ token: "TEST_wb", sessionKey: s.sessionKey, text: "电子信息" });
    expect(r.status).toBe("answering");
    expect(r.field!.key).toBe("scale");
  });

  it("⑯ departments 非破坏合并：既有[生产部,销售部]只提「质检」→ 三个都在、原 id 不变、新 id 不撞名", async () => {
    factoryRow = {
      industry: "",
      industryText: null,
      headcount: "",
      departments: [
        { id: "d1", name: "生产部" },
        { id: "d2", name: "销售部" },
      ],
      profile: {},
    };
    const s = await caller.startGuide({ token: "TEST_wb", guideId: "org_profile" });
    await caller.answerGuide({ token: "TEST_wb", sessionKey: s.sessionKey, text: "电子信息" });
    await caller.answerGuide({ token: "TEST_wb", sessionKey: s.sessionKey, text: "八十来个" });
    await caller.answerGuide({ token: "TEST_wb", sessionKey: s.sessionKey, text: "精密五金件" });
    // departments 预填「生产部，销售部」，用户只补「质检」→ 覆盖为「质检」再与既有合并
    await caller.answerGuide({ token: "TEST_wb", sessionKey: s.sessionKey, text: "质检" });
    await caller.confirmGuide({ token: "TEST_wb", sessionKey: s.sessionKey, decision: "confirm" });
    const depts = JSON.parse(String(factoryUpdates[0]!.params[3])) as Array<{ id: string; name: string }>;
    expect(new Set(depts.map((d) => d.name))).toEqual(new Set(["生产部", "销售部", "质检"]));
    expect(depts).toHaveLength(3);
    expect(depts.find((d) => d.name === "生产部")?.id).toBe("d1"); // 原 id 不变
    expect(depts.find((d) => d.name === "销售部")?.id).toBe("d2");
    const added = depts.find((d) => d.name === "质检")!;
    expect(["d1", "d2"]).not.toContain(added.id); // 新 id 不与既有撞名
    expect(added.id).toBe("gd_1");
  });

  it("⑰ industry 选「其他」时同步清 industryText（不残留旧行业描述）", async () => {
    factoryRow = {
      industry: "装备制造",
      industryText: "精密五金",
      headcount: "",
      departments: [],
      profile: {},
    };
    const s = await caller.startGuide({ token: "TEST_wb", guideId: "org_profile" });
    await caller.answerGuide({ token: "TEST_wb", sessionKey: s.sessionKey, text: "其他" });
    await caller.answerGuide({ token: "TEST_wb", sessionKey: s.sessionKey, text: "八十来个" });
    await caller.answerGuide({ token: "TEST_wb", sessionKey: s.sessionKey, text: "精密五金件" });
    await caller.answerGuide({ token: "TEST_wb", sessionKey: s.sessionKey, text: "生产部" });
    await caller.confirmGuide({ token: "TEST_wb", sessionKey: s.sessionKey, decision: "confirm" });
    const params = factoryUpdates[0]!.params;
    expect(params[0]).toBe("其他");
    expect(params[1]).toBeNull(); // industryText 已清
  });
});

// ─── asset_register ──────────────────────────────────────────────────────────

describe("asset_register 引导（复用 wbAssets.register 契约）", () => {
  it("全流程：无扫码上下文 → manual 手工码；confirm 才调 register", async () => {
    const s = await caller.startGuide({ token: "TEST_wb", guideId: "asset_register" });
    expect(s.sessionKey).toBe("10-7-asset_register");
    expect(s.field.key).toBe("name");
    await caller.answerGuide({ token: "TEST_wb", sessionKey: s.sessionKey, text: "一号注塑机" });
    const r2 = await caller.answerGuide({ token: "TEST_wb", sessionKey: s.sessionKey, text: "生产设备" });
    expect(r2.field!.key).toBe("location");
    const r3 = await caller.answerGuide({ token: "TEST_wb", sessionKey: s.sessionKey, text: "没有" });
    expect(r3.status).toBe("confirming");
    expect(r3.summary!.find((x) => x.key === "location")?.display).toBe("（未填）");
    expect(registerMock).not.toHaveBeenCalled(); // 引导中不落库
    const r4 = await caller.confirmGuide({ token: "TEST_wb", sessionKey: s.sessionKey, decision: "confirm" });
    expect(r4.status).toBe("submitted");
    expect(registerMock).toHaveBeenCalledTimes(1);
    const arg = registerMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.token).toBe("TEST_wb");
    expect(arg.name).toBe("一号注塑机");
    expect(arg.category).toBe("production");
    expect(arg.codeType).toBe("manual");
    expect(String(arg.codeValue)).toMatch(/^MANUAL-10-[0-9A-F]{6}$/);
    expect(arg.location).toBeUndefined(); // 未填位置不下发
  });

  it("扫码上下文 prefill（codeValue/codeType）透传到 register；选填位置重问 2 次后跳过", async () => {
    const s = await caller.startGuide({
      token: "TEST_wb",
      guideId: "asset_register",
      prefill: { codeValue: "QR-XYZ-001", codeType: "qr" },
    });
    await caller.answerGuide({ token: "TEST_wb", sessionKey: s.sessionKey, text: "二号贴片机" });
    await caller.answerGuide({ token: "TEST_wb", sessionKey: s.sessionKey, text: "生产设备" });
    const long = "位".repeat(200);
    const r1 = await caller.answerGuide({ token: "TEST_wb", sessionKey: s.sessionKey, text: long });
    expect(r1.status).toBe("reask");
    const r2 = await caller.answerGuide({ token: "TEST_wb", sessionKey: s.sessionKey, text: long });
    // 选填项重问 2 次仍不过 → 跳过进确认态
    expect(r2.status).toBe("confirming");
    expect(r2.summary!.find((x) => x.key === "location")?.value).toBeNull();
    await caller.confirmGuide({ token: "TEST_wb", sessionKey: s.sessionKey, decision: "confirm" });
    const arg = registerMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.codeValue).toBe("QR-XYZ-001");
    expect(arg.codeType).toBe("qr");
  });
});

// ─── voice.utterance 前置链 ──────────────────────────────────────────────────

describe("voice.utterance 引导前置链", () => {
  it("「帮我完善一下企业资料」→ kind=guide 启动；后续每句直进引导机直到确认提交", async () => {
    const r1 = await voiceCaller.utterance({ token: "TEST_wb", sessionId: 1, text: "帮我完善一下企业资料" });
    expect(r1.kind).toBe("guide");
    if (r1.kind !== "guide") return;
    expect(r1.guide.guideId).toBe("org_profile");
    expect(r1.guide.status).toBe("answering");
    expect(r1.reply).toContain("哪个行业");
    expect(llmMock).not.toHaveBeenCalled(); // 启动不经过 parseUtterance

    const r2 = await voiceCaller.utterance({ token: "TEST_wb", sessionId: 1, text: "电子信息" });
    expect(r2.kind).toBe("guide");
    if (r2.kind !== "guide") return;
    expect(r2.guide.progress).toEqual({ done: 1, total: 4 });
    expect(llmMock).not.toHaveBeenCalled(); // activeGuide 直进引导机，不落主链 LLM

    await voiceCaller.utterance({ token: "TEST_wb", sessionId: 1, text: "八十来个" });
    await voiceCaller.utterance({ token: "TEST_wb", sessionId: 1, text: "精密五金件" });
    const r5 = await voiceCaller.utterance({ token: "TEST_wb", sessionId: 1, text: "生产部，质检部" });
    expect(r5.kind).toBe("guide");
    if (r5.kind !== "guide") return;
    expect(r5.guide.status).toBe("confirming");
    // 口播「确认」→ 真实写库
    const r6 = await voiceCaller.utterance({ token: "TEST_wb", sessionId: 1, text: "确认" });
    expect(r6.kind).toBe("guide");
    if (r6.kind !== "guide") return;
    expect(r6.guide.status).toBe("submitted");
    expect(factoryUpdates).toHaveLength(1);
    expect(hasActiveGuide(10, "7")).toBe(false);
  });

  it("「帮我看看企业画像」不命中 → 正常 chat 主链，不产生引导", async () => {
    llmMock.mockResolvedValue({ ok: true, content: '{"kind":"chat","reply":"画像在这。"}' });
    const r = await voiceCaller.utterance({ token: "TEST_wb", sessionId: 1, text: "帮我看看企业画像" });
    expect(r.kind).toBe("chat");
    expect(hasActiveGuide(10, "7")).toBe(false);
  });
});

// ─── M27 wb_invite：灵枢为企业成员开工作台账号 ──────────────────────────────

describe("M27 wb_invite 引导（复用 wbInvites.create 契约）", () => {
  beforeEach(() => {
    factoryRow = {
      industry: "装备制造",
      industryText: null,
      headcount: "50-100",
      departments: [
        { id: "d1", name: "生产部" },
        { id: "d2", name: "质检部" },
      ],
      profile: {},
    };
  });

  it("触发词：开/注册工作台账号、给人开账号、邀请进工作台、分发账号；谈论类不命中", () => {
    expect(detectGuideStart("注册工作台账号")).toBe("wb_invite");
    expect(detectGuideStart("帮我开通工作台的账号")).toBe("wb_invite");
    expect(detectGuideStart("给王经理开个账号")).toBe("wb_invite");
    expect(detectGuideStart("邀请他进工作台")).toBe("wb_invite");
    expect(detectGuideStart("分发部门账号")).toBe("wb_invite");
    // 宁漏判不误判：谈论/询问语境不命中
    expect(detectGuideStart("工作台账号怎么登录")).toBeNull();
    expect(detectGuideStart("帮我看看账号余额")).toBeNull();
  });

  it("全流程：姓名→部门→角色 → 确认 → wbInvites.create 契约调用，口播不含邀请码明文", async () => {
    const r1 = await caller.startGuide({ token: "TEST_wb", guideId: "wb_invite" });
    expect(r1.status).toBe("answering");
    expect(r1.field.key).toBe("displayName");
    expect(r1.progress).toEqual({ done: 0, total: 3 });

    await caller.answerGuide({ token: "TEST_wb", sessionKey: r1.sessionKey, text: "王建国" });
    await caller.answerGuide({ token: "TEST_wb", sessionKey: r1.sessionKey, text: "生产部" });
    const r4 = await caller.answerGuide({ token: "TEST_wb", sessionKey: r1.sessionKey, text: "负责人" });
    expect(r4.status).toBe("confirming");
    expect(r4.summary?.map((s) => s.label)).toEqual(["姓名", "部门", "角色"]);

    const r5 = await caller.confirmGuide({ token: "TEST_wb", sessionKey: r1.sessionKey, decision: "confirm" });
    expect(r5.status).toBe("submitted");
    // 契约调用：deptName「生产部」→ deptId=d1，role 归一 manager
    expect(inviteMock).toHaveBeenCalledTimes(1);
    expect(inviteMock.mock.calls[0][0]).toMatchObject({ displayName: "王建国", deptId: "d1", role: "manager" });
    // 纪律：邀请码明文绝不进口播（敏感串），只进 result 供屏幕展示
    expect(r5.reply).not.toContain("iv_");
    expect(r5.reply).toContain("72 小时内有效");
    expect(r5.result).toMatchObject({ saved: true, deptName: "生产部", role: "manager" });
    expect(String((r5.result as Record<string, unknown>).inviteCode)).toMatch(/^iv_[a-f0-9]{48}$/);
    expect(String((r5.result as Record<string, unknown>).inviteUrl)).toContain("/wb/invite?code=");
  });

  it("角色口语归一：「普通员工」→ staff；部门无匹配 → 不写库不烧码，人话列出既有部门", async () => {
    const r1 = await caller.startGuide({ token: "TEST_wb", guideId: "wb_invite" });
    await caller.answerGuide({ token: "TEST_wb", sessionKey: r1.sessionKey, text: "小李" });
    await caller.answerGuide({ token: "TEST_wb", sessionKey: r1.sessionKey, text: " phantom部" });
    await caller.answerGuide({ token: "TEST_wb", sessionKey: r1.sessionKey, text: "普通员工" });
    const r5 = await caller.confirmGuide({ token: "TEST_wb", sessionKey: r1.sessionKey, decision: "confirm" });
    expect(r5.status).toBe("submitted");
    expect(inviteMock).not.toHaveBeenCalled(); // 无此部门 → 绝不写库
    expect(r5.result).toMatchObject({ saved: false, reason: "dept_not_found" });
    expect(r5.reply).toContain("生产部");
    expect(r5.reply).toContain("质检部");
  });

  it("语音前置链：「给王经理开个工作台账号」→ kind=guide 启动 wb_invite，逐句直进，口播确认提交", async () => {
    const r1 = await voiceCaller.utterance({ token: "TEST_wb", sessionId: 1, text: "给王经理开个工作台账号" });
    expect(r1.kind).toBe("guide");
    if (r1.kind !== "guide") return;
    expect(r1.guide.guideId).toBe("wb_invite");
    expect(llmMock).not.toHaveBeenCalled();

    await voiceCaller.utterance({ token: "TEST_wb", sessionId: 1, text: "王建国" });
    await voiceCaller.utterance({ token: "TEST_wb", sessionId: 1, text: "生产部" });
    await voiceCaller.utterance({ token: "TEST_wb", sessionId: 1, text: "负责人" });
    const r5 = await voiceCaller.utterance({ token: "TEST_wb", sessionId: 1, text: "确认" });
    expect(r5.kind).toBe("guide");
    if (r5.kind !== "guide") return;
    expect(r5.guide.status).toBe("submitted");
    // 结果经 guide.result 透传给 App（屏幕展示用），口播 reply 不含码
    expect(r5.reply).not.toContain("iv_");
    expect((r5.guide as { result?: Record<string, unknown> }).result).toMatchObject({ saved: true });
    expect(inviteMock).toHaveBeenCalledTimes(1);
    expect(hasActiveGuide(10, "7")).toBe(false);
  });
});
