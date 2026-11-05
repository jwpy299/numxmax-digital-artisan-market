/** 管理台二维码实例/会话/过期时间签名：HMAC 防篡改；密钥只读 env，绝不下发。 */
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { QR_SESSION_RE } from "../lib/qrSession";
import { warnThrottled } from "../queries/rawRows";

const PREFIX = "lingshu://qr-login?";
export const ADMIN_CONSOLE_ID_RE = /^[a-z0-9][a-z0-9-]{2,62}$/;

function proofKey(): Buffer {
  const dedicated = (process.env.ADMIN_CONSOLE_PROOF_KEY ?? "").trim();
  if (dedicated) {
    if (!/^[0-9a-fA-F]{64}$/.test(dedicated)) throw new Error("ADMIN_CONSOLE_PROOF_KEY 形态错（须 64 hex）");
    return Buffer.from(dedicated, "hex");
  }
  const master = (process.env.QR_LOGIN_ENC_KEY ?? "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(master)) throw new Error("ADMIN_CONSOLE_PROOF_KEY/QR_LOGIN_ENC_KEY 未配或形态错（须 64 hex）");
  // 未配独立证明钥时按用途派生子钥，AES 密钥与 HMAC 密钥不共用同一原始密钥材料。
  return Buffer.from(hkdfSync("sha256", Buffer.from(master, "hex"), Buffer.alloc(0), "numx-admin-console-proof-v1", 32));
}

export function adminConsoleId(): string {
  const configured = (process.env.ADMIN_CONSOLE_ID ?? "").trim();
  if (!configured) {
    if (process.env.NODE_ENV === "production") throw new Error("ADMIN_CONSOLE_ID 未配置——生产环境必须显式声明实例，拒绝冒充默认生产实例");
    warnThrottled("admin-console-id-missing", "ADMIN_CONSOLE_ID 未配置——使用非生产占位实例；生产环境将 fail-loud");
    return "numx-dev-admin-unconfigured";
  }
  if (!ADMIN_CONSOLE_ID_RE.test(configured)) throw new Error("ADMIN_CONSOLE_ID 形态无效");
  return configured;
}

export function adminConsoleProof(session: string, consoleId: string, expiresAt: number): string {
  return createHmac("sha256", proofKey()).update(`admin-console-v1|${session}|${consoleId}|${expiresAt}`).digest("hex").slice(0, 32);
}

export function verifyAdminConsoleProof(session: string, consoleId: string, expiresAt: number, proof: string): boolean {
  if (!/^[0-9a-f]{32}$/.test(proof) || consoleId !== adminConsoleId()) return false;
  const expect = adminConsoleProof(session, consoleId, expiresAt);
  return timingSafeEqual(Buffer.from(expect, "utf8"), Buffer.from(proof, "utf8"));
}

export function buildAdminConsoleQrText(session: string, expiresAt: number): string {
  const consoleId = adminConsoleId();
  const proof = adminConsoleProof(session, consoleId, expiresAt);
  const params = new URLSearchParams({ s: session, t: "admin_console", c: consoleId, e: String(expiresAt), p: proof });
  return `${PREFIX}${params.toString()}`;
}

export function parseAdminConsoleQrText(text: string): { session: string; consoleId: string; expiresAt: number; proof: string } | null {
  if (!text.startsWith(PREFIX)) return null;
  const p = new URLSearchParams(text.slice(PREFIX.length));
  const session = p.get("s") ?? "";
  const consoleId = p.get("c") ?? "";
  const expiresAt = Number(p.get("e"));
  const proof = p.get("p") ?? "";
  if (p.get("t") !== "admin_console" || !QR_SESSION_RE.test(session) || !ADMIN_CONSOLE_ID_RE.test(consoleId) || !Number.isSafeInteger(expiresAt) || expiresAt <= 0 || !/^[0-9a-f]{32}$/.test(proof)) return null;
  return { session, consoleId, expiresAt, proof };
}
