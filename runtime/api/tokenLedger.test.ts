/**
 * M34 站内 Token 支付闭环单测：
 * 1. 余额读取：有钱包行 → 实数；无行 → 0。
 * 2. 原子扣费：余额够 → 扣减成功，balanceAfter=before-amount；
 *    余额不足 → BAD_REQUEST 人话文案（含现有/所需数值），绝不透支；
 *    并发竞态（影响行 0）→ 复查余额后同样人话拦截；
 *    amount=0 免费包 → 不扣费直接通过。
 * 3. 扣费 SQL 必须带 tokenBalance >= amount 条件（防负数的最后一道闸）。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

let balance: number | null; // null=无钱包行
let lastSql: string;
let lastParams: unknown[];
let lastMutationSql = "";

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
function sqlParamsOf(q: unknown): unknown[] {
  const chunks = (q as { queryChunks?: unknown[] } | null)?.queryChunks;
  if (!Array.isArray(chunks)) return [];
  const out: unknown[] = [];
  const walk = (c: unknown): void => {
    const rec = c as { constructor?: { name?: string }; value?: unknown; queryChunks?: unknown[] };
    if (rec?.constructor?.name === "StringChunk") return;
    if (rec && Array.isArray(rec.queryChunks)) {
      for (const cc of rec.queryChunks) walk(cc);
      return;
    }
    if (rec && typeof rec === "object" && "value" in rec) out.push(rec.value);
    else out.push(c);
  };
  for (const c of chunks) walk(c);
  return out;
}

vi.mock("./queries/connection", () => {
  const db = {
    execute: async (q: unknown) => {
      const t = sqlTextOf(q);
      lastSql = t;
      if (/\b(UPDATE|INSERT|DELETE)\b/.test(t)) lastMutationSql = t;
      lastParams = sqlParamsOf(q);
      if (/st_agent_work_tasks/.test(t)) return [[{ escrow_job_tokens: 0, taskNo: 'zero-task' }]];
      if (/SELECT tokenBalance FROM enterprises/.test(t)) {
        return [balance == null ? [] : [{ tokenBalance: balance }]];
      }
      if (/UPDATE enterprises SET tokenBalance/.test(t)) {
        const amount = Number(lastParams[0]);
        if (balance != null && balance >= amount) {
          balance -= amount;
          return [{ affectedRows: 1 }];
        }
        return [{ affectedRows: 0 }];
      }
      return [[]];
    },
    transaction: async (callback: (tx: never) => Promise<unknown>) => callback(db as never),
  };
  return { getDb: () => db };
  it("零释放只读余额，不再独占总钱包行", async () => {
    const result = await withEnterpriseEscrowTx(getDb() as never, async (_tx, escrow) => escrow.releaseEnterpriseEscrowWith(10, 1, 0));
    expect(result).toEqual({ availableAfter: 1000, releasedJobTokens: 0 });
    expect(lastSql).toContain('SELECT tokenBalance FROM enterprises');
    expect(lastSql).not.toContain('FOR UPDATE');
  });
});

vi.mock("./routers/terminal", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./routers/terminal")>();
  return { ...orig, rawRows: (r: unknown) => (Array.isArray(r) && Array.isArray(r[0]) ? r[0] : r) as Record<string, unknown>[] };
});

import { debitForPurchase, getFactoryTokenBalance, withEnterpriseEscrowTx } from "./routers/tokenLedger";
import { getDb } from "./queries/connection";

beforeEach(() => {
  balance = 1000;
  lastSql = "";
  lastParams = [];
});

describe("M34 Token 支付闭环", () => {
  it("余额读取：有行实数，无行 0", async () => {
    expect(await getFactoryTokenBalance(10)).toBe(1000);
    balance = null;
    expect(await getFactoryTokenBalance(10)).toBe(0);
  });

  it("扣费成功：balanceAfter 正确；SQL 带防透支闸", async () => {
    const r = await debitForPurchase({ factoryId: 10, amount: 600, packKey: "SP-X" });
    expect(r.balanceBefore).toBe(1000);
    expect(r.balanceAfter).toBe(400);
    expect(balance).toBe(400);
    expect(lastMutationSql).toContain("tokenBalance >=");
  });

  it("余额不足：人话拦截，绝不透支", async () => {
    balance = 300;
    await expect(debitForPurchase({ factoryId: 10, amount: 600, packKey: "SP-X" })).rejects.toThrow(/余额不足（现有 300，需 600）/);
    expect(balance).toBe(300); // 分文未动
  });

  it("无钱包行购买收费包 → 余额不足拦截；免费包（0）直接通过", async () => {
    balance = null;
    await expect(debitForPurchase({ factoryId: 10, amount: 100, packKey: "SP-Y" })).rejects.toThrow(/余额不足/);
    const r = await debitForPurchase({ factoryId: 10, amount: 0, packKey: "SP-FREE" });
    expect(r.balanceBefore).toBe(0);
    expect(r.balanceAfter).toBe(0);
  });
});
