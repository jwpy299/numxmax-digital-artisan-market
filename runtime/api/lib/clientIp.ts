/**
 * clientIp —— socket peer 锚定的客户端 IP 解析单点。
 * 非可信 peer：只返回真实 peer，不信任何转发头；可信 peer：只接受 XFF，失败即空串。
 * TRUSTED_PROXY_HOPS 含直连 socket 代理：当前 nginx 单层=1；CDN→nginx=2，且 CDN 出口也须入 TRUSTED_PROXIES。
 * 配置漂移=限流/扫码/邀测等 IP 键功能 fail-closed，绝不回退 unknown 共桶或让伪造者自选键。
 */
import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { isIP } from "node:net";
import { createHash, createHmac } from "node:crypto";

const DEFAULT_TRUSTED_PROXIES = "127.0.0.1,::1";
const PROXY_WARN_TTL_MS = 60_000;
const MAX_XFF_HOPS = 64;
const proxyWarnAt = new Map<string, number>();

/** IPv4/IPv6 归一：压缩/展开/大小写统一；IPv4-mapped 统一成 dotted IPv4。 */
export function normalizeIpLiteral(value: string | null | undefined): string {
  const raw = (value ?? "").trim();
  const kind = isIP(raw);
  if (kind === 4) return raw;
  if (kind !== 6) return "";
  try {
    const canonical = new URL(`http://[${raw}]/`).hostname.slice(1, -1).toLowerCase();
    if (!canonical.startsWith("::ffff:")) return canonical;
    const tail = canonical.slice(7);
    if (isIP(tail) === 4) return tail;
    const parts = tail.split(":");
    if (parts.length === 2 && /^[0-9a-f]{1,4}$/.test(parts[0]) && /^[0-9a-f]{1,4}$/.test(parts[1])) {
      const hi = Number.parseInt(parts[0], 16);
      const lo = Number.parseInt(parts[1], 16);
      return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    }
    return canonical;
  } catch {
    return "";
  }
}

/** 按诊断种类分桶节流：同类不刷屏，不同配置/不同失败面不互相吞掉。 */
function warnProxy(kind: string, message: string): void {
  const now = Date.now();
  const last = proxyWarnAt.get(kind) ?? 0;
  if (now - last < PROXY_WARN_TTL_MS) return;
  if (proxyWarnAt.size >= 1024) {
    // peer-xff 可含不同源 IP，必须有界；淘汰最老 1/4，保留近期诊断。
    const drop = Math.ceil(proxyWarnAt.size / 4);
    for (const key of [...proxyWarnAt.keys()].slice(0, drop)) proxyWarnAt.delete(key);
  }
  proxyWarnAt.set(kind, now);
  console.warn(`[clientIp] ${message}`);
}

let proxyCacheKey: string | undefined;
let proxyCacheSet = new Set<string>();

/** 按原始 env 串缓存解析结果（改 env 即重算）；显式空值=空信任集，绝不回退默认信任。 */
function trustedProxies(): Set<string> {
  const configured = process.env.TRUSTED_PROXIES;
  const raw = configured === undefined ? DEFAULT_TRUSTED_PROXIES : configured.trim();
  if (raw === proxyCacheKey) return proxyCacheSet;
  proxyCacheKey = raw;
  proxyCacheSet = new Set<string>();
  if (!raw) {
    warnProxy("trust-empty", "TRUSTED_PROXIES 显式为空：不信任任何代理，转发头一律忽略");
    return proxyCacheSet;
  }
  let invalid = false;
  for (const item of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const ip = normalizeIpLiteral(item);
    if (ip) proxyCacheSet.add(ip);
    else invalid = true;
  }
  if (invalid) warnProxy("trust-invalid", "TRUSTED_PROXIES 含非 IP 项，已忽略；请只配置代理 IP 字面量");
  if (!invalid && proxyCacheSet.size === 0) {
    warnProxy("trust-empty", `TRUSTED_PROXIES=${raw} 未解析出任何 IP：不信任任何代理，转发头一律忽略`);
  }
  return proxyCacheSet;
}

function xffHops(xff: string | null | undefined): string[] {
  if (!xff) return [];
  return xff.split(",").map((s) => s.trim()).filter(Boolean);
}

