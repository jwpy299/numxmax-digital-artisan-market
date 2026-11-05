/**
 * evoArm —— 执行官施工臂（M58，沙箱演练版）。
 *
 * 定位（彭总拍板的自进化第四条回路）：更新执行官（Kimi K3 内嵌 DSH 之脑）出提案 →
 * 施工臂（开源 Codex harness 壳 + 海禛云统一 API 供脑）在隔离工作区改码 →
 * diff/报告落审计 → verified 登记与 C 级双签仍走 M51 人工闸，AI 永不持扳机。
 *
 * 安全闸（fail-closed，生产默认关）：
 * - EVO_ARM_ENABLED=1 才开放，生产 .env 不配 → 一律 PRECONDITION_FAILED；
 * - 工作区必须落在 EVO_ARM_WORKSPACE（默认 /tmp/evo-arm）且强制 /tmp 前缀——
 *   施工臂永远碰不到生产 checkout 与 artifacts；
 * - git 全程 execFile 参数数组，指令文本只进文件内容/提交信息（stripSecrets + 限长），
 *   绝不拼 shell 串；
 * - 施工对象必须是 st_releases 的 draft 提案——臂不能凭空施工，必须挂在提案流水线上。
 *
 * 执行器双轨：mock（确定性演练，测试/无模型环境用）/ codex（开源 CLI，EVO_ARM_EXECUTOR=codex
 * 且二进制在场才启用，缺席诚实报错 ok:false——绝不静默降级成假成功）。
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { requireHqAdmin } from "./terminal";
import { stripSecrets } from "./voice";

const execFileP = promisify(execFile);
const tokenInput = z.object({ token: z.string().trim().min(1) });

type Row = Record<string, unknown>;

function rowsOf(result: unknown): Row[] {
  const first = Array.isArray(result) ? (result as unknown[])[0] : result;
  return Array.isArray(first) ? (first as Row[]) : [];
}

function armEnabled(): boolean {
  return (process.env.EVO_ARM_ENABLED ?? "").trim() === "1";
}

function workspaceDir(): string {
  const w = (process.env.EVO_ARM_WORKSPACE ?? "/tmp/evo-arm").trim();
  if (!w.startsWith("/tmp/")) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "施工臂工作区必须在 /tmp 下" });
  }
  return w;
}

async function git(ws: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", ["-C", ws, ...args], { timeout: 30_000 });
  return String(stdout ?? "").trim();
}

/**
 * 施工执行进程：spawn + stdio stdin=ignore（codex 遇管道 stdin 会阻塞等输入，真钻实证），
 * 参数数组零 shell 拼接，超时杀进程，非零退出带尾行报错（不吞错）。
 */
function spawnCollect(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`施工执行超时（${Math.round(timeoutMs / 1000)}s）`));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`施工执行退出码 ${code}：${(err || out).trim().slice(-400)}`));
    });
  });
}

export interface ArmRunOutcome {
  ok: boolean;
  executor: "mock" | "codex";
  branch?: string;
  diffStat?: string;
  report?: string;
  error?: string;
}

/**
 * mock 执行器（确定性）：把指令记入工作区 ARM_CHANGELOG.md 并在 arm/rls-<id> 分支提交。
 * 演练证明的是编排与闸门（工作区隔离/分支命名/diff 收集/审计落库），模型施工走 codex 轨。
 */
async function runMockExecutor(ws: string, releaseId: number, instruction: string): Promise<ArmRunOutcome> {
  const branch = `arm/rls-${releaseId}`;
  const cur = await git(ws, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "");
  if (cur !== branch) {
    await git(ws, ["checkout", "-B", branch]);
  }
  const entry =
    `\n## release #${releaseId} · ${new Date().toISOString()}\n` +
    `- 指令：${instruction}\n- 执行器：mock（编排演练，非模型施工）\n`;
  appendFileSync(`${ws}/ARM_CHANGELOG.md`, entry, "utf8");
  await git(ws, ["add", "ARM_CHANGELOG.md"]);
  await git(ws, ["-c", "user.name=evo-arm", "-c", "user.email=evo-arm@sandbox.local",
    "commit", "-m", `arm: release #${releaseId} 施工演练`]);
  const diffStat = await git(ws, ["diff", "--stat", "HEAD~1", "HEAD"]).catch(() => "");
  return {
    ok: true,
    executor: "mock",
    branch,
    diffStat: diffStat || "ARM_CHANGELOG.md 1 entry",
    report: `已在分支 ${branch} 完成编排演练：指令落账、提交、diff 收集全链通过。模型施工请配置 EVO_ARM_EXECUTOR=codex。`,
  };
}

