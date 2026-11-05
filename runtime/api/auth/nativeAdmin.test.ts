/**
 * nativeAdmin 形状闸钉（批七-c R7-c45-④）：st_admin_accounts schema 漂移不变式全钉——
 *  coerceFiniteId：null/undefined/""/" "/"1.5"/NaN 全拒；toAdminAccountRow：空串列全拒；
 *  findNativeAdminByToken：ER_NO_SUCH_TABLE → null（pre-migration 降级），真 infra 上行。
 */
import { describe, expect, it, vi } from "vitest";

let execThrows: unknown = null;
let execRows: unknown[] = [];

vi.mock("../queries/connection", () => ({
  getDb: () => ({
    execute: async () => {
      if (execThrows) throw execThrows;
      return [execRows, []];
    },
  }),
}));

import { coerceFiniteId, toAdminAccountRow, findNativeAdminByToken } from "./nativeAdmin";

const goodRow = { id: 1, username: "u", passwordHash: "x", displayName: "d", role: "admin", disabled: 0, authToken: null };

describe("coerceFiniteId 字段闸（在场性+finite+整数）", () => {
  it("缺列/空串/空白串/非数字/非整数/NaN 全拒", () => {
    for (const bad of [null, undefined, "", " ", "1.5", "abc", NaN]) {
      expect(() => coerceFiniteId(bad, "id")).toThrow(/schema 漂移/);
    }
  });
  it("数字与数字串通过（强转 number）", () => {
    expect(coerceFiniteId(7, "id")).toBe(7);
    expect(coerceFiniteId("7", "id")).toBe(7);
  });
});

describe("toAdminAccountRow 行闸", () => {
  it("完好行通过", () => {
    expect(toAdminAccountRow({ ...goodRow }).username).toBe("u");
  });
  it("空串/缺列全拒（username/passwordHash/role/displayName）", () => {
    for (const key of ["username", "passwordHash", "role", "displayName"] as const) {
      expect(() => toAdminAccountRow({ ...goodRow, [key]: "" })).toThrow(/schema 漂移/);
      expect(() => toAdminAccountRow({ ...goodRow, [key]: undefined })).toThrow(/schema 漂移/);
    }
  });
});

describe("findNativeAdminByToken 降级口径", () => {
  it("ER_NO_SUCH_TABLE → null（pre-migration 容忍）", async () => {
    const e = new Error("no table") as Error & { code: string };
    e.code = "ER_NO_SUCH_TABLE";
    execThrows = e;
    expect(await findNativeAdminByToken("nt_x")).toBeNull();
    execThrows = null;
  });
  it("真 infra 错误上行（不静默）", async () => {
    execThrows = new Error("conn down");
    await expect(findNativeAdminByToken("nt_x")).rejects.toThrow("conn down");
    execThrows = null;
  });
});
