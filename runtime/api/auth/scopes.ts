/**
 * 四层四锁账号体系·角色与舱域单点（批七-a，全景图 P0-2：三舱权限的钥匙）。
 *
 * 四层角色（boss 老板 / admin 管理 / staff 员工 / guest 访客）× 三舱域（code 代码舱 / training 训练舱 / distill 蒸馏舱）。
 * 权限三态：write（写+读）/ read（只读）/ none（不可见）。
 *
 * 纪律：
 * - 本文件只放矩阵与类型，零运行时依赖（纯数据叶，测试/前端/服务端三侧同引）；
 * - 矩阵字面量即策略——改权限=改本表+彭总拍板，代码里不得出现第二份权限字面值；
 * - fail-closed 方向恒定：未登记的组合一律 none。
 */

export const ROLES = Object.freeze(["boss", "admin", "staff", "guest"] as const); // R7-b2-④：运行期同冻——CABINS 被 normalizeCabin 运行期消费，push 即静默扩舱域（「未知舱域返 null」契约被 run-time 改写）
export type Role = (typeof ROLES)[number];

export const CABINS = Object.freeze(["code", "training", "distill"] as const); // R7-b2-④：同冻
export type Cabin = (typeof CABINS)[number];

export type Access = "write" | "read" | "none";

/** 舱域中文名单点（降级话术/UI 标签不落英文字面量） */
export const CABIN_LABELS = {
  code: "代码舱",
  training: "训练舱",
  distill: "蒸馏舱",
} as const satisfies Record<Cabin, string>; // R7-c8-④：类型面只读化——与下方运行期 Object.freeze 双闸，import 方不再可写

/**
 * 权限矩阵（批七-a 骨架版，彭总 2026-09-23 定调）：
 * - 老板 boss：三舱全权（write）；
 * - 管理 admin：代码舱 write、训练舱 read、蒸馏舱 read（经营视角只读监管）；
 * - 员工 staff：代码舱 none（不见工程线）、训练舱 write（本职语料/反馈产线）、蒸馏舱 none；
 * - 访客 guest：全 none（登录即最低权限，任何开舱都要显式授权）。
 *
 * satisfies 钉全格（R7-1-④）：缺格/多格/错值编译期即炸；不写显式 Record 标注（会把键放宽）
 */
export const ACCESS_MATRIX = {
  boss: { code: "write", training: "write", distill: "write" },
  admin: { code: "write", training: "read", distill: "read" },
  staff: { code: "none", training: "write", distill: "none" },
  guest: { code: "none", training: "none", distill: "none" },
} as const satisfies Record<Role, Record<Cabin, Access>>;

// R7-13-④：运行期冻结——as const/satisfies 只管编译期，矩阵是唯一策略源，导入方不得静默改写
Object.values(ACCESS_MATRIX).forEach((row) => Object.freeze(row)); // R7-17-⑤：显式回调
Object.freeze(ACCESS_MATRIX);
Object.freeze(CABIN_LABELS); // R7-b-③：舱域中文名同冻（同为导出策略单源，UI/话术不被静默改写）

/**
 * 权限判定谓词（单点）：未登记的组合一律 none（fail-closed）。
 * R7-1-⑤ security：自有属性判定（Object.hasOwn）——原型链键（constructor/name 等）不得命中，
 *  仓内同约：releaseCenter「归属判断走 hasOwnProperty」/harness/policy 用 Object.hasOwn
 */
export function accessOf(role: Role, cabin: Cabin): Access {
  if (!Object.hasOwn(ACCESS_MATRIX, role)) return "none";
  const row = ACCESS_MATRIX[role];
  return Object.hasOwn(row, cabin) ? row[cabin] : "none";
}

/** 门禁规则单点（R7-9-②）：read/write 门规只此一处——guards 判决层与便捷谓词同引，规则演进不改两处 */
export function doorRule(access: Access, mode: "read" | "write"): boolean {
  return mode === "write" ? access === "write" : access !== "none";
}

// R7-c3-③：canRead/canWrite 薄壳摘除——全仓无在产消费端（门禁层走 judgeRead/judgeWrite→doorRule），
//  双薄壳会与 doorRule 漂移且只被测试当神谕（神谕与实现同源=假测试）；消费端真来时从 doorRule 重新立
