/**
 * wb 角色方言归一（零依赖中性叶，批七 R7-7-④）：本模块不引 connection/drizzle/crypto——
 *  安全边界层（auth/guards）与路由层（routers/wbSession）同引，auth 不再倒依赖路由/DB 层（防环）。
 *
 * 口径（自 wbSession 迁入，单点不变）：
 * - admin/owner → admin（存量枚举 owner 不批量 UPDATE，读取侧归一）；
 * - manager → manager（部门负责人，另有 wb_dept_heads 并集口径在 wbSession.effectiveRoleOf）；
 * - member/staff/null/未知历史值 → staff 兜底（会话兼容面）。
 * 注意：本归一的「未知→staff」是【会话兼容】口径；四锁安全边界走 identity.ts 品牌证据
 * （unknown/半成品一律落 guest 不上特权——legacyDialectToLockRole 已退役摘除，不再指向死名），两口径有意不同。
 * 分层分工钉准（R7-c2-⑦）：本叶管 wb 会话归一（owner→admin 含存量）；四锁边界管理层（guards）owner→guest、identity 证据层严格 role==='admin'——owner 存量行在 requireAdmin 即 401（同闸不另开通道），三层口径分工有意不同不「对齐」回潮。
 * 组合纪律（R7-13-②/R7-c3-①/R7-c7-② 钉准）：normalizeRole 的输出【不可】直喂 lockRoleOfWbRole——其入参收窄为
 *  Exclude<WbRole, "admin">（R7-b6-②/R7-c10-③ 单源同引：本表更名即编译期跟红），WbRole 全联合在编译期喂不进；
 *  四锁边界在七-c 统一走 identity.ts 品牌证据（legacyDialectToLockRole 已退役摘除）；normalizeRole 仅供会话兼容面，两器分工不互替。
 */

export type WbRole = "admin" | "manager" | "staff";

/** 会话角色归一（双端会话兼容面）——组合纪律（R7-16-①/R7-17-①/R7-c12-④）：输出【不可】直喂 lockRoleOfWbRole
 *  （其入参 Exclude<WbRole,"admin"> 收窄，组合陷阱由该函数类型层+运行期 fail-closed 自兜，normalizeRoleStrict 双轨已摘除）；
 *  存量员工层方言名单已退役（R7-c7-①/R7-c9-③：legacyDialectToLockRole 连同名单摘除——唯一消费端没了；四锁 staff 判定归七-c identity.ts 品牌证据） */
export function normalizeRole(role: string | null | undefined): WbRole {
  if (role === "admin" || role === "owner") return "admin";
  if (role === "manager") return "manager";
  return "staff"; // member / null / 未知历史值一律 staff 兜底（会话兼容面）
}
