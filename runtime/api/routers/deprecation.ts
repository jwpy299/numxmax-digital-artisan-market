/**
 * deprecation —— 废弃端点观察器（彭总拍板 2026-08-13：类四下线）。
 *
 * 机制：30 天观察期内功能保留，但每次调用：
 * 1. 内存计数 + console.warn（运维巡检可见）；
 * 2. 响应追加 { deprecated: true, successor } 打标（调用方/抓包可见迁移方向）。
 * 观察期 0 调用 → 到期物理删除；有调用 → 顺着 successor 迁移调用方后再删。
 *
 * 在册三端点：
 * - workbenchLink.workbenchLogin → agentic.authLogin（老转发口径，HK 双机时代遗物）
 * - workbenchLink.workbenchRegister → agentic.authRegister（同上）
 * - agentic.sessionUpgrade → wbInvites.accept（占位桩，M22 入企已被邀请契约覆盖）
 */

const hits = new Map<string, number>();

/** 打标并计数（成功响应外壳；payload 必须为对象） */
export function markDeprecated<T extends object>(
  name: string,
  successor: string,
  payload: T,
): T & { deprecated: true; successor: string } {
  const n = (hits.get(name) ?? 0) + 1;
  hits.set(name, n);
  console.warn(`[deprecated] ${name} hit #${n}; successor=${successor}`);
  return { ...payload, deprecated: true as const, successor };
}

/** 观察期命中计数（巡检用） */
export function deprecatedHits(): Record<string, number> {
  return Object.fromEntries(hits);
}
