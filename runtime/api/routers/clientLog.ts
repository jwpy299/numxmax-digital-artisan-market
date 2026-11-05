/**
 * clientLog —— M46 客户端崩溃/启动信标（无鉴权，设备级，为"闪退"取证而生）。
 *
 * 纪律：
 * - 无 token（启动早期可能无会话）；payload 只允许 版本/阶段/错误摘要/设备型号——
 *   绝不收账号/会话/文本内容等任何 PII；
 * - zod 严格裁剪 + 长度封顶（error ≤ 800 字）；写库失败静默；
 * - nginx 层已有 IP 限流兜底滥用面。
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";

export const clientLogRouter = createRouter({
  /** report（mutation）：启动阶段信标 / JS 全局错误上报 */
  report: publicQuery
    .input(
      z.object({
        version: z.string().trim().min(1).max(16),
        phase: z.enum(["module", "render", "face", "ready", "js_error", "native_hint", "crumbs"]), // +crumbs（hp#36 缺陷④：APP 面包屑取证面——/api/client-crumbs 404=取证设施发不出去面封死）
        error: z.string().trim().max(800).optional(),
        device: z.string().trim().max(64).optional(),
        items: z.array(z.string().trim().max(60)).max(40).optional(), // crumbs 面：动作串流（只动作标签——纪律面：绝不记内容/token）
      }),
    )
    .mutation(async ({ input }) => {
      try {
        // crumbs 面：动作串 join 进 error 列（表不加列——st_client_logs 既有面零 schema 变更；trail=「→」串链）
        // crumbs 截断面（NumX 复锚抓向）：保尾部 12 条——本设施存在理由=「崩后查最后几个动作」（crumbs.ts 客户端 push 尾/超 40 头丢/回卷保后 10 三面全保最新）；条边界截断不切半标签（12×63=756<800 列宽=严格模式 1406 面封死）；zod max(40) 契约不动（已发版客户端接得住）
        const errText = input.error ?? (input.items?.length ? input.items.slice(-12).join(" → ") : null);
        await getDb().execute(
          sql`INSERT INTO st_client_logs (version, phase, error, device, created_at)
              VALUES (${input.version}, ${input.phase}, ${errText}, ${input.device ?? null}, NOW())`,
        );
      } catch (e) {
        // 表未建/库抖动/超长截断漏网：信标丢弃但不静默——服务端留痕（NumX critical：catch{} 吞错+返回 ok=静默假成功面封死），绝不抛回客户端（无鉴权信标宗旨不动）
        console.warn("[clientLog] insert failed:", e instanceof Error ? e.message.slice(0, 200) : e);
      }
      return { ok: true as const };
    }),
});