/**
 * codex 执行器：开源 harness 壳，推理端点必须指向海禛云 IDoictOS 统一网关（三端零直连纪律，
 * 与 modelGateway 同一组 env：IDOICTOS_BASE_URL / IDOICTOS_API_KEY；密钥只经 env 注入，绝不落盘回显）。
 * 施工模型默认 kimi-k2.7-code（网关目录代码模型），EVO_ARM_MODEL 可覆盖。
 */
async function runCodexExecutor(ws: string, releaseId: number, instruction: string): Promise<ArmRunOutcome> {
  const bin = (process.env.EVO_ARM_CODEX_BIN ?? "codex").trim();
  const baseUrl = (process.env.IDOICTOS_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const apiKey = (process.env.IDOICTOS_API_KEY ?? "").trim();
  if (!baseUrl || !apiKey) {
    return { ok: false, executor: "codex", error: "codex 轨未配置海禛云统一网关（IDOICTOS_BASE_URL / IDOICTOS_API_KEY）" };
  }
  try {
    await execFileP(bin, ["--version"], { timeout: 15_000 });
  } catch {
    return { ok: false, executor: "codex", error: `codex 二进制不在场（${bin}），先按 DSH 插件仓标准上架施工臂` };
  }
  const model = (process.env.EVO_ARM_MODEL ?? "kimi-k2.7-code").trim();
  const branch = `arm/rls-${releaseId}`;
  await git(ws, ["checkout", "-B", branch]);
  // 只读+本分支写：codex 在隔离工作区内自主施工；沙箱无网闸由外层 bwrap/环境保证。
  // 真钻实证（2026-08-22，codex 0.149.0 + 海禛云网关 + kimi-k2.7-code）：
  // - 0.149.0 已废弃 --full-auto（用 -s workspace-write，写权限仍限定工作区）；
  // - wire_api 只支持 responses（chat 已移除），网关 /v1/responses 实测兼容；
  // - stdin 必须 ignore，否则 codex 阻塞等管道输入。
  // execFile 无 stdio 选项且 stdin 继承会阻塞 codex，故走 spawnCollect（stdio ["ignore","pipe","pipe"]）。
  await spawnCollect(bin, [
    "exec", "-s", "workspace-write", "--skip-git-repo-check",
    "-c", 'model_provider="idoictos"',
    "-c", `model="${model}"`,
    "-c", 'model_providers.idoictos.name="海禛云 IDoictOS 统一网关"',
    "-c", `model_providers.idoictos.base_url="${baseUrl}/v1"`,
    "-c", 'model_providers.idoictos.env_key="IDOICTOS_API_KEY"',
    "-c", 'model_providers.idoictos.wire_api="responses"',
    instruction,
  ], ws, { ...process.env, IDOICTOS_API_KEY: apiKey }, 600_000);
  // codex 新建文件是 untracked，裸 git diff 看不见——先暂存再取 staged diff（不提交，复核权在执行官）
  await git(ws, ["add", "-A"]).catch(() => "");
  const diffStat = await git(ws, ["diff", "--cached", "--stat", "HEAD"]).catch(() => "");
  return {
    ok: true, executor: "codex", branch,
    diffStat: diffStat || "（无 diff——施工臂未改动，需人工复核指令）",
    report: `codex 施工完成（模型 ${model}，海禛云网关供脑），diff 待执行官复核后提 verified 登记。`,
  };
}

/**
 * 施工核心（M69 抽出复用）：draft 校验 → 隔离工作区 → 执行器施工 → 审计落库。
 * 调用方各自负责鉴权与 enabled 闸（evoArm.run 走 requireHqAdmin；
 * Nebula Harness 编排器走 requireAdmin + 自身 fail-closed 检查）——行为与 M58 等价。
 */
export interface ArmConstructInput {
  releaseId: number;
  instruction: string;
  actor: string;
}
export interface ArmConstructResult {
  ok: boolean;
  executor: "mock" | "codex";
  branch: string | null;
  diffStat: string | null;
  report: string | null;
  error: string | null;
}

export function armExecutorKind(): "mock" | "codex" {
  return (process.env.EVO_ARM_EXECUTOR ?? "mock").trim() === "codex" ? "codex" : "mock";
}

export async function armConstruct(input: ArmConstructInput): Promise<ArmConstructResult> {
  const rel = rowsOf(await getDb().execute(sql`SELECT * FROM st_releases WHERE id = ${input.releaseId} LIMIT 1`))[0];
  if (!rel) throw new TRPCError({ code: "NOT_FOUND", message: "版本提案不存在" });
  if (String(rel.status) !== "draft") {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "施工对象必须是 draft 提案（先 propose 再施工）" });
  }
  const instruction = stripSecrets(input.instruction).slice(0, 500);
  const ws = workspaceDir();
  mkdirSync(ws, { recursive: true });
  if (!existsSync(`${ws}/.git`)) {
    await execFileP("git", ["init", "-b", "main", ws], { timeout: 15_000 });
    writeFileSync(`${ws}/ARM_CHANGELOG.md`, "# 施工臂演练台账\n", "utf8");
    await git(ws, ["add", "ARM_CHANGELOG.md"]);
    await git(ws, ["-c", "user.name=evo-arm", "-c", "user.email=evo-arm@sandbox.local",
      "commit", "-m", "init: 施工臂工作区"]);
  }
  const executor = armExecutorKind();
  const outcome = executor === "codex"
    ? await runCodexExecutor(ws, input.releaseId, instruction)
    : await runMockExecutor(ws, input.releaseId, instruction);
  const actor = stripSecrets(input.actor).slice(0, 64) || "unknown";
  await getDb().execute(sql`
    INSERT INTO st_release_audit (release_id, channel, actor, action, detail)
    VALUES (${input.releaseId}, ${String(rel.channel)}, ${actor}, 'arm:run',
      ${stripSecrets(JSON.stringify({
        executor: outcome.executor, ok: outcome.ok, branch: outcome.branch ?? null,
        diffStat: (outcome.diffStat ?? "").slice(0, 300),
        report: (outcome.report ?? outcome.error ?? "").slice(0, 600),
      })).slice(0, 2000)})`);
  return {
    ok: outcome.ok,
    executor: outcome.executor,
    branch: outcome.branch ?? null,
    diffStat: outcome.diffStat ?? null,
    report: outcome.report ?? null,
    error: outcome.error ?? null,
  };
}

