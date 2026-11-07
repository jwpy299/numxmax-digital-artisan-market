import { NEBULA_AUTH_STORAGE_KEY } from "@/config/workbench";
import {
  saveWbSession,
  clearWbSession,
  type WbSessionSaveResult,
} from "@/lib/wbSession";

/**
 * 工作台会话（localStorage("nebula_auth")，沿用官方文档约定）。
 * 登录 / 注册成功后，工作台返回的会话对象（含 token）原样保存；
 * token 单点有效——重新登录或 SSO 消费 ticket 后旧 token 即失效。
 */
export interface WorkbenchSession {
  token: string;
  username?: string;
  displayName?: string;
  enterpriseName?: string;
  factoryId?: string | number;
  role?: string;
  [key: string]: unknown;
}

/** 读取本地工作台会话；解析失败视为无会话 */
export function loadWorkbenchSession(): WorkbenchSession | null {
  try {
    const raw = localStorage.getItem(NEBULA_AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WorkbenchSession;
    return typeof parsed?.token === "string" && parsed.token ? parsed : null;
  } catch {
    return null;
  }
}

/** 保存工作台会话对象（含 token；ticket 明文严禁写入，仅会话 token 可持久化） */
export function saveWorkbenchSession(
  session: WorkbenchSession,
): WbSessionSaveResult {
  const factoryId =
    session.factoryId === undefined || session.factoryId === ""
      ? undefined
      : Number(session.factoryId);
  return saveWbSession({
    ...session,
    factoryId:
      factoryId !== undefined &&
      Number.isSafeInteger(factoryId) &&
      factoryId > 0
        ? factoryId
        : undefined,
  });
}

/** 断开：清除本地工作台会话 */
export function clearWorkbenchSession(): boolean {
  return clearWbSession();
}