/** 代理层数可配置：默认 1 层取末跳；CDN/LB 多层时按实际层数回跳，避免把出口代理当客户。 */
function trustedProxyHops(): number {
  const raw = (process.env.TRUSTED_PROXY_HOPS ?? "1").trim();
  if (!/^\d+$/.test(raw)) {
    warnProxy("hops-invalid", `TRUSTED_PROXY_HOPS=${raw} 非正整数，按 1 层处理`);
    return 1;
  }
  const n = Number(raw);
  if (n < 1 || n > 16) {
    warnProxy("hops-invalid", `TRUSTED_PROXY_HOPS=${raw} 超出 1..16，按 1 层处理`);
    return 1;
  }
  return n;
}

/**
 * 取客户跳并验证其右侧的 XFF 代理跳全在信任集。
 * socket peer 已在 clientIp 验证，故 skip=1 无需再跳 XFF 代理；skip=2 须验证最右一枚为 CDN/LB。
 */
function xffClientHopStr(xff: string | null | undefined, trusted: Set<string>, peerIp: string): string {
  const hops = xffHops(xff);
  const skip = trustedProxyHops();
  if (hops.length === 0) {
    warnProxy("xff-missing", `可信代理 ${peerIp} 缺少 XFF——本次请求无 IP 键，请核 proxy_set_header`);
    return "";
  }
  if (hops.length > MAX_XFF_HOPS) {
    warnProxy("xff-shape", `可信代理 ${peerIp} 的 XFF 跳数超过 ${MAX_XFF_HOPS}——按不可解析拒绝`);
    return "";
  }
  if (hops.length < skip) {
    warnProxy("xff-hops", `可信代理 ${peerIp} 的 XFF 仅 ${hops.length} 跳，少于 TRUSTED_PROXY_HOPS=${skip}——按配置错误拒绝`);
    return "";
  }
  const normalized = hops.map((hop) => normalizeIpLiteral(hop.slice(0, 64)));
  if (normalized.some((hop) => !hop)) {
    warnProxy("xff-shape", `可信代理 ${peerIp} 的 XFF 含 unknown/主机名/端口或非法 IP——本次请求无 IP 键`);
    return "";
  }
  // 客户跳右侧的 XFF 项都是代理；任何一项不可信即可能是客户端自带伪造链，不能按位置盲信。
  for (let i = normalized.length - skip + 1; i < normalized.length; i += 1) {
    if (!trusted.has(normalized[i])) {
      warnProxy("xff-untrusted-hop", `XFF 第 ${i + 1} 跳 ${normalized[i]} 不在 TRUSTED_PROXIES——拒绝按 TRUSTED_PROXY_HOPS=${skip} 取更左值`);
      return "";
    }
  }
  const candidate = normalized[normalized.length - skip] ?? "";
  if (candidate && trusted.has(candidate)) {
    warnProxy("xff-undercount", `解析候选 ${candidate} 仍在 TRUSTED_PROXIES——TRUSTED_PROXY_HOPS=${skip} 小于实际代理链，拒绝把代理当客户`);
    return "";
  }
  return candidate;
}

/** 限流 IP 指纹：优先 HMAC 密钥；未配置时兼容无盐 SHA-256 并明确告警，绝不宣称匿名化。 */
export function rateIpDigest(ip: string): string {
  const secret = (process.env.RATE_KEY_SECRET ?? "").trim();
  if (secret.length >= 32) return createHmac("sha256", secret).update(ip).digest("hex");
  warnProxy("rate-key-secret-missing", "RATE_KEY_SECRET 未配置——限流 IP 键使用可枚举无盐 SHA-256，请配置 32+ 字节密钥");
  return createHash("sha256").update(ip).digest("hex");
}

export function clientIp(c: Context): string {
  let peer = "";
  let peerError = false;
  try { peer = getConnInfo(c).remote.address ?? ""; } catch { peerError = true; }
  const peerIp = normalizeIpLiteral(peer);
  if (!peerIp) {
    warnProxy("peer-missing", `socket peer ${peerError ? "读取失败" : `非 IP 字面量（${peer || "empty"}）`}——本次请求无 IP 键`);
    return "";
  }
  const trusted = trustedProxies();
  if (!trusted.has(peerIp)) {
    if (c.req.header("x-forwarded-for")) warnProxy(`peer-xff:${peerIp}`, `非可信 peer ${peerIp} 携带 XFF——转发头被忽略；请核 TRUSTED_PROXIES`);
    return peerIp;
  }
  // 可信代理但 XFF 缺失/伪造/含端口/跳数或信任链不符=配置错误，fail-closed。
  return xffClientHopStr(c.req.header("x-forwarded-for"), trusted, peerIp);
}
