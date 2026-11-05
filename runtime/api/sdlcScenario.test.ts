/**
 * v163 AI-Native SDLC 装入运行时后的全链场景沙箱演练（SQL 层 mock，不连库）。
 *
 * 演练目的：回答彭总「装上 SDLC 之后系统会怎么样」——
 * 场景一：合规提案 + 沙盘已在 + AI 预审 pass → 输送带照常施工，审计链多出 sdlc:review 报备行；
 * 场景二：缺沙盘预演 → G2 闸依旧拦截（SDLC 预审如实留痕但不越权放行）；
 * 场景三：高危提案（涉资金）→ G4 合规闸先行拦截，预审不执行（牙齿在预审之前）；
 * 场景四：模型故障 → unreviewed 诚实降级，不装审过、不堵输送带。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let execQueue: unknown[] = [];
let execLog: string[] = [];

/** 把 drizzle sql 模板粗还原成可读文本（值内联），供审计内容断言 */
function sqlText(q: unknown): string {
  const chunks = (q as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return String(q);
  return chunks
    .map((c) => {
      if (typeof c === "string") return c;
      const v = (c as { value?: unknown })?.value;
      return v === undefined ? "" : String(v);
    })
    .join(" ");
}

vi.mock("./queries/connection", () => ({
  getDb: () => ({
    execute: async (q: unknown) => {
      execLog.push(sqlText(q));
      return execQueue.shift() ?? [[]];
    },
  }),
}));

let modelReply: { ok: boolean; content?: string } | null = { ok: true, content: "" };
vi.mock("./routers/modelGateway", () => ({
  callSlotChatFast: async () => modelReply,
}));

import { executeConveyorActions } from "./harness/executor";

const APPROVED = [[{ id: 7, status: "approved", proposal_type: "skill_update", skill_key: "cs_reply" }]];

beforeEach(() => {
  execQueue = [];
  execLog = [];
  modelReply = { ok: true, content: "判定：可行\n风险：跨厂数据需隔离\n风险：高峰期性能未测" };
});

describe("SDLC 装入后的输送带行为", () => {
  it("场景一：合规+沙盘+预审pass → 施工照常，sdlc:review 报备入审计", async () => {
    execQueue = [
      APPROVED.shift(), // 提案实况
      [{ id: 7, proposal_type: "skill_update", skill_key: "cs_reply" }], // 预审读提案
      [[]], // v165 判错案例回灌查询（无历史）
      [{}], // sdlc:review 审计写入
      [{}], // v165 判决书底档 upsert
      [[{ id: 99 }]], // G2 沙盘记录：在案
      [[]], // 审计锁：未施工过
      [[]], // st_releases 无重
      [{ insertId: 42 }], // 建 draft 发布
      [{}], // construct:queued 审计
    ];
    const [r] = await executeConveyorActions([{ kind: "queue_construct", proposalId: 7 } as never]);
    expect(r.ok).toBe(true);
    expect(r.refId).toBe(42);
    const reviewAudit = execLog.find((t) => t.includes("sdlc:review"));
    expect(reviewAudit).toBeTruthy();
    expect(reviewAudit).toContain("verdict:pass");
    expect(reviewAudit).toContain("risks:2");
    // v165 学习环：判决书底档已落 st_sdlc_verdicts（对账事实源）
    expect(execLog.some((t) => t.includes("st_sdlc_verdicts"))).toBe(true);
  });

  it("场景二：缺沙盘预演 → G2 拦截依旧，预审留痕但不越权", async () => {
    execQueue = [
      [{ id: 7, status: "approved", proposal_type: "skill_update", skill_key: "cs_reply" }],
      [{ id: 7, proposal_type: "skill_update", skill_key: "cs_reply" }],
      [[]], // v165 判错案例回灌查询（无历史）
      [{}], // sdlc:review 审计
      [{}], // v165 判决书底档 upsert
      [[]], // 沙盘：无记录
    ];
    const [r] = await executeConveyorActions([{ kind: "queue_construct", proposalId: 7 } as never]);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("沙盘预演");
    expect(execLog.some((t) => t.includes("sdlc:review"))).toBe(true);
    expect(execLog.some((t) => t.includes("construct:queued"))).toBe(false);
  });

  it("场景三：涉资金提案 → G4 合规闸先拦，预审不执行（牙齿在预审之前）", async () => {
    execQueue = [
      [{ id: 8, status: "approved", proposal_type: "退款自动化", skill_key: "auto_refund" }],
    ];
    const [r] = await executeConveyorActions([{ kind: "queue_construct", proposalId: 8 } as never]);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("合规拦截");
    expect(execLog.some((t) => t.includes("sdlc:review"))).toBe(false);
  });

  it("场景四：模型故障 → unreviewed 诚实标注，不堵输送带", async () => {
    modelReply = null;
    execQueue = [
      [{ id: 7, status: "approved", proposal_type: "skill_update", skill_key: "cs_reply" }],
      [{ id: 7, proposal_type: "skill_update", skill_key: "cs_reply" }],
      [[]], // v165 判错案例回灌查询（无历史）
      [{}], // sdlc:review 审计（unreviewed 如实写入）
      [{}], // v165 判决书底档 upsert
      [[{ id: 99 }]], // 沙盘在案
      [[]],
      [[]],
      [{ insertId: 43 }],
      [{}],
    ];
    const [r] = await executeConveyorActions([{ kind: "queue_construct", proposalId: 7 } as never]);
    expect(r.ok).toBe(true);
    const audit = execLog.find((t) => t.includes("sdlc:review"));
    expect(audit).toBeTruthy();
    expect(audit).toContain("verdict:unreviewed"); // 诚实降级：如实标「未审」而非装审过
  });
});
