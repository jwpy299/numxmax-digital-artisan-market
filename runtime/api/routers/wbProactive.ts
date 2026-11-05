/**
 * wbProactive —— M23b 主动服务消息（数字人主动开口，但「主动≠骚扰」）。
 *
 * 纪律：
 * - 框架层无自动鉴权，token 只在请求体；poll/markRead 走 sessionMe（同 wbAssets）；
 * - 可见性分两类（企业隔离 factoryId 必带）：
 *   定向行（userId=本人）：readAt 已读语义——未读才出，markRead 后不再出；
 *   广播行（userId IS NULL）：时间窗可见——createdAt > NOW()-24h 即视为未读展示，
 *   不依赖 readAt，多台设备都能收到同一广播（不接受「首台设备代收」语义）；
 * - markRead 幂等：仅对 userId=本人的定向未读行生效（广播行不受影响），
 *   重复调用/越权 id 一律 ok:true，不泄露他企业/他人消息存在性；
 * - 写入侧在 proactiveJobs（触发器）：一切写入先按 dedupeKey 查重，同 key 跳过——
 *   同事件每日历天(UTC)最多一次（主动≠骚扰）。
 */
import { and, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { wbProactiveMsgs } from "@db/schema";
import { sessionMe } from "./wbSession";
import { sweepMissedCalls } from "./wbCalls";

const tokenInput = { token: z.string().trim().min(1) };

/** 广播行可见时间窗：createdAt > NOW()-24h 即视为未读展示（多设备同收，不依赖 readAt） */
export const BROADCAST_WINDOW_MS = 24 * 3600 * 1000;

export const wbProactiveRouter = createRouter({
  /**
   * wbProactive.poll：本人可见主动消息，倒序 ≤10 条。
   * 定向行（userId=本人）：未读（readAt IS NULL）才出；广播行（userId IS NULL）：
   * createdAt > NOW()-24h 时间窗内即出（多设备同收，markRead 不影响广播）。
   * 出参 items[].broadcast=true 表示全员广播（前端可区分展示）。
   */
  poll: publicQuery.input(z.object({ ...tokenInput })).query(async ({ input }) => {
    const db = getDb();
    const { user, factory } = await sessionMe(input.token);
    // v1.4.0：missed 惰性判定——本企业 ringing 超 60s（RING_TIMEOUT_MS，与 App 主叫等待对齐）未接的呼叫顺带落 missed
    // （清扫先于取消息：本轮 poll 即可看到 missed 后续提醒的准确状态）
    await sweepMissedCalls(factory.id, new Date(), db);
    const rows = await db
      .select()
      .from(wbProactiveMsgs)
      .where(
        and(
          eq(wbProactiveMsgs.factoryId, factory.id),
          or(
            // 定向行：readAt 已读语义
            and(eq(wbProactiveMsgs.userId, user.id), isNull(wbProactiveMsgs.readAt)),
            // 广播行：24h 时间窗可见（不依赖 readAt，多设备同收）
            and(
              isNull(wbProactiveMsgs.userId),
              gt(wbProactiveMsgs.createdAt, new Date(Date.now() - BROADCAST_WINDOW_MS)),
            ),
          ),
        ),
      )
      .orderBy(desc(wbProactiveMsgs.id))
      .limit(10);
    return {
      items: rows.map((m) => ({
        msgId: m.id,
        kind: m.kind,
        content: m.content,
        priority: m.priority,
        broadcast: m.userId == null,
        createdAt: m.createdAt,
      })),
    };
  }),

  /** wbProactive.markRead：批量已读（仅 userId=本人的定向行生效；广播行不受影响；幂等 ok:true） */
  markRead: publicQuery
    .input(
      z.object({
        ...tokenInput,
        ids: z.array(z.number().int().positive()).min(1).max(50),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { user, factory } = await sessionMe(input.token);
      await db
        .update(wbProactiveMsgs)
        .set({ readAt: new Date() })
        .where(
          and(
            inArray(wbProactiveMsgs.id, input.ids),
            eq(wbProactiveMsgs.factoryId, factory.id),
            // 仅本人定向行：广播行（userId IS NULL）不做已读置位（时间窗语义，多设备同收）
            eq(wbProactiveMsgs.userId, user.id),
            isNull(wbProactiveMsgs.readAt),
          ),
        );
      // 幂等：已读/越权/广播行/不存在 id 一律 ok:true（不泄露消息存在性）
      return { ok: true as const };
    }),
});
