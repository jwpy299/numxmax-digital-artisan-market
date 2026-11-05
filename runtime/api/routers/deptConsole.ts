/**
 * deptConsole —— M47 部门工作台（运营/品牌/市场）平台侧独立控制台。
 *
 * 定位：NumX Max 自己的三个业务部门的管理工作台配置面 + DSH 内嵌对话入口。
 * - 每个部门一行配置（st_dept_consoles）：驻部智能体组 + 部门主官 + DSH 开关 + 模型槽位；
 * - 配置/分派一律 requireAdmin（超级终端）；对话走 runWorkbenchAgentTask，
 *   runtime=dsh 即 DSH 底座深度执行（人格+纪律注入、MCP 工具面），模型统一走
 *   modelGateway（海禛云优先，自动降级），本文件绝不直连任何模型方；
 * - 与企业侧 wb_dept_heads（客户组织的部门负责人）语义隔离，互不读写；
 * - 绝不回显任何密钥/内部主机信息；错误一律通用文案。
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { requireAdmin as requireAdminToken, rawRows } from "./terminal";
import { requireStaff } from "./staff";
import { getDb } from "../queries/connection";
import { listVoiceAgentRoster, runWorkbenchAgentTask } from "./agentBridge";
import { terminalRouter } from "./terminal";
import { sessionMe, normalizeRole } from "./wbSession";

import { DEPT_CODES, type DeptCode } from "@contracts/deptCodes"; // 本件消费面（契约层单源——portal#57 复审票）
export { DEPT_CODES, type DeptCode }; // 转出保既有面（既有引 deptConsole 不破——转出同字面）

const DEPT_LABEL: Record<DeptCode, string> = {
  ops: "运营部",
  brand: "品牌部",
  marketing: "市场部",
  tech: "技术部",
  finance: "财务部",
  legal: "法务部",
};

interface ConsoleRow {
  id: number;
  dept_code: string;
  dept_name: string;
  chief_agent_code: string | null;
  agent_codes: string; // JSON text
  dsh_enabled: number;
  model_slot: string;
  allowed_models?: unknown; // M79 JSON 列（缺席=旧行未带，读侧 null 兜底）
  config: string | null; // JSON text（staffDeptKeys 白名单等）
  updated_at: string;
}

async function readConsoles(): Promise<ConsoleRow[]> {
  const db = getDb();
  // 平台定编 = factory_id IS NULL（M53 起企业工作台同表分行，超终平台面只看平台七席）
  try {
    return rawRows(
      await db.execute(
        sql`SELECT id, dept_code, dept_name, chief_agent_code, agent_codes, dsh_enabled, model_slot, allowed_models, config, updated_at
            FROM st_dept_consoles WHERE factory_id IS NULL ORDER BY id ASC`,
      ),
    ) as unknown as ConsoleRow[];
  } catch (e) {
    // allowed_models 列未上（旧环境）→ 回退旧查询，绝不炸控制台
    if (!/unknown column|er_bad_field/i.test(String((e as Error)?.message ?? e))) throw e;
    return rawRows(
      await db.execute(
        sql`SELECT id, dept_code, dept_name, chief_agent_code, agent_codes, dsh_enabled, model_slot, config, updated_at
            FROM st_dept_consoles WHERE factory_id IS NULL ORDER BY id ASC`,
      ),
    ) as unknown as ConsoleRow[];
  }
}

function parseCodes(json: unknown): string[] {
  try {
    // mysql2 对 JSON 列可能已解析成数组，兼容字符串与对象两种形态
    const v = typeof json === "string" ? JSON.parse(json) : json;
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** M79：部门首选模型（执行链用）：平台定编行 allowed_models 首项；无配置/异常 → null 走槽位默认 */
export async function deptPrimaryModelOf(deptCode: string | null | undefined): Promise<string | null> {
  if (!deptCode) return null;
  try {
    const rows = await readConsoles();
    const row = rows.find((r) => r.dept_code === deptCode);
    const models = parseAllowedModels(row?.allowed_models ?? null);
    return models?.[0] ?? null;
  } catch {
    return null; // 静默：模型指派是增强项，绝不阻塞任务主链
  }
}

/** M79：allowed_models JSON 列解析（缺席/坏值 → null=不限） */
export function parseAllowedModels(json: unknown): string[] | null {
  try {
    if (json == null) return null;
    const v = typeof json === "string" ? JSON.parse(json) : json;
    if (!Array.isArray(v)) return null;
    const ids = v.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 64);
    return ids.length > 0 ? ids : null;
  } catch {
    return null;
  }
}

/** config JSON 列同理：mysql2 可能已解析 */
function parseConfig(json: unknown): Record<string, unknown> {
  try {
    const v = typeof json === "string" ? JSON.parse(json) : json;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function requireDept(deptCode: DeptCode): Promise<ConsoleRow> {
  const rows = await readConsoles();
  const row = rows.find((r) => r.dept_code === deptCode);
  if (!row) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `部门工作台 ${DEPT_LABEL[deptCode]} 尚未初始化（请先执行 db/sync-m47.mts）`,
    });
  }
  return row;
}

