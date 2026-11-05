/**
 * evoSignals —— M45 自进化信号总线 E1：统一信号上报入口。
 *
 * 口径：
 * - report（mutation）：客户端/服务端异常与失败信号统一落 st_evo_signals；
 *   登录态带上 factoryId/actor；未登录（启动期崩溃）允许匿名但限 kind 白名单 + IP 软顶；
 * - 防滥用：payload message ≤500 字、stack ≤2000 字；匿名限 crash 类且内存级 30 次/小时/实例；
 * - 绝不回读给客户端（只进不出，读面在 evo 引擎/超终）。
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { stQuery } from "./terminal";
import { sessionMe } from "./wbSession";

const KINDS = [
  "crash",
  "api_error",
  "voice_fail",
  "tts_fail",
  "asr_fail",
  "skill_fail",
  "device_fail",
  "dag_fail",
  "mishear_diff",
  "boot",
  "spirit_miss", // 精灵答不上/意图落空（精灵蒸馏考题源）
  "radar_miss",  // 扫一扫识别不出/连不上（指纹库蒸馏考题源）
  "spirit_intent", // P2-6：精灵意图流量信号（递归自优化内环 sense——高频正常流量；蒸馏考题源/异常升级面已排除本 kind）
] as const;

// 匿名软顶（内存级，单实例；重启清零可接受——防的是失控刷库，不是防攻击）
let anonCount = 0;
let anonHourKey = "";
function anonBudgetOk(): boolean {
  const key = new Date().toISOString().slice(0, 13);
  if (key !== anonHourKey) {
    anonHourKey = key;
    anonCount = 0;
  }
  return anonCount < 30;
}

/** 写信号（供本路由与其他路由内联调用；失败静默绝不阻塞主链）。M77：可带部门上下文 deptKey（设备/智能体所属部门），激活大小环联邦判定 */
export async function emitEvoSignal(opts: {
  kind: (typeof KINDS)[number];
  factoryId?: number | null;
  deptKey?: string | null;
  actor?: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  try {
    await stQuery(
      sql`INSERT INTO st_evo_signals (factory_id, dept_key, kind, actor, payload)
          VALUES (${opts.factoryId ?? null}, ${(opts.deptKey ?? "").slice(0, 32) || null},
                  ${opts.kind}, ${(opts.actor ?? "").slice(0, 64)},
                  ${JSON.stringify(opts.payload).slice(0, 3800)})`,
    );
  } catch {
    // dept_key 列未补（sync-m73 未跑）时回退 legacy 写法，信号绝不因列缺席而丢
    try {
      await stQuery(
        sql`INSERT INTO st_evo_signals (factory_id, kind, actor, payload)
            VALUES (${opts.factoryId ?? null}, ${opts.kind}, ${(opts.actor ?? "").slice(0, 64)},
                    ${JSON.stringify(opts.payload).slice(0, 3800)})`,
      );
    } catch {
      /* 表未建/库抖动静默 */
    }
  }
}

export const evoSignalsRouter = createRouter({
  report: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1).optional(),
        kind: z.enum(KINDS),
        message: z.string().trim().min(1).max(500),
        stack: z.string().max(2000).optional(),
        appVersion: z.string().trim().max(32).optional(),
        deptKey: z.string().trim().min(1).max(32).optional(), // M77 部门上下文（登录态才生效，匿名防污）
      }),
    )
    .mutation(async ({ input }) => {
      let factoryId: number | null = null;
      let actor = "anon";
      if (input.token) {
        try {
          const { user, factory } = await sessionMe(input.token);
          factoryId = factory.id;
          actor = String(user.username);
        } catch {
          // 令牌失效不拦上报（崩溃现场可能就在登出态）
        }
      }
      if (actor === "anon") {
        if (input.kind !== "crash" && input.kind !== "api_error" && input.kind !== "boot") {
          return { ok: true as const, dropped: true as const };
        }
        if (!anonBudgetOk()) return { ok: true as const, dropped: true as const };
        anonCount += 1;
      }
      await emitEvoSignal({
        kind: input.kind,
        factoryId,
        deptKey: actor === "anon" ? null : (input.deptKey ?? null), // 匿名信号不带部门（防污部门环）
        actor,
        payload: {
          message: input.message,
          ...(input.stack ? { stack: input.stack.slice(0, 2000) } : {}),
          ...(input.appVersion ? { appVersion: input.appVersion } : {}),
        },
      });
      return { ok: true as const };
    }),
});
