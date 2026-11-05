import type { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import fs from "fs";
import path from "path";

type App = Hono<{ Bindings: HttpBindings }>;
const HTML_NO_CACHE = "no-cache, must-revalidate";
const FILE_LIKE_PATH = /\.[a-zA-Z0-9]{1,8}$/;
const isFileLikePath = (p: string) => FILE_LIKE_PATH.test(p);
const isHtmlFilePath = (p: string) => p.endsWith(".html");
const isHtmlSurface = (p: string) => isHtmlFilePath(p) || !isFileLikePath(p);
const isSpaFallbackSurface = (p: string) => !isFileLikePath(p); // 缓存面含 .html；SPA fallback 只吃无扩展名路径，语义不混写
const isGetHead = (m: string) => m === "GET" || m === "HEAD";
const isApiPath = (p: string) => p === "/api" || p.startsWith("/api/");
const isHtmlRequest = (p: string, m: string) => !isApiPath(p) && isGetHead(m);

export function serveStaticFiles(app: App) {
  const distPath = path.resolve(import.meta.dirname, "../dist/public");

  // 所有 HTML 候选面同一缓存源：.html、无扩展名与目录斜杠路径（含 /org、/org/）。
  // 带扩展名的指纹 assets/图片/字体不在这里降缓存；判定与下方 fallback 共用同一组谓词。
  app.use("*", async (c, next) => {
    const p = c.req.path;
    if (isHtmlRequest(p, c.req.method) && isHtmlSurface(p)) {
      c.header("Cache-Control", HTML_NO_CACHE);
    }
    await next();
  });
  app.use("*", serveStatic({ root: "./dist/public" }));

  app.notFound((c) => {
    const p = c.req.path;
    if (isHtmlRequest(p, c.req.method) && isSpaFallbackSurface(p)) {
      c.header("Cache-Control", HTML_NO_CACHE);
      const indexPath = path.resolve(distPath, "index.html");
      const content = fs.readFileSync(indexPath, "utf-8");
      return c.html(content);
    }
    return c.json({ error: "Not Found" }, 404);
  });
}
