/**
 * totp —— 七-d 二要素（2FA）· RFC 6238 TOTP 纯实现（零外部依赖）。
 *
 * 口径：
 * - HMAC-SHA1 / 30s 步长 / 6 位码 / ±1 窗容忍（时钟漂移+人读码输入时延）；
 * - 密钥 base32 编解码自实现（otpauth:// 生态兼容——扫码器/钥匙串 App 通用）；
 * - 生成=20 字节加密随机（RFC 4226 推荐长）；校验=恒定时比较（时序侧信道钉）；
 * - 本模块纯函数零 DB——存储/回放闸归 adminAuth（st_admin_2fa.last_step 拒同步重放）。
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto"; // 门禁 PR#9-r8-⓪：静态加密件同引
import { env } from "../lib/env"; // 门禁 PR#9-r9-③：生产判别走 env 共享抽象

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** 协议参数单源（门禁 PR#9-⑤）：步长/位数具名常量——模块内步扫/形状钉与 adminAuth otpauth URL 全同引
 *  （任一处字面量漂移=服务端校验与扫码器生成静默不匹配面封死） */
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** 门禁 PR#9-r2-⓪/⑦/⑧：算法/密钥长/漂移容忍窗同升格具名单源（±1 窗=同时在效码数=暴破面尺寸——
 *  adminAuth 节流参数与本仓注释全按它 sizing；TOTP_ALGORITHM 供 enroll otpauth URI 同引锁步） */
export const TOTP_ALGORITHM = "sha1"; // RFC 6238 基线（URI 侧大写形态在 adminAuth 派生）
export const TOTP_SECRET_BYTES = 20; // RFC 4226 推荐 160-bit
export const TOTP_DRIFT_STEPS = 1; // ±1 窗（时钟漂移+人读码时延）
export const TOTP_CODE_RE = new RegExp(`^\\d{${TOTP_DIGITS}}$`); // 形状钉随位数常量派生（adminAuth schema 同引——门禁 PR#9-r2-⑥）

/** base32 编码（无填充——otpauth 生态惯例） */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** base32 解码（容忍小写/空白/填充符——手抄/粘贴形态全收） */
export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=]+/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error("base32 非法字符");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 静态加密（门禁 PR#9-r8-⓪ security medium——P-2FA-ENC 提前落地）：AES-256-GCM，钥走 env TOTP_SECRET_ENC_KEY
 *  （64 hex=32B——形态错 fail-loud 不降级弱存）；行格式 `v1.<iv_b64>.<tag_b64>.<ct_b64>`；
 *  无钥=明文 base32 原样存（dev/pre-migration 可用——生产上线检查单必配；enroll 点节流告警）；旧明文行按前缀分流可读（混合期平滑） */
const TOTP_ENC_PREFIX = "v1.";
/** 加密配置事故型别（门禁 PR#9-r11-②）：配置错按型别分类——调用方不再咬话术子串（措辞演进/撞词误判面封死） */
export class TotpConfigError extends Error {}
function totpEncKey(): Buffer | null {
  const hex = env.totpSecretEncKey.trim(); // 门禁 PR#9-r35-⑤：env 单点（process.env 直读收口）
  if (hex === "") return null;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new TotpConfigError("[auth/totp] TOTP_SECRET_ENC_KEY 形态错（须 64 hex=32B——配置错配 fail-loud）");
  return Buffer.from(hex, "hex");
}
/** 加密就绪判别（门禁 PR#9-r9-④）：adminAuth 告警支同引——调用方不再内联 env 直读（与 totpEncKey 双源漂移面封死）；
 *  形态错不在此吞（totpEncKey fail-loud 原样上行——配置事故炸眼，不降级成「未配」误导读） */
export function totpEncKeyConfigured(): boolean {
  return totpEncKey() !== null;
}

/** 入库加密：有钥 v1 三段式；无钥=【仅显式 dev/test】明文（告警归调用方）；其余一切环境（生产/staging/未设/拼错 NODE_ENV）
 *  无钥即拒写（门禁 PR#9-r9-③+r13-⑥ security medium——与 identity 的 opt-in 旗环境闸同政策：非显式开发态不裸存，
 *  配置回滚/漏配/环境名漂移不再静默把全员二要素种子静态裸存——fail-closed 显因） */
