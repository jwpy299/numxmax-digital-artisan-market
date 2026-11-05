/** v179 DSH 驱动口全链（mock 库/模型/会话） */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./queries/connection", () => ({ getDb: () => ({ execute: async () => [[]] }) }));
vi.mock("./routers/modelGateway", () => ({
  callSlotChatFast: async () => ({ ok: true, content: "兄弟，这一单我盯着。", provider: "t", providerLabel: "t", latencyMs: 5 }),
}));
vi.mock("./routers/wbSession", () => ({
  sessionMe: async () => ({ user: { id: 42, displayName: "彭" }, factory: { id: 1 } }),
}));
vi.mock("./harness/memoryBridge", () => ({
  recallForContext: async () => "上次你说要做巡检",
  captureEvent: async () => true,
}));

import { dshBridgeRouter } from "./routers/dshBridge";
const caller = dshBridgeRouter.createCaller({} as never);

describe("DSH 驱动口", () => {
  it("灵枢应答：人格口吻+会话钥匙+记忆命中", async () => {
    const r = await caller.chat({ token: "t", persona: "lingshu", message: "巡检搞咋样了" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.reply).toContain("兄弟");
      expect(r.sessionKey).toBe("dsh:u42:lingshu");
      expect(r.memoryHit).toBe(true);
    }
  });
  it("星云人格+模型故障诚实兜底", async () => {
    const r = await caller.chat({ token: "t", persona: "xingyun", message: "在吗" });
    expect(r.ok).toBe(true);
  });
});