const adminInput = z.object({ token: z.string().trim().min(1) });

// ─── M53 企业级部门工作台（factory_id 非空 = 企业自有工作台）─────────────────

/**
 * 注册即供给：企业创建时按其申报部门实时生成 DSH 工作台配置（每部门一行）。
 * 幂等（factory_id+dept_code 复合唯一），失败不阻断注册主链。
 */
export async function provisionFactoryConsoles(
  factoryId: number,
  departments: Array<{ id: string; name: string }>,
): Promise<number> {
  if (!departments.length) return 0;
  const db = getDb();
  let n = 0;
  for (const d of departments.slice(0, 20)) {
    const code = String(d.id).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 16) || "dept";
    const name = String(d.name).slice(0, 32) || code;
    await db.execute(
      sql`INSERT IGNORE INTO st_dept_consoles (factory_id, dept_code, dept_name, chief_agent_code, agent_codes, dsh_enabled, model_slot)
          VALUES (${factoryId}, ${code}, ${name}, NULL, JSON_ARRAY(), 1, 'chat')`,
    );
    n++;
  }
  return n;
}

/** 企业域读取本厂工作台行（无则空数组——未供给的老企业按需补供） */
async function readFactoryConsoles(factoryId: number): Promise<ConsoleRow[]> {
  const db = getDb();
  return rawRows(
    await db.execute(
      sql`SELECT id, dept_code, dept_name, chief_agent_code, agent_codes, dsh_enabled, model_slot, config, updated_at
          FROM st_dept_consoles WHERE factory_id = ${factoryId} ORDER BY id ASC`,
    ),
  ) as unknown as ConsoleRow[];
}

/** staff 部门归属解析：deptKey 直中 dept_code，或中 config.staffDeptKeys 白名单 */
async function findConsoleForStaff(deptKey: string): Promise<ConsoleRow | null> {
  if (!deptKey) return null;
  const rows = await readConsoles();
  for (const r of rows) {
    if (r.dept_code === deptKey) return r;
    const cfg = parseConfig(r.config);
    if (Array.isArray(cfg.staffDeptKeys) && cfg.staffDeptKeys.includes(deptKey)) return r;
  }
  return null;
}