export function encryptSecretForStore(secretB32: string): string {
  const key = totpEncKey();
  if (!key) {
    if (!env.isExplicitNonProd) throw new TotpConfigError("[auth/totp] 未配 TOTP_SECRET_ENC_KEY 且非显式 dev/test——拒绝明文落库（2FA 静态加密强制件；环境集判定归 env.isExplicitNonProd 单点——门禁 PR#9-r14-④）");
    return secretB32;
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(secretB32, "utf8"), cipher.final()]);
  return `${TOTP_ENC_PREFIX}${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${ct.toString("base64")}`;
}
/** 出库解密：明文行原样返（前缀分流）；v1 行无钥/形态漂移/验签败（篡改/错钥）一律抛（fail-loud——不静默产错钥） */
export function decryptSecretFromStore(stored: string): string {
  if (!stored.startsWith(TOTP_ENC_PREFIX)) return stored;
  const key = totpEncKey();
  if (!key) throw new TotpConfigError("[auth/totp] 密文行在场但 TOTP_SECRET_ENC_KEY 未配——2FA 不可验（配置回滚/迁移漏带钥=显因显形）");
  const parts = stored.slice(TOTP_ENC_PREFIX.length).split(".");
  if (parts.length !== 3) throw new Error("[auth/totp] 密文形态漂移（v1 三段式不齐）——schema/数据漂移面");
  const [ivB64, tagB64, ctB64] = parts;
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}
/** 新密钥（TOTP_SECRET_BYTES 字节随机→base32——enroll 时下发一次；入库形态=encryptSecretForStore 单点决策；
 *  门禁 PR#9-r16-③：本 doc 随函数归位（此前悬在加密段上=归错属面封死） */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(TOTP_SECRET_BYTES)); // 密钥长单源（门禁 PR#9-r2-⑧）
}

/** 指定时间窗的 TOTP 码（RFC 6238 动态截断） */
export function totpAt(secretB32: string, step: number, digits = TOTP_DIGITS): string {
  const key = base32Decode(secretB32);
  // 门禁 PR#9-r8-①：密钥长钉——截断/腐化存量静默产短 HMAC 钥面封死（fail-loud——调用方 guardInfra 归 500 显因）
  if (key.length !== TOTP_SECRET_BYTES) throw new Error(`[auth/totp] 密钥长漂移（解得 ${key.length}B≠${TOTP_SECRET_BYTES}B）——schema/数据漂移面`);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(step));
  const h = createHmac(TOTP_ALGORITHM, key).update(buf).digest(); // 算法单源（门禁 PR#9-r2-⓪）
  const offset = h[h.length - 1] & 0x0f;
  const bin = ((h[offset] & 0x7f) << 24) | ((h[offset + 1] & 0xff) << 16) | ((h[offset + 2] & 0xff) << 8) | (h[offset + 3] & 0xff);
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** 校验（±TOTP_DRIFT_STEPS 窗容忍+恒定时比较）；返回命中步长（供回放闸拒同步重放）或 null。
 *  回放闸=高水位语义（门禁 PR#9-r4-⓪ 复审答复登记）：lastStep 后所有窗（含「当前窗」）一并拒——
 *  同窗码=同码，被 +1 容忍提前消费的下一窗码即「下一窗的码」本体，不存在「新鲜当前窗码被误拒」
 *  （该码已被出示过一次=再放行即真重放）；改记逐窗集合=旧窗码重放真洞（C100 在 105 窗再放行）。
 *  代价显式钉：提前消费 +1 窗后须等 +2 窗才出新码（测试 vi.setSystemTime +61s 钉死——有意取舍非缺陷） */
export function verifyTotp(secretB32: string, code: string, nowMs: number, lastStep: number | null): number | null { // 门禁 PR#9-r5-⓪ security medium：lastStep 改显式必填——省略即回放闸静默失效面封死（无码面调用方须显式 null 并在注释担责）
  const clean = code.replace(/\s+/g, "");
  if (!TOTP_CODE_RE.test(clean)) return null; // 形状不符即拒（不进窗扫）——形状钉随 TOTP_DIGITS 派生
  const step = Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
  const windows: number[] = [step]; // 当前窗先判（热径序保持）
  for (let d = 1; d <= TOTP_DRIFT_STEPS; d++) windows.push(step - d, step + d); // 漂移窗随常量派生（门禁 PR#9-r2-⑦）
  for (const w of windows) {
    if (w < 0) continue; // 门禁 PR#9-r25-① bug low：负步长钉——nowMs 不足一步时漂移窗探到 -1=writeBigUInt64BE RangeError 裸炸（形状不符该 null 不抛）
    if (lastStep !== null && w <= lastStep) continue; // 回放闸：已消费步长不再命中（高水位——含被 +1 容忍提前消费的窗）
    const expect = totpAt(secretB32, w);
    const a = Buffer.from(clean);
    const b = Buffer.from(expect);
    if (a.length === b.length && timingSafeEqual(a, b)) return w;
  }
  return null;
}
