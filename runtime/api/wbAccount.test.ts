/**
 * M35 账号注销验收单测（PIPL 硬项）：
 * 1. 个人游离账号：确认口令正确 → PII 全清 + username 匿名化 + token 置空；
 * 2. 口令错误 → 拒（防误触），账号原样；
 * 3. 在企 staff/manager → 拒（先移出企业）；
 * 4. 在企 admin → 拒（先转让/解散）；
 * 5. 无效 token → UNAUTHORIZED。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { authTokenHash } from "./auth/revocation"; // P3-6 落库哈希单点
import { TRPCError } from "@trpc/server";

interface UserFake {
  id: number;
  username: string;
  displayName: string;
  phone: string | null;
  realName: string | null;
  idCardMasked: string | null;
  idCardHash: string | null;
  passwordHash: string;
  authToken: string | null;
  factoryId: number;
  role: string;
  kind: string;
}
let users: UserFake[];

vi.mock("./queries/connection", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: (cond: unknown) => ({
          limit: async () => {
            // drizzle eq(authToken, token) 的条件对象里抠出查询值——P3-6 双轨后明文腿是 and(eq, guard) 嵌套形态，递归抠（and() 的 queryChunks 里子条件是嵌套 SQL 对象，平扫抠不到=有效 token 全灭）
            const dig = (chunks: unknown[]): string => {
              for (const c of chunks) {
                const v = (c as { value?: unknown })?.value;
                if (typeof v === "string" && v.startsWith("nt_")) return v;
                const inner = (c as { queryChunks?: unknown[] })?.queryChunks;
                if (Array.isArray(inner)) { const r = dig(inner); if (r) return r; }
              }
              return "";
            };
            const queried = dig((cond as { queryChunks?: unknown[] })?.queryChunks ?? []);
            const u = users.find((x) => x.authToken === queried);
            return u ? [{ ...u }] : [];
          },
        }),
      }),
    }),
    update: () => ({
      set: (vals: Partial<UserFake>) => ({
        where: async () => {
          const u = users.find((x) => x.authToken === "nt_live" || x.authToken === authTokenHash("nt_live")); // P3-6：resolveWbUserByToken 惰性迁移会把行改写为指纹——mock 两形同匹（close() 的 set(authToken:null) 不再因迁移丢目标）
          if (u) Object.assign(u, vals);
          return [{ affectedRows: u ? 1 : 0 }];
        },
      }),
    }),
    execute: async () => [[]],
  }),
}));
vi.mock("./routers/adminAnalytics", () => ({ writeAdminAudit: vi.fn() }));

import { wbAccountRouter } from "./routers/wbAccount";

const caller = wbAccountRouter.createCaller({} as never);

function seed(u: Partial<UserFake>): void {
  users = [
    {
      id: 7,
      username: "13900000001",
      displayName: "张三",
      phone: "13900000001",
      realName: "张三",
      idCardMasked: "1101**********1234",
      idCardHash: "abc",
      passwordHash: "salt:hash",
      authToken: "nt_live",
      factoryId: 0,
      role: "member",
      kind: "person",
      ...u,
    },
  ];
}

beforeEach(() => {
  seed({});
});

describe("M35 账号注销", () => {
  it("个人游离账号：确认注销 → PII 全清+匿名化+token 置空", async () => {
    const r = await caller.close({ token: "nt_live", confirmText: "确认注销" });
    expect(r.ok).toBe(true);
    const u = users[0]!;
    expect(u.username).toBe("closed_7");
    expect(u.displayName).toBe("已注销用户");
    expect(u.phone).toBeNull();
    expect(u.realName).toBeNull();
    expect(u.idCardMasked).toBeNull();
    expect(u.idCardHash).toBeNull();
    expect(u.authToken).toBeNull();
    expect(u.passwordHash).not.toBe("salt:hash");
  });

  it("口令错误 → 拒，账号原样", async () => {
    await expect(caller.close({ token: "nt_live", confirmText: "确认" })).rejects.toThrow(/确认注销/);
    expect(users[0]!.phone).toBe("13900000001");
  });

  it("在企员工 → 拒（先移出企业）", async () => {
    seed({ factoryId: 100, role: "member", kind: "enterprise" });
    await expect(caller.close({ token: "nt_live", confirmText: "确认注销" })).rejects.toThrow(/移出企业/);
    expect(users[0]!.phone).toBe("13900000001");
  });

  it("在企管理员 → 拒（先转让或解散）", async () => {
    seed({ factoryId: 100, role: "admin", kind: "enterprise" });
    await expect(caller.close({ token: "nt_live", confirmText: "确认注销" })).rejects.toThrow(/管理员/);
  });

  it("无效 token → UNAUTHORIZED", async () => {
    await expect(caller.close({ token: "nt_dead", confirmText: "确认注销" })).rejects.toThrow(/无效/);
  });
});
