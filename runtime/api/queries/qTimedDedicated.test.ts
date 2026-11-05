import { describe, expect, it, vi } from "vitest";
import { qTimed } from "./connection";

describe("qTimed 独立连接边界", () => {
  it("带 release() 的池连接直接拒绝，不执行 SQL，也不制造 destroy/release 双收口", async () => {
    const conn = { connection: { release: vi.fn(), query: vi.fn(), destroy: vi.fn() }, query: vi.fn(), release: vi.fn(), destroy: vi.fn() };
    await expect(qTimed(conn as never, "SELECT 1", [], 1000)).rejects.toThrow("仅接受独立连接");
    expect(conn.query).not.toHaveBeenCalled();
    expect(conn.destroy).not.toHaveBeenCalled();
    expect(conn.release).not.toHaveBeenCalled();
  });
});
