/**
 * clientLog.report 截断+出声钉（NumX critical 修面）：
 * ① crumbs join 超 varchar(800) 截断钉（40×60+分隔=2517 > 800=严格模式 1406 静默断链面封死）
 * ② catch 出声钉（INSERT 失败 console.warn 留痕+仍 ok:true 不抛回客户端——信标宗旨与可观测双保）
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

let captured: unknown[] = []; // 累积面（同调用链 ops_access_log 二次 execute 不冲——push 不覆盖）
let insertFails = false;

vi.mock("./queries/connection", () => ({
  getDb: () => ({
    execute: async (stmt: unknown) => {
      // 递归扫 queryChunks 收嵌入参数（drizzle sql 模板面——参数值直接嵌在 chunks 里）
      const vals: unknown[] = [];
      const walk = (n: unknown): void => {
        if (Array.isArray(n)) { for (const x of n) walk(x); return; }
        if (n && typeof n === "object" && "queryChunks" in (n as Record<string, unknown>)) { walk((n as Record<string, unknown>).queryChunks); return; }
        if (typeof n === "string" && n.length > 0) vals.push(n);
      };
      walk(stmt);
      captured.push(...vals);
      if (insertFails) throw new Error("insert down 1406");
      return [[], []];
    },
  }),
}));

import { clientLogRouter } from "./routers/clientLog";
const caller = clientLogRouter.createCaller({} as never);

describe("clientLog.report 截断+出声钉", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { captured = []; insertFails = false; warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); });

  it("① 40 条×60 字 crumbs → 保尾 12 条+方向钉（本设施存在理由=崩后查最后几个动作）", async () => {
    const items = Array.from({ length: 40 }, (_, i) => `act${i}:${"a".repeat(54)}`); // 每条 ≤60 字（act39: 前缀 6 字符+54=60 不越 zod 帽）
    const r = await caller.report({ version: "2.9.58", phase: "crumbs", items });
    expect(r.ok).toBe(true);
    const trail = captured.find((v) => typeof v === "string" && (v as string).includes("act39"));
    expect(trail).toBeDefined(); // 方向钉①：最新动作必在（保尾——slice(0,·) 保头=把临终前拍成出生时的方向雷钉死）
    expect(trail as string).not.toContain("act0:"); // 方向钉②：最早动作已丢
    expect((trail as string).length).toBeLessThanOrEqual(800); // 列宽钉：12×60+11×3=753<800 永不超长
    expect((trail as string).length).toBeGreaterThan(700); // 信息量钉：真保留 12 条不是丢光
    expect((trail as string).match(/act\d+:/g)?.length).toBe(12); // 条边界钉：不切半标签
  });

  it("② error 与 items 同给时 error 优先（?? 语义钉）", async () => {
    const r = await caller.report({ version: "2.9.58", phase: "js_error", error: "boom-msg", items: ["x"] });
    expect(r.ok).toBe(true);
    expect(captured.some((v) => v === "boom-msg")).toBe(true);
    expect(captured.some((v) => typeof v === "string" && v === "x")).toBe(false);
  });

  it("③ INSERT 失败 → console.warn 出声 + 仍 ok:true（出声钉）", async () => {
    insertFails = true;
    const r = await caller.report({ version: "2.9.58", phase: "ready" });
    expect(r.ok).toBe(true); // 不抛回客户端
    expect(warnSpy).toHaveBeenCalledOnce(); // 服务端留痕
    expect(String(warnSpy.mock.calls[0][1])).toContain("insert down");
  });
});
