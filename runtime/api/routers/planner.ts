/**
 * planner 路由 —— 集群规划骨架（M7-d）。
 *
 * 链路：老板说一句话目标 → planner.draft（AI 拆解为白名单具名协议组合 + 部门归属，仅草稿不执行）
 *   → 老板过目 → planner.submit（confirm=true 过闸，元意图协议 intent_plan_submit，C 级两段确认）
 *   → gate 执行器逐步 submitIntent（每步独立双签+WAL，actor=ai:planner:<发起人> 上链可审计）
 *   → 子步骤含 C 级 → 计划挂起 pending_confirm，到组织中枢逐条确认。
 *
 * 铁律：规划层永不直触执行层——步骤只允许白名单具名协议（且禁止递归包含 intent_plan_submit 自身）；
 * 部门 scope 物化：步骤的 dept 必须是本厂真实部门（wb_role_agents），跨部门协作=向该部门提交意图。
 */
import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { sessionMe } from "./wbSession";
import { stQuery } from "./terminal";
import { submitIntent } from "./gate";
import { callSlotChat, callSlotChatFast } from "./modelGateway";
import type { CallOpts, LlmCallResult } from "./modelGateway";

/** M8-a：flash 槽走双通道竞速+熔断路由；双败回落 {ok:false} 保持原契约（上层报"规划器暂时不可用"） */
async function callFlash(opts: CallOpts): Promise<LlmCallResult> {
  try {
    const r = await callSlotChatFast("flash", opts);
    return r as unknown as LlmCallResult;
  } catch {
    // 竞速双败（或熔断全开）→ 回退原顺序链路，保持上层契约与可测性
    return callSlotChat("flash", opts);
  }
}

// ─── 类型 ────────────────────────────────────────────────────────────────────

export interface PlanStep {
  seq: number;
  actionType: string;
  payload: Record<string, unknown>;
  dept: string | null;
  reason: string;
}

interface ProtocolLite {
  code: string;
  name: string;
  level: string;
}

/** 元意图协议自身：禁止递归 */
const META_PROTOCOL = "intent_plan_submit";

// ─── 数据助手 ────────────────────────────────────────────────────────────────

async function activeProtocols(): Promise<ProtocolLite[]> {
  const rows = await stQuery(
    sql`SELECT code, name, level FROM st_protocols WHERE status = 'active' AND code <> ${META_PROTOCOL} ORDER BY level, code`,
  );
  return rows.map((r) => ({ code: String(r.code), name: String(r.name), level: String(r.level) }));
}

/** 本厂部门清单（职责域物化的来源：wb_role_agents 真实部门 + #12 舱位制：st_ent_cabins 舱码/舱名） */
async function factoryDepts(factoryId: number): Promise<string[]> {
  const rows = await stQuery(
    sql`SELECT DISTINCT deptName FROM wb_role_agents WHERE factoryId = ${factoryId} ORDER BY deptName`,
  );
  const cabins = await stQuery(
    sql`SELECT code, name FROM st_ent_cabins WHERE factory_id = ${factoryId} AND disabled = 0`,
  );
  const set = new Set<string>(rows.map((r) => String(r.deptName)));
  for (const c of cabins) {
    set.add(String(c.code));
    set.add(String(c.name));
  }
  return [...set].sort();
}

/** #12 舱位识别：dept 是本厂舱码/舱名时返回舱信息（跨舱协作路由依据） */
async function cabinOf(factoryId: number, dept: string): Promise<{ id: number; code: string; name: string } | null> {
  const rows = await stQuery(
    sql`SELECT id, code, name FROM st_ent_cabins
        WHERE factory_id = ${factoryId} AND disabled = 0 AND (code = ${dept} OR name = ${dept}) LIMIT 1`,
  );
  return rows[0] ? { id: Number(rows[0].id), code: String(rows[0].code), name: String(rows[0].name) } : null;
}

/** 步骤校验：白名单 + 禁递归 + 部门真实存在。返回错误清单（空=通过），绝不静默修改 */
export function validateSteps(
  steps: PlanStep[],
  protocols: ProtocolLite[],
  depts: string[],
): string[] {
  const errors: string[] = [];
  const codes = new Set(protocols.map((p) => p.code));
  for (const s of steps) {
    if (!codes.has(s.actionType)) {
      errors.push(`步骤${s.seq}：动作 ${s.actionType} 不在白名单（禁止递归元意图）`);
    }
    if (s.dept != null && !depts.includes(s.dept)) {
      errors.push(`步骤${s.seq}：部门「${s.dept}」不在本厂部门清单（${depts.join("、") || "无"}）`);
    }
    if (!s.payload || typeof s.payload !== "object") {
      errors.push(`步骤${s.seq}：payload 缺失或非法`);
    }
  }
  return errors;
}

// ─── AI 拆解（LLM 结构化输出，白名单+部门约束）──────────────────────────────

