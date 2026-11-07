import { useState } from "react";
import JumpCard from "@/components/workbench-portal/JumpCard";
import AccountCard from "@/components/workbench-portal/AccountCard";
import FlowSteps from "@/components/workbench-portal/FlowSteps";
import EmployeePreview from "@/components/workbench-portal/EmployeePreview";
import ApiIntegration from "@/components/workbench-portal/ApiIntegration";
import BottomCta from "@/components/workbench-portal/BottomCta";
import {
  clearWorkbenchSession,
  loadWorkbenchSession,
  saveWorkbenchSession,
  type WorkbenchSession,
} from "@/components/workbench-portal/session";

/**
 * /workbench — 星云智能工作台跳转门户
 * 市场负责雇佣与供给，工作台（独立执行端产品）负责执行与交付；
 * 本页为通往星云智能工作台的中转入口：两段式 SSO（createWorkbenchTicket → entryUrl）已打通，
 * 页面瘦身（彭总 2026-10-15 令）：PortalHero 冗余品牌头已退役（JumpCard 自带标题+定位语义全盖）。
 * 工作台账号会话沿用官方文档约定保存于 localStorage("nebula_auth")。
 */
export default function Workbench() {
  const [session, setSession] = useState<WorkbenchSession | null>(() =>
    loadWorkbenchSession(),
  );
  const [sessionError, setSessionError] = useState<string | null>(null);

  function handleSessionChange(next: WorkbenchSession | null) {
    if (next) {
      const saved = saveWorkbenchSession(next);
      if (!saved.ok) {
        setSessionError(saved.error);
        setSession(null);
        return;
      }
    } else {
      const cleared = clearWorkbenchSession();
      if (!cleared) {
        setSessionError("本地会话清除失败，请检查浏览器存储/隐私设置；当前页面已退出，但原会话可能仍被保留。");
        setSession(null);
        return;
      }
    }
    setSessionError(null);
    setSession(next);
  }

  return (
    <>
      <JumpCard session={session} />
      <AccountCard session={session} onSessionChange={handleSessionChange} />
      {sessionError && (
        <p
          role="alert"
          className="mx-auto max-w-3xl rounded-lg border border-ember-red/30 p-3 text-sm text-ember-red"
        >
          {sessionError}
        </p>
      )}
      <FlowSteps />
      <EmployeePreview />
      <ApiIntegration />
      <BottomCta />
    </>
  );
}
