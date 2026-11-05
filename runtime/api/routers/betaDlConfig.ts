import { PORTAL_WEB_URL_DEFAULT } from "@contracts/portal"; // 门户站域跨栈单源（二十九轮票）

/**
 * betaDlConfig —— 内测安装包下载链配置单源（OCR wb#77 二十八轮 test 票：helper 内嵌 router 件=行为钉要拖
 * 整棵路由依赖图——独立轻件直钉；sms.ts 引本件）。
 * 误配一律回退缺省（不发断链短信=闸纪律）；BETA_DL_BASE_DEFAULT 与前端 NEBULA_PORTAL_URL 缺省同引
 *  @contracts/portal PORTAL_WEB_URL_DEFAULT 跨栈真单源（二十九轮票——字面互钉已升级为契约件同引）。
 */

/** 门户 www 缺省域跨栈真单源（OCR wb#77 二十九轮票：字面复刻挪 @contracts/portal.ts——前端同引一源） */
export const BETA_DL_BASE_DEFAULT = PORTAL_WEB_URL_DEFAULT;

/** scheme+裸域校验（二十三轮 bug 票：/值或带换行覆值=相对/断行短信链——不匹配即回退缺省） */
export function betaDlBaseOf(envVal: string | undefined): string {
  const v = (envVal?.trim() || BETA_DL_BASE_DEFAULT).replace(/\/+$/, "");
  return /^https?:\/\/[^\s?#]+$/i.test(v) ? v : BETA_DL_BASE_DEFAULT; // ?# 同拒（二十四轮票：BASE 带 query/fragment=固定路径被吞面封死——与 dlPathOf 对称）；i 旗=scheme 大小写不敏感（三十轮票：HTTPS:// 不误判回退）
}

/** 站内路径归一（二十二轮 bug 票：绝对 URL/query 覆值=BASE+path 拼出断链——误配回退缺省不硬拼；
 *  空白/#同拒[二十四轮票——与 betaDlBaseOf 守卫对称]；缺前导斜杠补） */
export function dlPathOf(envVal: string | undefined, fallback: string): string {
  const p = envVal?.trim();
  if (!p || /^[a-z][a-z0-9+.-]*:\/\//i.test(p) || /[\s?#]/.test(p)) return fallback;
  return p.startsWith("/") ? p : `/${p}`;
}

/** 工作台安装包下载域（彭总链路钉：env 可配 BETA_DL_BASE——缺省 www 门户域[portal.lingshu 子域 DNS 不解析=死链实证]；
 *  直链 exe 不带 code 参[wb#77 security 票——包装页落地后恢复带码，P-DL-WRAPPER 挂账]） */
export const BETA_DL_BASE = betaDlBaseOf(process.env.BETA_DL_BASE);

/** 安装包路径（env 可覆——host 可配路径不可配=配置不对称面封死[十八轮票]；缺省=固定部署产物[P-DL-WRAPPER]） */
export const BETA_DL_PERSONAL_PATH = dlPathOf(process.env.BETA_DL_PERSONAL_PATH, "/dl/numx-personal-setup.exe");
export const BETA_DL_ENTERPRISE_PATH = dlPathOf(process.env.BETA_DL_ENTERPRISE_PATH, "/dl/numx-enterprise-setup.exe");
