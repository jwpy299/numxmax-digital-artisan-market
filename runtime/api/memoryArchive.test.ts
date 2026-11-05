/**
 * memoryArchive 记忆自动归档（M49）单测。
 *
 * 闸点：
 * 1. distillArchive：LLM 正常 → 提炼文本；LLM 失败/异常/过短 → 纯文本拼接兜底（记忆不丢）；
 * 2. 兜底与提炼都过 stripSecrets（密钥样式串绝不进归档）；
 * 3. 正文 ≤ 8000 字截断；
 * 4. 常量语义：厂级阈值 FACTORY_ARCHIVE_THRESHOLD=500（设计契约锁死，防误改）。
 */
import { describe, expect, it } from "vitest";
import { distillArchive, FACTORY_ARCHIVE_THRESHOLD } from "./routers/memoryArchive";

const ITEMS = [
  { content: "老板习惯早上 9 点听晨报", kind: "preference", importance: 4 },
  { content: "本月预算上限 2000", kind: "fact", importance: 5 },
];

describe("distillArchive 提炼与兜底", () => {
  it("LLM 正常 → 返回提炼文本", async () => {
    const llm = async () => ({ content: "主题一：作息偏好。老板习惯早上 9 点听晨报，晨报应在此时间前就绪。" });
    const out = await distillArchive("lingshu", ITEMS, llm as never);
    expect(out).toContain("作息偏好");
  });

  it("LLM 抛异常 → 纯文本拼接兜底，条目一条不丢", async () => {
    const llm = async () => { throw new Error("gateway down") };
    const out = await distillArchive("xingyun", ITEMS, llm as never);
    expect(out).toContain("自动归档·原始条目 2 条");
    expect(out).toContain("早上 9 点听晨报");
    expect(out).toContain("本月预算上限 2000");
  });

  it("LLM 输出过短（<20 字）→ 视为失败走兜底", async () => {
    const llm = async () => ({ content: "好的" });
    const out = await distillArchive("lingshu", ITEMS, llm as never);
    expect(out).toContain("原始条目");
  });

  it("敏感串双保险脱敏（st_/pk_ 票据/发布键样式绝不进归档）", async () => {
    const llm = async () => ({ content: "记忆里出现票据 st_ABCdef123456 与发布键 pk_Zyx987 必须抹掉，其余保留。" });
    const out = await distillArchive("lingshu", ITEMS, llm as never);
    expect(out).not.toContain("st_ABCdef123456");
    expect(out).not.toContain("pk_Zyx987");
    expect(out).toContain("[已遮蔽]");
  });

  it("正文超 8000 字截断", async () => {
    const llm = async () => ({ content: "长".repeat(9000) });
    const out = await distillArchive("lingshu", ITEMS, llm as never);
    expect(out.length).toBeLessThanOrEqual(8000);
  });
});

describe("归档常量契约", () => {
  it("厂级阈值 500（彭总「达到一定程度」的工程口径）", () => {
    expect(FACTORY_ARCHIVE_THRESHOLD).toBe(500);
  });
});
