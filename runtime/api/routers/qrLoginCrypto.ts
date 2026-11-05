/**
 * qrLoginCrypto —— 扫码登录 wb token 的一次性密文面（AES-256-GCM，vp1 三段式同手法——voiceprint.ts 实证面复刻）。
 * 纪律：wb token 明文不落库——confirm 时加密落 wb_token_enc（qk1 前缀三段式），status 首次取出解密返+清列（一次性面）。
 * 钥面：env QR_LOGIN_ENC_KEY（64 hex=32B）——与声纹钥分域（凭证隔离面，不共用 VOICEPRINT_ENC_KEY）。
 * 未配钥=fail-loud（登录链不许静默降级明文落库——彭总凭证纪律）。
 */
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

const QR_ENC_PREFIX = "qk1";

function qrEncKey(): Buffer {
  const hex = (process.env.QR_LOGIN_ENC_KEY ?? "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("[qrLogin] QR_LOGIN_ENC_KEY 未配或形态错（须 64 hex=32B）——扫码登录 fail-loud 不明文落库");
  }
  return Buffer.from(hex, "hex");
}

/** 加密：qk1 + iv.tag.ct（base64 三段式） */
export function encryptQrToken(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", qrEncKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `${QR_ENC_PREFIX}${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${ct.toString("base64")}`;
}

/** 解密：非 qk1/验签败/坏档=返 null（数据面柔性强）；
 *  但 QR_LOGIN_ENC_KEY 未配/形态错=**抛**（fail-loud——配置故障装成 expired=静默烧会话面封死，门禁 wb#70 钉） */
export function decryptQrToken(stored: string): string | null {
  if (!stored.startsWith(QR_ENC_PREFIX)) return null;
  const key = qrEncKey(); // 配置错=抛（不吞——fail-loud 纪律：配置故障≠会话过期）
  const parts = stored.slice(QR_ENC_PREFIX.length).split(".");
  if (parts.length !== 3) return null;
  const [ivB64, tagB64, ctB64] = parts;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null; // 验签败/坏档=数据面 null（不抛）
  }
}