export const deptConsoleRouter = createRouter({
  /** 三部门总览（超终/驾驶舱打通面）：配置 + 主官画像 + 驻部人数 */
  listConsoles: publicQuery.input(adminInput).query(async ({ input }) => {
    await requireAdminToken(input.token);
    const [rows, roster] = await Promise.all([readConsoles(), listVoiceAgentRoster()]);
    return rows.map((r) => {
      const codes = parseCodes(r.agent_codes);
      const chief = r.chief_agent_code
        ? roster.find((a) => a.code === r.chief_agent_code)
        : undefined;
      const cfg = parseConfig(r.config);
      const staffDeptKeys = Array.isArray(cfg.staffDeptKeys)
        ? (cfg.staffDeptKeys.filter((x) => typeof x === "string") as string[])
        : [];
      return {
        deptCode: r.dept_code as DeptCode,
        deptName: r.dept_name,
        chiefAgentCode: r.chief_agent_code,
        chiefAgent: chief ? { code: chief.code, name: chief.name, title: chief.title } : null,
        agentCodes: codes,
        agentCount: codes.length,
        dshEnabled: Number(r.dsh_enabled) === 1,
        modelSlot: r.model_slot,
        allowedModels: parseAllowedModels(r.allowed_models ?? null), // M79 部门适配模型集合（null=不限）
        staffDeptKeys,
        updatedAt: r.updated_at,
      };
    });
  }),

  /** 单部门详情：配置 + 驻部智能体画像明细 */
  getConsole: publicQuery
    .input(adminInput.extend({ deptCode: z.enum(DEPT_CODES) }))
    .query(async ({ input }) => {
      await requireAdminToken(input.token);
      const row = await requireDept(input.deptCode);
      const roster = await listVoiceAgentRoster();
      const codes = parseCodes(row.agent_codes);
      return {
        deptCode: row.dept_code as DeptCode,
        deptName: row.dept_name,
        chiefAgentCode: row.chief_agent_code,
        dshEnabled: Number(row.dsh_enabled) === 1,
        modelSlot: row.model_slot,
        agents: codes.map((c) => {
          const a = roster.find((x) => x.code === c);
          return a
            ? { code: a.code, name: a.name, title: a.title, active: true as const }
            : { code: c, name: c, title: "（已不在役）", active: false as const };
        }),
        updatedAt: row.updated_at,
      };
    }),

  /** 任命/撤换部门主官（agentCode=null 表示撤任） */
  setChief: publicQuery
    .input(
      adminInput.extend({
        deptCode: z.enum(DEPT_CODES),
        agentCode: z.string().trim().min(1).max(64).nullable(),
      }),
    )
    .mutation(async ({ input }) => {
      await requireAdminToken(input.token);
      await requireDept(input.deptCode);
      if (input.agentCode !== null) {
        const roster = await listVoiceAgentRoster();
        const a = roster.find((x) => x.code === input.agentCode);
        if (!a) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "该智能体不在在役花名册" });
      }
      const db = getDb();
      await db.execute(
        sql`UPDATE st_dept_consoles SET chief_agent_code = ${input.agentCode} WHERE dept_code = ${input.deptCode}`,
      );
      return { ok: true as const, deptCode: input.deptCode, chiefAgentCode: input.agentCode };
    }),

  /** 配置驻部智能体组（全量替换；成员必须在役） */
  setAgents: publicQuery
    .input(
      adminInput.extend({
        deptCode: z.enum(DEPT_CODES),
        agentCodes: z.array(z.string().trim().min(1).max(64)).max(50),
      }),
    )
    .mutation(async ({ input }) => {
      await requireAdminToken(input.token);
      await requireDept(input.deptCode);
      const roster = await listVoiceAgentRoster();
      const bad = input.agentCodes.filter((c) => !roster.some((x) => x.code === c));
      if (bad.length > 0) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: `以下智能体不在在役花名册：${bad.join("、")}` });
      }
      const db = getDb();
      await db.execute(
        sql`UPDATE st_dept_consoles SET agent_codes = ${JSON.stringify(input.agentCodes)} WHERE dept_code = ${input.deptCode}`,
      );
      return { ok: true as const, deptCode: input.deptCode, agentCodes: input.agentCodes };
    }),

  /** DSH 开关与模型槽位（槽位限 modelGateway 既有五档） */
  setEngine: publicQuery
    .input(
      adminInput.extend({
        deptCode: z.enum(DEPT_CODES),
        dshEnabled: z.boolean().optional(),
        modelSlot: z.enum(["brain", "orggen", "chat", "flash", "creative"]).optional(),
        // M79 部门适配模型集合（彭总 2026-08-24 指令）：海禛云目录内 id；空数组=清除限制
        allowedModels: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      await requireAdminToken(input.token);
      await requireDept(input.deptCode);
      if (input.dshEnabled === undefined && input.modelSlot === undefined && input.allowedModels === undefined) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "没有要改的项" });
      }
      const db = getDb();
      if (input.dshEnabled !== undefined) {
        await db.execute(
          sql`UPDATE st_dept_consoles SET dsh_enabled = ${input.dshEnabled ? 1 : 0} WHERE dept_code = ${input.deptCode}`,
        );
      }
      if (input.modelSlot !== undefined) {
        await db.execute(
          sql`UPDATE st_dept_consoles SET model_slot = ${input.modelSlot} WHERE dept_code = ${input.deptCode}`,
        );
      }
      if (input.allowedModels !== undefined) {
        // 目录校验：必须是海禛云在册模型 id（笔误宁可拒不可错挂）
        const { GATEWAY_CATALOG } = await import("./modelGateway");
        const valid = new Set(GATEWAY_CATALOG.map((m) => m.id));
        const bad = input.allowedModels.filter((m) => !valid.has(m));
        if (bad.length > 0) {
          throw new TRPCError({ code: "BAD_REQUEST", message: `不在海禛云目录的模型：${bad.join("、")}` });
        }
        const json = input.allowedModels.length > 0 ? JSON.stringify(input.allowedModels) : null;
        await db.execute(
          sql`UPDATE st_dept_consoles SET allowed_models = ${json} WHERE dept_code = ${input.deptCode}`,
        );
      }
      return { ok: true as const };
    }),

  /**
   * 部门对话（DSH 内嵌模块的核心入口）：默认 runtime=dsh 深度执行；
   * 部门未配主官时回退驻部第一人；DSH 关闭时走 bridge 快速通道。
   */
  chat: publicQuery
    .input(
      adminInput.extend({
        deptCode: z.enum(DEPT_CODES),
        message: z.string().trim().min(2).max(2000),
      }),
    )
    .mutation(async ({ input }) => {
      const user = await requireAdminToken(input.token);
      const row = await requireDept(input.deptCode);
      const codes = parseCodes(row.agent_codes);
      const roster = await listVoiceAgentRoster();
      const pick =
        (row.chief_agent_code && roster.find((a) => a.code === row.chief_agent_code)) ||
        roster.find((a) => codes.includes(a.code));
      if (!pick) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `${row.dept_name}尚未配置在役智能体，请先在超终配置驻部智能体与主官`,
        });
      }
      const runtime: "bridge" | "dsh" = Number(row.dsh_enabled) === 1 ? "dsh" : "bridge";
      const run = await runWorkbenchAgentTask({
        agentCode: pick.code,
        task: `[${row.dept_name}工作台] ${input.message}`,
        username: `deptConsole:${user.username ?? user.id}`,
        runtime,
      });
      if (!run) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "该部门智能体当前未启用" });
      }
      return {
        ok: true as const,
        deptCode: input.deptCode,
        runtime,
        agent: { code: run.agentCode, name: run.agentName, title: run.agentTitle },
        reply: run.reply,
        ...(run.artifacts.length > 0 ? { artifacts: run.artifacts } : {}),
      };
    }),

  /** 驾驶舱级部门总览：配置 + 驻部画像 + Panda 四席位（平台军团）+ 近 7 日产出 */
  overview: publicQuery
    .input(adminInput.extend({ deptCode: z.enum(DEPT_CODES) }))
    .query(async ({ input }) => {
      await requireAdminToken(input.token);
      const row = await requireDept(input.deptCode);
      const db = getDb();
      const roster = await listVoiceAgentRoster();
      const codes = parseCodes(row.agent_codes);
      const chief = row.chief_agent_code
        ? roster.find((a) => a.code === row.chief_agent_code)
        : undefined;

      // Panda 四席位：平台军团（duty 以「平台」前缀标识的平台级四角色）
      const pandaRows = rawRows(
        await db.execute(
          sql`SELECT role, duty, ref_type, ref_key, enabled FROM st_panda_members WHERE duty LIKE '平台%' LIMIT 8`,
        ),
      ) as Array<Record<string, unknown>>;

      // 近 7 日驻部产出（st_agent_artifacts 按 agentCode 归集）
      let artifacts7d = 0;
      if (codes.length > 0) {
        const codeParts = codes.map((c) => sql`${c}`);
        const codeList = sql.join(codeParts, sql`, `);
        const cntRows = rawRows(
          await db.execute(
            sql`SELECT COUNT(*) AS c FROM st_agent_artifacts
                WHERE agentCode IN (${codeList})
                  AND createdAt >= DATE_SUB(NOW(), INTERVAL 7 DAY)`,
          ),
        ) as Array<Record<string, unknown>>;
        artifacts7d = Number(cntRows[0]?.c ?? 0);
      }

      return {
        deptCode: row.dept_code as DeptCode,
        deptName: row.dept_name,
        chiefAgent: chief ? { code: chief.code, name: chief.name, title: chief.title } : null,
        dshEnabled: Number(row.dsh_enabled) === 1,
        modelSlot: row.model_slot,
        agents: codes.map((c) => {
          const a = roster.find((x) => x.code === c);
          return a
            ? { code: a.code, name: a.name, title: a.title, active: true as const }
            : { code: c, name: c, title: "（已不在役）", active: false as const };
        }),
        pandaSeats: pandaRows.map((p) => ({
          role: String(p.role),
          duty: String(p.duty ?? ""),
          refType: String(p.ref_type ?? ""),
          refKey: String(p.ref_key ?? ""),
          enabled: Number(p.enabled) === 1,
        })),
        artifacts7d,
        updatedAt: row.updated_at,
      };
    }),

  /**
   * APP 员工通道（NumX Max APP ↔ 部门工作台打通）：staff token 鉴权，
   * 部门归属 = staff.deptKey 直接命中 console.dept_code，或命中该 console 的
   * config.staffDeptKeys 白名单（超终 setStaffKeys 配置）。无归属 → 诚实 412。
   */
  myConsole: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const staff = await requireStaff(input.token);
      const row = await findConsoleForStaff(staff.deptKey ?? "");
      if (!row) return { joined: false as const, deptKey: staff.deptKey ?? "" };
      const roster = await listVoiceAgentRoster();
      const chief = row.chief_agent_code
        ? roster.find((a) => a.code === row.chief_agent_code)
        : undefined;
      return {
        joined: true as const,
        deptCode: row.dept_code as DeptCode,
        deptName: row.dept_name,
        chiefAgent: chief ? { code: chief.code, name: chief.name, title: chief.title } : null,
        agentCount: parseCodes(row.agent_codes).length,
        dshEnabled: Number(row.dsh_enabled) === 1,
      };
    }),

  chatStaff: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        message: z.string().trim().min(2).max(2000),
      }),
    )
    .mutation(async ({ input }) => {
      const staff = await requireStaff(input.token);
      const row = await findConsoleForStaff(staff.deptKey ?? "");
      if (!row) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "你的部门尚未接入部门工作台，请联系平台管理员在超级终端配置",
        });
      }
      const codes = parseCodes(row.agent_codes);
      const roster = await listVoiceAgentRoster();
      const pick =
        (row.chief_agent_code && roster.find((a) => a.code === row.chief_agent_code)) ||
        roster.find((a) => codes.includes(a.code));
      if (!pick) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `${row.dept_name}尚未配置在役智能体，请联系平台管理员`,
        });
      }
      const runtime: "bridge" | "dsh" = Number(row.dsh_enabled) === 1 ? "dsh" : "bridge";
      const run = await runWorkbenchAgentTask({
        agentCode: pick.code,
        task: `[${row.dept_name}·${staff.displayName ?? staff.username}] ${input.message}`,
        username: `staff:${staff.username}`,
        runtime,
      });
      if (!run) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "该部门智能体当前未启用" });
      return {
        ok: true as const,
        deptCode: row.dept_code as DeptCode,
        deptName: row.dept_name,
        runtime,
        agent: { code: run.agentCode, name: run.agentName, title: run.agentTitle },
        reply: run.reply,
        ...(run.artifacts.length > 0 ? { artifacts: run.artifacts } : {}),
      };
    }),

  /**
   * 点将直连（驾驶舱/超终用）：按 agentCode 直接呼叫在役主官，
   * runtime 由调用方指定（默认 dsh 深度轨）。部门六主官与驻部皆可点。
   */
  chatAgent: publicQuery
    .input(
      adminInput.extend({
        agentCode: z.string().trim().min(1).max(64),
        message: z.string().trim().min(2).max(2000),
        runtime: z.enum(["bridge", "dsh"]).optional().default("dsh"),
      }),
    )
    .mutation(async ({ input }) => {
      const user = await requireAdminToken(input.token);
      const roster = await listVoiceAgentRoster();
      const pick = roster.find((a) => a.code === input.agentCode);
      if (!pick) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "该智能体不在在役花名册" });
      }
      const run = await runWorkbenchAgentTask({
        agentCode: pick.code,
        task: input.message,
        username: `cockpit:${user.username ?? user.id}`,
        runtime: input.runtime,
      });
      if (!run) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "该智能体当前未启用" });
      return {
        ok: true as const,
        runtime: input.runtime,
        agent: { code: run.agentCode, name: run.agentName, title: run.agentTitle },
        reply: run.reply,
        ...(run.artifacts.length > 0 ? { artifacts: run.artifacts } : {}),
      };
    }),

  /** 驾驶舱六主官阵列（在役花名册全量，平台级只读） */
  officers: publicQuery.input(adminInput).query(async ({ input }) => {
    await requireAdminToken(input.token);
    const roster = await listVoiceAgentRoster();
    return roster.map((a) => ({ code: a.code, name: a.name, title: a.title, deptCode: a.deptCode }));
  }),

  /** 配置区挂技能：把技能库技能挂载到本部门全体驻部智能体（含主官），幂等 */
  equipSkill: publicQuery
    .input(
      adminInput.extend({
        deptCode: z.enum(DEPT_CODES),
        skillKey: z.string().trim().min(1).max(64),
      }),
    )
    .mutation(async ({ input }) => {
      await requireAdminToken(input.token);
      const row = await requireDept(input.deptCode);
      const codes = Array.from(
        new Set([...parseCodes(row.agent_codes), ...(row.chief_agent_code ? [row.chief_agent_code] : [])]),
      );
      if (codes.length === 0) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "本部门尚无驻部智能体，先派驻再挂技能" });
      }
      const db = getDb();
      const skillRows = rawRows(
        await db.execute(
          sql`SELECT skill_key FROM st_skills WHERE skill_key = ${input.skillKey} AND status = 'active' LIMIT 1`,
        ),
      );
      if (skillRows.length === 0) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "技能不在现役技能库（超终插件仓可一键装机入库）" });
      }
      const agentRows = rawRows(
        await db.execute(
          sql`SELECT id, code FROM st_agents WHERE code IN (${sql.join(codes.map((c) => sql`${c}`), sql`, `)}) AND status = 'active'`,
        ),
      ) as Array<Record<string, unknown>>;
      let equipped = 0;
      for (const a of agentRows) {
        await db.execute(
          sql`INSERT INTO st_agent_skills (agent_id, skill_key, enabled, proficiency, revisions, created_at)
              VALUES (${Number(a.id)}, ${input.skillKey}, 1, 0, 0, NOW())
              ON DUPLICATE KEY UPDATE enabled = 1`,
        );
        equipped++;
      }
      return { ok: true as const, deptCode: input.deptCode, skillKey: input.skillKey, equippedAgents: equipped };
    }),

  /** 配置区卸技能：本部门全体驻部智能体摘除（enabled=0，保留档案） */
  unequipSkill: publicQuery
    .input(
      adminInput.extend({
        deptCode: z.enum(DEPT_CODES),
        skillKey: z.string().trim().min(1).max(64),
      }),
    )
    .mutation(async ({ input }) => {
      await requireAdminToken(input.token);
      const row = await requireDept(input.deptCode);
      const codes = Array.from(
        new Set([...parseCodes(row.agent_codes), ...(row.chief_agent_code ? [row.chief_agent_code] : [])]),
      );
      if (codes.length === 0) return { ok: true as const, unequippedAgents: 0 };
      const db = getDb();
      const agentRows = rawRows(
        await db.execute(
          sql`SELECT id FROM st_agents WHERE code IN (${sql.join(codes.map((c) => sql`${c}`), sql`, `)})`,
        ),
      ) as Array<Record<string, unknown>>;
      let n = 0;
      for (const a of agentRows) {
        await db.execute(
          sql`UPDATE st_agent_skills SET enabled = 0 WHERE agent_id = ${Number(a.id)} AND skill_key = ${input.skillKey}`,
        );
        n++;
      }
      return { ok: true as const, unequippedAgents: n };
    }),

  /** 本部门已挂载技能清单（配置区展示用） */
  equippedSkills: publicQuery
    .input(adminInput.extend({ deptCode: z.enum(DEPT_CODES) }))
    .query(async ({ input }) => {
      await requireAdminToken(input.token);
      const row = await requireDept(input.deptCode);
      const codes = Array.from(
        new Set([...parseCodes(row.agent_codes), ...(row.chief_agent_code ? [row.chief_agent_code] : [])]),
      );
      if (codes.length === 0) return [];
      const db = getDb();
      const rows = rawRows(
        await db.execute(
          sql`SELECT DISTINCT sk.skill_key, s.name, s.layer FROM st_agent_skills sk
              JOIN st_agents a ON a.id = sk.agent_id
              LEFT JOIN st_skills s ON s.skill_key = sk.skill_key
              WHERE a.code IN (${sql.join(codes.map((c) => sql`${c}`), sql`, `)}) AND sk.enabled = 1
              ORDER BY sk.skill_key LIMIT 50`,
        ),
      ) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        skillKey: String(r.skill_key),
        name: String(r.name ?? r.skill_key),
        layer: String(r.layer ?? ""),
      }));
    }),

  /**
   * 跨部门协作委派：发起部门主官 → 目标部门主官。
   * 目标部门按其引擎档位执行（DSH 开=深度轨），回执全文落 st_dept_collabs 台账，
   * 三部门工作台共享可见。同部门委派拒绝（那是本部门内的事，用 chat）。
   */
  delegate: publicQuery
    .input(
      adminInput.extend({
        fromDept: z.enum(DEPT_CODES),
        toDept: z.enum(DEPT_CODES),
        message: z.string().trim().min(2).max(2000),
      }),
    )
    .mutation(async ({ input }) => {
      const user = await requireAdminToken(input.token);
      const r = await runDeptDelegate({
        fromDept: input.fromDept, toDept: input.toDept, message: input.message,
        username: user.username ?? String(user.id),
      });
      return {
        ok: true as const,
        from: { dept: input.fromDept, agent: r.fromAgentName },
        to: { dept: input.toDept, agent: r.toAgentName },
        runtime: r.runtime,
        reply: r.reply,
        ...(r.artifacts.length > 0 ? { artifacts: r.artifacts } : {}),
      };
    }),

  /** 协作台账（三部门共享可见，倒序 50 条） */
  collabFeed: publicQuery.input(adminInput).query(async ({ input }) => {
    await requireAdminToken(input.token);
    const db = getDb();
    const rows = rawRows(
      await db.execute(
        sql`SELECT id, from_dept, to_dept, from_agent, to_agent, message, reply, runtime, status, created_at
            FROM st_dept_collabs ORDER BY id DESC LIMIT 50`,
      ),
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      fromDept: String(r.from_dept),
      toDept: String(r.to_dept),
      fromDeptName: DEPT_LABEL[String(r.from_dept) as DeptCode] ?? String(r.from_dept),
      toDeptName: DEPT_LABEL[String(r.to_dept) as DeptCode] ?? String(r.to_dept),
      fromAgent: String(r.from_agent),
      toAgent: String(r.to_agent),
      message: String(r.message ?? ""),
      reply: String(r.reply ?? ""),
      runtime: String(r.runtime),
      status: String(r.status),
      createdAt: String(r.created_at ?? ""),
    }));
  }),

  // ─── 临时会议插件能力（复用 terminal 会议引擎 st_meetings 全套）────────────
  /**
   * 发起临时会议：scope=dept（本部门内部）/ cross（跨部门）/ all（全公司）。
   * 参会人 = 所选部门的主官（无主官回退驻部第一人）。议题+开场白直入会议引擎。
   */
  meetingStart: publicQuery
    .input(
      adminInput.extend({
        topic: z.string().trim().min(2).max(200),
        scope: z.enum(["dept", "cross", "all"]),
        deptCode: z.enum(DEPT_CODES).optional(), // scope=dept 时的本部门
        participantDepts: z.array(z.enum(DEPT_CODES)).min(2).max(3).optional(), // scope=cross
        opening: z.string().trim().max(1000).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      await requireAdminToken(input.token);
      let roomType: "enterprise" | "dept" | "cross";
      let participantDepts: string[] | undefined;
      let meetingType: "full" | "partial" = "full";
      if (input.scope === "dept") {
        if (!input.deptCode) throw new TRPCError({ code: "BAD_REQUEST", message: "部门内部会需指定本部门" });
        roomType = "dept";
        meetingType = "partial";
        participantDepts = [input.deptCode];
      } else if (input.scope === "cross") {
        if (!input.participantDepts || input.participantDepts.length < 2) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "跨部门会议需至少勾选 2 个部门" });
        }
        roomType = "cross";
        meetingType = "partial";
        participantDepts = [...input.participantDepts];
      } else {
        roomType = "enterprise";
        participantDepts = undefined;
      }
      const caller = terminalRouter.createCaller({} as never);
      const r = await caller.meetingCreate({
        token: input.token,
        topic: input.topic,
        opening: input.opening,
        meetingType,
        roomType,
        participantDepts,
      });
      return { ok: true as const, meetingId: r.meetingId, roomType: r.roomType, topic: r.topic };
    }),

  /** 会议圆桌推进一轮（各参会主官依次发言） */
  meetingRound: publicQuery
    .input(adminInput.extend({ meetingId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      await requireAdminToken(input.token);
      const caller = terminalRouter.createCaller({} as never);
      return await caller.meetingRunRound({ token: input.token, meetingId: input.meetingId });
    }),

  /** 会议纪要收口 */
  meetingSummarize: publicQuery
    .input(adminInput.extend({ meetingId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      await requireAdminToken(input.token);
      const caller = terminalRouter.createCaller({} as never);
      return await caller.meetingSummarize({ token: input.token, meetingId: input.meetingId });
    }),

  /** 会议室实况（详情+消息流，轮询用） */
  meetingView: publicQuery
    .input(adminInput.extend({ meetingId: z.number().int().positive() }))
    .query(async ({ input }) => {
      await requireAdminToken(input.token);
      const caller = terminalRouter.createCaller({} as never);
      return await caller.meetingDetail({ token: input.token, meetingId: input.meetingId });
    }),

  /** 人类打断插话（商讨进行中随时可发，落在当前轮） */
  meetingSay: publicQuery
    .input(
      adminInput.extend({
        meetingId: z.number().int().positive(),
        content: z.string().trim().min(1).max(1000),
      }),
    )
    .mutation(async ({ input }) => {
      await requireAdminToken(input.token);
      const caller = terminalRouter.createCaller({} as never);
      return await caller.meetingHumanSay({
        token: input.token,
        meetingId: input.meetingId,
        content: input.content,
      });
    }),

  /** 近期会议列表（三部门共享） */
  meetingList: publicQuery.input(adminInput).query(async ({ input }) => {
    await requireAdminToken(input.token);
    const db = getDb();
    const rows = rawRows(
      await db.execute(
        sql`SELECT id, topic, status, room_type, participants, createdAt FROM st_meetings ORDER BY id DESC LIMIT 20`,
      ),
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      topic: String(r.topic ?? ""),
      status: String(r.status ?? ""),
      roomType: String(r.room_type ?? ""),
      participants: String(r.participants ?? ""),
      createdAt: String(r.createdAt ?? ""),
    }));
  }),

  /** 企业域：本厂部门工作台清单（无则按申报部门补供——老企业兼容） */
  myFactoryConsoles: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const { factory } = await sessionMe(input.token);
      let rows = await readFactoryConsoles(factory.id);
      if (rows.length === 0) {
        const depts = (Array.isArray(factory.departments) ? factory.departments : []) as Array<{ id: string; name: string }>;
        if (depts.length > 0) {
          await provisionFactoryConsoles(factory.id, depts);
          rows = await readFactoryConsoles(factory.id);
        }
      }
      return rows.map((r) => ({
        deptCode: r.dept_code,
        deptName: r.dept_name,
        chiefAgentCode: r.chief_agent_code,
        agentCodes: parseCodes(r.agent_codes),
        agentCount: parseCodes(r.agent_codes).length,
        dshEnabled: Number(r.dsh_enabled) === 1,
        modelSlot: r.model_slot,
      }));
    }),

  /** 企业域：本厂部门对话（DSH 轨带 factoryId——本厂设备/插件工具面自动可见） */
  factoryChat: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        deptCode: z.string().trim().min(1).max(16),
        message: z.string().trim().min(2).max(2000),
      }),
    )
    .mutation(async ({ input }) => {
      const { user, factory } = await sessionMe(input.token);
      const rows = await readFactoryConsoles(factory.id);
      const row = rows.find((r) => r.dept_code === input.deptCode);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "该部门工作台不存在" });
      if (!row.chief_agent_code) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `${row.dept_name}尚未任命主官——请先在数字员工超市雇佣智能体并在工作台任命`,
        });
      }
      const runtime: "bridge" | "dsh" = Number(row.dsh_enabled) === 1 ? "dsh" : "bridge";
      const run = await runWorkbenchAgentTask({
        agentCode: row.chief_agent_code,
        task: `[${factory.enterpriseName}·${row.dept_name}] ${input.message}`,
        username: `factory:${factory.id}:${user.username ?? user.id}`,
        runtime,
        factoryId: factory.id,
      });
      if (!run) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "主官智能体当前不在役（雇佣可能已到期）" });
      }
      return {
        ok: true as const,
        deptCode: row.dept_code,
        deptName: row.dept_name,
        runtime,
        agent: { code: run.agentCode, name: run.agentName, title: run.agentTitle },
        reply: run.reply,
        ...(run.artifacts.length > 0 ? { artifacts: run.artifacts } : {}),
      };
    }),

  /** 企业域：任命本厂部门主官（admin/manager；候选=本厂已雇佣智能体） */
  factorySetChief: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        deptCode: z.string().trim().min(1).max(16),
        agentCode: z.string().trim().min(1).max(64).nullable(),
      }),
    )
    .mutation(async ({ input }) => {
      const { user, factory } = await sessionMe(input.token);
      const role = normalizeRole(user.role);
      if (role !== "admin" && role !== "manager") {
        throw new TRPCError({ code: "FORBIDDEN", message: "仅企业负责人/部门主管可任命主官" });
      }
      const rows = await readFactoryConsoles(factory.id);
      if (!rows.some((r) => r.dept_code === input.deptCode)) {
        throw new TRPCError({ code: "NOT_FOUND", message: "该部门工作台不存在" });
      }
      if (input.agentCode !== null) {
        // 主官候选 = 平台在役主官花名册（六主官以本厂 factoryId 工具面驻厂服务；
        // 企业雇佣的专项智能体驻部通路为后续迭代）
        const roster = await listVoiceAgentRoster();
        if (!roster.some((a) => a.code === input.agentCode)) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "该智能体不在在役主官花名册" });
        }
      }
      const db = getDb();
      await db.execute(
        sql`UPDATE st_dept_consoles SET chief_agent_code = ${input.agentCode}
            WHERE factory_id = ${factory.id} AND dept_code = ${input.deptCode}`,
      );
      return { ok: true as const };
    }),

  /** 超终配置：某部门工作台接纳哪些 staff.deptKey（APP 员工通道归属白名单） */
  setStaffKeys: publicQuery
    .input(
      adminInput.extend({
        deptCode: z.enum(DEPT_CODES),
        staffDeptKeys: z.array(z.string().trim().min(1).max(64)).max(30),
      }),
    )
    .mutation(async ({ input }) => {
      await requireAdminToken(input.token);
      const row = await requireDept(input.deptCode);
      const cfg = parseConfig(row.config);
      cfg.staffDeptKeys = input.staffDeptKeys;
      const db = getDb();
      await db.execute(
        sql`UPDATE st_dept_consoles SET config = ${JSON.stringify(cfg)} WHERE dept_code = ${input.deptCode}`,
      );
      return { ok: true as const };
    }),
});

