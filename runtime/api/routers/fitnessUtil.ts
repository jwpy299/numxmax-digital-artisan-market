/**
 * fitnessUtil —— iter96 技能适应度回写工具（api/lib 禁改，故放 routers 目录）。
 *
 * recordFitness(factoryId, skillKey, success)：upsert st_skill_fitness
 *   uses+1，success 时 successes+1，last_at=NOW()。任何异常吞掉，绝不阻断主链路。
 * recordFeedback(factoryId, skillKey, up)：thumbs_up / thumbs_down +1。
 * getFactoryFitness(factoryId)：本厂适应度榜（含成功率 successRate = successes/uses*100）。
 */
import { sql } from "drizzle-orm";
import { stQuery } from "./terminal";

/** 技能使用结果回写：uses+1 / successes+1 / last_at=NOW()（upsert，永不 throw） */
export async function recordFitness(
  factoryId: number,
  skillKey: string,
  success: boolean,
): Promise<void> {
  try {
    const key = skillKey.slice(0, 64);
    await stQuery(
      sql`INSERT INTO st_skill_fitness (factory_id, skill_key, uses, successes, last_at)
          VALUES (${factoryId}, ${key}, 1, ${success ? 1 : 0}, NOW())
          ON DUPLICATE KEY UPDATE uses = uses + 1,
                                  successes = successes + VALUES(successes),
                                  last_at = NOW()`,
    );
  } catch (e) {
    console.error(
      "[fitness] st_skill_fitness 写入失败:",
      e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
    );
  }
}

/** 人工反馈回写：thumbs_up / thumbs_down +1（upsert，永不 throw） */
export async function recordFeedback(
  factoryId: number,
  skillKey: string,
  up: boolean,
): Promise<void> {
  try {
    const key = skillKey.slice(0, 64);
    await stQuery(
      sql`INSERT INTO st_skill_fitness (factory_id, skill_key, thumbs_up, thumbs_down, last_at)
          VALUES (${factoryId}, ${key}, ${up ? 1 : 0}, ${up ? 0 : 1}, NOW())
          ON DUPLICATE KEY UPDATE thumbs_up = thumbs_up + VALUES(thumbs_up),
                                  thumbs_down = thumbs_down + VALUES(thumbs_down),
                                  last_at = NOW()`,
    );
  } catch (e) {
    console.error(
      "[fitness] st_skill_fitness 反馈写入失败:",
      e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
    );
  }
}

export interface SkillFitnessRow {
  skillKey: string;
  uses: number;
  successes: number;
  thumbsUp: number;
  thumbsDown: number;
  /** 成功率 %（0 次使用 = 0） */
  successRate: number;
  lastAt: string | null;
}

/** 本厂技能适应度榜（按 uses 降序，含成功率） */
export async function getFactoryFitness(factoryId: number): Promise<SkillFitnessRow[]> {
  const rows = await stQuery(
    sql`SELECT skill_key AS skillKey, uses, successes,
               thumbs_up AS thumbsUp, thumbs_down AS thumbsDown, last_at AS lastAt
        FROM st_skill_fitness WHERE factory_id = ${factoryId}
        ORDER BY uses DESC, successes DESC LIMIT 200`,
  );
  return rows.map((r) => {
    const uses = Number(r.uses);
    const successes = Number(r.successes);
    return {
      skillKey: String(r.skillKey),
      uses,
      successes,
      thumbsUp: Number(r.thumbsUp),
      thumbsDown: Number(r.thumbsDown),
      successRate: uses > 0 ? Math.round((successes / uses) * 10000) / 100 : 0,
      lastAt: r.lastAt === null || r.lastAt === undefined ? null : String(r.lastAt),
    };
  });
}
