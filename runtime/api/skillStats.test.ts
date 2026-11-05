/**
 * Harness H1「技能真实化审计」验收单测（SQL 层 mock，不连库）：
 * 1. 执行器登记：executorRegistry 覆盖 SKILL_EXECUTOR_MAP 全量 20 个真执行器
 *    （专用 6 → 'tool'，通用 14 → 各自 llm_*），值域合法；
 * 2. generic 兜底：未登记 skillKey → executorKind null，badge 'generative'；
 * 3. badgeOf 两态：真执行器 → 'real'，无执行器/'generic' → 'generative'；
 * 4. 真实成功率：mock st_skill_calls 近 90 天聚合（10 次 8 成功 → 80.0）；
 * 5. 样本不足：<5 次调用 / 无记录 / 表缺失（查询抛错）均返回 null 且静默不抛；
 * 6. market.list 响应含 executorKind/badge/realSuccessRate，且不含种子 successRate=98；
 * 7. skillShop.list 同源接线：source_skill_key 命中登记表 → 'real' + 真实成功率。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let selectQueue: Array<Array<Record<string, unknown>>> = [];
let callsAggRows: Array<Record<string, unknown>> = [];
let marketRows: Array<Record<string, unknown>> = [];
let packRows: Array<Record<string, unknown>> = [];
let throwOnCallsQuery = false;

function route(text: string): unknown {
  if (text.includes("FROM st_skill_calls")) {
    if (throwOnCallsQuery) throw new Error("table st_skill_calls doesn't exist");
    return [callsAggRows.map((r) => ({ ...r }))];
  }
  if (text.includes("FROM st_skill_market")) return [marketRows.map((r) => ({ ...r }))];
  if (text.includes("FROM st_skill_packs")) return [packRows.map((r) => ({ ...r }))];
  if (text.includes("FROM st_recommend_slots")) throw new Error("no such table");
  return [[]];
}

vi.mock("./queries/connection", async () => {
  const { MySqlDialect } = await import("drizzle-orm/mysql-core");
  const dialect = new MySqlDialect();
  return {
    getDb: () => ({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => selectQueue.shift() ?? [],
          }),
        }),
      }),
      execute: async (stmt: unknown) => {
        const q = dialect.sqlToQuery(stmt as never);
        return route(q.sql);
      },
    }),
  };
});

import {
  badgeOf,
  badgeOfKind,
  executorKindOf,
  executorRegistry,
  MIN_RATE_SAMPLES,
  skillSuccessRate,
} from "./routers/skillStats";
import { SKILL_EXECUTOR_MAP } from "./routers/skillExecutor";
import { marketRouter } from "./routers/skillMarket";
import { skillShopRouter } from "./routers/skillShop";

const marketCaller = marketRouter.createCaller({} as never);
const shopCaller = skillShopRouter.createCaller({} as never);

const ownerUser = { id: 1, username: "boss", displayName: "老板", role: "owner", factoryId: 10 };
const factory = { id: 10, enterpriseName: "测试企业A", industry: "工业制造", industryGroup: "工业制造" };

beforeEach(() => {
  selectQueue = [];
  callsAggRows = [];
  marketRows = [];
  packRows = [];
  throwOnCallsQuery = false;
});

describe("执行器登记（回填数据源 = SKILL_EXECUTOR_MAP）", () => {
  it("全量真执行器登记：与 SKILL_EXECUTOR_MAP 一一对应，值域合法", () => {
    const registry = executorRegistry();
    const mapKeys = Object.keys(SKILL_EXECUTOR_MAP);
    // SKILL_EXECUTOR_MAP 当前全量 20 个（专用 6 + 通用 14，含 M20 波 2 ppt/excel）
    expect(mapKeys).toHaveLength(20);
    expect(Object.keys(registry).sort()).toEqual(mapKeys.sort());
    const allowed = new Set(["tool", "llm_doc", "llm_analysis", "llm_kb_qa", "llm_ppt", "llm_sheet"]);
    for (const kind of Object.values(registry)) expect(allowed.has(kind)).toBe(true);
    // 抽查：专用工具 → 'tool'；通用类 → 各自 llm_*
    expect(registry.doc_write).toBe("tool");
    expect(registry.claw_browser_task).toBe("tool");
    expect(registry.ppt_make).toBe("llm_ppt");
    expect(registry.excel_report).toBe("llm_sheet");
    expect(registry.kb_qa).toBe("llm_kb_qa");
    expect(registry.tax_notice).toBe("llm_analysis");
    expect(registry.weekly_report).toBe("llm_doc");
  });

  it("generic 兜底：未登记技能 executorKind 为 null，徽标为 generative", () => {
    expect(executorKindOf("factory_custom_skill")).toBeNull();
    expect(badgeOfKind(null)).toBe("generative");
    expect(badgeOfKind(undefined)).toBe("generative");
    expect(badgeOfKind("generic")).toBe("generative"); // 匠市无映射技能登记 'generic' = 无真执行器
  });
});

describe("badgeOf 两态", () => {
  it("真执行器 → 'real'；无执行器 → 'generative'", () => {
    expect(badgeOf("doc_write")).toBe("real");
    expect(badgeOf("ppt_make")).toBe("real");
    expect(badgeOf("excel_report")).toBe("real");
    expect(badgeOf("factory_custom_skill")).toBe("generative");
    expect(badgeOfKind("tool")).toBe("real");
    expect(badgeOfKind("llm_sheet")).toBe("real");
  });
});

describe("skillSuccessRate 真实成功率（近 90 天 st_skill_calls）", () => {
  it("真实计算：10 次调用 8 次成功 → 80.0", async () => {
    callsAggRows = [{ skillKey: "doc_write", total: 10, ok: 8 }];
    expect(await skillSuccessRate("doc_write")).toBe(80);
  });

  it(`样本不足（<${MIN_RATE_SAMPLES} 次）/ 无记录 / 表缺失 → null 且静默不抛`, async () => {
    callsAggRows = [{ skillKey: "doc_write", total: MIN_RATE_SAMPLES - 1, ok: 4 }];
    expect(await skillSuccessRate("doc_write")).toBeNull(); // 样本不足
    callsAggRows = [];
    expect(await skillSuccessRate("doc_write")).toBeNull(); // 无记录
    throwOnCallsQuery = true;
    await expect(skillSuccessRate("doc_write")).resolves.toBeNull(); // 表缺失静默
  });
});

describe("market.list 接线（匠市技能市场）", () => {
  it("响应含 executorKind/badge/realSuccessRate，且不含种子 successRate=98", async () => {
    selectQueue.push([ownerUser], [factory]); // sessionMe
    marketRows = [
      { id: 5, skillKey: "doc_write", title: "文档撰写", industry: "工业制造", description: null, priceTokens: 0, listedAt: "2026-08-05 10:00:00" },
      { id: 6, skillKey: "factory_custom_skill", title: "本厂定制技能", industry: "工业制造", description: null, priceTokens: 100, listedAt: "2026-08-06 10:00:00" },
    ];
    callsAggRows = [{ skillKey: "doc_write", total: 12, ok: 9 }];
    const res = await marketCaller.list({ token: "nt_x" });
    expect(res.items).toHaveLength(2);
    const real = res.items[0]!;
    expect(real.executorKind).toBe("tool");
    expect(real.badge).toBe("real");
    expect(real.realSuccessRate).toBe(75); // 9/12
    const gen = res.items[1]!;
    expect(gen.executorKind).toBeNull();
    expect(gen.badge).toBe("generative");
    expect(gen.realSuccessRate).toBeNull(); // 样本不足
    // 种子 successRate=98 不得出现在市场响应中
    for (const item of res.items) expect(item).not.toHaveProperty("successRate");
    expect(JSON.stringify(res)).not.toContain("98");
  });
});

describe("skillShop.list 接线（技能商店）", () => {
  it("source_skill_key 命中登记表 → 'real' 徽标 + 真实成功率；未命中 → 'generative' + null", async () => {
    packRows = [
      { pack_key: "SP-DOC_WRITE", source_skill_key: "doc_write", title: "文档撰写", description: "", layer: "general", track: "A", creator_type: "platform", factory_id: null, price_tokens: 500, sales_count: 3, status: "listed", listed_at: null, created_at: null },
      { pack_key: "SP-CUSTOM", source_skill_key: null, title: "个人创作包", description: "", layer: "general", track: "B", creator_type: "staff", factory_id: null, price_tokens: 200, sales_count: 1, status: "listed", listed_at: null, created_at: null },
    ];
    callsAggRows = [{ skillKey: "doc_write", total: 20, ok: 19 }];
    const res = await shopCaller.list({});
    expect(res).toHaveLength(2);
    expect(res[0]!.executorKind).toBe("tool");
    expect(res[0]!.badge).toBe("real");
    expect(res[0]!.realSuccessRate).toBe(95); // 19/20
    expect(res[1]!.executorKind).toBeNull();
    expect(res[1]!.badge).toBe("generative");
    expect(res[1]!.realSuccessRate).toBeNull();
    expect(JSON.stringify(res)).not.toContain("\"successRate\":98");
  });

  it("st_skill_calls 缺失时列表仍正常返回（徽标保留，成功率为 null，失败静默）", async () => {
    packRows = [
      { pack_key: "SP-PPT_MAKE", source_skill_key: "ppt_make", title: "PPT制作", description: "", layer: "general", track: "A", creator_type: "platform", factory_id: null, price_tokens: 500, sales_count: 0, status: "listed", listed_at: null, created_at: null },
    ];
    throwOnCallsQuery = true;
    const res = await shopCaller.list({});
    expect(res).toHaveLength(1);
    expect(res[0]!.badge).toBe("real");
    expect(res[0]!.realSuccessRate).toBeNull();
  });
});
