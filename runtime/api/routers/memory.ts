/**
 * memory —— 迭代60「员工个体记忆治理」（admin 专属）：
 * v12 让记忆自动沉淀并注入对话；本路由让记忆可治理：
 * - list：按员工/对话对象过滤查看全部记忆行；
 * - correct：纠正错误记忆（content/kind），旧值进审计；
 * - forget：物理删除不当记忆，被删内容进审计。
 * 全部 writeAdminAudit 留痕；token 只在请求体。
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { requireAdmin, stQuery } from "./terminal";
import { writeAdminAudit, adminDisplayName } from "./adminAnalytics";

const tokenInput = z.object({ token: z.string().trim().min(1) });

export const memoryRouter = createRouter({
  /** 记忆列表：可按 agentCode / actor 过滤，最新在前 */
  list: publicQuery
    .input(
      tokenInput.extend({
        agentCode: z.string().trim().max(32).optional(),
        actor: z.string().trim().max(64).optional(),
      }),
    )
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      const rows = await stQuery(
        sql`SELECT id, agent_code, actor, kind, content, source, created_at, updated_at
            FROM st_agent_memories
            WHERE 1=1
            ${input.agentCode ? sql`AND agent_code = ${input.agentCode}` : sql``}
            ${input.actor ? sql`AND actor = ${input.actor}` : sql``}
            ORDER BY updated_at DESC LIMIT 500`,
      );
      return {
        items: rows.map((r) => ({
          id: Number(r.id),
          agentCode: String(r.agent_code),
          actor: String(r.actor),
          kind: String(r.kind),
          content: String(r.content),
          source: String(r.source),
          createdAt: r.created_at ? new Date(String(r.created_at)) : null,
          updatedAt: r.updated_at ? new Date(String(r.updated_at)) : null,
        })),
      };
    }),

  /** 纠正记忆：改 content（必填）/kind（可选），旧值留审计 */
  correct: publicQuery
    .input(
      tokenInput.extend({
        id: z.number().int().positive(),
        content: z.string().trim().min(4, "记忆内容至少 4 字").max(255),
        kind: z.enum(["preference", "fact", "note"]).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const admin = await requireAdmin(input.token);
      const rows = await stQuery(
        sql`SELECT id, agent_code, actor, kind, content FROM st_agent_memories WHERE id = ${input.id} LIMIT 1`,
      );
      const old = rows[0];
      if (!old) throw new TRPCError({ code: "NOT_FOUND", message: "记忆不存在" });
      await getDb().execute(
        sql`UPDATE st_agent_memories SET content = ${input.content}
            ${input.kind ? sql`, kind = ${input.kind}` : sql``}
            WHERE id = ${input.id}`,
      );
      writeAdminAudit(Number(admin.id), adminDisplayName(admin), "memory.correct", String(input.id), {
        agentCode: String(old.agent_code),
        actor: String(old.actor),
        oldContent: String(old.content),
        newContent: input.content,
        oldKind: String(old.kind),
        newKind: input.kind ?? String(old.kind),
      });
      return { ok: true as const };
    }),

  /** 遗忘记忆：物理删除，被删内容留审计 */
  forget: publicQuery
    .input(tokenInput.extend({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const admin = await requireAdmin(input.token);
      const rows = await stQuery(
        sql`SELECT id, agent_code, actor, content FROM st_agent_memories WHERE id = ${input.id} LIMIT 1`,
      );
      const old = rows[0];
      if (!old) throw new TRPCError({ code: "NOT_FOUND", message: "记忆不存在" });
      await getDb().execute(sql`DELETE FROM st_agent_memories WHERE id = ${input.id}`);
      writeAdminAudit(Number(admin.id), adminDisplayName(admin), "memory.forget", String(input.id), {
        agentCode: String(old.agent_code),
        actor: String(old.actor),
        deletedContent: String(old.content),
      });
      return { ok: true as const };
    }),
});
