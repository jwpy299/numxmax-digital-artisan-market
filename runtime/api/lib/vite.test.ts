import type { HttpBindings } from "@hono/node-server";
import { describe, expect, it, vi } from "vitest";

async function makeApp() {
  vi.resetModules();
  vi.doMock("@hono/node-server/serve-static", () => ({
    serveStatic: () => async (c: { req: { path: string }; html: (s: string) => Response; body: (s: string, status: number, h: Record<string, string>) => Response }, next: () => Promise<void>) => {
      if (c.req.path.startsWith("/api")) return next();
      if (c.req.path.startsWith("/assets/")) return c.body("asset", 200, { "content-type": "application/javascript" });
      return c.html("<h1>page</h1>");
    },
  }));
  const { Hono } = await import("hono");
  const { serveStaticFiles } = await import("./vite");
  const app = new Hono<{ Bindings: HttpBindings }>();
  serveStaticFiles(app);
  return app;
}

describe("HTML 全表面缓存纪律", () => {
  it("SPA/目录 HTML/.html 全部 no-cache", async () => {
    const app = await makeApp();
    for (const p of ["/get-desktop", "/org", "/org/", "/index.html"]) {
      const r = await app.request(p);
      expect(r.headers.get("cache-control"), p).toBe("no-cache, must-revalidate");
    }
  });

  it("带扩展名 assets 与 API 不被误降缓存", async () => {
    const app = await makeApp();
    const asset = await app.request("/assets/app.js");
    expect(asset.headers.get("cache-control")).not.toBe("no-cache, must-revalidate");
    for (const p of ["/api/example", "/api"]) {
      const api = await app.request(p);
      expect(api.status, p).toBe(404);
      expect(api.headers.get("cache-control"), p).not.toBe("no-cache, must-revalidate");
      expect(await api.json(), p).toEqual({ error: "Not Found" });
    }
  });
});
