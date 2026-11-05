/**
 * dagRuns —— M33 Agent DAG 任务编排运行时（Harness 运行装配线 P0-①）。
 *
 * 一张任务图：老板一句话目标 → orggen 槽（DeepSeek V4 Pro 结构化）拆成 2-6 步、
 * 每步绑定在役驻部智能体 → 确认创建 → 异步执行器逐步跑 agentBridge 管线 →
 * 每步产出落 steps JSON（含 artifactIds）→ 失败步骤可 retry 续跑。
 *
 * 纪律：
 * - 长任务标准模式（iter47 实证）：run 立即返回 + 客户端轮询 detail，绝不同步长等；
 * - 智能体绑定白名单：创建时 agentCode 必须 ∈ 在役花名册（listVoiceAgentRoster 同源）；
 * - 惰性恢复：running 但 updatedAt 超 5 分钟 → 读侧标 failed（进程重启不断片）；
 * - 企业强隔离：一切读写带 factoryId；创建须 admin/manager（与开房同口径）；
 * - 步骤执行复用 M28 runWorkbenchAgentTask（技能/记忆/数据摘要全继承）。
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { sessionMe, normalizeRole } from "./wbSession";
import { stQuery } from "./terminal";
import { listVoiceAgentRoster, runWorkbenchAgentTask } from "./agentBridge";
import { parseDbUtc } from "./dbTime";
import { callSlotChat } from "./modelGateway";

const tokenInput = z.object({ token: z.string().trim().min(1) });

/** running 停滞判定：5 分钟无更新视为断片 */
const STALE_RUNNING_MS = 5 * 60_000;

/**
 * DB 时间戳解析（UTC 口径）：时区修复后库内 TIMESTAMP 为 UTC 墙钟，
 * 直接 new Date("YYYY-MM-DD HH:mm:ss") 会被 Node 按本地时区(CST)解释 → 偏 8 小时。
 * 统一补 'T…Z' 按 UTC 解析。（同坑第三变身：迁移时区修复后读侧解析口径）
 */

export interface DagStep {
  key: string;
  title: string;
  agentCode: string;
  agentName?: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  result?: string;
  artifactIds?: number[];
  error?: string;
}

interface DagRunRow {
  id: number;
  factoryId: number;
  goal: string;
  steps: string | DagStep[];
  status: string;
  /** M34b：运行时双轨——bridge=现有 agentBridge 管线；dsh=DSH 底座试点 lane */
  runtime: string;
  createdBy: number;
  createdAt: unknown;
  updatedAt: unknown;
  finishedAt: unknown;
}

function parseSteps(raw: unknown): DagStep[] {
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(v)) return [];
    return v.map((s) => ({
      key: String(s.key),
      title: String(s.title),
      agentCode: String(s.agentCode),
      agentName: s.agentName == null ? undefined : String(s.agentName),
      status: (["pending", "running", "done", "failed", "skipped"].includes(String(s.status))
        ? String(s.status)
        : "pending") as DagStep["status"],
      result: s.result == null ? undefined : String(s.result),
      artifactIds: Array.isArray(s.artifactIds) ? s.artifactIds.map(Number) : undefined,
      error: s.error == null ? undefined : String(s.error),
    }));
  } catch {
    return [];
  }
}

async function loadRun(id: number, factoryId: number): Promise<DagRunRow> {
  const rows = await stQuery(
    sql`SELECT id, factoryId, goal, steps, status, runtime, createdBy, createdAt, updatedAt, finishedAt
        FROM st_dag_runs WHERE id = ${id} AND factoryId = ${factoryId} LIMIT 1`,
  );
  const r = rows[0];
  if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "任务图不存在" });
  return {
    id: Number(r.id),
    factoryId: Number(r.factoryId),
    goal: String(r.goal),
    steps: r.steps as string,
    status: String(r.status),
    runtime: String(r.runtime ?? "bridge"),
    createdBy: Number(r.createdBy),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    finishedAt: r.finishedAt,
  };
}

