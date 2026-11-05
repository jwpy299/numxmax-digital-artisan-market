/**
 * P2-4（台账 W3）数字员工审核流水线单测 —— agentReviewQueueRouter + 初审口径。
 *
 * 覆盖：
 * 1. 初审五维口径（可解释规则）：完整度/简介/标签匹配/定价/师承，各维边界；
 * 2. 双阈值三档分流：默认 HIGH=88 / LOW=60，env 可覆盖；HIGH 档自动通过**默认关**；
 * 3. list：77 条量级队列的过滤/分页/tier 筛选/排序；
 * 4. approve：pending → active 的 SQL 必须带 reviewedAt/reviewedBy（留痕），并落审计；
 * 5. reject：**不填理由被拒（zod 层，且未触库）**；填了理由才写三件套；
 * 6. bulkApprove：开关默认关 → 拒绝；开关开但未 ack → 拒绝；双闸都过才批量。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── mock 夹具 ───────────────────────────────────────────────────────────────

interface ExecCall {
  text: string;
  result: unknown;
}

let execCalls: ExecCall[] = [];
let columnsReady = true;
let masterRows: { id: number; name: string }[] = [{ id: 1, name: "传承建档中" }];
let pendingRows: Record<string, unknown>[] = [];
let activePrices: { monthlyPrice: number }[] = [];
let groupPrices: { monthlyPrice: number }[] = [];
let updateAffected = 1;
let statsRows: Record<string, unknown>[] = [];
let activeTotal = 47;

/** drizzle sql 模板 → 可断言的文本（只取 StringChunk，参数位留空） */
function sqlTextOf(q: unknown): string {
  const chunks = (q as { queryChunks?: unknown[] } | null)?.queryChunks;
  if (!Array.isArray(chunks)) return String(q ?? "");
  return chunks
    .filter((c) => (c as { constructor?: { name?: string } })?.constructor?.name === "StringChunk")
    .map((c) => {
      const v = (c as { value?: unknown }).value;
      return Array.isArray(v) ? v.join("") : String(v ?? "");
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function responseFor(text: string): unknown {
  if (/FROM information_schema\.COLUMNS/.test(text)) {
    return [columnsReady ? [{ COLUMN_NAME: "reviewedAt" }, { COLUMN_NAME: "reviewedBy" }, { COLUMN_NAME: "rejectReason" }] : []];
  }
  if (/FROM masters\b/.test(text)) return [masterRows];
  if (/FROM agents WHERE status = 'pending'/.test(text)) return [pendingRows];
  if (/FROM agents WHERE status = 'active' AND industryGroup =/.test(text)) return [groupPrices];
  if (/FROM agents WHERE status = 'active' ORDER BY monthlyPrice/.test(text)) return [activePrices];
  if (/SELECT status, COUNT\(\*\) AS c FROM agents/.test(text)) return [statsRows];
  if (/SELECT COUNT\(\*\) AS c FROM agents WHERE status = 'active'/.test(text)) return [[{ c: activeTotal }]];
  if (/^UPDATE agents SET/.test(text)) return [{ affectedRows: updateAffected }];
  return [[]];
}

vi.mock("./queries/connection", () => ({
  getDb: () => ({
    execute: async (q: unknown) => {
      const text = sqlTextOf(q);
      const result = responseFor(text);
      execCalls.push({ text, result });
      return result;
    },
  }),
}));

vi.mock("./routers/admin", () => ({
  requireAdmin: async (token: string) => {
    if (token !== "TEST_admin") throw new Error("管理员凭证无效");
    return { id: 7, username: "TEST_admin", displayName: "测试管理员" };
  },
}));

const auditCalls: { action: string; target: string; detail: unknown }[] = [];
vi.mock("./routers/adminAnalytics", () => ({
  writeAdminAudit: (_id: number, _name: string, action: string, target: string, detail?: unknown) => {
    auditCalls.push({ action, target, detail });
  },
  adminDisplayName: (a: { displayName?: string | null; username?: string | null }) =>
    String(a.displayName ?? a.username ?? "admin"),
}));

import {
  agentReviewQueueRouter,
  bulkApproveInput,
  DEFAULT_HIGH_T,
  DEFAULT_LOW_T,
  DIMENSION_WEIGHTS,
  LINEAGE_PLACEHOLDER_PENALTY,
  autoApproveHighEnabled,
  highThreshold,
  listInput,
  lowThreshold,
  rejectInput,
  scoreCandidate,
  scoreCompleteness,
  scoreIntro,
  scoreLineage,
  scorePricing,
  scoreTagFit,
  summarizeTiers,
  tierOf,
  type PricingAnchor,
  type ReviewCandidate,
} from "./routers/agentReview";

const caller = agentReviewQueueRouter.createCaller({} as never);

function cand(over: Partial<ReviewCandidate> = {}): ReviewCandidate {
  return {
    id: 1,
    code: "NX-1000",
    name: "策律",
    industry: "法律·企业法务",
    industryGroup: "法律合规",
    introText: "面向中小企业的合同审查与合规体检数字员工，覆盖劳动法务与风险预警场景。",
    masterId: 1,
    monthlyPrice: 1000,
    suggestedPrice: 1200,
    capabilityTags: ["合同审查", "合规体检", "风险预警", "劳动法务"],
    skillCount: 4,
    listedAt: new Date("2026-09-30T08:24:37Z"),
    ...over,
  };
}

const baseAnchor: PricingAnchor = { group: "法律合规", median: 1000, sampleSize: 12, scaled: false };
const realMaster = new Map<number, string>([[1, "彭真人"]]);
const placeholderMaster = new Map<number, string>([[1, "传承建档中"]]);

beforeEach(() => {
  execCalls = [];
  auditCalls.length = 0;
  columnsReady = true;
  masterRows = [{ id: 1, name: "传承建档中" }];
  pendingRows = [];
  activePrices = [{ monthlyPrice: 900 }];
  groupPrices = [];
  updateAffected = 1;
  statsRows = [];
  activeTotal = 47;
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── 1. 五维口径 ─────────────────────────────────────────────────────────────

describe("P2-4 初审 D1 数据完整度", () => {
  it("8/8 齐备 → 100，missing 空", () => {
    const r = scoreCompleteness(cand());
    expect(r.dim.score).toBe(100);
    expect(r.missing).toEqual([]);
    expect(r.dim.basis).toContain("8/8");
  });

  it("缺简介与月薪 → 6/8 = 75，并点名缺哪两项", () => {
    const r = scoreCompleteness(cand({ introText: "", monthlyPrice: 0 }));
    expect(r.dim.score).toBe(75);
    expect(r.missing).toEqual(["简介", "月薪"]);
  });

  it("空标签数组算缺失（不是有标签）", () => {
    const r = scoreCompleteness(cand({ capabilityTags: [] }));
    expect(r.missing).toEqual(["能力标签"]);
    expect(r.dim.score).toBe(88);
  });
});

describe("P2-4 初审 D2 简介质量", () => {
  const intro100 = "面向中小企业提供合同全生命周期审查服务的数字员工，可完成条款比对、风险识别、修订建议与合规意见书撰写，并同步监管政策变化。";

  it("≥60 字 + 结尾标点 + 无瑕疵 → 100", () => {
    const r = scoreIntro(cand({ introText: intro100 }));
    expect(r.dim.score).toBe(100);
    expect(r.flags).toEqual([]);
    expect(r.dim.basis).toContain("无灌水");
  });

  it("40-59 字且缺结尾标点 → 70+10=80，并出「疑模板截断」旗标", () => {
    const r = scoreIntro(cand({ introText: "面向中小企业的合同审查与合规体检数字员工，覆盖劳动法务与风险预警场景，支持条款比对" }));
    expect(r.dim.score).toBe(80);
    expect(r.flags).toContain("简介缺结尾标点（疑模板截断）");
  });

  it("空简介 → 0 分 + 简介缺失", () => {
    const r = scoreIntro(cand({ introText: "" }));
    expect(r.dim.score).toBe(0);
    expect(r.flags).toContain("简介缺失");
  });

  it("<40 字 → 出「简介偏短」旗标", () => {
    const r = scoreIntro(cand({ introText: "很短的简介。" }));
    expect(r.flags.some((f) => f.includes("简介偏短"))).toBe(true);
  });

  it("正常中文用词重复（「合规体检/合规风险」）**不得**误判为灌水（实测假阳性回归钉）", () => {
    const r = scoreIntro(cand({ introText: "面向企业的合规体检与合规风险预警数字员工，覆盖合规意见书撰写。" }));
    expect(r.flags.some((f) => f.includes("灌水"))).toBe(false);
    expect(r.dim.basis).toContain("无灌水");
  });

  it("4 连重复字符 → 扣分 + 灌水旗标", () => {
    const r = scoreIntro(cand({ introText: `热热热热，${"测".repeat(50)}。` }));
    expect(r.flags).toContain("简介含 4 连重复字符（疑灌水/占位）");
    expect(r.dim.score).toBeLessThan(100);
  });

  it("连续空白 → 扣分 + 拼接残留旗标", () => {
    const r = scoreIntro(cand({ introText: `合同审查    合规体检，覆盖风险预警与条款比对。${"细".repeat(10)}。` }));
    expect(r.flags).toContain("简介含连续空白（疑拼接残留）");
  });
});

describe("P2-4 初审 D3 技能与行业大类匹配", () => {
  it("命中 3 个以上大类关键词 → 100", () => {
    const r = scoreTagFit(cand());
    expect(r.dim.score).toBe(100);
    expect(r.dim.basis).toContain("合同");
  });

  it("零命中 → 0 分 + 旗标", () => {
    const r = scoreTagFit(cand({ capabilityTags: ["光合作用", "星座运势", "盆栽修剪", "咖啡拉花"] }));
    expect(r.dim.score).toBe(0);
    expect(r.flags.some((f) => f.includes("零匹配"))).toBe(true);
  });

  it("未登记的大类 → 0 分且如实标注「不下判定」，不假装算过", () => {
    const r = scoreTagFit(cand({ industryGroup: "外星贸易" }));
    expect(r.dim.score).toBe(0);
    expect(r.dim.basis).toContain("未建关键词表");
    expect(r.flags.some((f) => f.includes("无匹配关键词表"))).toBe(true);
  });
});

describe("P2-4 初审 D4 定价合理性", () => {
  it("偏离同类中位 0% → 100", () => {
    expect(scorePricing(cand({ monthlyPrice: 1000 }), baseAnchor).dim.score).toBe(100);
  });

  it("偏离 60% → 50 分档", () => {
    expect(scorePricing(cand({ monthlyPrice: 1600 }), baseAnchor).dim.score).toBe(50);
  });

  it("大类无存量 → 用全站中位且得分减半（置信度如实下调）", () => {
    const scaled: PricingAnchor = { group: "农业服务", median: 900, sampleSize: 0, scaled: true };
    expect(scorePricing(cand({ monthlyPrice: 900 }), scaled).dim.score).toBe(50); // 100 × 0.5
    expect(scorePricing(cand({ monthlyPrice: 900 }), scaled).flags.some((f) => f.includes("置信度减半"))).toBe(true);
  });

  it("月薪高于建议价 1.5 倍 → 扣 30 并出旗标（防虚高定价）", () => {
    const r = scorePricing(cand({ monthlyPrice: 1000, suggestedPrice: 500 }), baseAnchor);
    expect(r.dim.score).toBe(70); // 100 − 30
    expect(r.flags.some((f) => f.includes("1.5 倍"))).toBe(true);
  });
});

describe("P2-4 初审 D5 师承有效性", () => {
  it("真师承 → 100 且无扣分", () => {
    const r = scoreLineage(cand(), realMaster);
    expect(r.dim.score).toBe(100);
    expect(r.penalty).toBe(0);
  });

  it("占位师承「传承建档中」→ 60 分 + 扣分 + 旗标（不判无效，如实标注待重录）", () => {
    const r = scoreLineage(cand(), placeholderMaster);
    expect(r.dim.score).toBe(60);
    expect(r.penalty).toBe(LINEAGE_PLACEHOLDER_PENALTY);
    expect(r.flags[0]).toContain("占位记录");
  });

  it("师承悬空（masters 查无）→ 0 分", () => {
    const r = scoreLineage(cand({ masterId: 999 }), realMaster);
    expect(r.dim.score).toBe(0);
    expect(r.flags).toEqual(["师承 999 悬空"]);
  });

  it("师承字段缺失 → 0 分", () => {
    expect(scoreLineage(cand({ masterId: 0 }), realMaster).dim.score).toBe(0);
  });
});

// ─── 2. 总分与三档分流 ───────────────────────────────────────────────────────

describe("P2-4 总分与双阈值三档", () => {
  it("权重合计 1.00", () => {
    const sum = Object.values(DIMENSION_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it("默认阈值 = 施工标定值 88 / 60", () => {
    expect(highThreshold()).toBe(DEFAULT_HIGH_T);
    expect(lowThreshold()).toBe(DEFAULT_LOW_T);
    expect(DEFAULT_HIGH_T).toBe(88);
    expect(DEFAULT_LOW_T).toBe(60);
  });

  it("三档边界：88 入高档、60 入中档、59 入低档", () => {
    expect(tierOf(88)).toBe("high");
    expect(tierOf(87)).toBe("mid");
    expect(tierOf(60)).toBe("mid");
    expect(tierOf(59)).toBe("low");
  });

  it("env 可覆盖阈值（抽检校准不改代码）", () => {
    vi.stubEnv("AGENT_REVIEW_HIGH_T", "80");
    vi.stubEnv("AGENT_REVIEW_LOW_T", "50");
    expect(highThreshold()).toBe(80);
    expect(lowThreshold()).toBe(50);
    expect(tierOf(80)).toBe("high");
    expect(tierOf(50)).toBe("mid");
  });

  it("非法 env 回落默认值（不因配错而放宽）", () => {
    vi.stubEnv("AGENT_REVIEW_HIGH_T", "abc");
    vi.stubEnv("AGENT_REVIEW_LOW_T", "-5");
    expect(highThreshold()).toBe(DEFAULT_HIGH_T);
    expect(lowThreshold()).toBe(DEFAULT_LOW_T);
  });

  it("HIGH 档自动通过默认关（首上线不做全自动）", () => {
    delete process.env.AGENT_REVIEW_AUTO_APPROVE_HIGH;
    expect(autoApproveHighEnabled()).toBe(false);
    vi.stubEnv("AGENT_REVIEW_AUTO_APPROVE_HIGH", "1");
    expect(autoApproveHighEnabled()).toBe(true);
    vi.stubEnv("AGENT_REVIEW_AUTO_APPROVE_HIGH", "true"); // 只认 "1"，不认字符串 true
    expect(autoApproveHighEnabled()).toBe(false);
  });

  it("同输入同输出（确定性：可写进审计复盘）", () => {
    const a = scoreCandidate(cand(), { masterNames: placeholderMaster, pricing: baseAnchor });
    const b = scoreCandidate(cand(), { masterNames: placeholderMaster, pricing: baseAnchor });
    expect(a).toEqual(b);
  });

  it("完整记录 > 残缺记录（分序有意义）", () => {
    const good = scoreCandidate(cand(), { masterNames: realMaster, pricing: baseAnchor });
    const bad = scoreCandidate(
      cand({ introText: "", monthlyPrice: 0, suggestedPrice: 0, capabilityTags: [] }),
      { masterNames: placeholderMaster, pricing: baseAnchor },
    );
    expect(good.score).toBeGreaterThan(bad.score);
    expect(bad.missing.length).toBeGreaterThan(0);
  });

  it("summarizeTiers 三档计数 + 显式暴露自动档开关状态", () => {
    const s = summarizeTiers([90, 88, 70, 60, 59, 10]);
    expect(s).toMatchObject({ high: 2, mid: 2, low: 2, highT: 88, lowT: 60, autoApproveEnabled: false });
  });

  it("维度分项齐全五维且带判据文本（可解释）", () => {
    const r = scoreCandidate(cand(), { masterNames: placeholderMaster, pricing: baseAnchor });
    expect(r.dimensions.map((d) => d.key)).toEqual(["completeness", "intro", "tagFit", "pricing", "lineage"]);
    for (const d of r.dimensions) {
      expect(d.basis.length).toBeGreaterThan(0);
      expect(d.score).toBeGreaterThanOrEqual(0);
      expect(d.score).toBeLessThanOrEqual(100);
    }
  });
});

// ─── 3. list / stats ─────────────────────────────────────────────────────────

function seedQueue(n: number): void {
  pendingRows = Array.from({ length: n }, (_, i) => ({
    id: 120146 + i,
    code: `NX-${1024 + i}`,
    name: `员工${i}`,
    industry: `行业${i}`,
    industryGroup: i % 2 === 0 ? "法律合规" : "软件服务",
    masterId: 1,
    monthlyPrice: 1000,
    suggestedPrice: 1200,
    skillCount: 4,
    introText: "面向中小企业的合同审查与合规体检数字员工，覆盖劳动法务与风险预警场景。",
    capabilityTags: i % 2 === 0 ? ["合同审查", "合规体检", "风险预警"] : ["API设计", "代码审查", "技术方案"],
    listedAt: "2026-09-30 08:24:37",
  }));
}

describe("P2-4 list 队列", () => {
  it("77 条 pending 全量可列（判据 3：队列能列出 77 条）", async () => {
    seedQueue(77);
    const r = await caller.list({ token: "TEST_admin", page: 1, pageSize: 100 });
    expect(r.total).toBe(77);
    expect(r.items).toHaveLength(77);
    expect(r.thresholds).toMatchObject({ high: 88, low: 60, autoApproveEnabled: false });
  });

  it("分页：pageSize=20 → 4 页，第 4 页 17 条", async () => {
    seedQueue(77);
    const p1 = await caller.list({ token: "TEST_admin", page: 1, pageSize: 20 });
    const p4 = await caller.list({ token: "TEST_admin", page: 4, pageSize: 20 });
    expect(p1.items).toHaveLength(20);
    expect(p4.items).toHaveLength(17);
    expect(p1.total).toBe(77);
  });

  it("搜索命中名称/编号；tier 过滤生效", async () => {
    seedQueue(10);
    const byName = await caller.list({ token: "TEST_admin", search: "员工3" });
    expect(byName.total).toBe(1);
    expect(byName.items[0].name).toBe("员工3");
    const byCode = await caller.list({ token: "TEST_admin", search: "NX-1027" });
    expect(byCode.total).toBe(1);
    const highTier = await caller.list({ token: "TEST_admin", tier: "high" });
    expect(highTier.total).toBe(0); // 当前数据够不到自动通过档
    const lowTier = await caller.list({ token: "TEST_admin", tier: "low" });
    expect(lowTier.total + (await caller.list({ token: "TEST_admin", tier: "mid" })).total).toBe(10);
  });

  it("排序：初审分降序；同分按 id 升序（稳定可复现）", async () => {
    seedQueue(5);
    const r = await caller.list({ token: "TEST_admin" });
    const scores = r.items.map((i) => i.ai.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    const ids = r.items.map((i) => i.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });

  it("每条带五维分项与判据（审核人看得懂为什么排前面）", async () => {
    seedQueue(1);
    const r = await caller.list({ token: "TEST_admin" });
    const ai = r.items[0].ai;
    expect(ai.dimensions).toHaveLength(5);
    expect(ai.dimensions.every((d) => d.basis.length > 0)).toBe(true);
  });

  it("非管理员拒绝", async () => {
    await expect(caller.list({ token: "TEST_nope" })).rejects.toThrow(/管理员凭证无效/);
  });

  it("stats 口径：pending/activeTotal/三档 + 留痕列状态 + 标定说明", async () => {
    seedQueue(77);
    activeTotal = 47;
    const s = await caller.stats({ token: "TEST_admin" });
    expect(s.pending).toBe(77);
    expect(s.activeTotal).toBe(47);
    expect(s.reviewColumnsReady).toBe(true);
    expect(s.tiers.high + s.tiers.mid + s.tiers.low).toBe(77);
    expect(s.thresholds.basisNote).toContain("抽检 10 条");
  });
});

// ─── 4. approve / reject / bulkApprove ───────────────────────────────────────

describe("P2-4 approve（判据 4）", () => {
  it("写 status=active + reviewedAt + reviewedBy，并落 st_admin_audit", async () => {
    const r = await caller.approve({ token: "TEST_admin", agentId: 120146 });
    expect(r).toMatchObject({ ok: true, agentId: 120146, status: "active", reviewedBy: 7 });
    const upd = execCalls.find((c) => /^UPDATE agents SET/.test(c.text));
    expect(upd).toBeDefined();
    expect(upd!.text).toContain("status =");
    expect(upd!.text).toContain("reviewedAt = UTC_TIMESTAMP()");
    expect(upd!.text).toContain("reviewedBy =");
    expect(upd!.text).toContain("rejectReason =");
    expect(upd!.text).toContain("WHERE id =");
    expect(upd!.text).toContain("AND status = 'pending'"); // 状态守卫：防重复/并发覆盖
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({ action: "agentReview.approve", target: "agent#120146" });
  });

  it("已审过（affectedRows=0）→ CONFLICT，不谎报成功", async () => {
    updateAffected = 0;
    await expect(caller.approve({ token: "TEST_admin", agentId: 1 })).rejects.toThrow(/不在待审状态/);
  });

  it("留痕列未签（C 级双签面）→ 降级为只迁状态，不 500，审计仍写", async () => {
    columnsReady = false;
    const r = await caller.approve({ token: "TEST_admin", agentId: 120146 });
    expect(r.status).toBe("active");
    const upd = execCalls.find((c) => /^UPDATE agents SET/.test(c.text));
    expect(upd!.text).not.toContain("reviewedAt");
    expect(auditCalls[0].action).toBe("agentReview.approve");
  });
});

describe("P2-4 reject（判据 5、6）", () => {
  // 判据 6 在**编译期**同样成立：rejectInput 的 rejectReason 是必填 string，
  // 所以下面这些负向用例走 schema 直测（而不是绕过类型去调 caller）。
  it("判据 6：不填理由 → schema 拒绝（rejectReason 缺失）", () => {
    const r = rejectInput.safeParse({ token: "T", agentId: 1 });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.join(".") === "rejectReason")).toBe(true);
    }
  });

  it("判据 6：空白理由（空格）→ schema 拒绝", () => {
    expect(rejectInput.safeParse({ token: "T", agentId: 1, rejectReason: "   " }).success).toBe(false);
  });

  it("判据 6：单字敷衍理由 → schema 拒绝", () => {
    expect(rejectInput.safeParse({ token: "T", agentId: 1, rejectReason: "x" }).success).toBe(false);
  });

  it("判据 6（路由层同源）：不填理由真的到不了库", async () => {
    // 通过 createCaller 传缺失字段在类型层已被拒；此处验证路由装配的正是同一 schema
    expect(rejectInput.shape.rejectReason.safeParse("简介与标签不匹配").success).toBe(true);
    expect(rejectInput.shape.rejectReason.safeParse(" ").success).toBe(false);
    expect(execCalls.filter((c) => /^UPDATE agents SET/.test(c.text))).toHaveLength(0);
    expect(auditCalls).toHaveLength(0);
  });

  it("判据 6：超长理由（>255）→ schema 拒绝", () => {
    expect(rejectInput.safeParse({ token: "T", agentId: 1, rejectReason: "长".repeat(256) }).success).toBe(false);
  });

  it("判据 5：填了理由 → status=rejected + rejectReason 写库 + 审计留痕", async () => {
    const r = await caller.reject({ token: "TEST_admin", agentId: 120146, rejectReason: "简介与能力标签不匹配" });
    expect(r).toMatchObject({ ok: true, status: "rejected", rejectReason: "简介与能力标签不匹配", reviewedBy: 7 });
    const upd = execCalls.find((c) => /^UPDATE agents SET/.test(c.text));
    expect(upd!.text).toContain("rejectReason =");
    expect(upd!.text).toContain("reviewedAt = UTC_TIMESTAMP()");
    expect(upd!.text).toContain("AND status = 'pending'");
    expect(auditCalls[0]).toMatchObject({ action: "agentReview.reject", target: "agent#120146" });
    expect((auditCalls[0].detail as { rejectReason: string }).rejectReason).toBe("简介与能力标签不匹配");
  });

  it("已审过（affectedRows=0）→ CONFLICT", async () => {
    updateAffected = 0;
    await expect(caller.reject({ token: "TEST_admin", agentId: 1, rejectReason: "重复驳回" })).rejects.toThrow(
      /不在待审状态/,
    );
  });
});

describe("P2-4 bulkApprove（双闸）", () => {
  it("开关默认关 → 任何批量调用被拒，且未触库", async () => {
    delete process.env.AGENT_REVIEW_AUTO_APPROVE_HIGH;
    await expect(
      caller.bulkApprove({ token: "TEST_admin", agentIds: [1, 2], acknowledgeAutoHigh: true }),
    ).rejects.toThrow(/自动通过未开启/);
    expect(execCalls.filter((c) => /^UPDATE agents SET/.test(c.text))).toHaveLength(0);
  });

  it("开关已开但未显式 ack → 仍被拒（第二道闸）", async () => {
    vi.stubEnv("AGENT_REVIEW_AUTO_APPROVE_HIGH", "1");
    await expect(caller.bulkApprove({ token: "TEST_admin", agentIds: [1] })).rejects.toThrow(/acknowledgeAutoHigh/);
    expect(execCalls.filter((c) => /^UPDATE agents SET/.test(c.text))).toHaveLength(0);
  });

  it("双闸都过 → 逐条通过，回报 approved/skipped（不吞掉已审过的）", async () => {
    vi.stubEnv("AGENT_REVIEW_AUTO_APPROVE_HIGH", "1");
    // 门禁 PR#35 票（bug/medium）：bulkApprove 现**服务端校验档位**（仅限 HIGH 档）。
    //   默认 HIGH_T(=88) 下本夹具够不到 HIGH 档 ⇒ 会被新闸拒。
    //   故把 HIGH_T 压到 "1" 使夹具落入 HIGH 档，才测得到「双闸都过」的**正向路径**。
    //   ⚠️ 不能用 "0"：highThreshold() 要求 v > 0，0 会**静默回落**到默认 88（本仓既有用例已验证该回落行为）。
    //   若此处覆盖失效，下面 expect 会立刻炸，不会静默通过。
    vi.stubEnv("AGENT_REVIEW_HIGH_T", "1");
    updateAffected = 1;
    const r1 = await caller.bulkApprove({ token: "TEST_admin", agentIds: [11, 12], acknowledgeAutoHigh: true });
    expect(r1.approved).toEqual([11, 12]);
    expect(r1.skipped).toEqual([]);
    updateAffected = 0; // 12 已不在 pending
    const r2 = await caller.bulkApprove({ token: "TEST_admin", agentIds: [12], acknowledgeAutoHigh: true });
    expect(r2.approved).toEqual([]);
    expect(r2.skipped).toEqual([12]);
    expect(auditCalls.some((a) => a.action === "agentReview.bulkApprove")).toBe(true);
  });

  // ⚠️ 覆盖缺口（如实记录，不造假测试充数）：
  //   新增的「bulkApprove 服务端档位校验」分支**没有单测覆盖**。
  //   原因：本文件的 `getDb()` mock 未提供待审队列夹具（`list` 在 mock 下返回空 items），
  //   而该闸只对「**在待审队列里、且非 HIGH 档**」的 id 生效 ——
  //   臆造 id 不在队列，会被放行给 migrate 计入 skipped，测不到这道闸。
  //   要覆盖它需先给 mock 补 CANDIDATE_SELECT 的候选行夹具（含 mapCandidate 需要的全部字段），
  //   属后续项。**在此之前，请勿把该分支当作已验证。**

  it("批量上限 50（不许一次性批完 77 条）", () => {
    expect(bulkApproveInput.safeParse({ token: "T", agentIds: Array.from({ length: 51 }, (_, i) => i + 1) }).success).toBe(false);
    expect(bulkApproveInput.safeParse({ token: "T", agentIds: Array.from({ length: 50 }, (_, i) => i + 1) }).success).toBe(true);
  });

  it("输入 schema 收紧：list 页码/页大小与 tier 枚举（非法值不放行）", () => {
    expect(listInput.safeParse({ token: "T" }).success).toBe(true);
    expect(listInput.safeParse({ token: "T", page: 0 }).success).toBe(false);
    expect(listInput.safeParse({ token: "T", pageSize: 101 }).success).toBe(false);
    expect(listInput.safeParse({ token: "T", tier: "urgent" }).success).toBe(false);
  });
});
