/** 桌面端 API/页面/导航/子资源信任域单源：主进程与构建期 preload 渲染同引。 */
const DOMAIN = process.env.NUMX_PUBLIC_DOMAIN || "example.invalid";
const WWW_ORIGIN = `https://www.${DOMAIN}`;
const ADMIN_ORIGIN = `https://admin.${DOMAIN}`;
const WB_ORIGIN = `https://wb.${DOMAIN}`;
const API_BASE_ARG = "--numx-api-base=";

const SHELL_API_BASE = Object.freeze({ personal: WB_ORIGIN, enterprise: WB_ORIGIN, org: WB_ORIGIN, admin: ADMIN_ORIGIN, ops: ADMIN_ORIGIN });
// 页面 URL 与 API base 语义分离但当前同值，不维护第二份域名表；未来可独立覆盖而不复制字面量。
const SHELL_APP_URL = SHELL_API_BASE;
const SHELL_NAV_ORIGINS = Object.freeze({
  personal: Object.freeze([WB_ORIGIN, WWW_ORIGIN]),
  enterprise: Object.freeze([WB_ORIGIN, WWW_ORIGIN]),
  org: Object.freeze([WB_ORIGIN, WWW_ORIGIN]),
  admin: Object.freeze([ADMIN_ORIGIN, WWW_ORIGIN]),
  ops: Object.freeze([ADMIN_ORIGIN, WWW_ORIGIN]),
});
// 子资源域单独登记：与导航域解耦，后续对象存储/字体 CDN 必须显式评审后加入，不默认放开。
const SHELL_RESOURCE_ORIGINS = Object.freeze({
  personal: Object.freeze([WB_ORIGIN, WWW_ORIGIN]),
  enterprise: Object.freeze([WB_ORIGIN, WWW_ORIGIN]),
  org: Object.freeze([WB_ORIGIN, WWW_ORIGIN]),
  admin: Object.freeze([ADMIN_ORIGIN, WWW_ORIGIN]),
  ops: Object.freeze([ADMIN_ORIGIN, WWW_ORIGIN]),
});
const SHELL_TRUSTED_HOSTS = Object.fromEntries(Object.entries(SHELL_NAV_ORIGINS).map(([key, origins]) => [key, new Set(origins.map((origin) => new URL(origin).hostname))]));
const SHELL_RESOURCE_HOSTS = Object.fromEntries(Object.entries(SHELL_RESOURCE_ORIGINS).map(([key, origins]) => [key, new Set(origins.map((origin) => new URL(origin).hostname))]));

function parts(value, shellKey, resource = false) {
  const table = resource ? SHELL_RESOURCE_HOSTS : SHELL_TRUSTED_HOSTS;
  const hosts = Object.hasOwn(table, shellKey) ? table[shellKey] : null;
  if (!hosts) return null;
  try {
    const url = new URL(String(value));
    return { url, hosts };
  } catch {
    return null;
  }
}

/** 导航级：仅 HTTPS、默认 443 端口、当前壳域名；shellKey 缺失/非法一律 fail-closed。 */
function isTrustedUrl(value, shellKey) {
  const parsed = parts(value, shellKey);
  if (!parsed) return false;
  const { url, hosts } = parsed;
  return url.protocol === "https:" && url.username === "" && url.password === "" && hosts.has(url.hostname) && url.port === "";
}

/** 子资源级：HTTPS/WSS、当前壳资源域；data/blob 由主进程单独处理。 */
function isTrustedRequestUrl(value, shellKey) {
  const parsed = parts(value, shellKey, true);
  if (!parsed) return false;
  const { url, hosts } = parsed;
  return (url.protocol === "https:" || url.protocol === "wss:") && url.username === "" && url.password === "" && hosts.has(url.hostname) && url.port === "";
}

module.exports = {
  DOMAIN,
  WWW_ORIGIN,
  ADMIN_ORIGIN,
  WB_ORIGIN,
  API_BASE_ARG,
  SHELL_API_BASE,
  SHELL_APP_URL,
  SHELL_RESOURCE_ORIGINS,
  isTrustedUrl,
  isTrustedRequestUrl,
};
