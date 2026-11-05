/** v164 情绪节点：称呼与文案确定性（彭总的情绪价值纪律——确定性，不靠模型现编） */
import { describe, expect, it } from "vitest";
import { emotionCopy, siblingTerm } from "./routers/emotionNodes";

describe("称呼分路", () => {
  it("男=兄弟 / 女=姐妹 / 未填=老板", () => {
    expect(siblingTerm("male")).toBe("兄弟");
    expect(siblingTerm("female")).toBe("姐妹");
    expect(siblingTerm(null)).toBe("老板");
    expect(siblingTerm(undefined)).toBe("老板");
  });
});

describe("四节点文案", () => {
  it("第7天：称呼入题，含行动指引", () => {
    const c = emotionCopy("day7", "兄弟");
    expect(c.title).toBe("兄弟，灵枢陪你七天了");
    expect(c.body).toContain("派一单");
  });
  it("首单：分身名入题", () => {
    const c = emotionCopy("first_order", "姐妹", { name: "小灵枢" });
    expect(c.title).toBe("姐妹，小灵枢拿下第一单！");
    expect(c.body).toContain("上架超市");
  });
  it("晋升：坑位号入正文", () => {
    const c = emotionCopy("promotion", "兄弟", { slotNo: 3 });
    expect(c.body).toContain("第 3 个分身坑位");
  });
  it("评分4.5：分数入题", () => {
    const c = emotionCopy("score45", "老板", { name: "小灵枢", score: 4.52 });
    expect(c.title).toContain("4.5");
    expect(c.title).toContain("老板");
  });
  it("全文案不带英文占位/模板残渣", () => {
    for (const n of ["day7", "first_order", "promotion", "score45"] as const) {
      const c = emotionCopy(n, "兄弟", { name: "X", slotNo: 2, score: 4.6 });
      expect(c.title).not.toMatch(/undefined|null|\$\{/);
      expect(c.body).not.toMatch(/undefined|null|\$\{/);
    }
  });
});
