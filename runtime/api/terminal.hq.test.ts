/**
 * terminal.requireAdmin 本厂闸门（M48d）单测。
 *
 * 彭总口径：超级终端管理后台只对广东灵智枢生态科技有限公司开放。
 * 闸点：
 * 1. HQ_FACTORY_IDS 已配置：本厂 admin 通过；外厂 admin 拒（口径文案精确）；
 * 2. 未配置：wb_users 路径 fail-closed 全拒（绝不裸奔）；
 * 3. 委派账号（st_staff head + 名单内）不受 HQ 闸影响（读救通道）；
 * 4. 多值配置（逗号分隔）全部放行；
 * 5. disabled 用户即使本厂也拒。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// drizzle 链式 mock：select().from().where().limit() → [user]
const limitMock = vi.fn();
const executeMock = vi.fn();
vi.mock("../api/queries/connection", () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: limitMock }) }) }),
    execute: executeMock,
  }),
}));

import { hqFactoryIds, requireAdmin, requireHqAdmin } from "./routers/terminal";

const HQ = "6290209";

function primeWbUser(user: Record<string, unknown> | null, disabledRows: unknown[] = [[{ disabled: 0 }]]) {
  limitMock.mockResolvedValue(user ? [user] : []);
  executeMock.mockResolvedValue(disabledRows);
}

beforeEach(() => {
  limitMock.mockReset();
  executeMock.mockReset();
  delete process.env.HQ_FACTORY_IDS;
});

describe("hqFactoryIds 解析", () => {
  it("未配置/空串/脏值 → 空数组；多值逗号分隔", () => {
    expect(hqFactoryIds()).toEqual([]);
    process.env.HQ_FACTORY_IDS = "";
    expect(hqFactoryIds()).toEqual([]);
    process.env.HQ_FACTORY_IDS = "abc, 0, -3";
    expect(hqFactoryIds()).toEqual([]);
    process.env.HQ_FACTORY_IDS = "6290209, 6290210";
    expect(hqFactoryIds()).toEqual([6290209, 6290210]);
  });
});

describe("requireHqAdmin 本厂闸门", () => {
  it("本厂 admin → 通过", async () => {
    process.env.HQ_FACTORY_IDS = HQ;
    primeWbUser({ id: 1, username: "boss", role: "admin", factoryId: 6290209 });
    const u = await requireHqAdmin("nt_ok");
    expect(u.username).toBe("boss");
  });

  it("外厂 admin → 拒，口径「仅对广东灵智枢生态科技有限公司开放」", async () => {
    process.env.HQ_FACTORY_IDS = HQ;
    primeWbUser({ id: 2, username: "outsider", role: "admin", factoryId: 6299999 });
    await expect(requireHqAdmin("nt_no")).rejects.toThrow("超级终端仅对广东灵智枢生态科技有限公司开放");
  });

  it("HQ 未配置 → wb_users 路径 fail-closed 全拒", async () => {
    primeWbUser({ id: 1, username: "boss", role: "admin", factoryId: 6290209 });
    await expect(requireHqAdmin("nt_ok")).rejects.toThrow();
  });

  it("委派账号（名单内 head）不受 HQ 闸影响，未配置也可进", async () => {
    // wb_users 未命中；st_staff_accounts 命中名单内 head
    limitMock.mockResolvedValue([]);
    executeMock.mockResolvedValue([[{ id: 9, username: "18024101277", displayName: "COO", role: "head", disabled: 0 }]]);
    const u = await requireHqAdmin("st_token");
    expect(u.role).toBe("admin");
    expect(String(u.displayName)).toContain("委派管理员");
  });

  it("多值配置：两个厂号都放行", async () => {
    process.env.HQ_FACTORY_IDS = "6290209,6290210";
    primeWbUser({ id: 3, username: "a2", role: "admin", factoryId: 6290210 });
    const u = await requireHqAdmin("nt_ok2");
    expect(u.username).toBe("a2");
  });

  it("本厂但 disabled → 拒", async () => {
    process.env.HQ_FACTORY_IDS = HQ;
    primeWbUser({ id: 1, username: "boss", role: "admin", factoryId: 6290209 }, [[{ disabled: 1 }]]);
    await expect(requireHqAdmin("nt_ok")).rejects.toThrow();
  });

  it("非 admin 角色（member）→ 走委派也空 → 拒", async () => {
    process.env.HQ_FACTORY_IDS = HQ;
    limitMock.mockResolvedValue([{ id: 4, username: "m", role: "member", factoryId: 6290209 }]);
    executeMock.mockResolvedValue([[]]);
    await expect(requireHqAdmin("nt_m")).rejects.toThrow();
  });
});

describe("requireAdmin 通用守卫不带本厂闸（duty-chat/deptConsole 等企业路径回归护栏）", () => {
  it("HQ 未配置：普通企业 admin 仍放行（fail-closed 只属 requireHqAdmin）", async () => {
    primeWbUser({ id: 5, username: "entboss", role: "admin", factoryId: 6299999 });
    const u = await requireAdmin("nt_ent");
    expect(u.username).toBe("entboss");
  });

  it("HQ 已配置：外厂 admin 走通用守卫也放行（本厂闸仅限超级终端过程）", async () => {
    process.env.HQ_FACTORY_IDS = HQ;
    primeWbUser({ id: 6, username: "entboss2", role: "admin", factoryId: 6299999 });
    const u = await requireAdmin("nt_ent2");
    expect(u.username).toBe("entboss2");
  });
});
