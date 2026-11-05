/**
 * identity 进口面哨兵（OCR 仓规 withTimeoutSurface 同例，批七 R7-13-③ + R7-14-④）：
 *  asResolvedAdminIdentity/__mintDelegatedIdentityForTest/roleOfEvidence/withMintArmed 是「mint/判决/开窗」出口——仅 identity.ts 内部与测试钩可引；
 *  namespace import 同守（R7-b4-①：* as 形态补网）；
 *  扫全仓 api/+src/ 双侧（七-c 接线点在路由层，只扫本子树会漏真接线处），他模块 import 即本测试红。
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    const f = join(dir, e);
    if (statSync(f).isDirectory()) yield* walk(f);
    else if (f.endsWith(".ts") || f.endsWith(".tsx")) yield f;
  }
}

/** 读源并剥掉钩别名行（raw 名只许出现在钩模块自身） */
function stripHookAlias(src: string): string {
  return src
    .split("\n")
    .filter((l) => !/__\w+ForTest/.test(l)) // R7-b4-修：钩别名通配（__*ForTest 一律剥掉，不再逐名登记）
    .join("\n");
}

describe("asResolvedAdminIdentity 引用面哨兵", () => {
  it("全仓仅 identity.ts 与 identityTestHook.ts 可 import asResolvedAdminIdentity", () => {
    const importRe = /import\s*\{[^}]*\b(asResolvedAdminIdentity|__mintDelegatedIdentityForTest|roleOfEvidence|withMintArmed)\b[^}]*\}\s*from|require\([^)]*(asResolvedAdminIdentity|__mintDelegatedIdentityForTest|roleOfEvidence|withMintArmed)/; // R7-17-②/R7-b4-①：roleOfEvidence 回守——无品牌判决谓词出口同属 mint 面；R7-c10-②：withMintArmed 开窗器同守（开窗=产证能力，同属 mint 面）
    const offenders: string[] = [];
    const nsRe = /import\s*\*\s*as\s+\w+\s+from\s*["'][^"']*\/identity["']/; // R7-b4-①：namespace import 补网（命名导入正则绕不过 * as 形态）
    const root = join(__dirname, "..", "..");
    for (const sub of ["api", "src", "contracts", "db"]) { // R7-b2-②：contracts/db 同入扫面（tsconfig.server 生产根，漏扫即暗道）
      for (const f of walk(join(root, sub))) {
        const base = f.split("/").pop() ?? "";
        if (["identity.ts", "identityTestHook.ts", "identitySurface.test.ts"].includes(base)) continue;
        const src = stripHookAlias(readFileSync(f, "utf8"));
        if (importRe.test(src) || nsRe.test(src)) offenders.push(f);
        // R7-15-③ security low：钩模块引用面同守——非测试文件引 identityTestHook 即犯（别名钩不能成产线暗道）
        if (!base.endsWith(".test.ts") && !base.endsWith(".test.tsx") && src.includes("identityTestHook")) offenders.push(f + " (hook-import)");
      }
    }
    expect(offenders).toEqual([]);
  });
});
