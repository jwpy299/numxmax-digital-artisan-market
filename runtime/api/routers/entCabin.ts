/**
 * entCabin —— 企业舱位制（彭总定稿 2026-08-30：按灵智枢分舱法给企业分舱）。
 *
 * 一舱 = 完整作战单元：舱主（真人）+ 数字员工（责任人制）+ 本舱任务（人机双轨）。
 * 纪律：行业预置舱一键落座；x_ 自建舱与平台码永不撞车；舱主即本舱验收签字人；
 * 舱数据本厂隔离；责任人制——数字员工必挂真人名下。
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { sessionMe } from "./wbSession";
import { rawRows } from "./terminal";
import { isValidCustomDeptCode } from "./deptCustom";
import { emitReport } from "./reportBus";

/** 行业预置舱图（纯数据可测） */
export const INDUSTRY_PRESETS: Record<string, { code: string; name: string }[]> = {
  manufacturing: [
    { code: "produce", name: "生产舱" }, { code: "quality", name: "质量舱" },
    { code: "purchase", name: "采购舱" }, { code: "sales", name: "销售舱" },
    { code: "finance", name: "财务舱" }, { code: "admin", name: "行政舱" },
  ],
  ecommerce: [
    { code: "ops", name: "运营舱" }, { code: "sales", name: "销售舱" },
    { code: "cs", name: "客服舱" }, { code: "logistics", name: "物流舱" }, { code: "finance", name: "财务舱" },
  ],
  gov: [
    { code: "service", name: "服务舱" }, { code: "inspect", name: "巡检舱" },
    { code: "finance", name: "财务舱" }, { code: "admin", name: "行政舱" },
  ],
};
export const PRESET_CODES = new Set(Object.values(INDUSTRY_PRESETS).flat().map((c) => c.code));

/** 舱码合法（纯函数）：行业预置码 或 x_ 自建码 */
export function isValidCabinCode(code: string): boolean {
  return PRESET_CODES.has(code) || isValidCustomDeptCode(code);
}

const tokenInput = { token: z.string().trim().min(1) };

