/**
 * canonicalLeaf 守门钉（战区④批 A-lite 收口——副本不养：rawRows/dupEntry 本地副本归中后，新副本长出来=红）。
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

function collect(dir: URL): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = new URL(dir.toString() + (dir.toString().endsWith("/") ? "" : "/") + e.name);
    if (e.isDirectory()) { out.push(...collect(p)); continue; }
    if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push([e.name, readFileSync(p, "utf-8")]);
  }
  return out;
}

describe("canonical 叶守门（批 A-lite——副本不养）", () => {
  const all = collect(new URL("./", import.meta.url));
  it("rawRows 唯一定义在 queries/rawRows.ts（别处置副本=红）", () => {
    const offenders = all.filter(([n, t]) => n !== "rawRows.ts" && /function rawRows\(/.test(t)).map(([n]) => n);
    expect(offenders, `rawRows 私本残留：${offenders.join(", ")}`).toEqual([]);
  });
  it("isDupEntry 唯一定义在 queries/dupEntry.ts（lib 副本已退役=re-export 面）", () => {
    const offenders = all.filter(([n, t]) => n !== "dupEntry.ts" && /function isDupEntry\(/.test(t)).map(([n]) => n);
    expect(offenders, `isDupEntry 私本残留：${offenders.join(", ")}`).toEqual([]);
    const lib = readFileSync(new URL("./lib/dupEntry.ts", import.meta.url), "utf-8");
    expect(lib).toContain('from "../queries/dupEntry"'); // 归中面锁死（回魂=红）
  });

  it("resolveWbUserByToken 唯一定义在 routers/wbSession.ts（第 7 份私抄长出=红——portal#86 安全面机器守门[NumX 残留①]）", () => {
    const offenders = all.filter(([n, t]) => n !== "wbSession.ts" && /function resolveWbUserByToken\(/.test(t)).map(([n]) => n);
    expect(offenders, `resolveWbUserByToken 私本残留：${offenders.join(", ")}`).toEqual([]);
    // 明文直读面守门：wbSession/identity 外的 eq(wbUsers.authToken 直读=红（双轨面唯一通道守门）
    const plainReaders = all.filter(([n, t]) => n !== "wbSession.ts" && n !== "identity.ts" && /eq\(wbUsers\.authToken/.test(t)).map(([n]) => n);
    expect(plainReaders, `明文直读残留：${plainReaders.join(", ")}`).toEqual([]);
    // 第四 token 族同律（portal#93 面）：devAccounts.authToken 明文直读=红（developer.ts 双轨外不收）
    const devReaders = all.filter(([n, t]) => n !== "developer.ts" && /eq\(devAccounts\.authToken/.test(t)).map(([n]) => n);
    expect(devReaders, `dev 族明文直读残留：${devReaders.join(", ")}`).toEqual([]);
  });
});
