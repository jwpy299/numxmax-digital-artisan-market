/** smsYxt 纯函数面单测——OTP/iv_ 掩码（安全钉）、验签装配、日志脱敏、键守卫/钳制纪律。
 *  DB 路径（处理器/事务）走集成面，此处锁纯逻辑分支。 */
import { describe, expect, it } from "vitest";
import { clamp, logSafe, maskOutboxMsg, yxtSign, yxtTaskId } from "./routers/smsYxt";
import { createHash } from "node:crypto";

describe("maskOutboxMsg——验证码明文不落库（安全钉）", () => {
  it("otp verbatim 命中 → 精确掩码", () => {
    expect(maskOutboxMsg("code", "【NumX Max】您的验证码是482913，5 分钟内有效。", "482913"))
      .toBe("【NumX Max】您的验证码是[OTP已掩码]，5 分钟内有效。");
  });
  it("otp 多次出现全掩", () => {
    expect(maskOutboxMsg("code", "验证码是482913，再发一次482913", "482913"))
      .toBe("验证码是[OTP已掩码]，再发一次[OTP已掩码]");
  });
  it("otp 未命中（模板措辞漂移）→ 6-8 位数字串兜底掩码", () => {
    expect(maskOutboxMsg("code", "【NumX Max】验证码：482913 五分钟内有效", "482913"))
      .toBe("【NumX Max】验证码：[OTP已掩码] 五分钟内有效");
  });
  it("缺省 otp → 兜底掩码；年份/长单号不误伤", () => {
    expect(maskOutboxMsg("code", "2026年单号20261001123456验证码667788", undefined))
      .toBe("2026年单号20261001123456验证码[OTP已掩码]");
  });
  it("notice 面掩 iv_ 邀请码（一次性凭证不落明文）", () => {
    expect(maskOutboxMsg("notice", "【NumX Max】恭喜获批，邀请码：iv_8f3k2j9x 请查收"))
      .toBe("【NumX Max】恭喜获批，邀请码：iv_[已掩码] 请查收");
  });
  it("notice 面无凭证原样", () => {
    expect(maskOutboxMsg("notice", "【NumX Max】报名已受理，评审回访请保持电话畅通"))
      .toBe("【NumX Max】报名已受理，评审回访请保持电话畅通");
  });
});

describe("yxtSign——签名装配单源（md5 字段序拼接+appkey，32 小写）", () => {
  it("与文档 §5.2 六参序一致", () => {
    const parts = ["appid1", "task1", "13800138000", "0", "DELIVRD", "7435186799234902633"];
    const expect_ = createHash("md5").update(parts.join("") + "KEY", "utf8").digest("hex");
    expect(yxtSign(parts, "KEY")).toBe(expect_);
    expect(yxtSign(parts, "KEY")).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("yxtTaskId——平台响应字段名兼容（§7.3 taskid / §8.3 taskId）", () => {
  it("taskid 优先", () => {
    expect(yxtTaskId({ taskid: "I123" })).toBe("I123");
  });
  it("taskId 驼峰兜底", () => {
    expect(yxtTaskId({ taskId: "I456" })).toBe("I456");
  });
  it("task_id 蛇形兜底", () => {
    expect(yxtTaskId({ task_id: "I789" })).toBe("I789");
  });
  it("全缺 → 空串（调用方面对空键守卫）", () => {
    expect(yxtTaskId({})).toBe("");
  });
  it("数字型归一字符串", () => {
    expect(yxtTaskId({ taskid: 123456789 })).toBe("123456789");
  });
});

describe("logSafe——日志注入防护", () => {
  it("CR/LF/TAB/ESC 全剥", () => {
    expect(logSafe("a\r\nb\tcd")).toBe("abcd");
  });
  it("正常值原样", () => {
    expect(logSafe("I1906141154338793")).toBe("I1906141154338793");
  });
});

describe("clamp——非键字段列宽钳制", () => {
  it("超长截断", () => {
    expect(clamp("x".repeat(600), 500)).toHaveLength(500);
  });
  it("未超长原样", () => {
    expect(clamp("短消息", 500)).toBe("短消息");
  });
});
