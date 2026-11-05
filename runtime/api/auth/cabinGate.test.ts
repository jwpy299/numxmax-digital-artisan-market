import { afterEach, describe, expect, it, vi } from "vitest";
import { cabinIdentityOf } from "./cabinGate";

const user = (id: number, username: string) => ({ id, username, displayName: username }) as never;
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("cabinGate 配置形状与不可变 id 通道", () => {
  it("用户名通道逐段 trim，合法三元组正常授权", () => {
    vi.stubEnv("ADMIN_CABIN_ROLES", " peng : admin : all , qiu:ops:ops");
    expect(cabinIdentityOf(user(1, "peng")).cabinRole).toBe("admin");
    expect(cabinIdentityOf(user(3, "qiu")).cabinRole).toBe("ops");
  });

  it("四元组/空段配置不误授权，坏角色只读", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("ADMIN_CABIN_ROLES", "peng:admin:all:extra,qiu: owner :ops");
    expect(cabinIdentityOf(user(1, "peng")).cabinRole).toBe("staff");
    expect(cabinIdentityOf(user(3, "qiu")).cabinRole).toBe("staff");
  });

  it("无效 id/角色配置也显式拒绝并留痕，不静默保留坏规则", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("ADMIN_CABIN_IDS", "007:tech:tech,abc:owner:tech");
    expect(cabinIdentityOf(user(7, "peng")).cabinRole).toBe("staff");
    expect(console.warn).toHaveBeenCalled();
  });

  it("用户名按 CI 单源匹配，大小写变体不意外失去授权", () => {
    vi.stubEnv("ADMIN_CABIN_ROLES", "peng:admin:all");
    expect(cabinIdentityOf(user(1, "PENG")).cabinRole).toBe("admin");
  });

  it("ID 通道按席位命名空间分带：委派/原生同数字 id 不撞 wb 席位", () => {
    vi.stubEnv("ADMIN_CABIN_IDS", "1000000000007:tech:tech,2000000000007:ops:ops");
    const delegated = { id: 7, username: "staff", displayName: "staff", delegated: true, kind: "staff" } as never;
    const native = { id: 7, username: "native", displayName: "native", delegated: true, adminOrigin: "native" } as never;
    expect(cabinIdentityOf(delegated).cabinRole).toBe("tech");
    expect(cabinIdentityOf(delegated).auditId).toBe(1000000000007);
    expect(cabinIdentityOf(native).cabinRole).toBe("ops");
    expect(cabinIdentityOf(native).auditId).toBe(2000000000007);
    expect(cabinIdentityOf(user(7, "wb")).cabinRole).toBe("staff");
  });

  it("ADMIN_CABIN_IDS 配置后只按 id：同名新号不继承，id 命中才授权", () => {
    vi.stubEnv("ADMIN_CABIN_IDS", "7:tech:tech");
    vi.stubEnv("ADMIN_CABIN_ROLES", "peng:admin:all");
    expect(cabinIdentityOf(user(7, "other")).cabinRole).toBe("tech");
    expect(cabinIdentityOf(user(8, "other")).cabinRole).toBe("staff");
    expect(cabinIdentityOf(user(8, "peng")).cabinRole).toBe("staff");
  });
});
