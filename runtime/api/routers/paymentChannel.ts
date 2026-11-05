/**
 * paymentChannel —— #19 财税链路：支付通道适配层（中信银行待接入）。
 *
 * 定位：业务侧（钱包/分账/提现）与支付通道之间的抽象层——
 * 通道可插拔：citic（中信银行，已签约待联调）/ wechat / alipay / yunzhanghu（云账户类灵工）。
 * 纪律：
 * - 通道实现未注册 → 返回 not_configured（绝不假装成功）；
 * - 一切调用写 st_channel_calls 台账（通道/动作/金额/结果/耗时）——对账中心的通道侧数据源；
 * - 密钥从 nebula.env 读（CITIC_* / WECHAT_* / ALIPAY_*），代码零硬编码。
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { rawRows, requireAdmin } from "./terminal";
import { sessionMe } from "./wbSession";

export type ChannelId = "citic" | "wechat" | "alipay" | "yunzhanghu";
export type ChannelAction = "pay" | "split" | "payout" | "refund" | "query";

export interface ChannelResult {
  ok: boolean;
  channel: ChannelId;
  action: ChannelAction;
  refId?: string;
  reason?: string;
  latencyMs: number;
}

/** 通道配置探测（nebula.env 有没有该通道的密钥） */
export function channelConfigured(ch: ChannelId): boolean {
  switch (ch) {
    case "citic": return !!(process.env.CITIC_MERCHANT_ID && process.env.CITIC_API_KEY);
    case "wechat": return !!(process.env.WECHAT_MCH_ID && process.env.WECHAT_API_KEY);
    case "alipay": return !!(process.env.ALIPAY_APP_ID && process.env.ALIPAY_PRIVATE_KEY);
    case "yunzhanghu": return !!(process.env.YZH_DEALER_ID && process.env.YZH_API_KEY);
  }
}

/** 通道状态一览（管理端） */
export function channelStatus(): Record<ChannelId, { configured: boolean; role: string }> {
  return {
    citic: { configured: channelConfigured("citic"), role: "收单+分账+代付（中信银行，已签约待联调）" },
    wechat: { configured: channelConfigured("wechat"), role: "C 端充值（微信支付）" },
    alipay: { configured: channelConfigured("alipay"), role: "C 端充值（支付宝，备份）" },
    yunzhanghu: { configured: channelConfigured("yunzhanghu"), role: "灵工完税提现（备选）" },
  };
}

async function ensureChannelLog(): Promise<void> {
  await getDb().execute(sql`
    CREATE TABLE IF NOT EXISTS st_channel_calls (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      channel VARCHAR(16) NOT NULL,
      action VARCHAR(16) NOT NULL,
      amount INT,
      ref_id VARCHAR(64),
      ok TINYINT(1) NOT NULL DEFAULT 0,
      reason VARCHAR(255),
      latency_ms INT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_channel_time (channel, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

/** 通道调用台账（一切调用留痕——对账中心通道侧数据源） */
export async function logChannelCall(r: ChannelResult, amount?: number): Promise<void> {
  try {
    await ensureChannelLog();
    await getDb().execute(
      sql`INSERT INTO st_channel_calls (channel, action, amount, ref_id, ok, reason, latency_ms)
          VALUES (${r.channel}, ${r.action}, ${amount ?? null}, ${r.refId ?? null}, ${r.ok ? 1 : 0}, ${r.reason ?? null}, ${r.latencyMs})`,
    );
  } catch { /* 台账失败静默 */ }
}

/**
 * 通道调用统一入口（骨架）：通道未配置 → not_configured（诚实）；
 * 真联调时在此接中信银行 SDK/HTTP 签名调用。
 */
export async function callChannel(ch: ChannelId, action: ChannelAction, amount: number, refId?: string): Promise<ChannelResult> {
  const t0 = Date.now();
  if (!channelConfigured(ch)) {
    const r: ChannelResult = { ok: false, channel: ch, action, reason: "not_configured", refId, latencyMs: Date.now() - t0 };
    await logChannelCall(r, amount);
    return r;
  }
  // TODO（中信联调）：HTTP 签名调用 → 结果映射
  const r: ChannelResult = { ok: false, channel: ch, action, reason: "channel_stub", refId, latencyMs: Date.now() - t0 };
  await logChannelCall(r, amount);
  return r;
}

export const paymentChannelRouter = createRouter({
  /** channels（query）：四通道配置状态（HQ admin） */
  channels: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      await sessionMe(input.token);
      await requireAdmin(input.token);
      return { channels: channelStatus() };
    }),

  /** channelCalls（query）：通道调用台账（对账中心用） */
  channelCalls: publicQuery
    .input(z.object({ token: z.string().trim().min(1), limit: z.number().int().min(1).max(100).default(30) }))
    .query(async ({ input }) => {
      await sessionMe(input.token);
      await requireAdmin(input.token);
      await ensureChannelLog();
      const rows = rawRows(
        await getDb().execute(
          sql`SELECT channel, action, amount, ref_id AS refId, ok, reason, latency_ms AS latencyMs, created_at AS createdAt
              FROM st_channel_calls ORDER BY id DESC LIMIT ${input.limit}`,
        ),
      );
      return { calls: rows };
    }),
});
