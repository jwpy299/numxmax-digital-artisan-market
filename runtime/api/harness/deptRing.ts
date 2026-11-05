/**
 * M80 小环完整化（彭总校正语义 2026-08-24）：小环=部门级 Nebula Harness，大环=组织框架管小环。
 *
 * 本模块两件事：
 * 1. 部门拍板权（deptDecide）：dept 定向提案（target_key 尾缀 @<dept>，M77 立案口径）
 *    可由该部门主管拍板（manager/admin/owner + departmentId=部门码 + 同厂），
 *    企业负责人（owner/admin）全域可拍（原路径不变）。
 * 2. 部门环候选过滤口径（纯函数）：deptTargetMatch / 大环本厂闸 HQ 过滤 SQL 片段常量。
 *
 * 纪律：additive 新端点，原 proposalApprove/Reject 一字不动（原来系统功能不变）；
 * apply 复用现有落地机制（optimize revisions+1 / retire 停用 / new_skill 入册）。
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { sessionMe } from "../routers/wbSession";
import { rawRows } from "../routers/terminal";

/** M77 立案口径：target_key 尾缀 @<deptKey> 即该部门小环提案 */
export function deptOfTargetKey(targetKey: unknown): string | null {
  const m = /@([a-z0-9_-]{1,32})$/i.exec(String(targetKey ?? ""));
  return m ? m[1] : null;
}

/** 大环（组织/平台环）本厂闸：输送带施工只消费本厂（HQ）提案——租户提案永不进平台施工链 */
export function hqFactoryIdOf(): number | null {
  const first = (process.env.HQ_FACTORY_IDS ?? "").split(",")[0]?.trim();
  const n = Number(first);
  return Number.isFinite(n) && n > 0 ? n : null;
}

interface DecideActor {
  userId: number;
  username: string;
  factoryId: number;
  role: string;
  departmentId: string | null;
}

/** 拍板权判定（纯函数，可单测）：企业负责人全域；部门主管限本部门小环提案 */
export function canDecide(actor: DecideActor, proposal: { factory_id: unknown; target_key: unknown }): boolean {
  if (Number(proposal.factory_id) !== actor.factoryId) return false; // 跨厂永不
  if (actor.role === "owner" || actor.role === "admin") return true; // 企业负责人全域
  const dept = deptOfTargetKey(proposal.target_key);
  if (!dept) return false; // 非部门定向提案只能企业负责人拍
  return actor.role === "manager" && String(actor.departmentId ?? "") === dept;
}

export const deptRingRouter = createRouter({
  /**
   * deptDecide（mutation）：部门环提案拍板（approve/reject 同体）。
   * - 提案须 pending 且 target_key 尾缀 @dept（小环提案）；
   * - 企业负责人（owner/admin）可拍任何本厂提案（含小环）；部门主管（manager）仅可拍本部；
   * - approve → 复用落地机制（optimize/retire/new_skill 同 proposalApprove 口径）→ applied；
   * - reject → rejected + 理由留痕。全程 decided_by/decided_at/decision_note 可追。
   */
  deptDecide: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        proposalId: z.number().int().positive(),
        approve: z.boolean(),
        reason: z.string().trim().max(255).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { user } = await sessionMe(input.token);
      const actor: DecideActor = {
        userId: Number(user.id),
        username: String(user.username ?? "unknown"),
        factoryId: Number(user.factoryId),
        role: String(user.role ?? "member"),
        departmentId: user.departmentId == null ? null : String(user.departmentId),
      };
      const db = getDb();
      const rows = rawRows(
        await db.execute(
          sql`SELECT id, factory_id, skill_key, proposal_type, title, status, target_key
              FROM st_evo_proposals WHERE id = ${input.proposalId} LIMIT 1`,
        ),
      );
      const p = rows[0];
      if (!p || Number(p.factory_id) !== actor.factoryId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "提案不存在" });
      }
      // P1-3 门禁：canDecide 只读 factory_id / target_key 两列，显式取列（原传整行 Record 类型不符）
      if (!canDecide(actor, { factory_id: p.factory_id, target_key: p.target_key })) {
        throw new TRPCError({ code: "FORBIDDEN", message: "仅企业负责人或本部门主管可拍板该提案" });
      }
      if (String(p.status) !== "pending") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "提案已处理，不可重复审批" });
      }
      if (!input.approve) {
        await db.execute(
          sql`UPDATE st_evo_proposals
              SET status = 'rejected', decided_by = ${actor.username}, decided_at = NOW(),
                  decision_note = ${input.reason ?? null}
              WHERE id = ${input.proposalId}`,
        );
        return { ok: true as const, proposalId: input.proposalId, status: "rejected" as const };
      }
      const skillKey = String(p.skill_key ?? "");
      const ptype = String(p.proposal_type ?? "optimize");
      await db.execute(
        sql`UPDATE st_evo_proposals SET status = 'approved', decided_by = ${actor.username}, decided_at = NOW()
            WHERE id = ${input.proposalId}`,
      );
      // apply：与 proposalApprove 同机制同口径（本厂雇佣员工限定）
      if (ptype === "optimize") {
        await db.execute(
          sql`UPDATE st_agent_skills SET revisions = revisions + 1
              WHERE skill_key = ${skillKey}
                AND agent_id IN (SELECT agentId FROM agent_hire_records WHERE enterpriseId = ${actor.factoryId})`,
        );
      } else if (ptype === "retire") {
        await db.execute(
          sql`UPDATE st_agent_skills SET enabled = 0
              WHERE skill_key = ${skillKey}
                AND agent_id IN (SELECT agentId FROM agent_hire_records WHERE enterpriseId = ${actor.factoryId})`,
        );
      } else if (ptype === "new_skill") {
        const exists = rawRows(
          await db.execute(sql`SELECT skill_key FROM st_skills WHERE skill_key = ${skillKey} LIMIT 1`),
        );
        if (exists.length === 0) {
          await db.execute(
            sql`INSERT INTO st_skills (skill_key, name, layer, category, description, status)
                VALUES (${skillKey}, ${String(p.title ?? skillKey).slice(0, 64)}, 'professional',
                  'custom', ${`由部门环提案 #${input.proposalId} 批准新增`}, 'active')`,
          );
        }
      }
      await db.execute(
        sql`UPDATE st_evo_proposals SET status = 'applied', applied_at = NOW() WHERE id = ${input.proposalId}`,
      );
      return { ok: true as const, proposalId: input.proposalId, status: "applied" as const, proposalType: ptype };
    }),
});
