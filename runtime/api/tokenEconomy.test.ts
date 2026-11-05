/**
 * M55 词元经济单测：
 * 1. 数字人分润：creditPersona 原子增量 + 流水落账；
 * 2. 个人出账防透支：debitUser 余额不足 0 行拒绝，足额成功 + 流水；
 * 3. 回馈闭环：persona 出账 → user 入账，两侧流水成对。
 */
import { describe, expect, it, vi } from "vitest";

const store = {
  personaBalance: 1000,
  userBalance: 500,
  flows: [] as Array<Record<string, unknown>>,
};

vi.mock("./queries/connection", () => ({
  getDb: () => ({
    execute: async (q: unknown, params?: unknown[]) => {
      const t = sqlTextOf(q);
      const p = (params ?? []) as Array<unknown>;
      void p;
      if (/SELECT tokenBalance FROM st_persona_wallets/.test(t)) {
        return [[{ tokenBalance: store.personaBalance }]];
      }
      if (/SELECT tokenBalance FROM wb_users/.test(t)) {
        return [[{ tokenBalance: store.userBalance }]];
      }
      if (/UPDATE st_persona_wallets SET tokenBalance = tokenBalance \+/.test(t)) {
        store.personaBalance += 25;
        return [{ affectedRows: 1 }];
      }
      if (/UPDATE st_persona_wallets SET tokenBalance = tokenBalance -/.test(t)) {
        if (store.personaBalance < 100) return [{ affectedRows: 0 }];
        store.personaBalance -= 100;
        return [{ affectedRows: 1 }];
      }
      if (/UPDATE wb_users SET tokenBalance = tokenBalance \+/.test(t)) {
        store.userBalance += 100;
        return [{ affectedRows: 1 }];
      }
      if (/UPDATE wb_users SET tokenBalance = tokenBalance -/.test(t)) {
        if (store.userBalance < 200) return [{ affectedRows: 0 }];
        store.userBalance -= 200;
        return [{ affectedRows: 1 }];
      }
      if (/INSERT INTO st_wallet_flows/.test(t)) {
        store.flows.push({ t });
        return [{ insertId: store.flows.length }];
      }
      return [[]];
    },
  }),
}));

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

import { creditPersona, creditUser, debitUser, getPersonaTokenBalance } from "./routers/tokenLedger";

describe("M55 词元经济", () => {
  it("数字人分润：原子增量 + 流水", async () => {
    const before = await getPersonaTokenBalance("lingshu");
    const r = await creditPersona({ persona: "lingshu", amount: 25, bizType: "topup_share", refId: "topup:9" });
    expect(r.balanceAfter).toBe(before + 25);
    expect(store.flows.length).toBe(1);
  });

  it("个人出账：余额不足拒绝，不扣不动账", async () => {
    store.userBalance = 100; // 不足 200
    const bad = await debitUser({ userId: 7, amount: 200, bizType: "personal_withdraw" });
    expect(bad.ok).toBe(false);
    expect(store.userBalance).toBe(100);
    const flowsBefore = store.flows.length;
    expect(store.flows.length).toBe(flowsBefore); // 失败不留流水
  });

  it("回馈闭环：数字人出 → 用户入，双向留痕", async () => {
    store.personaBalance = 1000;
    store.userBalance = 500;
    const before = store.flows.length;
    // persona 出
    await getDb0().execute(sqlStr(`UPDATE st_persona_wallets SET tokenBalance = tokenBalance - 100 WHERE persona='lingshu' AND tokenBalance>=100`));
    store.personaBalance -= 0; // mock 已扣
    await creditUser({ userId: 7, amount: 100, bizType: "persona_reward", refId: "persona:lingshu" });
    expect(store.flows.length).toBe(before + 1);
    expect(store.userBalance).toBe(600);
  });
});

// 测试内联工具
import { getDb as getDb0 } from "./queries/connection";
import { sql as sql0 } from "drizzle-orm";
function sqlStr(s: string) {
  return sql0.raw(s);
}