// ─── M78c 委派核心（trpc mutation 与 SSE 流式端点单一事实源）─────────────────

export interface DeptDelegateCoreResult {
  fromAgentName: string;
  toAgentName: string;
  runtime: "bridge" | "dsh";
  reply: string;
  artifacts: unknown[];
  collabId: number;
}

/**
 * 跨部门协作委派核心：鉴权由调用方负责（trpc=requireAdminToken / SSE 同强度）。
 * 校验→选人→执行→台账落库，与原 delegate mutation 逻辑逐字等价（仅 insertId 回填 collabId 为新增）。
 */
export async function runDeptDelegate(input: {
  fromDept: DeptCode;
  toDept: DeptCode;
  message: string;
  username: string;
}): Promise<DeptDelegateCoreResult> {
  if (input.fromDept === input.toDept) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "同部门协作请直接用本部门对话窗" });
  }
  const fromRow = await requireDept(input.fromDept);
  const toRow = await requireDept(input.toDept);
  const roster = await listVoiceAgentRoster();

  const fromPick =
    (fromRow.chief_agent_code && roster.find((a) => a.code === fromRow.chief_agent_code)) ||
    roster.find((a) => parseCodes(fromRow.agent_codes).includes(a.code));
  const toPick =
    (toRow.chief_agent_code && roster.find((a) => a.code === toRow.chief_agent_code)) ||
    roster.find((a) => parseCodes(toRow.agent_codes).includes(a.code));
  if (!fromPick) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: `${fromRow.dept_name}尚未配置在役智能体（发起方）` });
  }
  if (!toPick) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: `${toRow.dept_name}尚未配置在役智能体（接收方）` });
  }

  const runtime: "bridge" | "dsh" = Number(toRow.dsh_enabled) === 1 ? "dsh" : "bridge";
  const collabTask =
    `【跨部门协作】${fromRow.dept_name}主官 ${fromPick.name} 向你（${toRow.dept_name}主官 ${toPick.name}）发起协作请求，` +
    `请按你部门职责给出可执行的回应或办理结果：\n${input.message}`;
  const run = await runWorkbenchAgentTask({
    agentCode: toPick.code,
    task: collabTask,
    username: `collab:${input.username}`,
    runtime,
  });
  if (!run) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "接收方智能体当前未启用" });

  const db = getDb();
  const ins = await db.execute(
    sql`INSERT INTO st_dept_collabs (from_dept, to_dept, from_agent, to_agent, message, reply, runtime, status, created_at)
        VALUES (${input.fromDept}, ${input.toDept}, ${fromPick.code}, ${toPick.code},
                ${input.message}, ${run.reply}, ${runtime}, 'answered', NOW())`,
  );
  const first = Array.isArray(ins) ? (ins as unknown[])[0] : ins;
  const collabId = Number((first as { insertId?: number })?.insertId ?? 0);
  return {
    fromAgentName: fromPick.name,
    toAgentName: toPick.name,
    runtime,
    reply: run.reply,
    artifacts: run.artifacts,
    collabId,
  };
}
