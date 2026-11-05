/**
 * sandboxCore —— 沙箱派单执行核心（iter100 抽出，供 legacy 直执链路与
 * 组织中枢「意图-票据」协议 sandbox_dispatch 复用，行为完全一致）。
 *
 * 逆操作（undo）：记录本函数插入的 st_sandbox_tasks 行 id 与技能计数增量，
 * rollback 时删除任务行并回退 st_sandbox_skills 计数（组织中枢 WAL 用）。
 */
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { stQuery } from "./terminal";
import { callSlotChat } from "./modelGateway";
import { sendAlert } from "./alertUtil";
import { recordFitness } from "./fitnessUtil";
import { recordFactoryLlmCall } from "./billing";
import { judgeSandboxReply } from "./sandbox";

export interface SandboxDispatchInput {
  instruction: string;
  skillKey: string;
  memberKey?: string;
}

export interface SandboxDispatchCoreResult {
  reply: string;
  score: number;
  pass: boolean;
  /** WAL 逆操作载荷：任务行 id + 技能计数增量 */
  undo: { taskId: number; skillKey: string; passIncrement: number };
}

/** 派单核心：LLM 真答 → 判分 → 物理分账 → 适应度/成本记账（前置链由调用方完成） */
export async function runSandboxDispatchCore(
  fid: number,
  corpsId: number,
  llmDailyLimit: number,
  input: SandboxDispatchInput,
): Promise<SandboxDispatchCoreResult> {
  // 技能提示词（判分 hint）：优先 st_sandbox_skills.title，缺省 skillKey
  const skRows = await stQuery(
    sql`SELECT title FROM st_sandbox_skills WHERE factory_id = ${fid} AND skill_key = ${input.skillKey} LIMIT 1`,
  );
  const hint = skRows[0] ? String(skRows[0].title) : input.skillKey;
  // LLM 真答复（modelGateway flash 槽，失败自动沿槽位降级链）
  const r = await callSlotChat("flash", {
    messages: [
      {
        role: "system",
        content: "你是企业熊猫军团的数字员工，围绕指定技能给出专业、具体、可执行的中文答复（120-300字）。",
      },
      { role: "user", content: `【技能特训·${hint}】${input.instruction}` },
    ],
    maxTokens: 800,
    timeoutMs: 60_000,
  });
  if (!r.ok || !r.content) {
    // LLM 失败：留 failed 任务行 + 告警到人，绝不静默
    await stQuery(
      sql`INSERT INTO st_sandbox_tasks (factory_id, corps_id, member_key, skill_key, instruction, status)
          VALUES (${fid}, ${corpsId}, ${input.memberKey ?? null}, ${input.skillKey}, ${input.instruction}, 'failed')`,
    );
    await sendAlert("error", "sandbox_llm_failed", {
      factoryId: fid,
      skillKey: input.skillKey,
      reason: r.reason ?? "unknown",
    });
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "训练场 LLM 暂不可用，请稍后重试" });
  }
  const reply = r.content;
  const { score, pass } = judgeSandboxReply(hint, reply);
  // 物理分账：只写 sandbox 表，不进正式 st_claw_operations
  await stQuery(
    sql`INSERT INTO st_sandbox_tasks (factory_id, corps_id, member_key, skill_key, instruction, reply, score, pass, status)
        VALUES (${fid}, ${corpsId}, ${input.memberKey ?? null}, ${input.skillKey}, ${input.instruction},
                ${reply}, ${score}, ${pass ? 1 : 0}, 'done')`,
  );
  const idRows = await stQuery(sql`SELECT LAST_INSERT_ID() AS id`);
  const taskId = Number(idRows[0]?.id ?? 0);
  await stQuery(
    sql`INSERT INTO st_sandbox_skills (factory_id, skill_key, title, task_count, pass_count)
        VALUES (${fid}, ${input.skillKey}, ${hint}, 1, ${pass ? 1 : 0})
        ON DUPLICATE KEY UPDATE task_count = task_count + 1,
                                pass_count = pass_count + VALUES(pass_count)`,
  );
  // iter96 适应度回写：判分完成 → uses+1 / successes+pass
  await recordFitness(fid, input.skillKey, pass);
  // 成本闸记账：本厂 LLM 日用量 +1（含 80%/100% 阈值告警）
  await recordFactoryLlmCall(fid, llmDailyLimit);
  return { reply, score, pass, undo: { taskId, skillKey: input.skillKey, passIncrement: pass ? 1 : 0 } };
}

/** WAL 逆操作：删除本次任务行 + 回退技能计数 */
export async function undoSandboxDispatch(fid: number, undo: SandboxDispatchCoreResult["undo"]): Promise<void> {
  if (undo.taskId > 0) {
    await stQuery(
      sql`DELETE FROM st_sandbox_tasks WHERE id = ${undo.taskId} AND factory_id = ${fid}`,
    );
  }
  await stQuery(
    sql`UPDATE st_sandbox_skills
        SET task_count = GREATEST(0, task_count - 1),
            pass_count = GREATEST(0, pass_count - ${undo.passIncrement})
        WHERE factory_id = ${fid} AND skill_key = ${undo.skillKey}`,
  );
}