export const evoArmRouter = createRouter({
  /** 施工：对指定 draft 提案在隔离工作区执行一次施工演练，产物落审计 */
  run: publicQuery
    .input(tokenInput.extend({
      releaseId: z.number().int().positive(),
      instruction: z.string().trim().min(4).max(1000),
    }))
    .mutation(async ({ input }) => {
      const user = await requireHqAdmin(input.token);
      if (!armEnabled()) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "施工臂仅沙箱演练开放（EVO_ARM_ENABLED=1）" });
      }
      const actor = stripSecrets(String((user as { username?: unknown }).username ?? "unknown")).slice(0, 64) || "unknown";
      return armConstruct({ releaseId: input.releaseId, instruction: input.instruction, actor });
    }),

  /** 施工台账：st_release_audit 中 action='arm:run' 的流水（新→旧） */
  report: publicQuery
    .input(tokenInput.extend({
      releaseId: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }))
    .query(async ({ input }) => {
      await requireHqAdmin(input.token);
      const rows = input.releaseId
        ? rowsOf(await getDb().execute(sql`
            SELECT * FROM st_release_audit WHERE release_id = ${input.releaseId} AND action = 'arm:run'
            ORDER BY id DESC LIMIT ${input.limit}`))
        : rowsOf(await getDb().execute(sql`
            SELECT * FROM st_release_audit WHERE action = 'arm:run'
            ORDER BY id DESC LIMIT ${input.limit}`));
      return {
        ok: true as const,
        items: rows.map((r) => ({
          id: Number(r.id),
          releaseId: r.release_id == null ? null : Number(r.release_id),
          channel: r.channel == null ? null : String(r.channel),
          actor: String(r.actor),
          detail: r.detail == null ? null : stripSecrets(String(r.detail)),
          createdAt: String(r.created_at),
        })),
      };
    }),
});
