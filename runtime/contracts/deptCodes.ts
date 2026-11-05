/**
 * deptCodes —— 职能部门键枚举跨栈单源（wb#79 复审票：deptConsole.ts 路由件导出=层级反[契约层引路由面]；
 * 挪契约层——deptConsole/deptMap/packages 三面同引一源，字面漂移面封死）。
 * ops 运营/brand 品牌/marketing 市场/tech 技术/finance 财务/legal 法务。
 */
export const DEPT_CODES = ["ops", "brand", "marketing", "tech", "finance", "legal"] as const;
export type DeptCode = (typeof DEPT_CODES)[number];