export async function decomposeGoal(
  goal: string,
  protocols: ProtocolLite[],
  depts: string[],
): Promise<PlanStep[]> {
  const protocolList = protocols.map((p) => `- ${p.code}（${p.name}，${p.level} 级）`).join("\n");
  const sys =
    `你是 NumX Max 的集群规划器。把老板的一句话目标拆解为「具名协议组合」执行计划。\n` +
    `可用协议白名单（除此之外一律不得使用）：\n${protocolList}\n` +
    `本厂部门清单：${depts.join("、") || "（无部门数据，dept 一律填 null）"}\n` +
    `输出严格 JSON 数组，每个元素：{"seq":序号,"actionType":"协议code","payload":{},"dept":"部门名或null","reason":"这步做什么"}\n` +
    `规则：\n` +
    `1. 只能使用白名单协议 code；payload 按协议语义填写（sandbox_dispatch 需 instruction/skillKey；device_rehearsal 需 deviceName；llm_limit_adjust 需 newLimit 整数；employee_offboard 需 username）；\n` +
    `2. dept 必须从部门清单选，选不出就 null；\n` +
    `3. 步骤按依赖排序，最多 5 步；目标无法由白名单完成时，返回能完成的部分并在 reason 说明边界；\n` +
    `4. 只输出 JSON 数组，不要任何额外文字。`;
  const r = await callFlash({
    messages: [
      { role: "system", content: sys },
      { role: "user", content: `老板的目标：「${goal}」` },
    ],
    maxTokens: 600,
    temperature: 0.2,
    timeoutMs: 45_000,
  });
  if (!r.ok) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "规划器暂时不可用，请稍后再试" });
  }
  const raw = String((r as { content?: string }).content ?? "");
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  let arr: unknown;
  try {
    arr = JSON.parse((m ? m[1]! : raw).trim());
  } catch {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "规划器输出无法解析，请换个说法再试" });
  }
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "这个目标规划不出可执行的步骤，请说得更具体些" });
  }
  return arr.slice(0, 5).map((s, i) => {
    const o = (s ?? {}) as Record<string, unknown>;
    return {
      seq: i + 1,
      actionType: String(o.actionType ?? ""),
      payload: (o.payload && typeof o.payload === "object" ? o.payload : {}) as Record<string, unknown>,
      dept: o.dept == null ? null : String(o.dept),
      reason: String(o.reason ?? "").slice(0, 200),
    };
  });
}

// ─── 路由 ────────────────────────────────────────────────────────────────────

const tokenInput = z.object({ token: z.string().trim().min(1) });

