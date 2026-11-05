/**
 * iter92 企业训练场 / 计费套餐 / 告警 / 技能市场 / 战绩榜测试（SQL 层 mock，不连库）。
 *
 * 方法：vi.mock("./queries/connection") 注入可编程假 db
 * （select→from→where→limit 与 execute 均按调用顺序出队），同 wbBilling.test.ts。
 *
 * 断言：
 * 1. judgeSandboxReply 判分复刻 corps-train（空/短/达标）；
 * 2. sandbox.dispatch 前置链：未签协议 403 → 套餐到期 403 → 日用量超限 403 → 军团未驻场 403；
 * 3. sandbox.dispatch LLM 不可用 → INTERNAL_SERVER_ERROR + 告警落库（不静默）；
 * 4. sandbox.graduate 闸门：<10 任务 BAD_REQUEST；达标 → 毕业 + 挂载 + 审计行；
 * 5. billing.plan：expire_at 过期动态 past_due（不写库）；
 * 6. admin.planSet：pro 档位映射 8/1000 + upsert；
 * 7. market.publish 未毕业 403；market.list 来源匿名「某{industry}企业」且无 sourceFactoryId；
 * 8. corpsBoard.industry：分桶计数 + myRank + 响应无他厂名称/id 字段；
 * 9. sendAlert 无 webhook → sentOk=false 且不 throw。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let selectQueue: Array<Array<Record<string, unknown>>> = [];
let execQueue: unknown[] = [];

vi.mock("./queries/connection", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => selectQueue.shift() ?? [],
        }),
      }),
    }),
    execute: async () => {
      const next = execQueue.shift() ?? [[]];
      if (next instanceof Error) throw next;
      return next;
    },
  }),
}));

import { judgeSandboxReply, sandboxRouter, agreementRouter } from "./routers/sandbox";
import { billingRouter } from "./routers/billing";
import { marketRouter, corpsBoardRouter } from "./routers/skillMarket";
import { adminRouter } from "./routers/admin";
import { sendAlert } from "./routers/alertUtil";

const sandboxCaller = sandboxRouter.createCaller({} as never);
const agreementCaller = agreementRouter.createCaller({} as never);
const billingCaller = billingRouter.createCaller({} as never);
const marketCaller = marketRouter.createCaller({} as never);
const corpsBoardCaller = corpsBoardRouter.createCaller({} as never);
const adminCaller = adminRouter.createCaller({} as never);

const ownerUser = { id: 1, username: "boss", displayName: "老板", role: "owner", factoryId: 10 };
const factory = { id: 10, enterpriseName: "测试企业A", industry: "工业制造", industryGroup: "工业制造" };
const adminUser = { id: 9, username: "admin", displayName: "管理员", role: "admin", factoryId: 0 };

const agreementSigned = [{ signedBy: "wb:boss", signedAt: "2026-08-01 00:00:00" }];
const planActive = [{
  factoryId: 10, planCode: "basic", seatLimit: 3, llmDailyLimit: 200,
  status: "active", expireAt: "2099-01-01 00:00:00",
}];
const corpsDeployed = [{ id: 3, status: "deployed" }];

beforeEach(() => {
  selectQueue = [];
  execQueue = [];
  vi.unstubAllEnvs();
});

describe("judgeSandboxReply（复刻 corps-train judge）", () => {
  it("空回复 → 0 分不通过", () => {
    expect(judgeSandboxReply("采购跟单", "")).toEqual({ score: 0, pass: false });
    expect(judgeSandboxReply("采购跟单", null)).toEqual({ score: 0, pass: false });
  });
  it("回复过短（<80 字）→ min(40,len) 不通过", () => {
    const r = judgeSandboxReply("采购跟单", "好".repeat(30));
    expect(r.score).toBe(30);
    expect(r.pass).toBe(false);
  });
  it("关键词 2-gram 命中 + 长度达标 → ≥60 通过", () => {
    const reply = `围绕采购跟单制定标准动作：采购跟单需每日核对供应商交期，跟单台账逐单登记，异常升级处理。${"执行后形成台账并复盘改进。".repeat(4)}`;
    const r = judgeSandboxReply("采购跟单", reply);
    expect(r.score).toBeGreaterThanOrEqual(60);
    expect(r.pass).toBe(true);
  });
});

describe("sandbox.dispatch 前置链", () => {
  it("未签协议 → FORBIDDEN（协议硬前置）", async () => {
    selectQueue.push([ownerUser], [factory]);
    execQueue.push([[]]); // 协议查询：无记录
    await expect(
      sandboxCaller.dispatch({ token: "nt_x", instruction: "特训一下采购跟单流程", skillKey: "purchase" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("套餐到期 → FORBIDDEN「套餐到期或未开通」", async () => {
    selectQueue.push([ownerUser], [factory]);
    execQueue.push(
      [agreementSigned],
      [[{ factoryId: 10, planCode: "basic", seatLimit: 3, llmDailyLimit: 200, status: "active", expireAt: "2020-01-01 00:00:00" }]],
    );
    await expect(
      sandboxCaller.dispatch({ token: "nt_x", instruction: "特训一下采购跟单流程", skillKey: "purchase" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("套餐到期或未开通") });
  });

  it("LLM 日用量达限 → FORBIDDEN（成本闸）", async () => {
    selectQueue.push([ownerUser], [factory]);
    execQueue.push(
      [agreementSigned],
      [planActive],
      [[{ calls: 200 }]], // 今日已用 = 限额 200
    );
    await expect(
      sandboxCaller.dispatch({ token: "nt_x", instruction: "特训一下采购跟单流程", skillKey: "purchase" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("日用量已达上限") });
  });

  it("军团未驻场 → FORBIDDEN", async () => {
    selectQueue.push([ownerUser], [factory]);
    execQueue.push(
      [agreementSigned],
      [planActive],
      [[]], // 今日用量 0
      [[{ id: 3, status: "training" }]],
    );
    await expect(
      sandboxCaller.dispatch({ token: "nt_x", instruction: "特训一下采购跟单流程", skillKey: "purchase" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("驻场") });
  });

  it("前置全过但 LLM 不可用 → INTERNAL_SERVER_ERROR + failed 任务行 + 告警落库", async () => {
    vi.stubEnv("IDOICTOS_API_KEY", ""); // 网关未配置 → callSlotChat 立即返回 not_configured（不发 fetch）
    selectQueue.push([ownerUser], [factory]);
    execQueue.push(
      [agreementSigned], // ① 协议
      [planActive], // ② 套餐
      [[]], // ③ 今日用量 0
      [corpsDeployed], // ④ 军团 deployed
      [[]], // ⑤ 技能标题（无 → 用 skillKey）
      [[{ insertId: 1 }]], // ⑥ INSERT failed 任务行
      [[{ insertId: 1 }]], // ⑦ INSERT st_alert_log（sandbox_llm_failed）
    );
    await expect(
      sandboxCaller.dispatch({ token: "nt_x", instruction: "特训一下采购跟单流程", skillKey: "purchase" }),
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });
});

describe("sandbox.graduate 毕业闸门", () => {
  it("taskCount<10 → BAD_REQUEST", async () => {
    selectQueue.push([ownerUser], [factory]);
    execQueue.push([[{ id: 1, title: "采购跟单", taskCount: 5, passCount: 5, graduated: 0 }]]);
    await expect(
      sandboxCaller.graduate({ token: "nt_x", skillKey: "purchase" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("未达毕业线") });
  });

  it("passRate<95 → BAD_REQUEST", async () => {
    selectQueue.push([ownerUser], [factory]);
    execQueue.push([[{ id: 1, title: "采购跟单", taskCount: 12, passCount: 10, graduated: 0 }]]);
    await expect(
      sandboxCaller.graduate({ token: "nt_x", skillKey: "purchase" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("达标 → 毕业 + 挂载 ex 成员 + 审计行", async () => {
    selectQueue.push([ownerUser], [factory]);
    execQueue.push(
      [[{ id: 1, title: "采购跟单", taskCount: 12, passCount: 12, graduated: 0 }]], // 技能行
      [[]], // UPDATE graduated=1
      [[{ c: 2 }]], // 待挂载 ex 成员数
      [[]], // UPDATE st_panda_members duty 追加「｜特训:」
      [[{ insertId: 9 }]], // INSERT st_claw_operations 审计行
    );
    const res = await sandboxCaller.graduate({ token: "nt_x", skillKey: "purchase" });
    expect(res.ok).toBe(true);
    expect(res.graduated).toBe(true);
    expect(res.passRate).toBe(100);
    expect(res.mountedMembers).toBe(2);
  });
});

describe("agreement", () => {
  it("未签 → signed=false；签署后 → signed=true（幂等）", async () => {
    selectQueue.push([ownerUser], [factory]);
    execQueue.push([[]]); // agreementRow：无
    const cur = await agreementCaller.current({ token: "nt_x" });
    expect(cur).toMatchObject({ version: "v1", signed: false, signedAt: null });

    selectQueue.push([ownerUser], [factory]);
    execQueue.push(
      [[{ insertId: 1 }]], // INSERT IGNORE 签署
      [[{ signedAt: "2026-08-05 10:00:00" }]], // 回查
    );
    const s = await agreementCaller.sign({ token: "nt_x", version: "v1" });
    expect(s.signed).toBe(true);
    expect(s.signedAt).toBe("2026-08-05 10:00:00");
  });
});

describe("billing.plan", () => {
  it("expire_at 过期 → 动态 past_due（不写库）", async () => {
    selectQueue.push([ownerUser], [factory]);
    execQueue.push(
      [[{ factoryId: 10, planCode: "basic", seatLimit: 3, llmDailyLimit: 200, status: "active", expireAt: "2020-01-01 00:00:00" }]],
      [[{ calls: 7 }]],
    );
    const res = await billingCaller.plan({ token: "nt_x" });
    expect(res.status).toBe("past_due");
    expect(res.planCode).toBe("basic");
    expect(res.llmUsedToday).toBe(7);
  });

  it("active 未过期 → status active", async () => {
    selectQueue.push([ownerUser], [factory]);
    execQueue.push([planActive], [[]]);
    const res = await billingCaller.plan({ token: "nt_x" });
    expect(res.status).toBe("active");
    expect(res.llmDailyLimit).toBe(200);
  });
});

describe("admin.planSet / admin.alertLog", () => {
  it("planSet pro → 8/1000 upsert + active", async () => {
    selectQueue.push([adminUser]);
    execQueue.push(
      [[]], // requireAdmin disabled 检查
      [[{ insertId: 10 }]], // upsert st_factory_plan
    );
    const res = await adminCaller.planSet({ token: "nt_admin", factoryId: 10, planCode: "pro", days: 30 });
    expect(res.ok).toBe(true);
    expect(res.seatLimit).toBe(8);
    expect(res.llmDailyLimit).toBe(1000);
    expect(res.status).toBe("active");
  });

  it("alertLog → {items} 近 100 条", async () => {
    selectQueue.push([adminUser]);
    execQueue.push(
      [[]],
      [[{ id: 1, level: "warn", event: "llm_usage_80", payload: "{\"factoryId\":10}", sentOk: 0, createdAt: "2026-08-05 10:00:00" }]],
    );
    const res = await adminCaller.alertLog({ token: "nt_admin" });
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({ event: "llm_usage_80", sentOk: false });
  });
});

describe("market", () => {
  it("publish 未毕业 → FORBIDDEN", async () => {
    selectQueue.push([ownerUser], [factory]);
    execQueue.push([[]]); // st_sandbox_skills 无记录
    await expect(
      marketCaller.publish({ token: "nt_x", skillKey: "purchase", title: "采购跟单技能", priceTokens: 0 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("毕业") });
  });

  it("list 来源匿名「某{industry}企业」且不暴露 sourceFactoryId", async () => {
    selectQueue.push([ownerUser], [factory]);
    execQueue.push(
      [[{ id: 5, skillKey: "purchase", title: "采购跟单技能", industry: "工业制造", description: null, priceTokens: 0, listedAt: "2026-08-05 10:00:00" }]],
    );
    const res = await marketCaller.list({ token: "nt_x" });
    expect(res.items).toHaveLength(1);
    expect(res.items[0].source).toBe("某工业制造企业");
    expect(res.items[0]).not.toHaveProperty("sourceFactoryId");
  });
});

describe("corpsBoard.industry", () => {
  it("聚合匿名：分桶计数 + myRank + 无他厂名称/id 字段", async () => {
    selectQueue.push([ownerUser], [factory]);
    execQueue.push(
      [[
        { corpsId: 1, factoryId: 10, trainPassRate: 96 },
        { corpsId: 2, factoryId: 11, trainPassRate: 85 },
        { corpsId: 3, factoryId: 12, trainPassRate: null },
      ]],
      [[{ c: 40 }]], // totalTasks
    );
    const res = await corpsBoardCaller.industry({ token: "nt_x" });
    expect(res.industry).toBe("工业制造");
    expect(res.corpsCount).toBe(3);
    expect(res.avgPassRate).toBe(90.5);
    expect(res.totalTasks).toBe(40);
    expect(res.myRank).toBe(1);
    expect(res.bands).toEqual([
      { label: "优秀(≥95)", count: 1 },
      { label: "良好(80-95)", count: 1 },
      { label: "待提升(<80)", count: 1 },
    ]);
    const json = JSON.stringify(res);
    expect(json).not.toContain("enterpriseName");
    expect(json).not.toContain("factoryId");
    expect(json).not.toContain("corpsId");
  });
});

describe("sendAlert", () => {
  it("无 webhook 配置 → sentOk=false 且不 throw（st_alert_log 落库）", async () => {
    vi.stubEnv("ALERT_WEBHOOK_URL", "");
    execQueue.push([[{ insertId: 1 }]]); // INSERT st_alert_log
    const r = await sendAlert("warn", "llm_usage_80", { factoryId: 10, used: 160, limit: 200 });
    expect(r.sentOk).toBe(false);
  });

  it("st_alert_log 写库失败也不 throw", async () => {
    vi.stubEnv("ALERT_WEBHOOK_URL", "");
    execQueue.push(new Error("db down")); // execute 抛错
    await expect(sendAlert("error", "sandbox_llm_failed", { factoryId: 10 })).resolves.toMatchObject({ sentOk: false });
  });
});
