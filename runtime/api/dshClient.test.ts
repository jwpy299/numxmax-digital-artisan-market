/**
 * M79 dshClient 模型覆盖透传测试：modelOverride 进 POST body；缺省不带键（行为零变化）。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { callDsh } from "./routers/dshClient";

beforeEach(() => {
  fetchMock.mockReset();
  process.env.DSH_SERVICE_TOKEN = "t";
  fetchMock.mockResolvedValue({
    status: 200, ok: true,
    json: async () => ({ ok: true, answer: "a" }),
  });
});

describe("M79 callDsh modelOverride 透传", () => {
  it("带覆盖 → body 含 modelOverride", async () => {
    await callDsh("task", 60, 1, "gpt-5.5-pro");
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.modelOverride).toBe("gpt-5.5-pro");
    expect(body.factoryId).toBe(1);
  });
  it("缺省 → body 无 modelOverride 键（老行为）", async () => {
    await callDsh("task", 60, 1);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect("modelOverride" in body).toBe(false);
  });
});
