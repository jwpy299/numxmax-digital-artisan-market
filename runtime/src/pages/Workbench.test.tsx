// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import Workbench from "./Workbench";

vi.mock("@/components/workbench-portal/session", () => ({
  loadWorkbenchSession: () => null,
  clearWorkbenchSession: vi.fn(),
  saveWorkbenchSession: () => ({ ok: false, error: "存储不可用" }),
}));
vi.mock("@/components/workbench-portal/AccountCard", () => ({
  default: ({
    onSessionChange,
  }: {
    onSessionChange: (session: { token: string }) => void;
  }) => (
    <button onClick={() => onSessionChange({ token: "new-session" })}>
      保存会话
    </button>
  ),
}));
vi.mock("@/components/workbench-portal/JumpCard", () => ({
  default: () => null,
}));
vi.mock("@/components/workbench-portal/FlowSteps", () => ({
  default: () => null,
}));
vi.mock("@/components/workbench-portal/EmployeePreview", () => ({
  default: () => null,
}));
vi.mock("@/components/workbench-portal/ApiIntegration", () => ({
  default: () => null,
}));
vi.mock("@/components/workbench-portal/BottomCta", () => ({
  default: () => null,
}));

describe("Workbench 会话保存失败提示", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("AccountCard 旁只显示一次明确错误，不重复也不静默", () => {
    render(<Workbench />);
    fireEvent.click(screen.getByRole("button", { name: "保存会话" }));
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByText("存储不可用")).toBeTruthy();
  });
});
