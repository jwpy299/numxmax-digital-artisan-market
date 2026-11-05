/**
 * pluginStore —— M48 插件仓系统级接入（dsh-plugin-store ↔ 全员工具体系）。
 *
 * 与 MCP 面 store_search/store_use（智能体会话内自取）互补：
 * 本路由是平台面——超终一键把仓内插件装机为系统技能（st_skills layer='store'），
 * 此后全厂可见集/MCP run_store_<key> 工具面自动带它，无需逐会话装载。
 *
 * 安全红线（沿用 M37/M42 设备插件纪律）：
 * - 仓只读；装机必验 sha256（索引值 vs 文件实算，不符拒装）；
 * - 文本字段注入过滤（提示注入特征一律 [已过滤]）；
 * - 只接受声明式 prompt-skill（kind 白名单），无可执行代码通道；
 * - 仓地址只从服务端 env 读（STORE_BASE，默认本机 8000），绝不回显内部地址给前端。
 */
import { z } from "zod";
import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { requireAdmin as requireAdminToken, rawRows } from "./terminal";
import { getDb } from "../queries/connection";

const STORE_BASE = (process.env.STORE_BASE ?? "http://127.0.0.1:8000").replace(/\/+$/, "");

const INJECTION_RE =
  /忽略.{0,12}(指令|要求|规则)|ignore\s+(all\s+)?(previous\s+)?instructions?|system\s*prompt|jailbreak/gi;

function sanitize(s: unknown, max = 255): string {
  return String(s ?? "")
    .replace(/[​-‏⁠‪-‮]/g, "")
    .replace(INJECTION_RE, "[已过滤]")
    .trim()
    .slice(0, max);
}

interface StoreIndexEntry {
  key: string;
  name: string;
  version: string;
  kind: string;
  description: string;
  file: string;
  sha256: string;
  author?: string;
}

async function fetchIndex(): Promise<StoreIndexEntry[]> {
  const res = await fetch(`${STORE_BASE}/index.json`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "插件仓暂时不可用，请稍后重试" });
  const j = (await res.json()) as { plugins?: StoreIndexEntry[] };
  return Array.isArray(j.plugins) ? j.plugins : [];
}

const adminInput = z.object({ token: z.string().trim().min(1) });

export const pluginStoreRouter = createRouter({
  /** 仓目录 + 装机状态（已装机的标 installed） */
  catalog: publicQuery.input(adminInput).query(async ({ input }) => {
    await requireAdminToken(input.token);
    const [entries, db] = [await fetchIndex(), getDb()];
    const installed = rawRows(
      await db.execute(sql`SELECT skill_key, status FROM st_skills WHERE layer = 'store'`),
    ) as Array<Record<string, unknown>>;
    const state = new Map(installed.map((r) => [String(r.skill_key), String(r.status)]));
    return entries.map((p) => ({
      key: sanitize(p.key, 48),
      name: sanitize(p.name, 64),
      version: sanitize(p.version, 16),
      kind: sanitize(p.kind, 32),
      description: sanitize(p.description, 120),
      author: sanitize(p.author ?? "", 32),
      installed: state.get(`store_${p.key}`) === "active",
    }));
  }),

  /** 一键装机：校验 sha256 → 声明式规范写入 st_skills（layer='store'）→ 全员工具面生效 */
  install: publicQuery
    .input(adminInput.extend({ key: z.string().trim().min(1).max(48) }))
    .mutation(async ({ input }) => {
      const admin = await requireAdminToken(input.token);
      const meta = (await fetchIndex()).find((p) => p.key === input.key);
      if (!meta) throw new TRPCError({ code: "NOT_FOUND", message: "插件仓中不存在该插件" });
      if (meta.kind !== "prompt-skill") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "仅支持声明式技能插件（prompt-skill）" });
      }
      const res = await fetch(`${STORE_BASE}/${meta.file}`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "插件文件拉取失败" });
      const raw = await res.text();
      const digest = createHash("sha256").update(raw, "utf8").digest("hex");
      if (digest !== meta.sha256) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "插件校验和不符，已拒装" });
      }
      const pkg = JSON.parse(raw) as {
        name?: string;
        description?: string;
        skillSpec?: { instructions?: string };
      };
      const instructions = sanitize(pkg.skillSpec?.instructions ?? "", 4000);
      if (!instructions) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "插件内容为空，未装机" });

      const db = getDb();
      const skillKey = `store_${sanitize(input.key, 44)}`;
      await db.execute(
        sql`INSERT INTO st_skills (skill_key, name, layer, category, description, output_template, executor, executor_kind, slot, status, created_at)
            VALUES (${skillKey}, ${sanitize(pkg.name, 64)}, 'store', 'plugin-store',
                    ${sanitize(pkg.description, 255)}, ${instructions},
                    'llm_analysis', 'generic', 'chat', 'active', NOW())
            ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description),
                    output_template = VALUES(output_template), status = 'active'`,
      );
      return { ok: true as const, skillKey, name: sanitize(pkg.name, 64), by: admin.username ?? "admin" };
    }),

  /** 下架（软删：status=disabled，保留审计轨迹） */
  uninstall: publicQuery
    .input(adminInput.extend({ key: z.string().trim().min(1).max(48) }))
    .mutation(async ({ input }) => {
      await requireAdminToken(input.token);
      const db = getDb();
      await db.execute(
        sql`UPDATE st_skills SET status = 'disabled' WHERE skill_key = ${`store_${sanitize(input.key, 44)}`} AND layer = 'store'`,
      );
      return { ok: true as const };
    }),

  /** 技能库文件清单（仓内 skills 分区，真实 SKILL.md 技能文件） */
  library: publicQuery.input(adminInput).query(async ({ input }) => {
    await requireAdminToken(input.token);
    const res = await fetch(`${STORE_BASE}/index.json`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "插件仓暂时不可用，请稍后重试" });
    const j = (await res.json()) as { skills?: Array<Record<string, unknown>> };
    return (Array.isArray(j.skills) ? j.skills : []).map((s) => ({
      key: sanitize(s.key, 48),
      name: sanitize(s.name, 64),
      layer: sanitize(s.layer, 16),
      category: sanitize(s.category, 32),
      description: sanitize(s.description, 120),
      file: sanitize(s.file, 96),
      sha256: sanitize(s.sha256, 64),
    }));
  }),

  /** 已装机清单 */
  installed: publicQuery.input(adminInput).query(async ({ input }) => {
    await requireAdminToken(input.token);
    const db = getDb();
    const rows = rawRows(
      await db.execute(
        sql`SELECT skill_key, name, description, status, created_at FROM st_skills WHERE layer = 'store' ORDER BY id DESC LIMIT 50`,
      ),
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      skillKey: String(r.skill_key),
      name: String(r.name),
      description: String(r.description ?? ""),
      status: String(r.status),
      createdAt: String(r.created_at ?? ""),
    }));
  }),
});