export const entCabinRouter = createRouter({
  /** 舱位图（本厂全部舱 + 每舱人数/数字员工数/未完成任务数） */
  map: publicQuery.input(z.object(tokenInput)).query(async ({ input }) => {
    const session = await sessionMe(input.token);
    const fid = session.factory.id;
    const db = getDb();
    const cabins = rawRows(
      await db.execute(
        sql`SELECT c.id, c.code, c.name, c.head_user_id AS headUserId, u.displayName AS headName,
              (SELECT COUNT(*) FROM st_cabin_tasks t WHERE t.cabin_id=c.id AND t.status='open') AS openTasks,
              (SELECT COUNT(*) FROM st_ent_agents a WHERE a.factory_id=c.factory_id AND a.dept_code=c.code AND a.status!='retired') AS agents
            FROM st_ent_cabins c LEFT JOIN wb_users u ON u.id=c.head_user_id
            WHERE c.factory_id=${fid} AND c.disabled=0 ORDER BY c.sort, c.id`,
      ),
    );
    return { cabins, presets: INDUSTRY_PRESETS };
  }),

  /** 行业预置舱一键落座（企业负责人；幂等——已存在的舱跳过） */
  seatPreset: publicQuery
    .input(z.object({ ...tokenInput, industry: z.enum(["manufacturing", "ecommerce", "gov"]) }))
    .mutation(async ({ input }) => {
      const session = await sessionMe(input.token);
      const db = getDb();
      let seated = 0;
      for (const [i, c] of INDUSTRY_PRESETS[input.industry].entries()) {
        const r = await db.execute(
          sql`INSERT IGNORE INTO st_ent_cabins (factory_id, code, name, sort) VALUES (${session.factory.id}, ${c.code}, ${c.name}, ${i})`,
        );
        const first = Array.isArray(r) ? (r as unknown[])[0] : r;
        seated += Number((first as { affectedRows?: number })?.affectedRows ?? 0);
      }
      return { ok: true as const, seated, total: INDUSTRY_PRESETS[input.industry].length };
    }),

  /** 自建舱（x_ 码） */
  create: publicQuery
    .input(z.object({ ...tokenInput, code: z.string().trim().toLowerCase(), name: z.string().trim().min(2).max(32) }))
    .mutation(async ({ input }) => {
      const session = await sessionMe(input.token);
      if (!isValidCabinCode(input.code)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "舱码须为行业预置码或 x_ 前缀自建码（如 x_logistics）" });
      }
      const db = getDb();
      const r = await db.execute(
        sql`INSERT IGNORE INTO st_ent_cabins (factory_id, code, name, sort) VALUES (${session.factory.id}, ${input.code}, ${input.name}, 99)`,
      );
      const first = Array.isArray(r) ? (r as unknown[])[0] : r;
      if (Number((first as { affectedRows?: number })?.affectedRows ?? 0) === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "舱码已存在" });
      }
      return { ok: true as const };
    }),

  /** 任命舱主（真人，本厂已确权成员；舱主即本舱验收签字人） */
  setHead: publicQuery
    .input(z.object({ ...tokenInput, cabinId: z.number().int().positive(), headUserId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const session = await sessionMe(input.token);
      const db = getDb();
      const bound = rawRows(
        await db.execute(
          sql`SELECT id FROM st_identity_bindings WHERE user_id=${input.headUserId} AND factory_id=${session.factory.id} AND status='active' LIMIT 1`,
        ),
      );
      const isSelfOwner = Number(session.user.id) === input.headUserId;
      if (bound.length === 0 && !isSelfOwner) {
        throw new TRPCError({ code: "FORBIDDEN", message: "舱主须为本厂已确权成员" });
      }
      const r = await db.execute(
        sql`UPDATE st_ent_cabins SET head_user_id=${input.headUserId} WHERE id=${input.cabinId} AND factory_id=${session.factory.id}`,
      );
      const first = Array.isArray(r) ? (r as unknown[])[0] : r;
      if (Number((first as { affectedRows?: number })?.affectedRows ?? 0) !== 1) {
        throw new TRPCError({ code: "NOT_FOUND", message: "舱不存在" });
      }
      return { ok: true as const };
    }),

  /** 舱内派任务（双轨：真人/数字员工二选一；责任人制） */
  dispatchTask: publicQuery
    .input(z.object({
      ...tokenInput,
      cabinId: z.number().int().positive(),
      title: z.string().trim().min(2).max(128),
      brief: z.string().trim().max(2000).optional(),
      assigneeUserId: z.number().int().positive().optional(),
      assigneeAgentId: z.number().int().positive().optional(),
    }))
    .mutation(async ({ input }) => {
      const session = await sessionMe(input.token);
      if (!input.assigneeUserId && !input.assigneeAgentId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "须派给真人或数字员工（二选一）" });
      }
      if (input.assigneeUserId && input.assigneeAgentId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "一单只派一方（人机二选一）" });
      }
      const db = getDb();
      const cabin = rawRows(
        await db.execute(sql`SELECT id, code, name FROM st_ent_cabins WHERE id=${input.cabinId} AND factory_id=${session.factory.id} AND disabled=0 LIMIT 1`),
      )[0];
      if (!cabin) throw new TRPCError({ code: "NOT_FOUND", message: "舱不存在" });
      // 数字员工必须挂在本舱（责任人制：舱码一致）
      if (input.assigneeAgentId) {
        const ag = rawRows(
          await db.execute(sql`SELECT id FROM st_ent_agents WHERE id=${input.assigneeAgentId} AND factory_id=${session.factory.id} AND dept_code=${String(cabin.code)} AND status!='retired' LIMIT 1`),
        )[0];
        if (!ag) throw new TRPCError({ code: "BAD_REQUEST", message: "该数字员工不属本舱（责任人制：先挂舱再派活）" });
      }
      await db.execute(
        sql`INSERT INTO st_cabin_tasks (factory_id, cabin_id, title, brief, assignee_user_id, assignee_agent_id)
            VALUES (${session.factory.id}, ${input.cabinId}, ${input.title}, ${input.brief ?? null}, ${input.assigneeUserId ?? null}, ${input.assigneeAgentId ?? null})`,
      );
      // 派给真人 → 汇报总线通知本人；派给数字员工 → 本厂播报
      if (input.assigneeUserId) {
        await emitReport({
          audience: "personal", userId: input.assigneeUserId, level: "action", sourceRing: "cabin",
          title: `📋 ${String(cabin.name)}新任务：${input.title}`,
          body: input.brief?.slice(0, 200) ?? "请到工作台查看。", dedupeKey: `ct:${input.cabinId}:${Date.now()}`,
        });
      } else {
        await emitReport({
          audience: "factory", factoryId: session.factory.id, level: "info", sourceRing: "cabin",
          title: `📋 ${String(cabin.name)}派单给数字员工：${input.title}`,
          body: "工单已下达，执行结果将回传验收。", dedupeKey: `ct:${input.cabinId}:${Date.now()}`,
        });
      }
      return { ok: true as const };
    }),

  /** 舱内任务列表（本舱） */
  tasks: publicQuery
    .input(z.object({ ...tokenInput, cabinId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const session = await sessionMe(input.token);
      const rows = rawRows(
        await getDb().execute(
          sql`SELECT t.id, t.title, t.status, t.assignee_user_id AS aUser, t.assignee_agent_id AS aAgent,
                u.displayName AS userName, a.name AS agentName, DATE_FORMAT(t.created_at, '%m-%d %H:%i') AS at
              FROM st_cabin_tasks t
              LEFT JOIN wb_users u ON u.id=t.assignee_user_id
              LEFT JOIN st_ent_agents a ON a.id=t.assignee_agent_id
              WHERE t.cabin_id=${input.cabinId} AND t.factory_id=${session.factory.id}
              ORDER BY t.id DESC LIMIT 30`,
        ),
      );
      return { tasks: rows };
    }),

  /** 任务完成（认领人本人或舱主可勾） */
  doneTask: publicQuery
    .input(z.object({ ...tokenInput, taskId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const session = await sessionMe(input.token);
      const uid = Number(session.user.id);
      const db = getDb();
      const t = rawRows(
        await db.execute(
          sql`SELECT t.id, t.status, t.assignee_user_id, c.head_user_id FROM st_cabin_tasks t JOIN st_ent_cabins c ON c.id=t.cabin_id
              WHERE t.id=${input.taskId} AND t.factory_id=${session.factory.id} LIMIT 1`,
        ),
      )[0];
      if (!t || String(t.status) !== "open") throw new TRPCError({ code: "BAD_REQUEST", message: "任务不存在或已关闭" });
      const isAssignee = t.assignee_user_id != null && Number(t.assignee_user_id) === uid;
      const isHead = t.head_user_id != null && Number(t.head_user_id) === uid;
      if (!isAssignee && !isHead) throw new TRPCError({ code: "FORBIDDEN", message: "只有认领人或舱主可完成" });
      await db.execute(sql`UPDATE st_cabin_tasks SET status='done', done_by=${uid}, done_at=NOW() WHERE id=${input.taskId}`);
      return { ok: true as const };
    }),
});
