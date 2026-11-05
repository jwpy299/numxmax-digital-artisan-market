/**
 * deptCustom —— 企业自定义编制（2026-08-26 彭总令 #5）。
 *
 * 口径：
 * - 平台六部门（factory_id IS NULL）永不动；企业自建部门=st_dept_consoles factory 分行，
 *   dept_code 强制 `x_` 前缀（与平台码永不撞车）；
 * - 模型指派走 allowed_models（GATEWAY_CATALOG 精确校验，笔误拒绝——与平台同规格）；
 * - 自建部门可入小环拍板与 delegate 委派（本厂内）；跨厂永不可见（factoryId 服务端会话口径）。
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { effectiveRoleOf, sessionMe } from "./wbSession";
import { GATEWAY_CATALOG } from "./modelGateway";

const tokenInput = { token: z.string().trim().min(1) };


/** 自定义部门码规则（纯函数可测）：x_ 前缀 + 2~10 位小写字母数字 */
export function isValidCustomDeptCode(code: string): boolean {
  return /^x_[a-z0-9]{2,10}$/.test(code);
}

/** 模型集合校验（与平台 setEngine 同规格：精确命中目录，笔误拒绝） */
export function validateAllowedModels(models: string[]): { ok: boolean; bad: string[] } {
  const catalog = new Set(GATEWAY_CATALOG.map((m) => m.id));
  const bad = models.filter((m) => !catalog.has(m));
  return { ok: bad.length === 0, bad };
}

async function requireFactoryAdmin(token: string) {
  const session = await sessionMe(token);
  const role = await effectiveRoleOf(session.user);
  if (role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "仅企业负责人可管理自定义编制" });
  return session;
}

export const deptCustomRouter = createRouter({
  /** 本厂自定义部门列表（跨厂永不返回） */
  list: publicQuery.input(z.object(tokenInput)).query(async ({ input }) => {
    const session = await sessionMe(input.token);
    const rows = rawRows(
      await getDb().execute(
        sql`SELECT dept_code AS deptCode, dept_name AS deptName, allowed_models AS allowedModels, dsh_enabled AS dshEnabled, updated_at AS updatedAt
            FROM st_dept_consoles WHERE factory_id=${session.factory.id} ORDER BY id ASC`,
      ),
    );
    return { departments: rows };
  }),

  /** 创建自建部门（名/职责/模型指派） */
  create: publicQuery
    .input(z.object({
      ...tokenInput,
      deptCode: z.string().trim().toLowerCase(),
      deptName: z.string().trim().min(2).max(16),
      duty: z.string().trim().max(200).default(""),
      allowedModels: z.array(z.string()).max(8).default([]),
    }))
    .mutation(async ({ input }) => {
      const session = await requireFactoryAdmin(input.token);
      if (!isValidCustomDeptCode(input.deptCode)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "部门码须 x_ 前缀+2~10位小写字母数字（如 x_design）" });
      }
      const mv = validateAllowedModels(input.allowedModels);
      if (!mv.ok) throw new TRPCError({ code: "BAD_REQUEST", message: `模型不在海禛云目录：${mv.bad.join(", ")}` });
      const db = getDb();
      try {
        await db.execute(
          sql`INSERT INTO st_dept_consoles (factory_id, dept_code, dept_name, agent_codes, allowed_models, config)
              VALUES (${session.factory.id}, ${input.deptCode}, ${input.deptName}, '[]',
                      ${input.allowedModels.length ? JSON.stringify(input.allowedModels) : null},
                      ${JSON.stringify({ duty: input.duty, custom: true })})`,
        );
      } catch (e) {
        if (/duplicate/i.test(String((e as Error)?.message ?? e))) {
          throw new TRPCError({ code: "CONFLICT", message: "该部门码本厂已存在" });
        }
        throw e;
      }
      return { ok: true as const, deptCode: input.deptCode };
    }),

  /** 模型指派调整 */
  setModels: publicQuery
    .input(z.object({ ...tokenInput, deptCode: z.string().trim().toLowerCase(), allowedModels: z.array(z.string()).max(8) }))
    .mutation(async ({ input }) => {
      const session = await requireFactoryAdmin(input.token);
      const mv = validateAllowedModels(input.allowedModels);
      if (!mv.ok) throw new TRPCError({ code: "BAD_REQUEST", message: `模型不在海禛云目录：${mv.bad.join(", ")}` });
      const r = await getDb().execute(
        sql`UPDATE st_dept_consoles SET allowed_models=${JSON.stringify(input.allowedModels)}
            WHERE factory_id=${session.factory.id} AND dept_code=${input.deptCode} AND dept_code LIKE 'x\\_%'`,
      );
      const affected = Number((rawRows(r)[0] as { affectedRows?: number })?.affectedRows ?? (r as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0);
      if (affected === 0) throw new TRPCError({ code: "NOT_FOUND", message: "本厂无此自定义部门" });
      return { ok: true as const };
    }),

  /** 停用（不物理删除——留痕可恢复） */
  disable: publicQuery
    .input(z.object({ ...tokenInput, deptCode: z.string().trim().toLowerCase() }))
    .mutation(async ({ input }) => {
      const session = await requireFactoryAdmin(input.token);
      await getDb().execute(
        sql`UPDATE st_dept_consoles SET dsh_enabled=0 WHERE factory_id=${session.factory.id} AND dept_code=${input.deptCode} AND dept_code LIKE 'x\\_%'`,
      );
      return { ok: true as const };
    }),
});

