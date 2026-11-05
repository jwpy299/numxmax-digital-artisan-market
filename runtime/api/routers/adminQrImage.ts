/** 管理台二维码图：实例签名有效 + 会话有效 + 创建 IP 匹配才出图，且不缓存。 */
import type { Context } from "hono";
import QRCode from "qrcode";
import { sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { rawRows, logQueryErrorThrottled } from "../queries/rawRows";
import { clientIp } from "../lib/clientIp";
import { ensureQrSessions, adminQrRateOk, adminQrExpiresAt } from "./qrLoginShared";
import { parseAdminConsoleQrText, verifyAdminConsoleProof, buildAdminConsoleQrText } from "./adminQrProof";

export async function adminQrImageHandler(c: Context): Promise<Response> {
  const text = (c.req.query("text") ?? "").trim().slice(0, 420);
  const parsed = parseAdminConsoleQrText(text);
  if (!parsed) return c.json({ ok: false, reason: "bad_text" }, 400);
  const ip = clientIp(c);
  if (!ip) return c.json({ ok: false, reason: "ip_unavailable" }, 400);
  try {
    if (!verifyAdminConsoleProof(parsed.session, parsed.consoleId, parsed.expiresAt, parsed.proof)) {
      return c.json({ ok: false, reason: "bad_text" }, 400);
    }
    await ensureQrSessions();
    const db = getDb();
    if (!(await adminQrRateOk(db, "image", ip, 60, 600))) return c.json({ ok: false, reason: "rate_limited" }, 429);
    // 不在 SQL 里混用 DB NOW()：created_at/expiresAt 均由本进程签发并同源校验，避免 Node/MySQL 时区或时钟差秒杀新会话。
    const rows = rawRows(await db.execute(sql`SELECT id, created_at FROM st_qr_sessions WHERE session=${parsed.session} AND target='admin_console' AND client_ip=${ip} AND state IN ('pending','confirmed') LIMIT 1`)) as Array<Record<string, unknown>>;
    const createdAt = rows[0] ? new Date(rows[0].created_at as string).getTime() : 0;
    if (rows.length !== 1 || adminQrExpiresAt(createdAt) !== parsed.expiresAt || Date.now() > parsed.expiresAt) return c.json({ ok: false, reason: "bad_text" }, 400);
    const canonicalText = buildAdminConsoleQrText(parsed.session, parsed.expiresAt); // 多余/重复参数不随用户输入回显进二维码
    const buf: Buffer = await QRCode.toBuffer(canonicalText, {
      type: "png", width: 420, margin: 2,
      color: { dark: "#0a0f1a", light: "#ffffff" },
    });
    return new Response(new Uint8Array(buf), {
      headers: { "content-type": "image/png", "cache-control": "private, no-store" },
    });
  } catch (e) {
    logQueryErrorThrottled("[routers/adminQrImage] 出图失败（会话查询/限流/编码）", e);
    return c.json({ ok: false, reason: "qr_error" }, 500);
  }
}
