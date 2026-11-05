/**
 * deptTeamSpec —— 部门包团队规格跨栈契约单源（与门户仓同构——彭总策略面：1 主管+N 专员[双层架构：执行层岗位 Agent+复核层复核 Agent 标配]）。
 * 消费面：api/routers/packages.ts（转出+种子面）、pkgCatalog.ts（文档体系种子目录）、前端部门包页。
 */
export interface DeptTeamSpec {
  lead: { role: "co"; deptKey: string; duty: string; skillHints: string[] }; // 部门主管（复核 Agent 标配——文档 2.1 双层架构复核层）
  members: Array<{ role: "ex" | "va" | "ev"; deptKey: string; duty: string; skillHints: string[] }>; // 专员清单（岗位 Agent 执行层）
}
