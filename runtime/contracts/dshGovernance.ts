/**
 * DSH 服务端治理契约（生产前沙箱版）。
 *
 * 边界：APP 只提交治理请求；安装/启用/预算/合同/审计/晋升/回滚必须由服务端裁决。
 * factoryId 只允许来自服务端会话，不接受客户端覆盖。
 */
export type DshGovernanceRisk = "A" | "B" | "C";
export type DshGovernanceAutonomy = "L0" | "L1" | "L2" | "L3" | "L4";
export type DshGovernanceKind = "skill" | "employee" | "workflow";
export type DshContractStatus = "proposed" | "shadow" | "active" | "retired" | "rolled_back";
export type DshTicketAction = "install" | "rollback" | "retire";
export type DshTicketStatus = "pending" | "consumed" | "cancelled";

export interface DshContractDto {
  id: number;
  contractNo: string;
  requestId: string;
  factoryId: number;
  capabilityKey: string;
  kind: DshGovernanceKind;
  risk: DshGovernanceRisk;
  autonomy: DshGovernanceAutonomy;
  permissions: string[];
  budgetMonthly: number;
  budgetUsed: number;
  status: DshContractStatus;
  successCount: number;
  failCount: number;
  evalScore: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface DshTicketDto {
  id: number;
  ticketNo: string;
  factoryId: number;
  contractId: number;
  action: DshTicketAction;
  status: DshTicketStatus;
  createdBy: string;
  confirmedBy: string | null;
  createdAt: string;
  consumedAt: string | null;
}

export interface DshAuditDto {
  id: number;
  factoryId: number;
  contractId: number | null;
  actor: string;
  action: string;
  risk: DshGovernanceRisk | null;
  detail: string;
  createdAt: string;
}
