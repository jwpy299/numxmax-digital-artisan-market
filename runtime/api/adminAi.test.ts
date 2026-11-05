/**
 * M7-e S3 管理终端 AI 原生化验收单测：
 * 1. NL 评审指令解析：驳回/通过/废止三类动词映射 + 理由提取。
 * 2. 白名单约束：解析出的 code 不在协议清单 → 拒绝（绝不猜测执行）。
 * 3. 解析器故障/输出非法 → 抛可读错误，不产出动作。
 * 4. 实况上下文拼装：briefToContext 含关键段且标注禁止编造。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const chatMock = vi.fn();

vi.mock("./routers/modelGateway", () => ({
  callSlotChat: (...args: unknown[]) => chatMock(...args),
}));
vi.mock("./queries/connection", () => ({ getDb: () => ({ execute: async () => [[]] }) }));

import { parseReviewCommand, briefToContext, type PlatformBrief } from "./routers/adminAi";

const knownCodes = ["device_rehearsal", "sandbox_dispatch", "llm_limit_adjust", "intent_plan_submit"];

beforeEach(() => chatMock.mockReset());

describe("NL 评审指令解析（parseReviewCommand）", () => {
  it("驳回指令 → reject + code + 理由", async () => {
    chatMock.mockResolvedValue({ ok: true, content: '{"action":"reject","code":"device_rehearsal","comment":"缺 undo"}' });
    const r = await parseReviewCommand("驳回 device_rehearsal，理由：缺 undo", knownCodes);
    expect(r).toEqual({ action: "reject", code: "device_rehearsal", comment: "缺 undo" });
  });

  it("通过指令 → approve", async () => {
    chatMock.mockResolvedValue({ ok: true, content: '{"action":"approve","code":"sandbox_dispatch","comment":null}' });
    const r = await parseReviewCommand("把沙箱训练派单上线", knownCodes);
    expect(r.action).toBe("approve");
    expect(r.code).toBe("sandbox_dispatch");
  });

  it("废止指令 → deprecate", async () => {
    chatMock.mockResolvedValue({ ok: true, content: '{"action":"deprecate","code":"llm_limit_adjust","comment":"旧版退役"}' });
    const r = await parseReviewCommand("废止 llm_limit_adjust", knownCodes);
    expect(r.action).toBe("deprecate");
  });

  it("code 不在协议清单 → 拒绝（绝不猜测执行）", async () => {
    chatMock.mockResolvedValue({ ok: true, content: '{"action":"reject","code":"hack_all","comment":null}' });
    await expect(parseReviewCommand("驳回 hack_all", knownCodes)).rejects.toThrow(/不在协议清单/);
  });

  it("解析器故障 → 抛错不产出动作", async () => {
    chatMock.mockResolvedValue({ ok: false, reason: "not_configured" });
    await expect(parseReviewCommand("驳回 xxx", knownCodes)).rejects.toThrow(/暂时不可用/);
  });

  it("输出非 JSON → 抛错", async () => {
    chatMock.mockResolvedValue({ ok: true, content: "随便聊聊" });
    await expect(parseReviewCommand("驳回 xxx", knownCodes)).rejects.toThrow();
  });
});

describe("实况上下文（briefToContext）", () => {
  it("包含待评审/信号/规划/沉默企业/冻结段，并标注禁止编造", () => {
    const b: PlatformBrief = {
      pendingProtocols: [{ code: "p1", name: "测试协议", level: "B", status: "draft" }],
      openSignals24h: { levelB: 1, levelC: 2, levelD: 0 },
      plans: { total: 5, today: 1, executed: 3, pendingConfirm: 1, failed: 1 },
      silentFactories7d: [{ id: 9, name: "某某厂" }],
      frozenFactories: 1,
    };
    const ctx = briefToContext(b);
    expect(ctx).toContain("p1");
    expect(ctx).toContain("C级 2 条");
    expect(ctx).toContain("某某厂");
    expect(ctx).toContain("禁止编造");
    expect(ctx).toContain("冻结中企业：1 家");
  });
});