/** 惰性恢复：running 且停滞 → failed（写回一次） */
async function lazyRecover(run: DagRunRow): Promise<DagRunRow> {
  if (run.status !== "running") return run;
  const updated = parseDbUtc(run.updatedAt);
  if (Number.isFinite(updated) && Date.now() - updated > STALE_RUNNING_MS) {
    const steps = parseSteps(run.steps).map((s) => (s.status === "running" ? { ...s, status: "failed" as const, error: "执行中断（进程重启）" } : s));
    await getDb().execute(
      sql`UPDATE st_dag_runs SET status = 'failed', steps = ${JSON.stringify(steps)} WHERE id = ${run.id}`,
    );
    return { ...run, status: "failed", steps };
  }
  return run;
}

async function saveSteps(id: number, factoryId: number, steps: DagStep[], status?: string): Promise<void> {
  await getDb().execute(
    sql`UPDATE st_dag_runs SET steps = ${JSON.stringify(steps)}
        ${status ? sql`, status = ${status}` : sql``}
        ${status === "done" || status === "failed" ? sql`, finishedAt = UTC_TIMESTAMP()` : sql``}
        WHERE id = ${id} AND factoryId = ${factoryId}`,
  );
}

/** 心跳：长步骤执行期间每 60s 刷新 updatedAt，防惰性恢复误伤在跑的图 */
async function touchRun(id: number, factoryId: number): Promise<void> {
  await getDb()
    .execute(sql`UPDATE st_dag_runs SET updatedAt = UTC_TIMESTAMP() WHERE id = ${id} AND factoryId = ${factoryId}`)
    .catch(() => undefined);
}

/** DSH 底座调用（试点 lane）：经本机 18795（dsh-sandbox-runtime 本机 runtime）；token 仅 env DSH_SERVICE_TOKEN */
/** callDsh 已抽到 ./dshClient（agentBridge/dagRuns 共用，防循环依赖）；此处转出口径不变 */
import { callDsh } from "./dshClient";

/** 进程内异步执行器：逐步跑，每步落库；任一步失败则后续 skipped，图 failed。 */
async function executeRun(id: number, factoryId: number, username: string): Promise<void> {
  const run = await loadRun(id, factoryId);
  const useDsh = run.runtime === "dsh";
  const steps = parseSteps(run.steps);
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (step.status !== "pending") continue;
    step.status = "running";
    await saveSteps(id, factoryId, steps);
    const keepalive = setInterval(() => void touchRun(id, factoryId), 60_000);
    keepalive.unref?.();
    try {
      const taskText = `任务图「${run.goal}」第 ${i + 1} 步「${step.title}」：请完成这一步并给出结论。`;
      if (useDsh) {
        const r = await callDsh(`${taskText}（执行智能体：${step.agentName ?? step.agentCode}）`, 300, factoryId);
        if (!r.ok) throw new Error(r.error ?? "dsh_failed");
        step.status = "done";
        step.result = `[DSH] ${String(r.answer ?? "").slice(0, 480)}`;
      } else {
        const r = await runWorkbenchAgentTask({ agentCode: step.agentCode, task: taskText, username });
        if (!r) throw new Error("智能体未启用");
        step.status = "done";
        step.result = r.reply.slice(0, 500);
        if (r.artifacts.length > 0) step.artifactIds = r.artifacts.map((a) => a.id).filter((x): x is number => x !== null); // null id 滤除（ack 缺 insertId=持久化未知 id 不伪造不传播——ArtifactInfo.id null 化契约，门禁钉）
      }
    } catch (e) {
      step.status = "failed";
      step.error = (e instanceof Error ? e.message : "执行失败").slice(0, 200);
      for (let j = i + 1; j < steps.length; j++) {
        if (steps[j]!.status === "pending") steps[j]!.status = "skipped";
      }
      await saveSteps(id, factoryId, steps, "failed");
      return;
    } finally {
      clearInterval(keepalive);
    }
    await saveSteps(id, factoryId, steps);
  }
  await saveSteps(id, factoryId, steps, "done");
}

/** 执行器登记表：防同一图并发双跑 */
const inflight = new Set<number>();

async function kickExecution(id: number, factoryId: number, username: string): Promise<void> {
  if (inflight.has(id)) return;
  inflight.add(id);
  void executeRun(id, factoryId, username)
    .catch(() => undefined)
    .finally(() => inflight.delete(id));
}