// ─── C2：自建部门入 delegate 委派（本厂内） ──────────────────────────────────
import { listVoiceAgentRoster, runWorkbenchAgentTask } from "./agentBridge";
import { rawRows } from "../queries/rawRows"; // 战区④批A-lite：私有副本退役→canonical 叶单源

interface FactoryConsoleRow {
  dept_code: string; dept_name: string; chief_agent_code: string | null;
  agent_codes: unknown; dsh_enabled: number; allowed_models: unknown;
}

function parseCodes(json: unknown): string[] {
  if (Array.isArray(json)) return json.map(String);
  if (typeof json === "string") { try { const v = JSON.parse(json); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } }
  return [];
}

async function requireFactoryDept(factoryId: number, deptCode: string): Promise<FactoryConsoleRow> {
  const rows = rawRows(
    await getDb().execute(
      sql`SELECT dept_code, dept_name, chief_agent_code, agent_codes, dsh_enabled, allowed_models
          FROM st_dept_consoles WHERE factory_id=${factoryId} AND dept_code=${deptCode} AND dept_code LIKE 'x\\_%' LIMIT 1`,
    ),
  ) as unknown as FactoryConsoleRow[];
  const row = rows[0];
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "本厂无此自定义部门" });
  return row;
}

/** 本厂内跨部门委派（自建↔自建 或 自建↔平台——平台部门可读不可穿厂） */
export async function runFactoryDelegate(input: {
  factoryId: number; fromDept: string; toDept: string; message: string; username: string;
}): Promise<{ collabId: number | null; runtime: string }> {
  if (input.fromDept === input.toDept) throw new TRPCError({ code: "BAD_REQUEST", message: "同部门协作请直接用本部门对话窗" });
  const fromRow = await requireFactoryDept(input.factoryId, input.fromDept);
  const toRow = await requireFactoryDept(input.factoryId, input.toDept);
  const roster = await listVoiceAgentRoster();
  const pick = (r: FactoryConsoleRow) =>
    (r.chief_agent_code && roster.find((a) => a.code === r.chief_agent_code)) ||
    roster.find((a) => parseCodes(r.agent_codes).includes(a.code));
  const fromPick = pick(fromRow);
  const toPick = pick(toRow);
  if (!fromPick) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `${fromRow.dept_name}尚未配置在役智能体（发起方）` });
  if (!toPick) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `${toRow.dept_name}尚未配置在役智能体（接收方）` });
  const runtime = Number(toRow.dsh_enabled) === 1 ? "dsh" : "bridge";
  const task = `【跨部门协作】${fromRow.dept_name}主官 ${fromPick.name} 向你（${toRow.dept_name}主官 ${toPick.name}）发起协作请求，请按你部门职责给出可执行的回应或办理结果：\n${input.message}`;
  const run = await runWorkbenchAgentTask({ agentCode: toPick.code, task, username: `collab:${input.username}`, runtime });
  if (!run) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "接收方智能体当前未启用" });
  const ins = await getDb().execute(
    sql`INSERT INTO st_dept_collabs (from_dept, to_dept, from_agent, to_agent, message, reply, runtime, status, created_at)
        VALUES (${input.fromDept}, ${input.toDept}, ${fromPick.code}, ${toPick.code}, ${input.message.slice(0, 500)}, ${""}, ${runtime}, 'done', NOW())`,
  );
  const first = Array.isArray(ins) ? (ins as unknown[])[0] : ins;
  return { collabId: Number((first as { insertId?: number })?.insertId ?? 0) || null, runtime };
}
