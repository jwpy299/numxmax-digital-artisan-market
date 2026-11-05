/**
 * dataLifecycle 闸钉（契约②——新表票必填保留期面的机器守门）：
 *  ① 新表闸：本仓 api/ 面 CREATE TABLE 每表必在台账（缺=红——新表不带生命周期声明不许进）；
 *  ② 幻影不养反向钉：台账每表必在双仓 DDL 面有落点（台账收幽灵表=红）；
 *  ③ 诚实面钉：cleanup 写了机制名的表，机制必须在代码里真实存在（宣称=实现——写 none 不扣分，写机制必须有其物）。
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { DATA_LIFECYCLE } from "@contracts/dataLifecycle";

/** 递归收 api/ 下全部 .ts（跳测试件）→ [路径, 文本] 对 */
function collectSources(apiDir: URL): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (u: URL) => {
    for (const e of readdirSync(u, { withFileTypes: true })) {
      const p = new URL(u.toString() + (u.toString().endsWith("/") ? "" : "/") + e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith(".ts") || e.name.endsWith(".test.ts")) continue;
      out.push([e.name, readFileSync(p, "utf-8")]);
    }
  };
  walk(apiDir);
  return out;
}

const OWN = collectSources(new URL("./", import.meta.url));
const WB_SYNC_BASE = process.env.WB_SYNC_BASE ?? "../../wb";
const OTHER = collectSources(new URL(`${WB_SYNC_BASE}/api/`, import.meta.url));
const ALL_SRC = [...OWN, ...OTHER];
const tableSet = (srcs: Array<[string, string]>) => {
  const s = new Set<string>();
  for (const [, t] of srcs) for (const m of t.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?([a-zA-Z_]\w*)/gi)) s.add(m[1]);
  return s;
};
const OWN_TABLES = tableSet(OWN);
const ALL_TABLES = tableSet(ALL_SRC);
const LEDGER = new Set(DATA_LIFECYCLE.map((r) => r.table));

describe("数据生命周期台账闸（契约②）", () => {
  it("① 新表闸：本仓 DDL 每表必在台账（缺=红——新表票必填保留期面）", () => {
    const missing = [...OWN_TABLES].filter((t) => !LEDGER.has(t));
    expect(missing, `未登记台账的表：${missing.join(", ")}——新表票必须先在 contracts/dataLifecycle.ts 登记保留期`).toEqual([]);
  });

  it("② 幻影不养：台账每表必在双仓 DDL 面有落点（幽灵登记=红）", () => {
    const phantom = [...LEDGER].filter((t) => !ALL_TABLES.has(t));
    expect(phantom, `台账幽灵表（双仓 DDL 面无落点）：${phantom.join(", ")}`).toEqual([]);
  });

  it("③ 诚实面：台账声明的清理机制必须在代码里真实存在（宣称=实现）", () => {
    const blob = ALL_SRC.map(([, t]) => t).join("\n");
    for (const r of DATA_LIFECYCLE) {
      if (r.cleanup === "none") continue;
      for (const m of r.cleanup.matchAll(/([a-zA-Z]\w{5,})\(/g)) {
        expect(blob.includes(m[1]), `${r.table} 台账声明的清理机制 ${m[1]} 在代码面不存在`).toBe(true);
      }
    }
  });
});
