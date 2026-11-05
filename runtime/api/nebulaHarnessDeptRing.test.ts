/**
 * M80 小环完整化测试（彭总校正语义：小环=部门级 Nebula Harness，大环管小环）。
 * 1. canDecide 矩阵（纯函数）：负责人全域/主管本部/跨厂永不/非部门提案主管不可；
 * 2. deptDecide 端点：approve→applied（复用落地）、reject 留痕、权限/状态闸；
 * 3. 输送带双闸：大环本厂过滤（factory_id=HQ 入 SQL）、小环 deptKey 定向过滤。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

let seenSql: string[] = [];
let proposals: Array<Record<string, unknown>> = [];
let authUser: Record<string, unknown> | null = null;
let skillUpdated: string[] = [];

const dialect = new MySqlDialect();
vi.mock("./queries/connection", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (authUser ? [authUser] : []),
        }),
      }),
    }),
    execute: async (stmt: unknown) => {
      const q = dialect.sqlToQuery(stmt as never);
      const text = q.sql.trim().replace(/\s+/g, " ");
      seenSql.push(text);
      if (text.startsWith("SELECT") && text.includes("FROM st_evo_proposals WHERE id =")) {
        const id = Number(q.params[0]);
        return [proposals.filter((p) => Number(p.id) === id)];
      }
      if (text.startsWith("UPDATE st_evo_proposals")) return [{ affectedRows: 1 }];
      if (text.startsWith("UPDATE st_agent_skills")) {
        skillUpdated.push(text);
        return [{ affectedRows: 1 }];
      }
      if (text.includes("FROM st_skills WHERE skill_key")) return [[]];
      if (text.startsWith("INSERT INTO st_skills")) return [{ insertId: 1 }];
      return [[]];
    },
  }),
}));

import { canDecide, deptOfTargetKey, hqFactoryIdOf, deptRingRouter } from "./harness/deptRing";
import { runConveyor } from "./harness/conveyor";

const caller = deptRingRouter.createCaller({} as never);

beforeEach(() => {
  seenSql = []; proposals = []; skillUpdated = []; authUser = null;
  process.env.HQ_FACTORY_IDS = "6290209";
});

describe("M80 canDecide 权限矩阵（纯函数）", () => {
  const P = { factory_id: 6290209, target_key: "crash@tech" };
  it("企业负责人（owner/admin）全域可拍", () => {
    expect(canDecide({ userId: 1, username: "a", factoryId: 6290209, role: "owner", departmentId: null }, P)).toBe(true);
    expect(canDecide({ userId: 1, username: "a", factoryId: 6290209, role: "admin", departmentId: null }, P)).toBe(true);
  });
  it("部门主管仅本部；跨部门拒；跨厂永不", () => {
    const mgr = { userId: 2, username: "m", factoryId: 6290209, role: "manager", departmentId: "tech" };
    expect(canDecide(mgr, P)).toBe(true);
    expect(canDecide(mgr, { factory_id: 6290209, target_key: "crash@ops" })).toBe(false);
    expect(canDecide(mgr, { factory_id: 6350239, target_key: "crash@tech" })).toBe(false);
    expect(canDecide({ ...mgr, role: "staff" }, P)).toBe(false);
    expect(canDecide({ ...mgr, departmentId: null }, P)).toBe(false);
  });
  it("非部门定向提案（无 @dept 尾缀）主管不可拍", () => {
    expect(canDecide(
      { userId: 2, username: "m", factoryId: 6290209, role: "manager", departmentId: "tech" },
      { factory_id: 6290209, target_key: "crash@resonance" },
    )).toBe(false); // resonance 是企业环合并案，主管无此权
  });
  it("deptOfTargetKey 口径 + hqFactoryIdOf", () => {
    expect(deptOfTargetKey("crash@tech")).toBe("tech");
    expect(deptOfTargetKey("crash@resonance")).toBe("resonance");
    expect(deptOfTargetKey("plain")).toBeNull();
    expect(hqFactoryIdOf()).toBe(6290209);
    delete process.env.HQ_FACTORY_IDS;
    expect(hqFactoryIdOf()).toBeNull();
  });
});

describe("M80 deptDecide 端点", () => {
  const mk = (over: Partial<Record<string, unknown>> = {}) => {
    proposals = [{
      id: 501, factory_id: 6290209, skill_key: "k1", proposal_type: "optimize",
      title: "t", status: "pending", target_key: "crash@tech", ...over,
    }];
  };
  const techMgr = { id: 2, username: "tech_mgr", role: "manager", factoryId: 6290209, departmentId: "tech", disabled: 0 };
  const owner = { id: 1, username: "boss", role: "owner", factoryId: 6290209, departmentId: null, disabled: 0 };

  it("部门主管拍本部小环提案：approve→applied + 技能 revisions 落地", async () => {
    mk();
    authUser = techMgr;
    const r = await caller.deptDecide({ token: "x", proposalId: 501, approve: true });
    expect(r.status).toBe("applied");
    expect(skillUpdated.some((t) => t.includes("revisions"))).toBe(true);
  });
  it("负责人拍小环（全域权）+ reject 留痕", async () => {
    mk();
    authUser = owner;
    const r = await caller.deptDecide({ token: "x", proposalId: 501, approve: false, reason: "缓一缓" });
    expect(r.status).toBe("rejected");
  });
  it("主管拍别部提案 → FORBIDDEN；跨厂 → NOT_FOUND；已处理 → BAD_REQUEST", async () => {
    mk({ target_key: "crash@ops" });
    authUser = techMgr;
    await expect(caller.deptDecide({ token: "x", proposalId: 501, approve: true })).rejects.toThrow("仅企业负责人或本部门主管");
    mk({ factory_id: 6350239 });
    await expect(caller.deptDecide({ token: "x", proposalId: 501, approve: true })).rejects.toThrow("提案不存在");
    mk({ status: "applied" });
    authUser = owner;
    await expect(caller.deptDecide({ token: "x", proposalId: 501, approve: true })).rejects.toThrow("不可重复审批");
  });
});

describe("M80 输送带双闸（大环本厂 + 小环定向）", () => {
  it("大环：SQL 带 factory_id=HQ 过滤（租户提案不进平台施工链）", async () => {
    await runConveyor({ domain: "enterprise", scope: "factory", evoOptOut: false });
    const q = seenSql.find((s) => s.includes("construct:queued"))!;
    expect(q).toContain("p.factory_id =");
    expect(q).not.toContain("target_key LIKE");
  });
  it("小环：scope=dept + deptKey → 追加 target_key 尾缀过滤", async () => {
    await runConveyor({ domain: "enterprise", scope: "dept", evoOptOut: false, deptKey: "tech" });
    const q = seenSql.find((s) => s.includes("construct:queued"))!;
    expect(q).toContain("p.factory_id =");
    expect(q).toContain("target_key LIKE");
  });
});
