/**
 * harness —— DeepSeek Harness 插件仓服务端代理（彭总指令：超市挂 DSH 插件仓，App 永不直连外网）。
 *
 * 契约（与灵枢 App src/api/harnessPort.ts / client.ts 逐字对齐）：
 * - harness.plugins.list  {search?, sort?, limit?} → { total, items: HarnessPlugin[] }（公开只读，无 token）
 * - harness.plugins.detail {repo}                  → HarnessPlugin（repo 形如 owner/repo）
 *
 * 数据源：GitHub Search/Repos API（topic:dsh-plugin，官方生态载体，README 口径 1800+ 仓库）。
 * 纪律：
 * - GITHUB_TOKEN 只存服务端 env（无 token 时走匿名配额 60 次/时/IP，配合缓存兜底）；
 * - 出口结果按 App 侧 toHarnessPlugin 同口径归一（repo 两段校验、stars 非数归零）；
 * - 上游故障抛 UPSTREAM_UNAVAILABLE，App 侧已有优雅降级（不崩、可重试）；
 * - 内存缓存 10 分钟（list 按 query 键、detail 按 repo 键），削匿名配额压力。
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";

const GITHUB_API = "https://api.github.com";
const DSH_TOPIC = "dsh-plugin";
const CACHE_TTL_MS = 10 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 10_000;

/** 与 App harnessPort.HarnessPlugin 逐字段对齐 */
export interface HarnessPluginDto {
  repo: string;
  name: string;
  description: string | null;
  stars: number;
  license: string | null;
  updatedAt: string | null;
}

interface CacheEntry<T> {
  at: number;
  value: T;
}
const listCache = new Map<string, CacheEntry<{ total: number; items: HarnessPluginDto[] }>>();
const detailCache = new Map<string, CacheEntry<HarnessPluginDto>>();

function readGithubToken(): string | null {
  const v = process.env.GITHUB_TOKEN;
  return v && v.trim() ? v.trim() : null;
}

function cacheGet<T>(m: Map<string, CacheEntry<T>>, key: string): T | null {
  const e = m.get(key);
  if (!e) return null;
  if (Date.now() - e.at > CACHE_TTL_MS) {
    m.delete(key);
    return null;
  }
  return e.value;
}

/** GitHub 仓库对象 → DTO（缺字段容错，与 App toHarnessPlugin 同口径） */
function normalizeRepo(raw: unknown): HarnessPluginDto | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const fullName = typeof r.full_name === "string" ? r.full_name : "";
  const parts = fullName.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const lic = r.license as { spdx_id?: unknown } | null | undefined;
  return {
    repo: fullName,
    name: typeof r.name === "string" && r.name ? r.name : parts[1],
    description: typeof r.description === "string" ? r.description : null,
    stars:
      typeof r.stargazers_count === "number" && Number.isFinite(r.stargazers_count)
        ? r.stargazers_count
        : 0,
    license:
      lic && typeof lic.spdx_id === "string" && lic.spdx_id !== "NOASSERTION" ? lic.spdx_id : null,
    updatedAt: typeof r.pushed_at === "string" ? r.pushed_at : null,
  };
}

async function githubFetch(path: string): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "lingshu-nebula-harness-proxy",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = readGithubToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(`${GITHUB_API}${path}`, { headers, signal: ctrl.signal });
    if (!res.ok) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `UPSTREAM_UNAVAILABLE: GitHub API HTTP ${res.status}`,
      });
    }
    return await res.json();
  } catch (e) {
    if (e instanceof TRPCError) throw e;
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `UPSTREAM_UNAVAILABLE: ${e instanceof Error ? e.message : String(e)}`,
    });
  } finally {
    clearTimeout(timer);
  }
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

export const harnessPluginsRouter = createRouter({
  list: publicQuery
    .input(
      z.object({
        search: z.string().max(120).optional(),
        sort: z.enum(["stars", "updated"]).default("stars"),
        limit: z.number().int().min(1).max(100).default(50),
      }),
    )
    .query(async ({ input }) => {
      const cacheKey = `${input.search ?? ""}|${input.sort}|${input.limit}`;
      const hit = cacheGet(listCache, cacheKey);
      if (hit) return hit;

      const q = input.search
        ? `topic:${DSH_TOPIC} ${input.search.replace(/[^\w\s.-]/g, " ").trim()}`
        : `topic:${DSH_TOPIC}`;
      const sort = input.sort === "updated" ? "updated" : "stars";
      const perPage = Math.min(input.limit, 100);
      const raw = (await githubFetch(
        `/search/repositories?q=${encodeURIComponent(q)}&sort=${sort}&order=desc&per_page=${perPage}`,
      )) as { total_count?: unknown; items?: unknown };
      const items = (Array.isArray(raw.items) ? raw.items : [])
        .map(normalizeRepo)
        .filter((x): x is HarnessPluginDto => x !== null)
        .slice(0, input.limit);
      const value = {
        total: typeof raw.total_count === "number" ? raw.total_count : items.length,
        items,
      };
      listCache.set(cacheKey, { at: Date.now(), value });
      return value;
    }),

  detail: publicQuery
    .input(z.object({ repo: z.string().regex(REPO_RE, "repo 必须形如 owner/repo") }))
    .query(async ({ input }) => {
      const hit = cacheGet(detailCache, input.repo);
      if (hit) return hit;
      const raw = await githubFetch(`/repos/${input.repo}`);
      const dto = normalizeRepo(raw);
      if (!dto) {
        throw new TRPCError({ code: "NOT_FOUND", message: `插件仓库不存在或不可读：${input.repo}` });
      }
      detailCache.set(input.repo, { at: Date.now(), value: dto });
      return dto;
    }),
});

export const harnessRouter = createRouter({
  plugins: harnessPluginsRouter,
});
