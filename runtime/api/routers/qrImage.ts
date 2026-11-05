/**
 * qrImage —— 邀请二维码图片端点（2026-09-05 彭总令：APP 邀请二维码扫码入舱）。
 * GET /api/invite-qr?code=iv_xxx → PNG（内容即智能落地页链接，扫码三形态同源）。
 * 纪律：iv_ 码格式校验防滥用；404 而不是 500；二维码内容永远是落地页 URL（设备自适应分流）。
 */
import type { Context } from "hono";
import QRCode from "qrcode";

const CODE_RE = /^iv_[A-Za-z0-9]{20,}$/;

export async function inviteQrHandler(c: Context): Promise<Response> {
  const code = (c.req.query("code") ?? "").trim().slice(0, 80);
  if (!CODE_RE.test(code)) return c.json({ ok: false, reason: "bad_code" }, 400);
  const url = `https://downloads.example.invalid/invite/?code=${code}`;
  try {
    const buf: Buffer = await QRCode.toBuffer(url, {
      type: "png",
      width: 480,
      margin: 2,
      color: { dark: "#0a0f1a", light: "#ffffff" },
    });
    return new Response(new Uint8Array(buf), {
      headers: {
        "content-type": "image/png",
        "cache-control": "private, max-age=300",
      },
    });
  } catch {
    return c.json({ ok: false, reason: "qr_error" }, 500);
  }
}
