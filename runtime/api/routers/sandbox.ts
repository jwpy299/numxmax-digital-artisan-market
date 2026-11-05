/**
 * sandbox / agreement —— iter92 企业训练场 + 数据授权协议。
 *
 * 三条铁律：
 * 1. 物理分账：只写 st_sandbox_tasks / st_sandbox_skills，龙虾副作用绝不进正式 st_claw_operations；
 * 2. 毕业闸门：技能 ≥10 任务且通过率 ≥95% 才能 graduate 回正式军团（duty 追加「｜特训:skill_key」）；
 * 3. 成本闸：dispatch 前置链 = 协议已签 → 套餐 active → 本厂 LLM 日用量 < llm_daily_limit → corps 已 deployed。
 *
 * LLM 真答复复用 modelGateway flash 槽（callSlotChat）；判分复刻 ops/corps-train.py 的 judge
 * （技能关键词 2-gram 命中 + 长度，≥60 分 pass）。
 *
 * 契约：
 * - sandbox.overview {token} → {agreementSigned, llmUsed, llmLimit, skills:[{skillKey,title,taskCount,passCount,passRate,graduated}], todayTasks}
 * - sandbox.dispatch {token, instruction, skillKey, memberKey?} → {reply, score, pass}
 * - sandbox.graduate {token, skillKey} → 毕业 + 挂载 + st_claw_operations 审计行（l2_tenant/done/wb:用户）
 * - agreement.current {token} → {version:'v1', signed, signedAt}
 * - agreement.sign {token, version} → 幂等签署（signed_by=wb 用户名，记录 ip）
 */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { stQuery } from "./terminal";
import { sessionMe } from "./wbSession";
import { requireWbHead } from "./claw";
import { emitSignal } from "./autoEngine";
import {
  assertFactoryPlanActive,
  factoryLlmUsedToday,
} from "./billing";
import { runSandboxDispatchCore } from "./sandboxCore";
import { getFactoryGateMode, submitIntent } from "./gate";

/** 数据授权协议当前版本 */
export const AGREEMENT_VERSION = "v1";

const PASS_SCORE = 60;
const MIN_REPLY_LEN = 80;

/** 判分（复刻 ops/corps-train.py judge）：关键词 2-gram 命中 + 长度合理，≥60 pass */
export function judgeSandboxReply(hint: string, reply: string | null | undefined): { score: number; pass: boolean } {
  if (!reply) return { score: 0, pass: false };
  const length = reply.length;
  if (length < MIN_REPLY_LEN) return { score: Math.min(40, length), pass: false };
  let score = 50;
  const grams = new Set<string>();
  if (hint.length >= 2) {
    for (let i = 0; i < hint.length - 1; i++) grams.add(hint.slice(i, i + 2));
  } else if (hint.length > 0) {
    grams.add(hint);
  }
  let hits = 0;
  for (const g of grams) if (g && reply.includes(g)) hits += 1;
  score += Math.min(40, hits * 10);
  if (length >= 200) score += 10;
  score = Math.min(100, score);
  return { score, pass: score >= PASS_SCORE };
}

/** 从 ctx 提取客户端 IP（structural，拿不到为空串） */
function clientIpOf(ctx: unknown): string {
  const ip = (ctx as { clientIp?: unknown }).clientIp;
  return typeof ip === "string" ? ip : "";
}

/** 本厂协议签署状态（version=AGREEMENT_VERSION） */
async function agreementRow(factoryId: number) {
  const rows = await stQuery(
    sql`SELECT signed_by AS signedBy, signed_at AS signedAt
        FROM st_data_agreements WHERE factory_id = ${factoryId} AND version = ${AGREEMENT_VERSION} LIMIT 1`,
  );
  return rows[0] ?? null;
}

