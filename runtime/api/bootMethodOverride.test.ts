/**
 * 安全收口回归：wb 前端 token 走 POST body（methodOverride）后，
 * 服务端必须接受 POST 形式的 query 请求（防 405 全线瘫痪）。
 * 不经 mock：真实 fetchRequestHandler 链路打 publicQuery。
 */
import { describe, expect, it } from "vitest";
import app from "./boot";

describe("tRPC allowMethodOverride（query 接受 POST）", () => {
  it("POST 打 query procedure（wbPair.status）→ 非 405，进入业务校验", async () => {
    const res = await app.request("/api/trpc/wbPair.status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "pd_deadbeef" }),
    });
    expect(res.status).not.toBe(405);
    const body = await res.json();
    // 业务可达：统一 expired 口径或输入校验错误均可，唯独不能是方法层 405
    expect(JSON.stringify(body)).not.toContain("METHOD_NOT_SUPPORTED");
  });

  it("GET 打 query procedure 仍可用（向后兼容旧客户端）", async () => {
    const input = encodeURIComponent(JSON.stringify({ code: "pd_deadbeef" }));
    const res = await app.request(`/api/trpc/wbPair.status?input=${input}`);
    expect(res.status).not.toBe(405);
  });
});