export const plannerRouter = createRouter({
  /** planner.draft：AI 拆解目标 → 计划草稿（不执行，老板过目后再 submit） */
  draft: publicQuery
    .input(tokenInput.extend({ goal: z.string().trim().min(2).max(500) }))
    .mutation(async ({ input }) => {
      const { user, factory } = await sessionMe(input.token);
      const protocols = await activeProtocols();
      const depts = await factoryDepts(factory.id);
      const steps = await decomposeGoal(input.goal, protocols, depts);
      const errors = validateSteps(steps, protocols, depts);
      if (errors.length > 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `规划校验未过：${errors.join("；")}` });
      }
      await stQuery(
        sql`INSERT INTO st_intent_plans (factory_id, actor, actor_role, goal, plan_json)
            VALUES (${factory.id}, ${String(user.username)}, ${String(user.role)}, ${input.goal},
                    ${JSON.stringify(steps)})`,
      );
      const idRows = await stQuery(sql`SELECT LAST_INSERT_ID() AS id`);
      const planId = Number(idRows[0]?.id ?? 0);
      // 部门 scope 物化：草稿时把本厂部门职责域落 st_dept_scopes（幂等，已存在不动）
      for (const d of depts) {
        await stQuery(
          sql`INSERT IGNORE INTO st_dept_scopes (factory_id, dept_name) VALUES (${factory.id}, ${d})`,
        );
      }
      return {
        planId,
        goal: input.goal,
        steps,
        status: "draft" as const,
        depts,
      };
    }),

  /** planner.submit：元意图过闸（C 级协议，confirm=true 两段确认后执行） */
  submit: publicQuery
    .input(
      tokenInput.extend({
        planId: z.number().int().positive(),
        confirm: z.boolean().optional().default(false),
      }),
    )
    .mutation(async ({ input }) => {
      const { user, factory } = await sessionMe(input.token);
      const rows = await stQuery(
        sql`SELECT actor, status FROM st_intent_plans WHERE id = ${input.planId} AND factory_id = ${factory.id} LIMIT 1`,
      );
      if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: `计划 #${input.planId} 不存在` });
      if (String(rows[0].actor) !== String(user.username)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "只有计划发起人能提交它过闸" });
      }
      const status = String(rows[0].status);
      if (status !== "draft" && status !== "submitted") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: `计划当前状态 ${status}，不可重复提交` });
      }
      const result = await submitIntent({
        actor: { username: String(user.username), role: String(user.role), factoryId: factory.id },
        actionType: META_PROTOCOL,
        payload: { planId: input.planId },
        reason: `集群规划元意图 #${input.planId}`,
        confirm: input.confirm,
      });
      // 元意图当场执行时执行器已回写最终状态（executed/pending_confirm/failed），以执行器为准，不可覆盖；
      // 仅挂起（meta pending_confirm）时标记 submitted 等待老板确认
      if (result.status === "executed") {
        await stQuery(sql`UPDATE st_intent_plans SET intent_id = ${result.intentId} WHERE id = ${input.planId}`);
      } else {
        await stQuery(
          sql`UPDATE st_intent_plans SET intent_id = ${result.intentId}, status = 'submitted' WHERE id = ${input.planId}`,
        );
      }
      const finalRows = await stQuery(
        sql`SELECT status, result_json AS resultJson FROM st_intent_plans WHERE id = ${input.planId} LIMIT 1`,
      );
      return {
        planId: input.planId,
        intentId: result.intentId,
        metaStatus: result.status,
        planStatus: finalRows[0] ? String(finalRows[0].status) : result.status,
        steps: finalRows[0]?.resultJson ? (JSON.parse(String(finalRows[0].resultJson)) as unknown[]) : null,
      };
    }),

  /** #12 跨舱协作：把计划的舱位步骤物化为各舱任务（彭总令 2026-09-02）
   *  部门级步骤走 submitIntent 不变；dept 命中舱码/舱名的步骤 → 入对应舱 st_cabin_tasks 队列，
   *  一张计划多单并行，各舱认领执行（人机双轨沿用 dispatchTask 纪律）。 */
  dispatchToCabins: publicQuery
    .input(tokenInput.extend({ planId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const { user, factory } = await sessionMe(input.token);
      const rows = await stQuery(
        sql`SELECT actor, goal, plan_json AS planJson, status FROM st_intent_plans WHERE id = ${input.planId} AND factory_id = ${factory.id} LIMIT 1`,
      );
      if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: `计划 #${input.planId} 不存在` });
      if (String(rows[0].actor) !== String(user.username) && String(user.role) !== "owner") {
        throw new TRPCError({ code: "FORBIDDEN", message: "只有计划发起人或企业主可下发" });
      }
      const steps = JSON.parse(String(rows[0].planJson)) as PlanStep[];
      const db = getDb();
      let created = 0;
      const skipped: number[] = [];
      for (const s of steps) {
        if (!s.dept) { skipped.push(s.seq); continue; }
        const cabin = await cabinOf(factory.id, s.dept);
        if (!cabin) { skipped.push(s.seq); continue; }
        const brief = `[计划#${input.planId}·步骤${s.seq}] ${s.reason}｜${JSON.stringify(s.payload ?? {}).slice(0, 300)}`;
        await db.execute(
          sql`INSERT INTO st_cabin_tasks (factory_id, cabin_id, title, brief)
              VALUES (${factory.id}, ${cabin.id}, ${`[P${input.planId}-S${s.seq}] ${s.reason.slice(0, 60)}`}, ${brief})`,
        );
        created++;
      }
      return { ok: true as const, planId: input.planId, cabinTasks: created, skipped };
    }),

  /** planner.list：本厂计划流水（最近 50，含步骤与执行结果） */
  list: publicQuery.input(tokenInput).query(async ({ input }) => {
    const { factory } = await sessionMe(input.token);
    const rows = await stQuery(
      sql`SELECT id, actor, goal, plan_json AS planJson, status, intent_id AS intentId,
                 result_json AS resultJson, created_at AS createdAt, handled_at AS handledAt
          FROM st_intent_plans WHERE factory_id = ${factory.id} ORDER BY id DESC LIMIT 50`,
    );
    return {
      plans: rows.map((r) => ({
        id: Number(r.id),
        actor: String(r.actor),
        goal: String(r.goal),
        steps: JSON.parse(String(r.planJson)) as unknown[],
        status: String(r.status),
        intentId: r.intentId == null ? null : Number(r.intentId),
        results: r.resultJson == null ? null : (JSON.parse(String(r.resultJson)) as unknown[]),
        createdAt: String(r.createdAt),
        handledAt: r.handledAt == null ? null : String(r.handledAt),
      })),
    };
  }),

  /** planner.cancel：撤销未执行的计划（draft/submitted 可撤；执行中的元意图由 WAL 背书不可撤） */
  cancel: publicQuery
    .input(tokenInput.extend({ planId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const { user, factory } = await sessionMe(input.token);
      const rows = await stQuery(
        sql`SELECT actor, status FROM st_intent_plans WHERE id = ${input.planId} AND factory_id = ${factory.id} LIMIT 1`,
      );
      if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: `计划 #${input.planId} 不存在` });
      if (String(rows[0].actor) !== String(user.username) && String(user.role) !== "owner") {
        throw new TRPCError({ code: "FORBIDDEN", message: "只有计划发起人或企业主可撤销" });
      }
      const status = String(rows[0].status);
      if (status !== "draft" && status !== "submitted") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: `计划当前状态 ${status}，已过闸不可撤销` });
      }
      await stQuery(
        sql`UPDATE st_intent_plans SET status = 'cancelled', handled_at = NOW() WHERE id = ${input.planId}`,
      );
      return { ok: true as const, planId: input.planId };
    }),
});
