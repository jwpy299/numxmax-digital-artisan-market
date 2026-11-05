import { TRPCError } from "@trpc/server";
import { requireAdmin, type DelegatedAdminIdentity } from "./adminGate";
import type { SafeWbUser } from "./identity";
import { warnThrottled } from "../queries/rawRows";
import { normalizeCiText } from "@contracts/authLock";
import { wbThreadUserId } from "./identity";

export type CabinRole = "admin" | "ops" | "tech" | "finance" | "staff";
export type CabinAction = "invite" | "release" | "training";
export type CabinIdentity = { id: number; auditId: number; username: string; displayName: string; cabin: string; cabinRole: CabinRole; delegated?: boolean; adminOrigin?: "native" };

const ROLE_VALUES = new Set<CabinRole>(["admin", "ops", "tech", "finance", "staff"]);
const ACTION_ROLES: Record<CabinAction, ReadonlySet<CabinRole>> = {
  invite: new Set(["admin", "ops"]),
  release: new Set(["admin", "tech"]),
  training: new Set(["admin", "tech"]),
};
type CabinRule = { key: string; role: string; cabin: string };

function cabinRules(rawConfig: string, source: "ADMIN_CABIN_ROLES" | "ADMIN_CABIN_IDS"): CabinRule[] {
  const out: CabinRule[] = [];
  if (!rawConfig.trim()) return out;
  for (const [index, item] of rawConfig.split(",").entries()) {
    const parts = item.trim().split(":").map((s) => s.trim());
    if (parts.length !== 3 || parts.some((p) => !p)) {
      warnThrottled(`cabin-rule-shape:${source}:${index}`, `${source} 第 ${index + 1} 项须为 key:role:cabin 三元组，已忽略该项`);
      continue;
    }
    const candidate = parts[1] as CabinRole;
    if (!ROLE_VALUES.has(candidate)) {
      warnThrottled(`cabin-rule-role:${source}:${index}`, `${source} 第 ${index + 1} 项角色 ${parts[1]} 非白名单，已忽略该项`);
      continue;
    }
    if (source === "ADMIN_CABIN_IDS" && (!/^[1-9]\d*$/.test(parts[0]) || !Number.isSafeInteger(Number(parts[0])))) {
      warnThrottled(`cabin-rule-id:${source}:${index}`, `${source} 第 ${index + 1} 项 id 非正整数/超安全整数，已忽略该项`);
      continue;
    }
    out.push({ key: parts[0], role: parts[1], cabin: parts[2] });
  }
  if (rawConfig.trim() && out.length === 0) warnThrottled(`cabin-rules-empty:${source}`, `${source} 已配置但无有效规则——全部写权限按 staff 只读，请修配置`);
  return out;
}

/** ADMIN_CABIN_IDS=id:role:cabin 配置后=只按不可变 id 授权；未配置才沿用 ADMIN_CABIN_ROLES 用户名通道。
 *  未映射/未知角色/坏三元组一律 staff 只读并节流留痕，绝不让空格或同名新号静默获得写权。 */
export function cabinIdentityOf(admin: SafeWbUser | DelegatedAdminIdentity): CabinIdentity {
  const username = admin.username;
  const idConfig = (process.env.ADMIN_CABIN_IDS ?? "").trim();
  const idMode = idConfig.length > 0;
  if (idMode && (process.env.ADMIN_CABIN_ROLES ?? "").trim()) warnThrottled("cabin-rules-shadowed", "ADMIN_CABIN_IDS 已启用，ADMIN_CABIN_ROLES 整表被遮蔽——请清理旧用户名名单，避免误判授权来源");
  const rules = cabinRules(idMode ? idConfig : (process.env.ADMIN_CABIN_ROLES ?? ""), idMode ? "ADMIN_CABIN_IDS" : "ADMIN_CABIN_ROLES");
  const auditId = wbThreadUserId(admin);
  let cabin = "self";
  let cabinRole: CabinRole = "staff";
  let matched = false;
  for (const rule of rules) {
    const hit = idMode ? rule.key === String(auditId) : normalizeCiText(rule.key) === normalizeCiText(username);
    if (!hit) continue;
    matched = true;
    cabinRole = rule.role as CabinRole; // cabinRules 已完成形状/id/角色白名单校验，不重复养第二套判定。
    cabin = rule.cabin.slice(0, 48);
    break;
  }
  if (!matched) warnThrottled(`cabin-role-unmapped:${idMode ? admin.id : username}`, `${idMode ? "ADMIN_CABIN_IDS" : "ADMIN_CABIN_ROLES"} 未映射账号 ${username}（id=${admin.id}），已按 staff 只读`);
  return {
    id: admin.id,
    auditId,
    username,
    displayName: admin.displayName || username,
    cabin,
    cabinRole,
    ...("delegated" in admin && typeof admin.delegated === "boolean" ? { delegated: admin.delegated } : {}),
    ...("adminOrigin" in admin && admin.adminOrigin === "native" ? { adminOrigin: "native" as const } : {}),
  };
}

export async function requireCabinAction(token: string, action: CabinAction): Promise<CabinIdentity> {
  const identity = cabinIdentityOf(await requireAdmin(token));
  if (!ACTION_ROLES[action].has(identity.cabinRole)) {
    throw new TRPCError({ code: "FORBIDDEN", message: `舱角色 ${identity.cabinRole} 对此动作只读——需具备 ${action} 写权限` });
  }
  return identity;
}
