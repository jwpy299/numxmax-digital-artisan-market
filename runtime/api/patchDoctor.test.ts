/** v177 补丁生成器：diff 校验与提取（纯规则；L2 纪律） */
import { describe, expect, it } from "vitest";
import { extractDiff, isValidDiffDraft } from "./harness/patchDoctor";

describe("diff 草案校验", () => {
  it("合法 unified diff 放行", () => {
    expect(isValidDiffDraft("--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@").ok).toBe(true);
  });
  it("不像 diff 的拒收", () => {
    expect(isValidDiffDraft("我建议重启服务").ok).toBe(false);
  });
  it("高危动作拒收（删表/密钥）", () => {
    expect(isValidDiffDraft("--- a/x\n+++ b/x\n@@\n-DROP TABLE users").ok).toBe(false);
    expect(isValidDiffDraft("--- a/x\n+++ b/x\n@@\n-process.env.MMX_TTS_API_KEY").ok).toBe(false);
  });
});
describe("diff 提取", () => {
  it("从 markdown 代码块提取", () => {
    expect(extractDiff("说明\n```diff\n--- a\n+++ b\n```\n尾")).toBe("--- a\n+++ b");
  });
});
