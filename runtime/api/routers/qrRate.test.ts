import { describe, expect, it } from "vitest";
import { bumpQrRate } from "./qrLoginShared";

function dbWithRows(rows: unknown) {
  let calls = 0;
  return {
    transaction: async (fn: (tx: { execute: (sql: unknown) => Promise<unknown> }) => Promise<unknown>) => fn({
      execute: async () => {
        calls += 1;
        return calls === 1 ? [{ affectedRows: 1 }, []] : [rows, []];
      },
    }),
  };
}

describe("QR 限流计数读回 fail-closed", () => {
  it("缺行不折算 0 次放行", async () => {
    await expect(bumpQrRate(dbWithRows([]) as never, "test:missing", "2026-10-25T00:00")).rejects.toThrow("读回异常");
  });
  it("0/NaN/负数均不接受", async () => {
    for (const n of [0, "not-a-number", -1]) {
      await expect(bumpQrRate(dbWithRows([{ n }]) as never, `test:${String(n)}`, "2026-10-25T00:00")).rejects.toThrow("读回异常");
    }
  });
});
