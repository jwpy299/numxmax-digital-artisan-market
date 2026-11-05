/**
 * dshBridge 驱动端点（2026-08-30）：DSH 式个人智能工作台的 Harness 驱动口。
 *
 * 链路（全部复用 Harness 真件，零新引擎）：
 * sessionKey 续聊身份 → 记忆召回（置信过滤，HARNESS_MEMORY_ENABLED 闸内）→ 网关 flash 槽应答
 * → 记忆捕获（火忘式）→ 汇报总线事件映射（免打扰纪律桥接）。
 * 纪律：模型只走网关槽位；记忆故障静默降级；人格二选一（灵枢/星云）。
 */
import { z } from "zod";
import { createRouter, publicQuery } from "../middleware";
import { sessionMe } from "./wbSession";
import { callSlotChatFast } from "./modelGateway";
import { emitReport } from "./reportBus";
import { mayEmitNow, mapEventLevel, sessionKey } from "../harness/dshBridge";
import { inQuietHours } from "./reportBus";

const PERSONA_SYS: Record<"lingshu" | "xingyun", string> = {
  lingshu: "你是灵枢，用户的数字分身搭子。兄弟式口吻，干脆、可靠、有江湖气。回答不超过 120 字。",
  xingyun: "你是星云，用户的数字分身搭子。姐妹式口吻，温暖、细致、有分寸。回答不超过 120 字。",
};

export const dshBridgeRouter = createRouter({
  /** dsh.chat：DSH 式工作台对话（Harness 全链驱动） */
  chat: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      persona: z.enum(["lingshu", "xingyun"]).default("lingshu"),
      message: z.string().trim().min(1).max(500),
    }))
    .mutation(async ({ input }) => {
      const session = await sessionMe(input.token);
      const uid = Number(session.user.id);
      const key = sessionKey(uid, input.persona);

      // 记忆召回（故障静默 null；recallForContext(query, sessionKey) 返回已过滤文本）
      let memoryText: string | null = null;
      try {
        const { recallForContext } = await import("../harness/memoryBridge");
        memoryText = await recallForContext(input.message, key).catch(() => null);
      } catch { /* 桥未开/表未建：静默 */ }

      // #25 对话舱工具层：真实数据给养（任务/纪要/身份——复用 spirit-chat resolveWho，故障静默）
      let dataCtx = "";
      try {
        const { resolveWho } = await import("./spiritChat");
        const w = await resolveWho(input.token).catch((): { who?: string; ctx?: string } => ({}));
        if (w.ctx) dataCtx = `\n真实数据（基于它如实回答业务问题；之外不编造）：${w.ctx}`;
      } catch { /* 静默 */ }

      const r = await callSlotChatFast("flash", {
        messages: [
          { role: "system", content: PERSONA_SYS[input.persona] + (memoryText ? `\n你记得的：${memoryText}` : "") + dataCtx },
          { role: "user", content: input.message },
        ],
        maxTokens: 380,
        temperature: 0.6,
        timeoutMs: 20_000,
        context: "dsh_bridge",
      }).catch(() => null);
      const reply = r?.ok && r.content ? r.content.trim()
        : input.persona === "lingshu" ? "兄弟，我这会儿线路有点忙，稍后再喊我。" : "姐妹，我这会儿线路有点忙，稍后再喊我。";

      // 记忆捕获（火忘式，绝不挡应答；captureEvent(sessionKey, userText, assistantText)）
      try {
        const { captureEvent } = await import("../harness/memoryBridge");
        void captureEvent(key, input.message.slice(0, 80), reply.slice(0, 80)).catch(() => undefined);
      } catch { /* 静默 */ }

      // 重要事件落汇报总线（过桥层纪律：免打扰不穿透，alert 才穿）
      const quiet = inQuietHours(new Date().toTimeString().slice(0, 5), "22:00", "08:00");
      if (/晋升|验收|入账|上架|冻结/.test(reply) && mayEmitNow(mapEventLevel("info"), quiet)) {
        void emitReport({
          audience: "personal", userId: uid, level: "info", sourceRing: "dsh",
          title: reply.slice(0, 60), body: reply.slice(0, 300),
          dedupeKey: `dsh:${key}:${new Date().toISOString().slice(0, 13)}`,
        }).catch(() => false);
      }
      return { ok: true as const, reply, persona: input.persona, sessionKey: key, memoryHit: memoryText != null };
    }),
});
