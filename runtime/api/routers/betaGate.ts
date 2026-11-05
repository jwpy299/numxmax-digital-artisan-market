/**
 * betaGate —— 内测邀请码闸（2026-09-05 彭总令：邀请制灰度）。
 * POST /api/beta-check {code} → { ok, orgName?, reason? }
 * 口径：iv_ 邀请码（wb_invites 未消费/未吊销/未过期）或环境变量 BETA_MASTER_CODE 万能内测码。
 * 纪律：计数限流防爆破（每 IP 10 次/分）；不泄露码是否存在以外的任何信息。
 */
import type { Context } from "hono";
import { sql } from "drizzle-orm";
import { createHash } from "crypto";
import { getDb } from "../queries/connection";
import { rawRows } from "./terminal";
import { clientIp } from "../lib/clientIp";
import { warnThrottled } from "../queries/rawRows";
import { ensureBetaInvites } from "./betaInvites"; // 建表 DDL 单源（门禁票：双份复刻摘）

const hits = new Map<string, number[]>();
function rateOk(ip: string): boolean {
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (arr.length >= 10) return false;
  arr.push(now);
  hits.set(ip, arr);
  return true;
}

export async function betaCheckHandler(c: Context): Promise<Response> {
  const ip = clientIp(c);
  if (!ip) {
    warnThrottled("betaGate.ip", "来源 IP 不可识别——验码下载 fail-closed，请核代理/XFF 配置");
    return c.json({ ok: false, reason: "ip_unavailable" }, 503);
  }
  if (!rateOk(ip)) return c.json({ ok: false, reason: "rate_limited" }, 429);
  let code = "";
  try {
    const body = await c.req.json<{ code?: string }>();
    code = (body.code ?? "").trim().slice(0, 80);
  } catch {
    return c.json({ ok: false, reason: "bad_request" }, 400);
  }
  if (!code) return c.json({ ok: false, reason: "empty" }, 400);

  // 万能内测码（彭总侧内测招商用）
  const master = process.env.BETA_MASTER_CODE;
  if (master && code === master)
    return c.json({ ok: true, orgName: null, via: "master" });

  if (!/^iv_[A-Za-z0-9]{20,}$/.test(code))
    return c.json({ ok: false, reason: "invalid" });
  try {
    await ensureBetaInvites();
    const hash = createHash("sha256").update(code).digest("hex");
    // 彭总 2026-10-02 令：内测资格码面迁 st_beta_invites（与 wb_invites 入企码语义分家）——只认资格码面（内测码全新签发，无旧码负担——legacy 兜底已摘，口径与注册面一致）；
    // st_beta_invites 由本件 ensure（启动面）；st_beta_applications 懒建面不 JOIN（炸面拆）；
    // consumed_at 消费在 wb 注册面（registerByPhone/authRegisterEnterprise 事务内）——本闸只验不消费（下载闸不耗码）；
    // 建表 DDL 与 betaApply.ensureBetaApplications 同形双份（门禁票注释钉：DDL 漂移两边同步改——表结构改动双仓同闸）
    const rows = rawRows(
      await getDb().execute(sql`
        SELECT b.id FROM st_beta_invites b
        WHERE b.codeHash = ${hash} AND b.consumed_at IS NULL AND b.revoked_at IS NULL AND b.expires_at > NOW()
        LIMIT 1`),
    ) as { id: number; enterpriseName?: string }[];
    // 只认 st_beta_invites（门禁票：下载闸认旧面但注册不认=口径不一致——legacy 兜底摘，内测码全走资格码面）
    if (rows.length === 0) return c.json({ ok: false, reason: "invalid" });
    return c.json({ ok: true, orgName: null, via: "invite_beta" }); // orgName 面摘（JOIN 懒建表雷拆——beta-check 只验不取名）
  } catch {
    return c.json({ ok: false, reason: "server_busy" }, 503);
  }
}
