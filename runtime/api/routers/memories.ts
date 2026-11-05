import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { agentMemories, agents } from "@db/schema";

export const memoriesRouter = createRouter({
  /** Agent 工作记忆（可检索：keyword 过滤） */
  list: publicQuery
    .input(
      z.object({
        agentId: z.number().int().positive(),
        keyword: z.string().trim().max(64).optional(),
        limit: z.number().int().min(1).max(100).default(30),
      }),
    )
    .query(async ({ input }) => {
      const db = getDb();
      let rows = await db
        .select()
        .from(agentMemories)
        .where(eq(agentMemories.agentId, input.agentId))
        .orderBy(desc(agentMemories.createdAt))
        .limit(input.keyword ? 200 : input.limit);
      if (input.keyword) {
        rows = rows.filter((r) => r.summary.includes(input.keyword!)).slice(0, input.limit);
      }
      const [agent] = await db
        .select({ memoryCount: agents.memoryCount })
        .from(agents)
        .where(eq(agents.id, input.agentId))
        .limit(1);
      return { total: agent?.memoryCount ?? rows.length, items: rows };
    }),
});
