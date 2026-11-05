/**
 * userMode —— 生活/工作模式（彭总 2026-09-03 令：精灵分双模式）+ 紧急穿透纪律。
 *
 * 模式存储：wb_users.work_mode（'work'|'life'，默认 work）。
 * 穿透纪律（生活模式下降噪不隔断）：
 * - alert 级（C级/安全/资金）→ 任何模式穿透（强弹+语音）
 * - action 级（双签/舱位事故/指定人找）→ 生活模式轻提醒（通知不语音炸）
 * - info 级 → 生活模式攒着，切回工作模式一并给
 * APP/精灵端按此路由呈现；服务端只管存取模式+暴露级别。
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { sessionMe } from "./wbSession";
import { rawRows } from "./terminal";

async function ensureModeColumn(): Promise<void> {
  await getDb().execute(
    sql`ALTER TABLE wb_users ADD COLUMN IF NOT EXISTS work_mode VARCHAR(8) NOT NULL DEFAULT 'work'`,
  ).catch(() => { /* 已存在 */ });
}

/** 读用户模式（供 emitReport 路由层/精灵调用） */
export async function getUserMode(userId: number): Promise<"work" | "life"> {
  try {
    await ensureModeColumn();
    const rows = rawRows(
      await getDb().execute(sql`SELECT work_mode AS m FROM wb_users WHERE id=${userId} LIMIT 1`),
    ) as unknown as { m: string }[];
    return rows[0]?.m === "life" ? "life" : "work";
  } catch {
    return "work"; // 故障默认工作模式（宁可打扰不可漏报）
  }
}

export const userModeRouter = createRouter({
  /** getMode（query） */
  getMode: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const session = await sessionMe(input.token);
      return { mode: await getUserMode(Number(session.user.id)) };
    }),

  /** setMode（mutation）：切换（说「下班了」精灵也可调此口） */
  setMode: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      mode: z.enum(["work", "life"]),
    }))
    .mutation(async ({ input }) => {
      const session = await sessionMe(input.token);
      await ensureModeColumn();
      await getDb().execute(
        sql`UPDATE wb_users SET work_mode=${input.mode} WHERE id=${session.user.id}`,
      );
      return { ok: true as const, mode: input.mode };
    }),
});
