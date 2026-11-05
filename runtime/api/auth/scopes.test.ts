/**
 * 四层四锁·矩阵钉测试（批七-a）：策略字面量改动必须过彭总拍板——
 *  全格逐格钉死，改一格即红；fail-closed 方向（未知角色/舱域 → none）同钉。
 */
import { describe, expect, it } from "vitest";
import { ACCESS_MATRIX, CABIN_LABELS, CABINS, ROLES, accessOf, doorRule, type Access } from "./scopes"; // R7-c3-③：canRead/canWrite 摘除，测试直钉门规单点 doorRule（神谕与实现不再同源）

describe("四层四锁·权限矩阵全格钉死（改一格即红=改策略）", () => {
  it("矩阵形状完整：四角色×三舱域全覆盖", () => {
    for (const r of ROLES) for (const c of CABINS) {
      expect(["write", "read", "none"]).toContain(ACCESS_MATRIX[r][c]);
    }
  });

  it("老板 boss：三舱全权", () => {
    for (const c of CABINS) expect(accessOf("boss", c)).toBe("write");
  });

  it("管理 admin：代码舱写、训练舱读、蒸馏舱读", () => {
    expect(accessOf("admin", "code")).toBe("write");
    expect(accessOf("admin", "training")).toBe("read");
    expect(accessOf("admin", "distill")).toBe("read");
  });

  it("员工 staff：训练舱写、代码舱/蒸馏舱 none", () => {
    expect(accessOf("staff", "training")).toBe("write");
    expect(accessOf("staff", "code")).toBe("none");
    expect(accessOf("staff", "distill")).toBe("none");
  });

  it("访客 guest：全 none（登录即最低权限）", () => {
    for (const c of CABINS) expect(accessOf("guest", c)).toBe("none");
  });

  it("fail-closed：未知角色/舱域一律 none", () => {
    expect(accessOf("ceo" as never, "code")).toBe("none");
    expect(accessOf("admin", "finance" as never)).toBe("none");
  });

  it("读闸/写闸谓词与矩阵同义（read/write 可读，仅 write 可写）", () => {
    const expectPair = (r: (typeof ROLES)[number], c: (typeof CABINS)[number], rd: boolean, wr: boolean) => {
      expect(doorRule(accessOf(r, c), 'read')).toBe(rd);
      expect(doorRule(accessOf(r, c), 'write')).toBe(wr);
    };
    expectPair("boss", "code", true, true);
    expectPair("admin", "training", true, false);
    expectPair("staff", "training", true, true);
    expectPair("staff", "code", false, false);
    expectPair("guest", "distill", false, false);
  });

  it("舱域中文名单点：三舱齐且不落英文", () => {
    expect(CABIN_LABELS.code).toBe("代码舱");
    expect(CABIN_LABELS.training).toBe("训练舱");
    expect(CABIN_LABELS.distill).toBe("蒸馏舱");
  });
});
