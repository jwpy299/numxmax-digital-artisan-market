/**
 * settlement 闸钉（critical 面——NumX portal#88 指正面全收：裸 toThrow=假绿[zod 先拒空串/错名 TypeError 也接住]；
 *  非空假 token 绕 zod min(1) 直抵 requireAdmin+正则匹配「管理员」话术——摘闸=真红[反证面成立]；
 *  mock 面：getDb 桩空库（select 空/execute 空——双轨解析零命中=闸该拦））。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./queries/connection", () => {
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }), // 双轨零命中（hash/明文腿同空）
    execute: async () => [[]], // qr 轨/disabled 复查面同空
  };
  return { getDb: () => db };
});

import { settlementRouter } from "./routers/settlement";

describe("settlement 闸钉（critical：经营数据收口管理员）", () => {
  const caller = settlementRouter.createCaller({} as never);
  it("overview 无有效 token=拒且为管理员闸（非 zod 空串错——非空假 token 才真测到闸）", async () => {
    await expect(caller.overview({ token: "nt_fake_000" })).rejects.toThrow(/管理员/);
  });
  it("agentLedger 无有效 token=拒且为管理员闸（procedure 名=agentLedger——闸不漏明细面）", async () => {
    await expect(caller.agentLedger({ token: "nt_fake_000", agentId: 1 })).rejects.toThrow(/管理员/);
  });
});
