/**
 * M65 admin.ts requireAdmin 第三层回退闸（nt_ 踢出事故修复回归）。
 *
 * 事故：admin.ts 本地 requireAdmin 只认 wb_users/staff 两层，nt_ 原生 token 打开
 * admin.overview 即 401「token 无效」→ 前端 isWbAuthError 全局清会话 → 超终登录后秒退。
 * 本闸：nt_ token 在 wb_users/staff 双双落空后，必须由 st_admin_accounts 接住放行。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { hashPassword } from "./routers/wbSession";

type Row = Record<string, unknown>;
let nativeAccounts: Row[] = [];

vi.mock("./queries/connection", async () => {
  const { MySqlDialect } = await import("drizzle-orm/mysql-core");
  const dialect = new MySqlDialect();
  /** drizzle select 链假：wb_users 恒空（本闸只关心 native 回退） */
  const emptySelectChain = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "where", "limit", "orderBy", "groupBy", "leftJoin", "innerJoin"]) {
      chain[m] = () => emptySelectChain();
    }
    // 注意：then 绝不能落在初始对象上（in 检查会拦截 Proxy 的 thenable 分支）
    return new Proxy(chain as object, {
      get(t, p) {
        if (p === Symbol.iterator) return undefined;
        if (p in t) return (t as Record<string, unknown>)[p as string];
        // 直接 await 链末端时按空数组 resolve
        if (p === "then") return (resolve: (v: unknown) => void) => resolve([]);
        return () => emptySelectChain();
      },
    });
  };
  return {
    getDb: () => ({
      select: () => emptySelectChain(),
      execute: async (stmt: unknown) => {
        const q = dialect.sqlToQuery(stmt as never);
        const text: string = q.sql;
        const params = q.params as unknown[];
        // 真实 drizzle mysql2 execute 返回 [rows, fields]（rawRows 取 [0]）
        // st_staff_accounts 委派查询：恒空
        if (text.includes("st_staff_accounts")) return [[]] as never;
        // wb_users disabled 复查：恒空
        if (text.includes("FROM wb_users")) return [[]] as never;
        // native：authToken 命中
        if (text.includes("st_admin_accounts")) {
          // P3-6 指纹面适配（adminAuth 对齐票配套）：新版查询先 hash 指纹后明文腿——params[0]=hash、明文腿在 params[1]，桩按「params 含明文」匹配
          const tok = params.find((p) => typeof p === "string" && String(p).startsWith("nt_"));
          return [nativeAccounts.filter((a) => a.authToken === tok).slice(0, 1)] as never;
        }
        return [[]] as never;
      },
    }),
  };
});

import { requireAdmin } from "./routers/admin";

describe("M65 admin.ts requireAdmin 第三层（nt_ 踢出事故回归）", () => {
  beforeEach(() => {
    nativeAccounts = [];
  });

  it("nt_ token：wb_users/staff 落空 → native 接住放行（delegated + adminOrigin）", async () => {
    nativeAccounts.push({
      id: 1,
      username: "lingshu_root",
      phone: null,
      passwordHash: hashPassword("x"),
      displayName: "灵枢超管",
      role: "super",
      disabled: 0,
      authToken: "nt_abc123",
    });
    const admin = await requireAdmin("nt_abc123");
    expect(admin.username).toBe("lingshu_root");
    expect(String(admin.displayName)).toContain("超终");
    expect((admin as unknown as { adminOrigin: string }).adminOrigin).toBe("native");
    expect((admin as unknown as { delegated: boolean }).delegated).toBe(true);
  });

  it("native 账号 disabled=1 → 不放行（UNAUTHORIZED）", async () => {
    nativeAccounts.push({
      id: 2,
      username: "probe",
      phone: null,
      passwordHash: hashPassword("x"),
      displayName: "探针",
      role: "admin",
      disabled: 1,
      authToken: "nt_dead",
    });
    await expect(requireAdmin("nt_dead")).rejects.toThrow();
  });

  it("三层全空 → UNAUTHORIZED（口径不泄露）", async () => {
    await expect(requireAdmin("nt_ghost")).rejects.toThrow();
  });
});
