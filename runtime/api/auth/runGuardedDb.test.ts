import { describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import { runGuardedDb, INFRA_UNAVAILABLE_MESSAGE } from "./identity";

describe("runGuardedDb 分类契约", () => {
  it("dupPassthrough：重复键原错透出，不包装成 infra 500", async () => {
    const dup = { code: "ER_DUP_ENTRY" };
    await expect(runGuardedDb(async () => { throw dup; }, "test.dup", "missing", { dupPassthrough: true })).rejects.toBe(dup);
  });

  it("普通 TRPCError 仍按原分类脱敏为 infra 500", async () => {
    const err = new TRPCError({ code: "CONFLICT", message: "conflict" });
    await expect(runGuardedDb(async () => { throw err; }, "test.conflict", "missing")).rejects.toThrow(INFRA_UNAVAILABLE_MESSAGE);
  });

  it("1146 表不存在=PRECONDITION_FAILED 且保留 missingMsg", async () => {
    await expect(runGuardedDb(async () => { throw { errno: 1146 }; }, "test.missing", "表未就绪")).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "表未就绪" });
  });
});
