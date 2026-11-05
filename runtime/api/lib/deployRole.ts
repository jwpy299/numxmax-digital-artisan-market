/** 部署角色单源：仅 admin 角色开放内管 API 与管理台 QR；public 必须 404。 */
export function isAdminDeploy(): boolean {
  return process.env.NEBULA_DEPLOY_ROLE?.trim() === "admin";
}
