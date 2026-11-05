/**
 * M32 数字员工考核列编单测：
 * 1. 评级公式：A/B/C/观察中 边界全符（样本<3 一律观察中）；
 * 2. board 聚合：任务数/产出数/采纳率按 agentCode 正确归集，样本不足 adoptionRate=null；
 * 3. 末位预警：样本≥3 且采纳率<40% → warn=true；
 * 4. 非管理员拒绝。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./queries/connection", () => ({
  getDb: () => ({
    execute: async (q: unknown) => {
      const t = sqlTextOf(q);
      if (/FROM st_agents WHERE status/.test(t)) {
        return [[
          { code: "ajun", name: "阿骏", title: "生产部长", deptCode: "prod" },
          { code: "xiaofa", name: "小法", title: "法务", deptCode: "legal" },
          { code: "lazy", name: "阿懒", title: "试用", deptCode: "test" },
        ]];
      }
      if (/FROM st_chat_threads t JOIN st_chat_messages/.test(t)) {
        return [[{ agentCode: "ajun", cnt: 42 }, { agentCode: "xiaofa", cnt: 3 }]];
      }
      if (/FROM st_agent_artifacts\s+WHERE/.test(t)) {
        return [[{ agentCode: "ajun", cnt: 6 }]];
      }
      if (/FROM st_artifact_feedback f JOIN st_agent_artifacts/.test(t)) {
        return [
          [{ agentCode: "ajun", adopted: 6, rejected: 1 }, { agentCode: "lazy", adopted: 1, rejected: 3 }],
        ];
      }
      return [[]];
    },
  }),
}));
vi.mock("./routers/terminal", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./routers/terminal")>();
  return {
    ...orig,
    requireAdmin: async (token: string) => {
      if (token !== "TEST_admin") throw new Error("管理员凭证无效");
      return { id: 1, username: "TEST_admin" };
    },
  };
});

function sqlTextOf(q: unknown): string {
  const chunks = (q as { queryChunks?: unknown[] } | null)?.queryChunks;
  if (!Array.isArray(chunks)) return String(q ?? "");
  return chunks
    .filter((c) => (c as { constructor?: { name?: string } })?.constructor?.name === "StringChunk")
    .map((c) => {
      const v = (c as { value?: unknown }).value;
      return Array.isArray(v) ? v.join("") : String(v ?? "");
    })
    .join("");
}

import { agentReviewRouter, gradeOf } from "./routers/agentReview";

const caller = agentReviewRouter.createCaller({} as never);

describe("M32 评级公式", () => {
  it("A/B/C/观察中 边界", () => {
    expect(gradeOf({ adoptionRate: 0.8, artifacts90d: 6, fbSamples: 5 })).toBe("A");
    expect(gradeOf({ adoptionRate: 0.8, artifacts90d: 2, fbSamples: 5 })).toBe("B"); // 产出不足降 B
    expect(gradeOf({ adoptionRate: 0.6, artifacts90d: 1, fbSamples: 5 })).toBe("B");
    expect(gradeOf({ adoptionRate: 0.3, artifacts90d: 1, fbSamples: 5 })).toBe("C");
    expect(gradeOf({ adoptionRate: 0.2, artifacts90d: 0, fbSamples: 2 })).toBe("观察中"); // 样本不足
    expect(gradeOf({ adoptionRate: null, artifacts90d: 0, fbSamples: 0 })).toBe("观察中");
  });
});

describe("M32 board 聚合", () => {
  it("任务/产出/采纳率/评级/预警正确归集", async () => {
    const r = await caller.board({ token: "TEST_admin" });
    const ajun = r.agents.find((a) => a.agentCode === "ajun")!;
    expect(ajun.tasks90d).toBe(42);
    expect(ajun.artifacts90d).toBe(6);
    expect(ajun.adopted).toBe(6);
    expect(ajun.rejected).toBe(1);
    expect(ajun.adoptionRate).toBeCloseTo(6 / 7, 3);
    expect(ajun.grade).toBe("A");
    expect(ajun.warn).toBe(false);

    const xiaofa = r.agents.find((a) => a.agentCode === "xiaofa")!;
    expect(xiaofa.adoptionRate).toBeNull(); // 无反馈样本
    expect(xiaofa.grade).toBe("观察中");

    const lazy = r.agents.find((a) => a.agentCode === "lazy")!;
    expect(lazy.adoptionRate).toBeCloseTo(0.25, 3);
    expect(lazy.warn).toBe(true); // 1/4=25%<40% 且样本≥3
    expect(lazy.grade).toBe("C");
    expect(r.formula).toContain("末位预警");
  });

  it("非管理员拒绝", async () => {
    await expect(caller.board({ token: "TEST_nope" })).rejects.toThrow(/管理员凭证无效/);
  });
});
