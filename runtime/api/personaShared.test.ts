/**
 * personaShared 人格单一事实源 + assistant 小星人格接线验收：
 * 1. PERSONA_STYLE（lingshu/xingyun）原文逐字保留，voice 与 assistant 引用同一份灵枢人格原文；
 * 2. assistant LLM system prompt 默认含小星人格（XINGXING_STYLE），且平台核心事实/回答规则段不动；
 * 3. cs_config.personaPrompt 覆盖优先（运营配置仍可压过默认小星人格）；
 * 4. voice 行为回归：parseUtterance 的 system prompt 仍以 personaShared 同一份原文开头。
 * （voice 全量行为回归由 api/voice.test.ts 既有用例钉死，需全绿。）
 */
import { describe, expect, it, vi } from "vitest";

const chatMock = vi.fn();

vi.mock("./routers/modelGateway", () => ({
  callSlotChat: (...args: unknown[]) => chatMock(...args),
  callSlotChatFast: vi.fn(async () => {
    throw new Error("fast lane disabled in tests");
  }),
}));

import { PERSONA_STYLE, XINGXING_STYLE } from "./routers/personaShared";
import { buildAssistantSystemPrompt } from "./routers/assistant";
import { parseUtterance } from "./routers/voice";

const protocols = [{ code: "LIMIT_SET", name: "限额调整", level: "C", payloadHint: "{amount:number}" }];

describe("personaShared 单一事实源", () => {
  it("PERSONA_STYLE 两条原文逐字保留（2026-08-13 口头禅纪律修正版，彭总实测反馈）", () => {
    expect(PERSONA_STYLE.lingshu).toBe(
      "你是灵枢，参谋长·秩序与执行。沉稳、简短、先结论后依据。" +
        "口头禅纪律（2026-08-13 彭总实测反馈修正）：「需要你确认。」只在真有事项等老板拍板时说，" +
        "闲聊、问答、汇报一律不说；「已拦截。」只在真的拦截了越权/未授权动作时说，绝不每句都挂。" +
        "管辖：意图执行、票据、审计、风险告警、确认流程。",
    );
    expect(PERSONA_STYLE.xingyun).toBe(
      "你是星云，参谋·洞察与增长。明快、有画面感、先洞察后数据，口头禅「我注意到……」「值得看一眼。」" +
        "管辖：经营分析、军团战绩、市场动态、训练场。",
    );
  });

  it("小星人格内嵌与 voice 同一份灵枢人格原文（只有一处事实源）", () => {
    expect(XINGXING_STYLE).toContain(PERSONA_STYLE.lingshu);
  });

  it("voice.parseUtterance 的 system prompt 以 personaShared 同一份原文开头（voice 行为零变化）", async () => {
    chatMock.mockReset();
    chatMock.mockResolvedValue({
      ok: true,
      content: JSON.stringify({ kind: "chat", actionType: "", payload: {}, reply: "好。" }),
    });
    await parseUtterance("lingshu", "你好", protocols, "【实况】");
    const sysLingshu = (chatMock.mock.calls[0][1] as { messages: Array<{ role: string; content: string }> })
      .messages[0].content;
    expect(sysLingshu.startsWith(PERSONA_STYLE.lingshu)).toBe(true);

    await parseUtterance("xingyun", "你好", protocols, "【实况】");
    const sysXingyun = (chatMock.mock.calls[1][1] as { messages: Array<{ role: string; content: string }> })
      .messages[0].content;
    expect(sysXingyun.startsWith(PERSONA_STYLE.xingyun)).toBe(true);
  });
});

describe("assistant 小星人格（LLM 层默认人格）", () => {
  it("默认 system prompt 含小星人格 + 保留平台核心事实与回答规则段", () => {
    const prompt = buildAssistantSystemPrompt(null);
    // 小星人格：自称小星、灵枢派驻前台客服、人格与灵枢完全一致、口头禅同款「需要你确认。」
    expect(prompt).toContain("小星");
    expect(prompt).toContain(XINGXING_STYLE);
    expect(prompt).toContain("灵枢派驻数字匠市的前台客服");
    expect(prompt).toContain("人格与灵枢完全一致");
    expect(prompt).toContain("需要你确认。");
    expect(prompt).not.toContain("更热情三分");
    // 平台事实段与回答规则段逐字保留（通用客服腔首行已被小星人格取代）
    expect(prompt).toContain("核心事实：数字匠市支持浏览在售上架、试用、签约");
    expect(prompt).toContain("回答规则：中文；专业温和；不超过 200 字");
    expect(prompt.startsWith("你是 NumX Max 的智能客服。")).toBe(false);
  });

  it("cs_config.personaPrompt 覆盖优先：运营人设拼入前部，小星仍是默认人格", () => {
    const prompt = buildAssistantSystemPrompt({
      welcome: "",
      personaPrompt: "你是店小二，只讲方言。",
      handoffHint: "",
    });
    expect(prompt.startsWith("你是店小二，只讲方言。\n\n")).toBe(true);
    // 覆盖只压前部：小星默认人格与平台事实段仍在（运营可整体改写前段风格）
    expect(prompt).toContain(XINGXING_STYLE);
    expect(prompt).toContain("核心事实：数字匠市");
  });

  it("personaPrompt 空白/缺失 → 回落默认小星人格", () => {
    const blank = buildAssistantSystemPrompt({ welcome: "", personaPrompt: "   ", handoffHint: "" });
    expect(blank).toBe(buildAssistantSystemPrompt(null));
    expect(blank).toBe(buildAssistantSystemPrompt(undefined));
    expect(blank).toContain(XINGXING_STYLE);
  });
});

describe("v1.5.2 自然语言识别优化（彭总指令）", () => {
  it("parseUtterance system prompt 含误听对照块与闲聊自然接应规则", async () => {
    chatMock.mockReset();
    chatMock.mockResolvedValue({
      ok: true,
      content: JSON.stringify({ kind: "chat", actionType: "", payload: {}, reply: "好。" }),
    });
    await parseUtterance("lingshu", "你好", protocols, "【实况】");
    const sys = (chatMock.mock.calls[0][1] as { messages: Array<{ role: string; content: string }> }).messages[0]
      .content;
    // 误听对照：星云/灵枢/PPT/白名单的生产实证误听全部入册
    expect(sys).toContain("误听对照");
    expect(sys).toContain("新云仙");
    expect(sys).toContain("林叔");
    expect(sys).toContain("皮迪亚");
    expect(sys).toContain("百名单");
    // 闲聊自然接应：夸赞寒暄先像人一样接住
    expect(sys).toContain("先像人一样自然接住");
    // 口头禅纪律：真有确认才说
    expect(PERSONA_STYLE.lingshu).toContain("只在真有事项等老板拍板时说");
  });
});
