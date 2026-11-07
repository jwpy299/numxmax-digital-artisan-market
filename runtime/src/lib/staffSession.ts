/**
 * 部门工作台（/staff/*）前端会话助手。
 *
 * 与 wbSession 同源但完全独立：会话存 localStorage("nebula_staff_auth")，
 * 避免与管理员/工作台会话（nebula_auth）互相覆盖（两套 nt_ token 单点体系互不影响）。
 * token 一律放请求体字段；tRPC 调用复用 wbSession 的 untyped client 助手。
 */
import { useCallback, useEffect, useState } from "react";
import {
  wbQuery,
  wbMutation,
  wbErrorMessage,
  isWbAuthError,
} from "@/lib/wbSession";
import { AUTH_SESSION_PERSIST_FAIL_MESSAGE } from "@contracts/authLock";

export const STAFF_AUTH_STORAGE_KEY = "nebula_staff_auth";

/** 部门工作台会话（staff.login 返回形态） */
export interface StaffSession {
  token: string;
  displayName: string;
  deptKey: string;
  deptName: string;
  role: "head" | "staff";
  username?: string;
  [key: string]: unknown;
}

const STAFF_SESSION_EVENT = "staff-session-changed";

function broadcastStaffSessionChange(): void {
  try { window.dispatchEvent(new Event(STAFF_SESSION_EVENT)) } catch (error) {
    console.warn('[staff-session] broadcast failed:', error instanceof Error ? error.name : 'unknown')
  }
}

export function loadStaffSession(): StaffSession | null {
  try {
    const raw = localStorage.getItem(STAFF_AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StaffSession;
    return typeof parsed?.token === "string" && parsed.token ? parsed : null;
  } catch {
    return null;
  }
}

export type StaffSessionSaveResult =
  { ok: true } | { ok: false; error: string };

function clearStaffAuthStorage(): boolean {
  try {
    localStorage.removeItem(STAFF_AUTH_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function saveStaffSession(
  session: StaffSession,
): StaffSessionSaveResult {
  let serialized: string;
  try {
    serialized = JSON.stringify(session);
  } catch (error) {
    console.warn(
      "[staff-session] session serialization failed:",
      error instanceof Error ? error.name : "unknown",
    );
    return { ok: false, error: "会话数据格式无效，未修改原会话，请重新登录。" };
  }
  try {
    localStorage.setItem(STAFF_AUTH_STORAGE_KEY, serialized);
  } catch (error) {
    console.warn(
      "[staff-session] storage write failed:",
      error instanceof Error ? error.name : "unknown",
    );
    const cleared = clearStaffAuthStorage();
    broadcastStaffSessionChange();
    return {
      ok: false,
      error: cleared
        ? AUTH_SESSION_PERSIST_FAIL_MESSAGE
        : `${AUTH_SESSION_PERSIST_FAIL_MESSAGE}（原会话清除结果未知）`,
    };
  }
  broadcastStaffSessionChange();
  return { ok: true };
}

export function clearStaffSession(): boolean {
  const cleared = clearStaffAuthStorage();
  // 存储删除失败也必须让监听者进入未登录态；返回值只表达物理清除结果。
  broadcastStaffSessionChange();
  return cleared;
}

export function useStaffSession() {
  const [session, setSession] = useState<StaffSession | null>(() =>
    loadStaffSession(),
  );

  useEffect(() => {
    const sync = () => setSession(loadStaffSession());
    window.addEventListener("storage", sync);
    window.addEventListener(STAFF_SESSION_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(STAFF_SESSION_EVENT, sync);
    };
  }, []);

  const save = useCallback((s: StaffSession) => saveStaffSession(s), []);
  const clear = useCallback(() => {
    const cleared = clearStaffSession();
    // 即使 removeItem 失败而 getItem 仍可读，也绝不在当前界面恢复旧身份。
    setSession(null);
    return cleared;
  }, []);
  return { session, save, clear };
}

// 透传调用助手（保持 import 入口统一）
export { wbQuery, wbMutation, wbErrorMessage, isWbAuthError };