export const sandboxRouter = createRouter({
  /** sandbox.overview（query, wb）：协议状态 + LLM 用量/限额 + 技能进度 + 今日任务数 */
  overview: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const { factory } = await sessionMe(input.token);
      const fid = factory.id;
      const ag = await agreementRow(fid);
      const planRows = await stQuery(
        sql`SELECT llm_daily_limit AS llmDailyLimit FROM st_factory_plan WHERE factory_id = ${fid} LIMIT 1`,
      );
      const llmLimit = planRows[0] ? Number(planRows[0].llmDailyLimit) : 0;
      const llmUsed = await factoryLlmUsedToday(fid);
      const skills = await stQuery(
        sql`SELECT skill_key AS skillKey, title, task_count AS taskCount, pass_count AS passCount,
                   graduated, graduated_at AS graduatedAt
            FROM st_sandbox_skills WHERE factory_id = ${fid} ORDER BY id ASC LIMIT 100`,
      );
      const today = await stQuery(
        sql`SELECT COUNT(*) AS c FROM st_sandbox_tasks
            WHERE factory_id = ${fid} AND DATE(created_at) = CURDATE()`,
      );
      return {
        agreementSigned: !!ag,
        llmUsed,
        llmLimit,
        skills: skills.map((s) => {
          const taskCount = Number(s.taskCount);
          const passCount = Number(s.passCount);
          return {
            skillKey: String(s.skillKey),
            title: String(s.title),
            taskCount,
            passCount,
            passRate: taskCount > 0 ? Math.round((passCount / taskCount) * 10000) / 100 : 0,
            graduated: Number(s.graduated) === 1,
          };
        }),
        todayTasks: Number(today[0]?.c ?? 0),
      };
    }),

  /** sandbox.dispatch（mutation, wb）：前置链 → LLM 真答 → 判分 → 计数（物理分账，只写 sandbox 表） */
  dispatch: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      instruction: z.string().trim().min(2).max(1000),
      skillKey: z.string().trim().min(1).max(64),
      memberKey: z.string().trim().min(1).max(64).optional(),
    }))
    .mutation(async ({ input }) => {
      const { user, factory } = await sessionMe(input.token);
      const fid = factory.id;
      // 前置链①：数据授权协议已签（硬前置）
      const ag = await agreementRow(fid);
      if (!ag) {
        throw new TRPCError({ code: "FORBIDDEN", message: "请先签署数据授权协议（agreement.sign），再使用企业训练场" });
      }
      // 前置链②：套餐 active 且未过期（欠费降权）
      const plan = await assertFactoryPlanActive(fid);
      // 前置链③：本厂 LLM 日用量 < llm_daily_limit（成本闸）
      const llmUsed = await factoryLlmUsedToday(fid);
      if (llmUsed >= plan.llmDailyLimit) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `本厂 LLM 日用量已达上限（${llmUsed}/${plan.llmDailyLimit}），明日恢复或联系平台升级套餐`,
        });
      }
      // 前置链④：corps 已 deployed
      const corps = await stQuery(
        sql`SELECT id, status FROM st_corps WHERE factory_id = ${fid} LIMIT 1`,
      );
      if (!corps[0] || String(corps[0].status) !== "deployed") {
        throw new TRPCError({ code: "FORBIDDEN", message: "本厂军团尚未驻场（deployed），请先完成军团训练毕业" });
      }
      const corpsId = Number(corps[0].id);
      // iter100 双跑开关：mode=gate → 走组织中枢「意图-票据」链路（同一执行核心，协议 sandbox_dispatch）
      if ((await getFactoryGateMode(fid)) === "gate") {
        const res = await submitIntent({
          actor: { username: String(user.username), role: String(user.role), factoryId: fid },
          actionType: "sandbox_dispatch",
          payload: { instruction: input.instruction, skillKey: input.skillKey, memberKey: input.memberKey ?? null },
          reason: "训练场派单（gate 模式）",
        });
        const out = res.result as { reply: string; score: number; pass: boolean };
        return { reply: out.reply, score: out.score, pass: out.pass };
      }
      // legacy 直执链路（默认）：同一执行核心，行为不变
      const res = await runSandboxDispatchCore(fid, corpsId, plan.llmDailyLimit, {
        instruction: input.instruction,
        skillKey: input.skillKey,
        memberKey: input.memberKey,
      });
      return { reply: res.reply, score: res.score, pass: res.pass };
    }),

  /** sandbox.graduate（mutation, wb owner）：≥10 任务且 passRate≥95% → 毕业 + 挂载正式军团 + 审计行 */
  graduate: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      skillKey: z.string().trim().min(1).max(64),
    }))
    .mutation(async ({ input }) => {
      const { user, factory } = await requireWbHead(input.token);
      const fid = factory.id;
      const rows = await stQuery(
        sql`SELECT id, title, task_count AS taskCount, pass_count AS passCount, graduated
            FROM st_sandbox_skills WHERE factory_id = ${fid} AND skill_key = ${input.skillKey} LIMIT 1`,
      );
      const sk = rows[0];
      if (!sk) throw new TRPCError({ code: "NOT_FOUND", message: `技能 ${input.skillKey} 在训练场无记录` });
      const taskCount = Number(sk.taskCount);
      const passCount = Number(sk.passCount);
      const passRate = taskCount > 0 ? Math.round((passCount / taskCount) * 10000) / 100 : 0;
      // 毕业闸门：≥10 任务且通过率 ≥95%
      if (taskCount < 10 || passRate < 95) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `未达毕业线：需 ≥10 任务且通过率 ≥95%（当前 ${taskCount} 任务 / 通过率 ${passRate}%）`,
        });
      }
      if (Number(sk.graduated) === 1) {
        return { ok: true as const, skillKey: input.skillKey, taskCount, passRate, graduated: true, alreadyGraduated: true as const, mountedMembers: 0 };
      }
      await stQuery(
        sql`UPDATE st_sandbox_skills SET graduated = 1, graduated_at = NOW() WHERE id = ${Number(sk.id)}`,
      );
      // 挂载：本厂全部 enabled 的 role='ex' 成员 duty 追加「｜特训:skill_key」（防重复追加）
      const targets = await stQuery(
        sql`SELECT COUNT(*) AS c FROM st_panda_members
            WHERE factory_id = ${fid} AND role = 'ex' AND enabled = 1
              AND (duty IS NULL OR duty NOT LIKE ${`%｜特训:${input.skillKey}%`})`,
      );
      const mountTag = `｜特训:${input.skillKey}`;
      await stQuery(
        sql`UPDATE st_panda_members
            SET duty = CONCAT(IFNULL(duty, ''), ${mountTag})
            WHERE factory_id = ${fid} AND role = 'ex' AND enabled = 1
              AND (duty IS NULL OR duty NOT LIKE ${`%${mountTag}%`})`,
      );
      // 审计行（毕业挂正式军团属租户级操作，留痕 st_claw_operations，与 sandbox 任务物理分账不冲突）
      const opNo = `SB${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      await stQuery(
        sql`INSERT INTO st_claw_operations
              (op_no, instance_key, actor, task, risk, approval_level, status, approved_by, approved_at, factory_id, finished_at)
            VALUES (${opNo}, 'main', ${`wb:${user.username}`}, ${`sandbox-graduate:${input.skillKey}`},
                    'low', 'l2_tenant', 'done', ${`wb:${user.username}`}, NOW(), ${fid}, NOW())`,
      );
      // iter96 信号接入点：特训技能毕业 → A 级只读信号（引擎自动归档摘要）
      await emitSignal(
        fid,
        "training",
        "A",
        `特训技能 ${input.skillKey} 毕业`,
        `技能 ${input.skillKey} 在训练场毕业（${taskCount} 任务 / 通过率 ${passRate}%），已挂载正式军团（${Number(targets[0]?.c ?? 0)} 名成员）。`,
      );
      return {
        ok: true as const,
        skillKey: input.skillKey,
        taskCount,
        passRate,
        graduated: true,
        alreadyGraduated: false as const,
        mountedMembers: Number(targets[0]?.c ?? 0),
      };
    }),
});

export const agreementRouter = createRouter({
  /** agreement.current（query, wb）：当前协议版本签署状态 */
  current: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const { factory } = await sessionMe(input.token);
      const ag = await agreementRow(factory.id);
      return {
        version: AGREEMENT_VERSION,
        signed: !!ag,
        signedAt: ag?.signedAt ? String(ag.signedAt) : null,
      };
    }),

  /** agreement.sign（mutation, wb）：幂等签署（UNIQUE(factory_id, version)，重复签署直接返回已有记录） */
  sign: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      version: z.string().trim().min(1).max(16),
    }))
    .mutation(async ({ input, ctx }) => {
      const { user, factory } = await sessionMe(input.token);
      const ip = clientIpOf(ctx) || null;
      await stQuery(
        sql`INSERT IGNORE INTO st_data_agreements (factory_id, version, signed_by, ip)
            VALUES (${factory.id}, ${input.version}, ${`wb:${user.username}`}, ${ip})`,
      );
      const rows = await stQuery(
        sql`SELECT signed_at AS signedAt FROM st_data_agreements
            WHERE factory_id = ${factory.id} AND version = ${input.version} LIMIT 1`,
      );
      return {
        ok: true as const,
        version: input.version,
        signed: true as const,
        signedAt: rows[0]?.signedAt ? String(rows[0].signedAt) : null,
      };
    }),
});