export const dagRunsRouter = createRouter({
  /**
   * plan（mutation，admin/manager）：目标拆步草稿（不写库）。
   * orggen 槽结构化拆解；LLM 不可用 → 确定性单步兜底（绝不放空）。
   */
  plan: publicQuery
    .input(tokenInput.extend({ goal: z.string().trim().min(4).max(500) }))
    .mutation(async ({ input }) => {
      await sessionMe(input.token); // 登录态校验（factory 未用，DAG 归属在执行期按企业隔离）
      const role = await roleOf(input.token);
      if (role === "staff") throw new TRPCError({ code: "FORBIDDEN", message: "建任务图需要负责人或管理员权限" });
      const roster = await listVoiceAgentRoster();
      if (roster.length === 0) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "没有在役智能体可编排" });

      const rosterText = roster.map((a) => `- ${a.code}：${a.name}（${a.title}，部门 ${a.deptCode}）`).join("\n");
      const r = await callSlotChat("orggen", {
        messages: [
          {
            role: "system",
            content:
              `你是任务图拆解器。把企业目标拆成 2-6 个有序步骤，每步指派一位在役驻部智能体。` +
              `智能体花名册（只能用册内 code）：\n${rosterText}\n` +
              `输出严格 JSON 数组：[{"key":"s1","title":"步骤名（≤20字）","agentCode":"花名册code"}]，不输出任何其他文字。`,
          },
          { role: "user", content: input.goal },
        ],
        maxTokens: 800,
        temperature: 0.2,
        timeoutMs: 45_000,
      });
      let steps: DagStep[] = [];
      if (r.ok && r.content) {
        try {
          const m = /\[[\s\S]*\]/.exec(r.content);
          const arr = JSON.parse(m ? m[0] : r.content) as unknown[];
          steps = arr
            .filter((x) => x && typeof x === "object")
            .slice(0, 6)
            .map((x, i) => {
              const o = x as Record<string, unknown>;
              return {
                key: typeof o.key === "string" ? o.key : `s${i + 1}`,
                title: String(o.title ?? `步骤 ${i + 1}`).slice(0, 60),
                agentCode: String(o.agentCode ?? ""),
                status: "pending" as const,
              };
            })
            .filter((s) => roster.some((a) => a.code === s.agentCode));
        } catch {
          steps = [];
        }
      }
      if (steps.length === 0) {
        // 兜底：单步给花名册首位（绝不放空目标）
        steps = [{ key: "s1", title: input.goal.slice(0, 60), agentCode: roster[0]!.code, status: "pending" }];
      }
      return {
        goal: input.goal,
        steps,
        roster: roster.map((a) => ({ code: a.code, name: a.name, title: a.title })),
      };
    }),

  /** create（mutation）：确认创建任务图（draft → ready 落库）。 */
  create: publicQuery
    .input(
      tokenInput.extend({
        goal: z.string().trim().min(4).max(500),
        steps: z
          .array(
            z.object({
              key: z.string().trim().min(1).max(32),
              title: z.string().trim().min(1).max(60),
              agentCode: z.string().trim().min(1).max(32),
            }),
          )
          .min(1)
          .max(6),
        runtime: z.enum(["bridge", "dsh"]).default("dsh"),
      }),
    )
    .mutation(async ({ input }) => {
      const { user, factory } = await sessionMe(input.token);
      const role = await roleOf(input.token);
      if (role === "staff") throw new TRPCError({ code: "FORBIDDEN", message: "建任务图需要负责人或管理员权限" });
      const roster = await listVoiceAgentRoster();
      for (const s of input.steps) {
        if (!roster.some((a) => a.code === s.agentCode)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: `智能体 ${s.agentCode} 不在在役花名册` });
        }
      }
      const steps: DagStep[] = input.steps.map((s) => ({
        key: s.key,
        title: s.title,
        agentCode: s.agentCode,
        agentName: roster.find((a) => a.code === s.agentCode)?.name,
        status: "pending" as const,
      }));
      const res = (await getDb().execute(
        sql`INSERT INTO st_dag_runs (factoryId, goal, steps, status, runtime, createdBy)
            VALUES (${factory.id}, ${input.goal}, ${JSON.stringify(steps)}, 'ready', ${input.runtime}, ${user.id})`,
      )) as unknown;
      const header = Array.isArray(res) ? (res[0] as { insertId?: number }) : {};
      return { ok: true as const, id: Number(header?.insertId ?? 0) };
    }),

  /** run（mutation）：启动执行（立即返回；执行器异步逐步跑，客户端轮询 detail）。 */
  run: publicQuery
    .input(tokenInput.extend({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const { user, factory } = await sessionMe(input.token);
      const run = await loadRun(input.id, factory.id);
      if (run.status === "running") return { ok: true as const, id: run.id, status: "running" as const };
      if (run.status === "done") return { ok: true as const, id: run.id, status: "done" as const };
      // ready/failed 均可（重）跑：failed 重跑时把 failed/skipped 复位 pending（retry 语义见 retry）
      const steps = parseSteps(run.steps).map((s) =>
        run.status === "failed" && (s.status === "failed" || s.status === "skipped")
          ? { ...s, status: "pending" as const, error: undefined }
          : s,
      );
      await getDb().execute(
        sql`UPDATE st_dag_runs SET status = 'running', steps = ${JSON.stringify(steps)}, finishedAt = NULL
            WHERE id = ${run.id} AND factoryId = ${factory.id}`,
      );
      await kickExecution(run.id, factory.id, String(user.username));
      return { ok: true as const, id: run.id, status: "running" as const };
    }),

  /** detail（query）：图详情（惰性恢复断片 running）。 */
  detail: publicQuery
    .input(tokenInput.extend({ id: z.number().int().positive() }))
    .query(async ({ input }) => {
      const { factory } = await sessionMe(input.token);
      const run = await lazyRecover(await loadRun(input.id, factory.id));
      return {
        id: run.id,
        goal: run.goal,
        status: run.status,
        runtime: run.runtime,
        steps: parseSteps(run.steps),
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        finishedAt: run.finishedAt,
      };
    }),

  /** list（query）：本企业任务图（新→旧，≤30）。 */
  list: publicQuery.input(tokenInput).query(async ({ input }) => {
    const { factory } = await sessionMe(input.token);
    const rows = await stQuery(
      sql`SELECT r.id, r.goal, r.status, r.createdAt, r.updatedAt, r.finishedAt,
                 COALESCE(u.displayName, u.username, '') AS creatorName
          FROM st_dag_runs r LEFT JOIN wb_users u ON u.id = r.createdBy
          WHERE r.factoryId = ${factory.id} ORDER BY r.id DESC LIMIT 30`,
    );
    return {
      runs: rows.map((r) => ({
        id: Number(r.id),
        goal: String(r.goal),
        status: String(r.status),
        creatorName: String(r.creatorName ?? ""),
        createdAt: r.createdAt,
        finishedAt: r.finishedAt,
      })),
    };
  }),

  /** retry（mutation）：重跑指定失败步骤并继续后续（断点续跑）。 */
  retry: publicQuery
    .input(tokenInput.extend({ id: z.number().int().positive(), stepKey: z.string().trim().min(1).max(32) }))
    .mutation(async ({ input }) => {
      const { user, factory } = await sessionMe(input.token);
      const run = await loadRun(input.id, factory.id);
      if (run.status === "running") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "任务图正在执行中" });
      }
      const steps = parseSteps(run.steps);
      const idx = steps.findIndex((s) => s.key === input.stepKey);
      if (idx < 0) throw new TRPCError({ code: "NOT_FOUND", message: "步骤不存在" });
      if (steps[idx]!.status !== "failed") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "只有失败的步骤需要重跑" });
      }
      // 断点续跑：该步及后续 skipped 复位 pending，前序 done 保留
      steps[idx]!.status = "pending";
      steps[idx]!.error = undefined;
      for (let j = idx + 1; j < steps.length; j++) {
        if (steps[j]!.status === "skipped") steps[j]!.status = "pending";
      }
      await getDb().execute(
        sql`UPDATE st_dag_runs SET status = 'running', steps = ${JSON.stringify(steps)}, finishedAt = NULL
            WHERE id = ${run.id} AND factoryId = ${factory.id}`,
      );
      await kickExecution(run.id, factory.id, String(user.username));
      return { ok: true as const, id: run.id, status: "running" as const };
    }),
});

/** admin/manager 判定（sessionMe 角色归一） */
async function roleOf(token: string): Promise<"admin" | "manager" | "staff"> {
  const { user } = await sessionMe(token);
  return normalizeRole(user.role);
}
