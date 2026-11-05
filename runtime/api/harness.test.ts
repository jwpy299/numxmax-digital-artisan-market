/**
 * harness 路由回归：harness.plugins.list / detail 服务端代理。
 * 全部网络调用经 vi.stubGlobal("fetch") mock；不触真实 GitHub。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { harnessRouter } from "./routers/harness";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const caller = harnessRouter.createCaller({} as never);

function ghRepo(full: string, stars = 100) {
  const [owner, name] = full.split("/");
  return {
    full_name: full,
    name,
    description: `${name} plugin`,
    stargazers_count: stars,
    license: { spdx_id: "MIT" },
    pushed_at: "2026-08-01T00:00:00Z",
    owner,
  };
}

function okJson(body: unknown) {
  return { ok: true, json: async () => body } as Response;
}

describe("harness.plugins.list", () => {
  beforeEach(() => fetchMock.mockReset());

  it("归一 GitHub 检索结果（repo/stars/license/updatedAt），带 topic 限定", async () => {
    fetchMock.mockResolvedValue(
      okJson({ total_count: 2, items: [ghRepo("aa/bb", 9), ghRepo("cc/dd", 7)] }),
    );
    const r = await caller.plugins.list({ sort: "stars", limit: 50 });
    expect(r.total).toBe(2);
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toMatchObject({ repo: "aa/bb", stars: 9, license: "MIT" });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(decodeURIComponent(url)).toContain("topic:dsh-plugin");
  });

  it("search 透传并消毒特殊字符；缓存键隔离", async () => {
    fetchMock.mockResolvedValue(okJson({ total_count: 1, items: [ghRepo("aa/bb")] }));
    const r = await caller.plugins.list({ search: "voice;$(rm)", sort: "updated", limit: 10 });
    expect(r.items).toHaveLength(1);
    const url = decodeURIComponent(String(fetchMock.mock.calls[0][0]));
    expect(url).toContain("voice");
    expect(url).not.toContain("$(");
  });

  it("畸形行丢弃（缺 full_name / 单段 repo）", async () => {
    fetchMock.mockResolvedValue(
      okJson({ total_count: 3, items: [ghRepo("aa/bb"), { name: "x" }, { full_name: "solo" }] }),
    );
    const r = await caller.plugins.list({ sort: "stars", limit: 30 }); // 独立缓存键，避开首用例缓存
    expect(r.items).toHaveLength(1);
    expect(r.items[0].repo).toBe("aa/bb");
  });

  it("上游 5xx → UPSTREAM_UNAVAILABLE（App 侧优雅降级）", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502, json: async () => ({}) });
    await expect(caller.plugins.list({ sort: "stars", limit: 5 })).rejects.toThrow(
      /UPSTREAM_UNAVAILABLE/,
    );
  });
});

describe("harness.plugins.detail", () => {
  beforeEach(() => fetchMock.mockReset());

  it("repo 非 owner/repo 形 → 入参拒绝", async () => {
    await expect(caller.plugins.detail({ repo: "bad" })).rejects.toThrow();
    await expect(caller.plugins.detail({ repo: "a/b/c" })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("命中返回归一 DTO；二次调用走缓存（fetch 仅一次）", async () => {
    fetchMock.mockResolvedValue(okJson(ghRepo("ee/ff", 42)));
    const a = await caller.plugins.detail({ repo: "ee/ff" });
    const b = await caller.plugins.detail({ repo: "ee/ff" });
    expect(a).toMatchObject({ repo: "ee/ff", stars: 42 });
    expect(b).toMatchObject({ repo: "ee/ff", stars: 42 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("上游 404 → NOT_FOUND 或 UPSTREAM_UNAVAILABLE", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    await expect(caller.plugins.detail({ repo: "no/such" })).rejects.toThrow();
  });
});
