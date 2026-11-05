/** v149 自治四口纯规则测试 */
import { describe, expect, it } from "vitest";
import { canAutoExecute, complianceCheck, filterConfidentMemories, tierOfAction } from "./harness/autonomy";

describe("G1 授权分级", () => {
  it("分级表：L0/L1 自动，L2/L3 必人工；未登记按最严 L3", () => {
    expect(tierOfAction("probe:read")).toBe("L0");
    expect(tierOfAction("queue_construct")).toBe("L2");
    expect(tierOfAction("eligible_deploy")).toBe("L3");
    expect(tierOfAction("billing:refund")).toBe("L3"); // 前缀通配
    expect(tierOfAction("unknown:action")).toBe("L3"); // 宁严勿宽
    expect(canAutoExecute("memory:capture")).toBe(true);
    expect(canAutoExecute("eligible_deploy")).toBe(false);
  });
});
describe("G3 记忆代谢", () => {
  it("低置信隔离：score<0.5 不进给养", () => {
    const src = "- **[a]** (score: 0.85)\n  高置信\n\n- **[b]** (score: 0.20)\n  低置信";
    const r = filterConfidentMemories(src);
    expect(r.text).toContain("高置信");
    expect(r.text).not.toContain("低置信");
    expect(r.suppressed).toBe(1);
    expect(filterConfidentMemories("- **[b]** (score: 0.2)\n  x").text).toBeNull();
  });
  it("#11 遗忘曲线：90天陈旧记忆进隔离区", () => {
    const old = "- **[老]** (score: 0.9) 2026-06-01\n  老黄历";
    const r = filterConfidentMemories(old);
    expect(r.text).toBeNull();
    expect(r.stale).toBe(1);
  });
  it("#11 冲突裁决：同主题只留最新", () => {
    // 夹具日期动态生成（时间炸弹钉：写死日期=半衰期衰减随真实时间跌破 stale 阈值[0.3]=text=null 红——
    // 钉逻辑面[同主题只留最新]不钉时间面：旧=45 天前/新=3 天前=衰减分恒高于阈值）
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
    const src = `- **[目标]** (score: 0.9) ${daysAgo(45)}\n  旧说法\n\n- **[目标]** (score: 0.6) ${daysAgo(3)}\n  新说法`;
    const r = filterConfidentMemories(src);
    expect(r.text).toContain("新说法");
    expect(r.text).not.toContain("旧说法");
  });
});
describe("G4 合规牙齿", () => {
  it("资金/数据/对外发声命中即拦截", () => {
    expect(complianceCheck("新增技能分类过滤").pass).toBe(true);
    const v = complianceCheck("调整平台佣金与退款规则");
    expect(v.pass).toBe(false);
    expect(v.hits[0]!.cls).toBe("billing");
    expect(complianceCheck("批量导出用户手机号").pass).toBe(false);
    expect(complianceCheck("推送全员营销文案").pass).toBe(false);
  });
});
