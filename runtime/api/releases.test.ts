/**
 * releases 发布观测板端点单测（Harness P0-③④）：
 * 1. 管理员 token 放行 → 返回 live boot.js md5/mtime（与磁盘真实文件一致）。
 * 2. artifacts 目录不存在 → 空清单降级，不抛错。
 * 3. 非管理员 → 拒绝（requireAdmin 抛出）。
 * 4. 回滚指引：面板只读，command 指向本机 artifacts/rollback.sh，不执行。
 */
import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

vi.mock("./queries/connection", () => ({ getDb: () => ({ execute: async () => [[]] }) }));
vi.mock("./routers/terminal", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./routers/terminal")>();
  return {
    ...orig,
    requireAdmin: async (token: string) => {
      if (token !== "TEST_admin") throw new Error("管理员凭证无效");
      return { id: 1, username: "TEST_admin" };
    },
    // M48d：board 已切 requireHqAdmin（本厂闸），测试口径同胚 mock
    requireHqAdmin: async (token: string) => {
      if (token !== "TEST_admin") throw new Error("管理员凭证无效");
      return { id: 1, username: "TEST_admin" };
    },
  };
});

import { releasesRouter } from "./routers/releases";

const caller = releasesRouter.createCaller({} as never);

describe("releases.board 发布观测板", () => {
  it("管理员放行：live md5 与磁盘 boot.js 一致；无制品库时空清单降级", async () => {
    const r = await caller.board({ token: "TEST_admin" });
    // live boot.js md5 与真实文件一致（8 位短码口径）
    const boot = path.join(process.cwd(), "dist", "boot.js");
    const buf = await fs.readFile(boot);
    const expectMd5 = createHash("md5").update(buf).digest("hex").slice(0, 8);
    expect(r.liveBootMd5).toBe(expectMd5);
    expect(r.liveBootMtime).toBeTruthy();
    // artifacts 未初始化 → 空清单不抛错
    expect(Array.isArray(r.artifacts)).toBe(true);
    expect(Array.isArray(r.log)).toBe(true);
    // 回滚指引只读：指向 rollback.sh，面板不执行
    expect(r.rollback.command).toContain("rollback.sh");
    expect(r.rollback.note).toContain("只读");
  });

  it("非管理员 → 拒绝", async () => {
    await expect(caller.board({ token: "TEST_nope" })).rejects.toThrow(/管理员凭证无效/);
  });
});
