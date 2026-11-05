/** 记忆隔离行为钉（哨兵实证坐实的高危面——契约⑦成立；userIdOfSession 派生钉+recall 过滤钉）。 */
import { describe, it, expect } from "vitest";
import { userIdOfSession } from "./harness/memoryBridge";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("./harness/memoryBridge.ts", import.meta.url), "utf-8");

describe("记忆隔离钉（哨兵实证面——契约⑦成立）", () => {
  it("userIdOfSession：dsh:u42:lingshu→u42 派生（不写死 harness）", () => {
    expect(userIdOfSession("dsh:u42:lingshu")).toBe("42"); // uid 数字面（正则捕 \d+——u 前缀不进）
    expect(userIdOfSession("dsh:u7:xingyun")).toBe("7");
    expect(userIdOfSession("")).toBe("anon"); // 非约定形=原样兜（不炸）
    expect(userIdOfSession("corp:x")).toBe("corp:x"); // 非 dsh 面原样
  });

  it("captureEvent 不写死 harness（user_id=userIdOfSession 派生面）", () => {
    expect(SRC).toContain('user_id: userIdOfSession(sessionKey)'); // capture 面
    expect(SRC).not.toContain('user_id: "harness"'); // ★写死面摘净
    expect(SRC).not.toContain('user_id:"harness"');
  });

  it("recall 带 session_key 过滤面（网关 L1-query 的 sessionKey 收敛面用起来了）", () => {
    expect(SRC).toContain('session_key: _sessionKey'); // recall 带 session 过滤
    expect(SRC).not.toContain('"/search/memories", { query, limit: 5 }'); // 旧的不带 session 面摘净
  });

  it("endMemorySession 同派生面", () => {
    expect(SRC).toContain('user_id: userIdOfSession(sessionKey)'); // end 面同派生
  });
});
