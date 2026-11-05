/**
 * claw —— 龙虾 P1 最小闭环：灵枢组织层对 OpenClaw 实例的任务下发 + 审批闸门 + 操作审计。
 *
 * 安全边界（P1 试行）：
 * - 仅 admin 可下发/审批/驳回；两段式：clawDispatch 建 pending 单，clawConfirm 才执行；
 * - 域名白名单（CLAW_ALLOWED_DOMAINS，默认 example.com/baidu.com），非白名单任务直接 rejected 留痕；
 * - 执行经 docker exec 走 OpenClaw CLI，浏览器沙箱在龙虾容器内，灵枢不碰其文件系统写权限；
 * - 证据（截图）回流 st_agent_artifacts（channel=admin, agentCode=claw），全程 st_claw_operations 留痕。
 */
import { z } from "zod";
import { execFile } from "child_process";
import { randomBytes } from "crypto";
import { promises as fsp } from "fs";
import path from "path";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { requireAdmin, stQuery } from "./terminal";
import { parseDbUtc } from "./dbTime";
import { requireStaff } from "./staff";
import { saveArtifact } from "./agentTools";
import { noteSilent } from "./silentWatch";
import { sessionMe } from "./wbSession";
import { sendAlert } from "./alertUtil";
import { assertFactoryPlanActive, factoryLlmUsedToday, recordFactoryLlmCall } from "./billing";
import { recordFitness } from "./fitnessUtil";

/** execFile 的 Promise 化（无 shell，参数不经过命令行拼接） */
function execFileP(cmd: string, args: string[], timeout = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 1024 * 1024 }, (err, out, serr) => {
      if (err) reject(new Error(`${cmd} ${args[0] ?? ""} failed: ${String(serr).slice(0, 200) || err.message}`));
      else resolve(String(out));
    });
  });
}

const CLAW_CONTAINER = (): string => process.env.CLAW_CONTAINER || "orgclaw-p0";
const CLAW_WORKSPACE = (): string => process.env.CLAW_WORKSPACE || "/opt/orgclaw/p0/workspace";

interface ClawInstance {
  instanceKey: string;
  displayName: string;
  containerName: string;
  agentId: string;
  status: string;
}

/** 实例解析：优先 st_claw_instances 注册表，缺省/异常回落环境变量单实例（P1 兼容） */
async function resolveInstance(instanceKey: string): Promise<ClawInstance> {
  try {
    const rows = await stQuery(
      sql`SELECT instance_key AS instanceKey, display_name AS displayName, container_name AS containerName,
                 agent_id AS agentId, status FROM st_claw_instances WHERE instance_key = ${instanceKey} LIMIT 1`,
    );
    const r = rows[0];
    if (r) {
      return {
        instanceKey: String(r.instanceKey), displayName: String(r.displayName),
        containerName: String(r.containerName), agentId: String(r.agentId), status: String(r.status),
      };
    }
  } catch {
    // 表缺失（未迁移）时回落
  }
  return {
    instanceKey, displayName: "龙虾·主实例", containerName: CLAW_CONTAINER(), agentId: "main", status: "active",
  };
}
const ALLOWED_DOMAINS = (): string[] =>
  (process.env.CLAW_ALLOWED_DOMAINS || "example.com,baidu.com,www.baidu.com")
    .split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);

function extractDomain(task: string): string | null {
  const m = task.match(/https?:\/\/([a-zA-Z0-9.-]+)/);
  return m ? m[1].toLowerCase() : null;
}

function genOpNo(): string {
  return `CL${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

/** 从 OpenClaw CLI 输出中提取：用户可读回复（非 [log] 行）+ 附件路径 */
function parseClawOutput(stdout: string): { reply: string; attachments: string[] } {
  const attachments: string[] = [];
  const attRe = /Attachment:\s*(\S+\.(?:png|jpe?g|webp))/gi;
  let m: RegExpExecArray | null;
  while ((m = attRe.exec(stdout)) !== null) attachments.push(m[1]);
  const replyLines = stdout
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "" && !l.startsWith("[") && !l.startsWith("EMBEDDED FALLBACK") && !l.startsWith("Gateway target") && !l.startsWith("Source:") && !l.startsWith("Config:") && !l.startsWith("Bind:") && !l.startsWith("Attachment:"));
  return { reply: replyLines.slice(-12).join("\n").slice(0, 800), attachments };
}

/** 后台执行龙虾任务：confirm 立即返回，执行与归档在此异步完成，clawList 轮询终态 */
export interface ClawOpCtx { agentCode: string; threadId: number | null; actor: string; channel: "admin" | "staff" | "meeting" | "voice" }

async function runClawTask(opNo: string, opId: number, task: string, actor: string, inst: ClawInstance, ctx?: ClawOpCtx): Promise<void> {
  const started = Date.now();
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        "docker",
        ["exec", inst.containerName, "node", "openclaw.mjs", "agent", "--agent", inst.agentId, "--message", task],
        { timeout: 720_000, maxBuffer: 4 * 1024 * 1024 },
        (err, out) => {
          if (err && !out) reject(err);
          else resolve(String(out));
        },
      );
    });
    const { reply, attachments } = parseClawOutput(stdout);
    let evidenceId: number | null = null;
    const instWorkspace = inst.instanceKey === "main" ? CLAW_WORKSPACE() : `/opt/orgclaw/${inst.instanceKey}/workspace`;
    for (const att of attachments) {
      const hostPath = att.replace("/home/node/.openclaw/workspace", instWorkspace);
      try {
        const buf = await fsp.readFile(hostPath);
        const ext = path.extname(hostPath).slice(1) || "png";
        const artifact = await saveArtifact(
          ctx ?? { agentCode: "claw", threadId: opId, actor, channel: "admin" },
          "claw_task",
          ext,
          `龙虾证据 · ${opNo}`,
          ext,
          buf,
          { opNo, instanceKey: inst.instanceKey, task: task.slice(0, 200), domain: extractDomain(task), latencyMs: Date.now() - started },
        );
        evidenceId = artifact.id;
      } catch {
        // 证据文件缺失不阻塞主流程，reply 仍归档
      }
    }
    await stQuery(
      sql`UPDATE st_claw_operations SET status = 'done', reply = ${reply || "（无文本回复）"},
          evidence_artifact_id = ${evidenceId}, finished_at = NOW() WHERE op_no = ${opNo}`,
    );
    // iter96 适应度回写：派发任务执行完成 → success=true（skillKey=派发技能，缺省 claw.dispatch）
    try {
      const f = await stQuery(
        sql`SELECT factory_id AS factoryId, skill_key AS skillKey FROM st_claw_operations WHERE op_no = ${opNo} LIMIT 1`,
      );
      if (f[0]?.factoryId !== null && f[0]?.factoryId !== undefined) {
        await recordFitness(
          Number(f[0].factoryId),
          f[0].skillKey ? String(f[0].skillKey) : "claw.dispatch",
          true,
        );
      }
    } catch {
      // 适应度回写异常绝不阻断主流程
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 400) : "unknown";
    await stQuery(
      sql`UPDATE st_claw_operations SET status = 'failed', error = ${msg}, finished_at = NOW() WHERE op_no = ${opNo}`,
    );
    // iter92 告警挂点：claw 执行失败（status='failed'）→ 告警到人（sendAlert 永不 throw）
    try {
      const f = await stQuery(
        sql`SELECT factory_id AS factoryId, skill_key AS skillKey FROM st_claw_operations WHERE op_no = ${opNo} LIMIT 1`,
      );
      // iter96 适应度回写：派发任务执行失败 → success=false
      if (f[0]?.factoryId !== null && f[0]?.factoryId !== undefined) {
        await recordFitness(
          Number(f[0].factoryId),
          f[0].skillKey ? String(f[0].skillKey) : "claw.dispatch",
          false,
        );
      }
      await sendAlert("error", "claw_exec_failed", {
        opNo,
        factoryId: f[0]?.factoryId === null || f[0]?.factoryId === undefined ? null : Number(f[0].factoryId),
        error: msg,
      });
    } catch {
      // 告警通道异常绝不阻断主流程
    }
  }
}

export const clawRouter = createRouter({
  /** clawDispatch（mutation, admin）：下发龙虾任务，建 pending 操作单 */
  clawDispatch: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      task: z.string().trim().min(2).max(500),
      instanceKey: z.string().trim().min(1).max(32).optional(),
    }))
    .mutation(async ({ input }) => {
      const admin = await requireAdmin(input.token);
      const instanceKey = input.instanceKey ?? "main";
      const inst = await resolveInstance(instanceKey);
      if (inst.status !== "active") {
        throw new TRPCError({ code: "BAD_REQUEST", message: `实例 ${instanceKey} 当前状态 ${inst.status}，不可派活` });
      }
      const opNo = genOpNo();
      const domain = extractDomain(input.task);
      const allowed = ALLOWED_DOMAINS();
      if (domain && !allowed.includes(domain)) {
        await stQuery(
          sql`INSERT INTO st_claw_operations (op_no, instance_key, actor, task, domain, risk, status, error)
              VALUES (${opNo}, ${instanceKey}, ${String(admin.username)}, ${input.task}, ${domain}, 'low', 'rejected', ${`域名不在白名单：${domain}`})`,
        );
        return { ok: false as const, opNo, reason: `域名 ${domain} 不在白名单（当前允许：${allowed.join("、")}），操作单已拒绝并留痕` };
      }
      await stQuery(
        sql`INSERT INTO st_claw_operations (op_no, instance_key, actor, task, domain, risk, status)
            VALUES (${opNo}, ${instanceKey}, ${String(admin.username)}, ${input.task}, ${domain}, 'low', 'pending')`,
      );
      return { ok: true as const, opNo, message: `任务已创建（实例：${inst.displayName}），待审批确认后执行（两段式闸门）` };
    }),

  /** clawConfirm（mutation, admin）：审批通过 → 后台执行（立即返回，clawList 轮询终态） */
  clawConfirm: publicQuery
    .input(z.object({ token: z.string().trim().min(1), opNo: z.string().trim().min(4).max(24) }))
    .mutation(async ({ input }) => {
      const admin = await requireAdmin(input.token);
      const r = await confirmClawOp(input.opNo, String(admin.username));
      return { ok: true as const, opNo: input.opNo, message: r.message };
    }),

  /** clawReject（mutation, admin）：驳回 pending 单 */
  clawReject: publicQuery
    .input(z.object({ token: z.string().trim().min(1), opNo: z.string().trim().min(4).max(24) }))
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      await rejectClawOp(input.opNo);
      return { ok: true as const };
    }),

  /** clawList（query, admin）：操作单全轨迹 */
  clawList: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      const rows = await stQuery(
        sql`SELECT op_no AS opNo, instance_key AS instanceKey, actor, task, domain, status, reply, evidence_artifact_id AS evidenceArtifactId,
                   error, created_at AS createdAt, finished_at AS finishedAt
            FROM st_claw_operations ORDER BY id DESC LIMIT 30`,
      );
      return {
        rows: rows.map((r) => ({
          opNo: String(r.opNo),
          instanceKey: r.instanceKey ? String(r.instanceKey) : "main",
          actor: String(r.actor), task: String(r.task),
          domain: r.domain ? String(r.domain) : null, status: String(r.status),
          reply: r.reply ? String(r.reply) : null,
          evidenceArtifactId: r.evidenceArtifactId ? Number(r.evidenceArtifactId) : null,
          error: r.error ? String(r.error) : null,
          createdAt: r.createdAt ? String(r.createdAt) : null,
          finishedAt: r.finishedAt ? String(r.finishedAt) : null,
        })),
      };
    }),

  /** clawInstances（query, admin）：龙虾实例清单（含各实例 running 占用情况） */
  clawInstances: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      let instances: ClawInstance[] = [];
      try {
        const rows = await stQuery(
          sql`SELECT instance_key AS instanceKey, display_name AS displayName, container_name AS containerName,
                     agent_id AS agentId, status FROM st_claw_instances ORDER BY id ASC`,
        );
        instances = rows.map((r) => ({
          instanceKey: String(r.instanceKey), displayName: String(r.displayName),
          containerName: String(r.containerName), agentId: String(r.agentId), status: String(r.status),
        }));
      } catch {
        // 表缺失（未迁移）时回落单实例
      }
      if (instances.length === 0) instances = [await resolveInstance("main")];
      const running = await stQuery(
        sql`SELECT instance_key AS instanceKey, op_no AS opNo FROM st_claw_operations WHERE status = 'running'`,
      );
      const busyMap = new Map(running.map((r) => [String(r.instanceKey ?? "main"), String(r.opNo)]));
      return {
        rows: instances.map((i) => ({ ...i, busyOpNo: busyMap.get(i.instanceKey) ?? null })),
      };
    }),

  /** clawInstanceUpsert（mutation, admin）：注册/更新龙虾实例（仅落账，懒接触——不校验容器存在性） */
  clawInstanceUpsert: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      instanceKey: z.string().trim().min(2).max(32).regex(/^[a-z0-9-]+$/, "实例标识仅限小写字母/数字/短横线"),
      displayName: z.string().trim().min(2).max(64),
      containerName: z.string().trim().min(2).max(64),
      agentId: z.string().trim().min(1).max(32).default("main"),
    }))
    .mutation(async ({ input }) => {
      const admin = await requireAdmin(input.token);
      await stQuery(
        sql`INSERT INTO st_claw_instances (instance_key, display_name, container_name, agent_id)
            VALUES (${input.instanceKey}, ${input.displayName}, ${input.containerName}, ${input.agentId})
            ON DUPLICATE KEY UPDATE display_name = VALUES(display_name),
              container_name = VALUES(container_name), agent_id = VALUES(agent_id)`,
      );
      return { ok: true as const, message: `实例 ${input.instanceKey} 已注册/更新（操作人：${String(admin.username)}），容器 ${input.containerName} 将于首次派活时接触` };
    }),

  /** clawInstanceSetStatus（mutation, admin）：实例三态流转；main 不可退休（防自锁） */
  clawInstanceSetStatus: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      instanceKey: z.string().trim().min(1).max(32),
      status: z.enum(["active", "paused", "retired"]),
    }))
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      if (input.instanceKey === "main" && input.status === "retired") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "主实例 main 不可退休（防自锁），可暂停" });
      }
      // 有 running 单的实例不可暂停/退休
      if (input.status !== "active") {
        const busy = await stQuery(
          sql`SELECT op_no AS opNo FROM st_claw_operations WHERE instance_key = ${input.instanceKey} AND status = 'running' LIMIT 1`,
        );
        if (busy[0]) {
          throw new TRPCError({ code: "CONFLICT", message: `实例有执行中操作单 ${String(busy[0].opNo)}，待终态后再变更状态` });
        }
      }
      await stQuery(
        sql`UPDATE st_claw_instances SET status = ${input.status} WHERE instance_key = ${input.instanceKey}`,
      );
      return { ok: true as const, message: `实例 ${input.instanceKey} 已置为 ${input.status}` };
    }),

  /** clawInstanceProvision（mutation, admin）：实例容器编排。dryRun 默认 true 只出计划；实跑起容器+健康检查+失败回滚。
   *  密钥边界：IDOICTOS 密钥经 docker -e VARNAME 透传 boot.js 进程环境，绝不出现在参数值/日志/返回值。 */
  clawInstanceProvision: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      instanceKey: z.string().trim().min(1).max(32),
      dryRun: z.boolean().default(true),
    }))
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      // 严格查注册表（禁回落）：未知实例不得编排，防误指 main 容器
      const irows = await stQuery(
        sql`SELECT instance_key AS instanceKey, display_name AS displayName, container_name AS containerName,
                   agent_id AS agentId, status FROM st_claw_instances WHERE instance_key = ${input.instanceKey} LIMIT 1`,
      );
      if (!irows[0]) {
        throw new TRPCError({ code: "NOT_FOUND", message: `实例 ${input.instanceKey} 未注册，先 clawInstanceUpsert 落账再编排` });
      }
      const inst: ClawInstance = {
        instanceKey: String(irows[0].instanceKey), displayName: String(irows[0].displayName),
        containerName: String(irows[0].containerName), agentId: String(irows[0].agentId), status: String(irows[0].status),
      };
      const hostDir = `/opt/orgclaw/${input.instanceKey}`;
      const image = process.env.CLAW_IMAGE || "orgclaw-golden:2026.7.1";
      // iter81 闸门一：新建容器硬隔离（不影响运行中的 p0）：
      // 砍全部特权 + 禁提权 + 资源硬顶；网络隔离段由 CLAW_DOCKER_NETWORK 指定（s3 运维脚本建网+封隧道）
      const dockerArgs = [
        "run", "-d", "--name", inst.containerName, "--restart", "unless-stopped",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--memory", "2g", "--pids-limit", "512", "--cpus", "1.5",
        ...(process.env.CLAW_DOCKER_NETWORK ? ["--network", process.env.CLAW_DOCKER_NETWORK] : []),
        "-v", `${hostDir}:/home/node/.openclaw`,
        "-v", "/opt/orgclaw/ms-playwright:/home/node/.cache/ms-playwright:ro",
        "-e", "IDOICTOS_API_KEY", "-e", "IDOICTOS_BASE_URL",
        image,
      ];
      const plan = {
        instanceKey: input.instanceKey,
        containerName: inst.containerName,
        hostDir,
        image,
        dockerArgs,
        note: "config 以 p0 为金模板生成：apiKey/baseUrl 改为 IDOICTOS_* 环境变量引用，网关令牌逐实例重生成；浏览器运行时共享只读挂载",
      };
      if (input.dryRun) return { ok: true as const, dryRun: true as const, plan };

      // 实跑：容器必须不存在
      const exists = await new Promise<boolean>((resolve) => {
        execFile("docker", ["inspect", inst.containerName], { timeout: 10_000 }, (err) => resolve(!err));
      });
      if (exists) throw new TRPCError({ code: "CONFLICT", message: `容器 ${inst.containerName} 已存在，先回收或换容器名` });

      // 金模板生成配置（密钥改环境引用，令牌逐实例重生成）
      let tpl: Record<string, unknown>;
      try {
        tpl = JSON.parse(await fsp.readFile("/opt/orgclaw/p0/openclaw.json", "utf8")) as Record<string, unknown>;
      } catch (e) {
        noteSilent("claw.farm.template", e);
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "p0 金模板配置读取失败，请联系平台检查 /opt/orgclaw/p0/openclaw.json" });
      }
      const models = tpl.models as { providers?: { idoictos?: Record<string, unknown> } };
      if (models?.providers?.idoictos) {
        models.providers.idoictos.apiKey = "${IDOICTOS_API_KEY}";
        models.providers.idoictos.baseUrl = "${IDOICTOS_BASE_URL}/v1";
      }
      const gateway = tpl.gateway as { auth?: { token?: string } } | undefined;
      if (gateway?.auth) gateway.auth.token = randomBytes(24).toString("hex");
      delete tpl.meta;
      await fsp.mkdir(`${hostDir}/workspace`, { recursive: true });
      await fsp.writeFile(`${hostDir}/openclaw.json`, JSON.stringify(tpl, null, 2), { mode: 0o600 });
      await execFileP("chown", ["-R", "1000:1000", hostDir]);

      try {
        await execFileP("docker", dockerArgs, 60_000);
        // 健康检查：运行态 + CLI 探活
        const insp = await execFileP("docker", ["inspect", "--format", "{{.State.Running}}", inst.containerName], 10_000);
        if (insp.trim() !== "true") throw new Error("容器未保持运行态");
        await execFileP("docker", ["exec", inst.containerName, "node", "openclaw.mjs", "--version"], 60_000);
      } catch (e) {
        // 回滚
        await execFileP("docker", ["rm", "-f", inst.containerName], 30_000).catch(() => undefined);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `编排失败已回滚：${e instanceof Error ? e.message.slice(0, 200) : "unknown"}` });
      }
      await stQuery(sql`UPDATE st_claw_instances SET status = 'active' WHERE instance_key = ${input.instanceKey}`);
      return { ok: true as const, dryRun: false as const, message: `实例 ${input.instanceKey} 容器 ${inst.containerName} 已起并通过健康检查（共享浏览器运行时，密钥经环境变量注入）` };
    }),

  /** clawInstanceTeardown（mutation, admin）：回收 retired 实例容器（保留 /opt/orgclaw/<key> 文件） */
  clawInstanceTeardown: publicQuery
    .input(z.object({ token: z.string().trim().min(1), instanceKey: z.string().trim().min(1).max(32) }))
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      const inst = await resolveInstance(input.instanceKey);
      if (inst.status !== "retired") {
        throw new TRPCError({ code: "BAD_REQUEST", message: `仅 retired 实例可回收（当前 ${inst.status}）` });
      }
      await execFileP("docker", ["rm", "-f", inst.containerName], 30_000).catch(() => undefined);
      return { ok: true as const, message: `实例 ${input.instanceKey} 容器 ${inst.containerName} 已回收，文件保留于 /opt/orgclaw/${input.instanceKey}` };
    }),

  // ─── iter78 Panda 组织底座：四角色席位 ────────────────────────────────────
  /** pandaMembers（query, admin）：四角色席位列表（平台级 + 各租户） */
  pandaMembers: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      factoryId: z.number().int().positive().nullish(),
    }))
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      const rows = await stQuery(
        sql`SELECT id, factory_id AS factoryId, role, ref_type AS refType, ref_key AS refKey,
                   dept_key AS deptKey, duty, enabled, created_at AS createdAt, updated_at AS updatedAt
            FROM st_panda_members
            WHERE (${input.factoryId ?? null} IS NULL OR factory_id <=> ${input.factoryId ?? null})
            ORDER BY factory_id IS NULL DESC, FIELD(role, 'co','ex','va','ev'), id ASC LIMIT 200`,
      );
      return { items: rows };
    }),

  /** pandaMemberUpsert（mutation, admin）：配置角色席位（唯一键命中则更新职责并启用） */
  pandaMemberUpsert: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      factoryId: z.number().int().positive().nullish(),
      role: z.enum(["co", "ex", "va", "ev"]),
      refType: z.enum(["agent", "staff", "admin", "model", "kernel"]),
      refKey: z.string().trim().min(1).max(64),
      deptKey: z.string().trim().max(32).nullish(),
      duty: z.string().trim().max(200).optional(),
    }))
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      await stQuery(
        sql`INSERT INTO st_panda_members (factory_id, role, ref_type, ref_key, dept_key, duty, enabled)
            VALUES (${input.factoryId ?? null}, ${input.role}, ${input.refType}, ${input.refKey},
                    ${input.deptKey ?? null}, ${input.duty ?? ""}, 1)
            ON DUPLICATE KEY UPDATE ref_type = VALUES(ref_type), dept_key = VALUES(dept_key),
                                    duty = VALUES(duty), enabled = 1`,
      );
      return { ok: true as const };
    }),

  /** pandaMemberToggle（mutation, admin）：启用/停用席位 */
  pandaMemberToggle: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      id: z.number().int().positive(),
      enabled: z.boolean(),
    }))
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      await stQuery(
        sql`UPDATE st_panda_members SET enabled = ${input.enabled ? 1 : 0} WHERE id = ${input.id}`,
      );
      return { ok: true as const };
    }),

  // ─── iter78 Panda 组织底座：分级审批 ─────────────────────────────────────
  /** pandaApprovals（query, admin）：待审批操作单（含审批级别） */
  pandaApprovals: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      level: z.enum(["l1_auto", "l2_tenant", "l3_platform"]).optional(),
    }))
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      const rows = await stQuery(
        sql`SELECT op_no AS opNo, instance_key AS instanceKey, actor, task, domain, risk,
                   approval_level AS approvalLevel, factory_id AS factoryId, created_at AS createdAt
            FROM st_claw_operations
            WHERE status = 'pending'
              AND (${input.level ?? null} IS NULL OR approval_level = ${input.level ?? null})
            ORDER BY id ASC LIMIT 50`,
      );
      return { items: rows };
    }),

  /** pandaApprove（mutation, admin）：审批留痕（approved_by/at）→ 转 running 执行 */
  pandaApprove: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      opNo: z.string().trim().min(4).max(24),
    }))
    .mutation(async ({ input }) => {
      const admin = await requireAdmin(input.token);
      const name = String(admin.username);
      await stQuery(
        sql`UPDATE st_claw_operations SET approved_by = ${name}, approved_at = NOW()
            WHERE op_no = ${input.opNo} AND status = 'pending'`,
      );
      const r = await confirmClawOp(input.opNo, name);
      return { ok: true as const, opNo: input.opNo, message: r.message };
    }),

  // ─── iter91 L2 租户侧审批中心（多租户化：factory_id 强制=本厂，跨租户隔离）──────
  /** pandaTenantApprovals（query, wb owner）：本厂 l2 待办（可批）+ l3 待办（只读）+ 近 50 条已办；
   *  台账行带 factoryId，全部查询强制 factory_id=本厂（不再命中 factory_id IS NULL 单租户遗留单）。 */
  pandaTenantApprovals: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const { factory } = await requireWbHead(input.token);
      const fid = factory.id;
      const pending = await stQuery(
        sql`SELECT op_no AS opNo, instance_key AS instanceKey, actor, task, domain, risk,
                   approval_level AS approvalLevel, factory_id AS factoryId, created_at AS createdAt
            FROM st_claw_operations
            WHERE status = 'pending' AND approval_level IN ('l2_tenant','l3_platform')
              AND factory_id = ${fid}
            ORDER BY id ASC LIMIT 50`,
      );
      const recent = await stQuery(
        sql`SELECT op_no AS opNo, actor, task, approval_level AS approvalLevel, status,
                   factory_id AS factoryId, approved_by AS approvedBy, approved_at AS approvedAt
            FROM st_claw_operations
            WHERE status IN ('done','rejected','failed') AND approval_level IN ('l2_tenant','l3_platform')
              AND factory_id = ${fid}
            ORDER BY id DESC LIMIT 50`,
      );
      return { factoryId: fid, pending, recent };
    }),

  /** pandaTenantApprove（mutation, wb owner）：仅本厂 l2_tenant 可批；l3/l1 一律 FORBIDDEN；留痕 approved_by=wb:用户名 */
  pandaTenantApprove: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      opNo: z.string().trim().min(4).max(24),
    }))
    .mutation(async ({ input }) => {
      const { user, factory } = await requireWbHead(input.token);
      const rows = await stQuery(
        sql`SELECT approval_level AS approvalLevel, status, factory_id AS factoryId
            FROM st_claw_operations WHERE op_no = ${input.opNo} LIMIT 1`,
      );
      const op = rows[0];
      if (!op) throw new TRPCError({ code: "NOT_FOUND", message: "操作单不存在" });
      if (Number(op.factoryId) !== factory.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "该操作单归属其他工厂，需平台超管审批" });
      }
      if (String(op.approvalLevel) !== "l2_tenant") {
        throw new TRPCError({ code: "FORBIDDEN", message: `该单为 ${String(op.approvalLevel)} 级，租户无权审批（l1 自动执行 / l3 需平台超管）` });
      }
      const name = `wb:${user.username}`;
      await stQuery(
        sql`UPDATE st_claw_operations SET approved_by = ${name}, approved_at = NOW()
            WHERE op_no = ${input.opNo} AND status = 'pending' AND factory_id = ${factory.id}`,
      );
      const r = await confirmClawOp(input.opNo, name);
      return { ok: true as const, opNo: input.opNo, factoryId: factory.id, message: r.message };
    }),

  /** pandaTenantReject（mutation, wb owner）：仅本厂 l2_tenant 可驳回 */
  pandaTenantReject: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      opNo: z.string().trim().min(4).max(24),
      reason: z.string().trim().max(200).optional(),
    }))
    .mutation(async ({ input }) => {
      const { user, factory } = await requireWbHead(input.token);
      const rows = await stQuery(
        sql`SELECT approval_level AS approvalLevel, factory_id AS factoryId
            FROM st_claw_operations WHERE op_no = ${input.opNo} LIMIT 1`,
      );
      const op = rows[0];
      if (!op) throw new TRPCError({ code: "NOT_FOUND", message: "操作单不存在" });
      if (Number(op.factoryId) !== factory.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "该操作单归属其他工厂，需平台超管处理" });
      }
      if (String(op.approvalLevel) !== "l2_tenant") {
        throw new TRPCError({ code: "FORBIDDEN", message: `该单为 ${String(op.approvalLevel)} 级，租户无权驳回` });
      }
      await stQuery(
        sql`UPDATE st_claw_operations
            SET status = 'rejected', approved_by = ${`wb:${user.username}`}, approved_at = NOW(),
                error = ${input.reason ?? "企业负责人驳回"}
            WHERE op_no = ${input.opNo} AND status = 'pending' AND factory_id = ${factory.id}`,
      );
      return { ok: true as const, opNo: input.opNo, factoryId: factory.id };
    }),

  // ─── iter91 龙虾租户化 · wb 企业侧接口 ───────────────────────────────────
  /** tierGet（query, wb）：本厂龙虾分级 + 已生效白名单数 + 待审批单数 */
  tierGet: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const { factory } = await sessionMe(input.token);
      const tier = await getFactoryTier(factory.id);
      const wl = await stQuery(
        sql`SELECT COUNT(*) AS c FROM st_claw_domain_whitelist
            WHERE status = 'approved' AND (factory_id IS NULL OR factory_id = ${factory.id})`,
      );
      const pa = await stQuery(
        sql`SELECT COUNT(*) AS c FROM st_claw_operations
            WHERE status = 'pending' AND factory_id = ${factory.id}`,
      );
      return {
        tier,
        whitelistCount: Number(wl[0]?.c ?? 0),
        pendingApprovals: Number(pa[0]?.c ?? 0),
      };
    }),

  /** tierRequestUpgrade（mutation, wb owner）：申请升舱（l1/l2），平台 l3 审批；幂等——已有 pending 申请不重复建单 */
  tierRequestUpgrade: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      targetTier: z.enum(["l1", "l2"]),
      reason: z.string().trim().min(2).max(500),
    }))
    .mutation(async ({ input }) => {
      const { user, factory } = await requireWbHead(input.token);
      const current = await getFactoryTier(factory.id);
      const rank = { l0: 0, l1: 1, l2: 2, l3: 3 } as Record<string, number>;
      if ((rank[input.targetTier] ?? 0) <= (rank[current] ?? 0)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `当前已是 ${current}，无需申请 ${input.targetTier}` });
      }
      const taskKey = `tier-upgrade:${input.targetTier}`;
      const dup = await stQuery(
        sql`SELECT op_no AS opNo FROM st_claw_operations
            WHERE factory_id = ${factory.id} AND task = ${taskKey} AND status = 'pending' LIMIT 1`,
      );
      if (dup[0]) {
        return { ok: true as const, opNo: String(dup[0].opNo), alreadyPending: true as const, message: "已有同目标升舱申请在平台审批队列中，不重复提交" };
      }
      const opNo = genOpNo();
      const ctx = JSON.stringify({ reason: input.reason, fromTier: current, targetTier: input.targetTier });
      await stQuery(
        sql`INSERT INTO st_claw_operations (op_no, instance_key, ctx_json, actor, task, risk, approval_level, factory_id, status)
            VALUES (${opNo}, 'main', ${ctx}, ${`wb:${user.username}`}, ${taskKey}, 'high', 'l3_platform', ${factory.id}, 'pending')`,
      );
      return { ok: true as const, opNo, alreadyPending: false as const, message: `升舱申请已提交平台审批（单号 ${opNo}）` };
    }),

  /** whitelistList（query, wb）：平台已批基础名单 + 本厂名单（含 pending/rejected） */
  whitelistList: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const { factory } = await sessionMe(input.token);
      const rows = await stQuery(
        sql`SELECT id, factory_id AS factoryId, domain, status, submitted_by AS submittedBy,
                   approved_by AS approvedBy, approved_at AS approvedAt, created_at AS createdAt
            FROM st_claw_domain_whitelist
            WHERE (factory_id IS NULL AND status = 'approved') OR factory_id = ${factory.id}
            ORDER BY factory_id IS NULL DESC, id ASC LIMIT 200`,
      );
      return {
        factoryId: factory.id,
        items: rows.map((r) => ({
          id: Number(r.id),
          scope: r.factoryId === null || r.factoryId === undefined ? ("platform" as const) : ("factory" as const),
          factoryId: r.factoryId === null || r.factoryId === undefined ? null : Number(r.factoryId),
          domain: String(r.domain),
          status: String(r.status),
          submittedBy: r.submittedBy ? String(r.submittedBy) : null,
          approvedBy: r.approvedBy ? String(r.approvedBy) : null,
          approvedAt: r.approvedAt ? String(r.approvedAt) : null,
          createdAt: r.createdAt ? String(r.createdAt) : null,
        })),
      };
    }),

  /** whitelistSubmit（mutation, wb）：提交本厂域名白名单申请（pending，待 s3 审批）；幂等 INSERT IGNORE */
  whitelistSubmit: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      domain: z.string().trim().min(3).max(255),
    }))
    .mutation(async ({ input }) => {
      const { user, factory } = await sessionMe(input.token);
      const domain = normalizeDomain(input.domain);
      await stQuery(
        sql`INSERT IGNORE INTO st_claw_domain_whitelist (factory_id, domain, status, submitted_by)
            VALUES (${factory.id}, ${domain}, 'pending', ${`wb:${user.username}`})`,
      );
      const rows = await stQuery(
        sql`SELECT id, status FROM st_claw_domain_whitelist
            WHERE factory_id = ${factory.id} AND domain = ${domain} LIMIT 1`,
      );
      const status = rows[0] ? String(rows[0].status) : "pending";
      return {
        ok: true as const,
        domain,
        status,
        message: status === "pending"
          ? `域名 ${domain} 已提交平台审批，批准后自动生效`
          : `域名 ${domain} 此前已提交，当前状态 ${status}`,
      };
    }),

  /** wbDispatch（mutation, wb）：企业侧龙虾派单。
   *  tier=l0 拒单；l1 仅只读技能（CLAW_READONLY_SKILLS）；l2 全量；
   *  高危技能/见习期高危 → approval_level='l2_tenant' + status='pending' 不直接执行；
   *  域名必须在（平台基础 approved ∪ 本厂 approved）名单内；全程强制 factory_id=本厂。 */
  wbDispatch: publicQuery
    .input(z.object({
      token: z.string().trim().min(1),
      task: z.string().trim().min(2).max(500),
      skillKey: z.string().trim().min(1).max(32).optional(),
    }))
    .mutation(async ({ input }) => {
      const { user, factory } = await sessionMe(input.token);
      const fid = factory.id;
      // iter92 成本闸①：欠费降权——套餐必须 status='active' 且 expire_at>NOW()，否则 403
      const plan = await assertFactoryPlanActive(fid);
      // iter92 成本闸②：本厂 LLM 日限额（st_factory_plan.llm_daily_limit），超限拒绝
      const llmUsed = await factoryLlmUsedToday(fid);
      if (llmUsed >= plan.llmDailyLimit) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `本厂 LLM 日用量已达上限（${llmUsed}/${plan.llmDailyLimit}），明日恢复或联系平台升级套餐`,
        });
      }
      const tier = await getFactoryTier(fid);
      if (tier === "l0") {
        throw new TRPCError({ code: "FORBIDDEN", message: "本厂龙虾能力未开通（tier=l0），请先 claw.tierRequestUpgrade 申请升舱" });
      }
      const skillKey = input.skillKey ?? "browse_web";
      if (tier === "l1" && !CLAW_READONLY_SKILLS.has(skillKey)) {
        throw new TRPCError({ code: "FORBIDDEN", message: `tier=l1 仅允许只读采集类技能（${[...CLAW_READONLY_SKILLS].join("、")}），${skillKey} 需升级 l2` });
      }
      // 技能闸（动作清单焊死层，与平台派单同标准）
      const domain = extractDomain(input.task);
      const cap = await assertSkillGate(skillKey, domain);
      // 域名校验：平台基础 approved ∪ 本厂 approved
      if (domain) {
        const hit = await stQuery(
          sql`SELECT id FROM st_claw_domain_whitelist
              WHERE status = 'approved' AND domain = ${domain}
                AND (factory_id IS NULL OR factory_id = ${fid}) LIMIT 1`,
        );
        if (!hit[0]) {
          throw new TRPCError({ code: "BAD_REQUEST", message: `域名 ${domain} 不在（平台基础 ∪ 本厂）已批白名单内，请先 claw.whitelistSubmit 申请` });
        }
      }
      const opNo = genOpNo();
      const actor = `wb:${user.username}`;
      // iter97 特训闭环：本厂军团成员 duty 含「｜特训：<skillKey>」时注入特训加成上下文
      let boostedBy: string | null = null;
      let task = input.task;
      {
        const hit = await stQuery(
          sql`SELECT m.duty FROM st_panda_members m
              WHERE m.factory_id = ${fid} AND m.enabled = 1 AND m.duty LIKE ${"%｜特训：" + skillKey + "%"} LIMIT 1`,
        );
        if (hit[0]) {
          const sk = await stQuery(
            sql`SELECT title FROM st_sandbox_skills WHERE factory_id = ${fid} AND skill_key = ${skillKey} AND graduated = 1 LIMIT 1`,
          );
          const title = sk[0] ? String(sk[0].title) : skillKey;
          task = `【特训加成·${title}】本厂数字员工已在「${title}」完成特训毕业，请以该领域专业水准执行以下任务：\n${input.task}`;
          boostedBy = `特训:${skillKey}`;
        }
      }
      const ctxJson = JSON.stringify({ agentCode: "claw", threadId: null, actor, channel: "staff", factoryId: fid, boostedBy });
      // 见习期：军团驻场 <14 天，高危一律 l2_tenant（即使 tier=l2）
      const probation = await inProbation(fid);
      // iter92 成本闸③：派单受理即计 1 次本厂 LLM 用量（含 80%/100% 阈值告警，每厂每日每档一次）
      await recordFactoryLlmCall(fid, plan.llmDailyLimit);
      if (cap.risk === "high") {
        await stQuery(
          sql`INSERT INTO st_claw_operations (op_no, instance_key, ctx_json, actor, task, skill_key, domain, risk, approval_level, factory_id, status)
              VALUES (${opNo}, 'main', ${ctxJson}, ${actor}, ${task}, ${skillKey}, ${domain}, 'high', 'l2_tenant', ${fid}, 'pending')`,
        );
        return { ok: true as const, opNo, autoStarted: false as const, message: `高危技能「${cap.displayName}」${probation ? "（见习期强制）" : ""}已转企业负责人审批（单号 ${opNo}），批准后由龙虾执行`, boostedBy };
      }
      // 低风险：本机无 docker → 入 s3 队列（免审直置），否则直接开工
      if (!(await hasDocker())) {
        await stQuery(
          sql`INSERT INTO st_claw_operations (op_no, instance_key, ctx_json, actor, task, skill_key, domain, risk, factory_id, status, exec_host, approved_by, approved_at)
              VALUES (${opNo}, 'main', ${ctxJson}, ${actor}, ${task}, ${skillKey}, ${domain}, 'low', ${fid}, 'pending', 's3', 'queue:auto', NOW())`,
        );
        return { ok: true as const, opNo, autoStarted: false as const, message: `龙虾任务已受理并排入执行队列（单号 ${opNo}），完成后证据自动回流`, boostedBy };
      }
      await stQuery(
        sql`INSERT INTO st_claw_operations (op_no, instance_key, ctx_json, actor, task, skill_key, domain, risk, factory_id, status)
            VALUES (${opNo}, 'main', ${ctxJson}, ${actor}, ${task}, ${skillKey}, ${domain}, 'low', ${fid}, 'running')`,
      );
      const rows = await stQuery(sql`SELECT id FROM st_claw_operations WHERE op_no = ${opNo} LIMIT 1`);
      const inst = await resolveInstance("main");
      void runClawTask(opNo, Number(rows[0].id), task, actor, inst, { agentCode: "claw", threadId: Number(rows[0].id), actor, channel: "staff" });
      return { ok: true as const, opNo, autoStarted: true as const, message: `龙虾已开工（单号 ${opNo}），完成后证据自动回流`, boostedBy };
    }),
});

/** 租户审批人守卫：staff 身份 + role=head（导出供冒烟复用） */
export async function requireTenantHead(token: string) {
  const account = await requireStaff(token);
  if (account.role !== "head") {
    throw new TRPCError({ code: "FORBIDDEN", message: "仅部门负责人可执行租户审批" });
  }
  return account;
}

// ─── iter91 龙虾租户化 · 共享 helper ─────────────────────────────────────────
/** wb 企业负责人守卫：nt_ token → sessionMe + role=owner/admin（审批/升舱等敏感动作） */
export async function requireWbHead(token: string) {
  const { user, factory } = await sessionMe(token);
  if (user.role !== "owner" && user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "仅企业负责人可执行该操作" });
  }
  return { user, factory };
}

/** 本厂龙虾分级（st_factory_claw_tier，缺省 l0=未开通；表缺失时安全回落 l0） */
export async function getFactoryTier(factoryId: number): Promise<string> {
  try {
    const rows = await stQuery(
      sql`SELECT tier FROM st_factory_claw_tier WHERE factory_id = ${factoryId} LIMIT 1`,
    );
    const t = rows[0] ? String(rows[0].tier) : "l0";
    return ["l0", "l1", "l2", "l3"].includes(t) ? t : "l0";
  } catch {
    return "l0";
  }
}

/** tier=l1 允许的只读采集类技能集合 */
export const CLAW_READONLY_SKILLS = new Set(["browse_web", "read_page", "search_web", "summarize_page", "extract_data", "site_audit", "screenshot_page"]);

/** 域名规范化+格式校验：禁 scheme/路径/端口，hostname 正则，输出小写 */
export function normalizeDomain(raw: string): string {
  const d = raw.trim().toLowerCase();
  if (/[:/@\\?#]/.test(d)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "域名仅允许 hostname（不含 scheme/路径/端口），如 www.example.com" });
  }
  if (!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(d)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "域名格式不正确（需为合法 hostname，如 www.example.com）" });
  }
  return d;
}

/** 见习期判定：本厂军团 deployed_at 距今 <14 天（无军团/未驻场=false；表缺失安全回落 false） */
export async function inProbation(factoryId: number): Promise<boolean> {
  try {
    const rows = await stQuery(
      sql`SELECT deployed_at AS deployedAt FROM st_corps WHERE factory_id = ${factoryId} LIMIT 1`,
    );
    const r = rows[0];
    if (!r || !r.deployedAt) return false;
    const t = parseDbUtc(r.deployedAt);
    return Number.isFinite(t) && Date.now() - t < 14 * 24 * 3600 * 1000;
  } catch {
    return false;
  }
}

// ─── iter81 闸门二 · 技能动作清单（焊死）────────────────────────────────────
interface SkillCap { skillKey: string; displayName: string; actions: string[]; domainPatterns: string[]; risk: string; enabled: boolean }

/** 查技能清单（st_claw_skill_caps）；未注册/停用 → null */
export async function loadSkillCap(skillKey: string): Promise<SkillCap | null> {
  const rows = await stQuery(
    sql`SELECT skill_key AS skillKey, display_name AS displayName, actions, domain_patterns AS domainPatterns, risk, enabled
        FROM st_claw_skill_caps WHERE skill_key = ${skillKey} LIMIT 1`,
  );
  const r = rows[0];
  if (!r || Number(r.enabled) !== 1) return null;
  const parseArr = (v: unknown): string[] => {
    try {
      const a = typeof v === "string" ? JSON.parse(v) : v;
      return Array.isArray(a) ? a.map(String) : [];
    } catch { return []; }
  };
  return {
    skillKey: String(r.skillKey), displayName: String(r.displayName),
    actions: parseArr(r.actions), domainPatterns: parseArr(r.domainPatterns),
    risk: String(r.risk), enabled: true,
  };
}

/** 技能闸：任务必须命中已焊死技能，且域名在技能域名模式内（空模式=回落全局白名单） */
async function assertSkillGate(skillKey: string, domain: string | null): Promise<SkillCap> {
  const cap = await loadSkillCap(skillKey);
  if (!cap) {
    throw new TRPCError({ code: "FORBIDDEN", message: `技能 ${skillKey} 未注册或已停用（技能动作清单焊死层拦截）` });
  }
  if (domain && cap.domainPatterns.length > 0 && !cap.domainPatterns.some((p) => domain === p || domain.endsWith(`.${p}`))) {
    throw new TRPCError({ code: "FORBIDDEN", message: `技能「${cap.displayName}」不允许访问域名 ${domain}（动作清单焊死层拦截）` });
  }
  return cap;
}

// ─── iter81 闸门一 · 执行环境探测 + 队列路由 ───────────────────────────────
let dockerAvailCache: { ok: boolean; at: number } | null = null;
/** 本机 docker 可用性（60s 缓存；s1/s2 无 docker → 任务入 s3 队列而非失败） */
export async function hasDocker(): Promise<boolean> {
  if (dockerAvailCache && Date.now() - dockerAvailCache.at < 60_000) return dockerAvailCache.ok;
  const ok = await execFileP("docker", ["info"], 8_000).then(() => true).catch(() => false);
  dockerAvailCache = { ok, at: Date.now() };
  return ok;
}

/** dispatchClawTask（员工技能入口，agentTools 动态调用）：白名单域名自动开工，否则 pending 待管理审批。
 *  两段式闸门对员工场景降级为「白名单内自动+全程留痕」，白名单外一律人工审批，安全边界不松。
 *  iter81：先过技能闸（动作清单焊死层）；高危技能强制人审；本机无 docker → 入 s3 执行队列。 */
export async function dispatchClawTask(opts: {
  task: string;
  actor: string;
  ctx: ClawOpCtx;
  instanceKey?: string;
  skillKey?: string;
}): Promise<{ ok: boolean; opNo: string; autoStarted: boolean; message: string }> {
  const instanceKey = opts.instanceKey ?? "main";
  const inst = await resolveInstance(instanceKey);
  if (inst.status !== "active") {
    return { ok: false, opNo: "", autoStarted: false, message: `龙虾实例 ${inst.displayName} 当前不可用（${inst.status}），请稍后再试或联系管理员` };
  }
  const opNo = genOpNo();
  const domain = extractDomain(opts.task);
  const allowed = ALLOWED_DOMAINS();
  const ctxJson = JSON.stringify(opts.ctx);
  // 闸门二：技能闸（默认 browse_web 只读技能；高危技能强制人审，不自动开工）
  const skillKey = opts.skillKey ?? "browse_web";
  let cap: SkillCap;
  try {
    cap = await assertSkillGate(skillKey, domain);
  } catch (e) {
    await stQuery(
      sql`INSERT INTO st_claw_operations (op_no, instance_key, ctx_json, actor, task, skill_key, domain, risk, status, error)
          VALUES (${opNo}, ${instanceKey}, ${ctxJson}, ${opts.actor}, ${opts.task}, ${skillKey}, ${domain}, 'high', 'rejected', ${e instanceof Error ? e.message.slice(0, 200) : "skill-gate"})`,
    );
    throw e;
  }
  if (domain && !allowed.includes(domain)) {
    await stQuery(
      sql`INSERT INTO st_claw_operations (op_no, instance_key, ctx_json, actor, task, skill_key, domain, risk, status, error)
          VALUES (${opNo}, ${instanceKey}, ${ctxJson}, ${opts.actor}, ${opts.task}, ${skillKey}, ${domain}, 'low', 'rejected', ${`域名不在白名单：${domain}`})`,
    );
    return { ok: false, opNo, autoStarted: false, message: `域名 ${domain} 不在白名单，任务已拒绝并留痕（允许：${allowed.join("、")}）` };
  }
  // 闸门三前置：高危技能（fill_form/submit_form/download_file）一律强制人审，绝不自动开工
  if (cap.risk === "high") {
    await stQuery(
      sql`INSERT INTO st_claw_operations (op_no, instance_key, ctx_json, actor, task, skill_key, domain, risk, approval_level, status)
          VALUES (${opNo}, ${instanceKey}, ${ctxJson}, ${opts.actor}, ${opts.task}, ${skillKey}, ${domain}, 'high', 'l2_tenant', 'pending')`,
    );
    return { ok: true, opNo, autoStarted: false, message: `技能「${cap.displayName}」为高危动作，任务已转人工审批（单号 ${opNo}），批准后由龙虾执行` };
  }
  // 并发互斥：同实例 running 期间自动单转 pending 排队
  const busy = await stQuery(
    sql`SELECT op_no AS opNo FROM st_claw_operations WHERE instance_key = ${instanceKey} AND status = 'running' LIMIT 1`,
  );
  if (busy[0]) {
    await stQuery(
      sql`INSERT INTO st_claw_operations (op_no, instance_key, ctx_json, actor, task, skill_key, domain, risk, status)
          VALUES (${opNo}, ${instanceKey}, ${ctxJson}, ${opts.actor}, ${opts.task}, ${skillKey}, ${domain}, 'low', 'pending')`,
    );
    return { ok: true, opNo, autoStarted: false, message: `龙虾正在忙（单 ${String(busy[0].opNo)}），任务已排队为待办单 ${opNo}，空闲后由管理员一键开工` };
  }
  // 闸门一路由：本机无 docker → 入 s3 执行队列（approved_at 直置=低风险单免审），由 s3 worker 认领执行
  if (!(await hasDocker())) {
    await stQuery(
      sql`INSERT INTO st_claw_operations (op_no, instance_key, ctx_json, actor, task, skill_key, domain, risk, status, exec_host, approved_by, approved_at)
          VALUES (${opNo}, ${instanceKey}, ${ctxJson}, ${opts.actor}, ${opts.task}, ${skillKey}, ${domain}, 'low', 'pending', 's3', 'queue:auto', NOW())`,
    );
    return { ok: true, opNo, autoStarted: false, message: `龙虾任务已受理并排入执行队列（单号 ${opNo}），浏览器任务约 3-10 分钟，完成后证据会自动出现在本对话` };
  }
  await stQuery(
    sql`INSERT INTO st_claw_operations (op_no, instance_key, ctx_json, actor, task, skill_key, domain, risk, status)
        VALUES (${opNo}, ${instanceKey}, ${ctxJson}, ${opts.actor}, ${opts.task}, ${skillKey}, ${domain}, 'low', 'running')`,
  );
  const rows = await stQuery(sql`SELECT id FROM st_claw_operations WHERE op_no = ${opNo} LIMIT 1`);
  void runClawTask(opNo, Number(rows[0].id), opts.task, opts.actor, inst, opts.ctx);
  return { ok: true, opNo, autoStarted: true, message: `龙虾已开工（单号 ${opNo}），浏览器任务约 3-10 分钟，完成后证据会自动出现在本对话` };
}

/** confirmClawOp（共享 helper：clawConfirm 与审批中心共用）：pending → running + 异步执行，含并发互斥 */
export async function confirmClawOp(opNo: string, actorName: string): Promise<{ message: string }> {
  const rows = await stQuery(
    sql`SELECT id, task, status, instance_key AS instanceKey, ctx_json AS ctxJson FROM st_claw_operations WHERE op_no = ${opNo} LIMIT 1`,
  );
  const op = rows[0];
  if (!op) throw new TRPCError({ code: "NOT_FOUND", message: "操作单不存在" });
  if (String(op.status) !== "pending") {
    throw new TRPCError({ code: "BAD_REQUEST", message: `操作单当前状态 ${String(op.status)}，不可审批执行` });
  }
  const instanceKey = op.instanceKey ? String(op.instanceKey) : "main";
  const inst = await resolveInstance(instanceKey);
  // 并发互斥：OpenClaw 单 agent 会话不支持并发驱动（iter48 实证 SessionTakeoverError），同实例只允许一个 running
  const busy = await stQuery(
    sql`SELECT op_no AS opNo FROM st_claw_operations
        WHERE instance_key = ${instanceKey} AND status = 'running' LIMIT 1`,
  );
  if (busy[0]) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `实例 ${inst.displayName} 忙：操作单 ${String(busy[0].opNo)} 执行中，待其终态后再审批（单会话并发互斥保护）`,
    });
  }
  // iter81 闸门一路由：本机无 docker → 审批通过后入 s3 队列（保持 pending + exec_host='s3'），由 s3 worker 认领
  if (!(await hasDocker())) {
    await stQuery(sql`UPDATE st_claw_operations SET exec_host = 's3' WHERE op_no = ${opNo} AND status = 'pending'`);
    return { message: `已审批通过，任务已排入龙虾执行队列（单 ${opNo}），执行完成后证据自动回流` };
  }
  await stQuery(sql`UPDATE st_claw_operations SET status = 'running' WHERE op_no = ${opNo} AND status = 'pending'`);
  let opCtx: ClawOpCtx | undefined;
  try { opCtx = op.ctxJson ? (JSON.parse(String(op.ctxJson)) as ClawOpCtx) : undefined; } catch { opCtx = undefined; }
  void runClawTask(opNo, Number(op.id), String(op.task), actorName, inst, opCtx);
  return { message: `已审批通过，${inst.displayName} 后台执行中（浏览器任务约 3-10 分钟），稍后刷新查看结果` };
}

/** rejectClawOp（共享 helper）：pending → rejected 留痕 */
export async function rejectClawOp(opNo: string): Promise<void> {
  await stQuery(
    sql`UPDATE st_claw_operations SET status = 'rejected', finished_at = NOW()
        WHERE op_no = ${opNo} AND status = 'pending'`,
  );
}

// ─── iter81 闸门一 · s3 执行器（ENABLE_CLAW_WORKER=1 时由 boot 启动）────────
/** 认领一张 s3 队列单（pending + exec_host='s3' + 已审批）→ 本机 docker 执行 → 写回。
 *  条件更新防双跑；单实例 worker，无需分布式锁。s3 宕机时单留在队列，恢复后补跑。 */
let workerBusy = false;
export function startClawWorker(): void {
  setInterval(() => {
    void (async () => {
      if (workerBusy) return;
      if (!(await hasDocker())) return;
      const cand = await stQuery(
        sql`SELECT op_no AS opNo FROM st_claw_operations
            WHERE status = 'pending' AND exec_host = 's3' AND approved_at IS NOT NULL
            ORDER BY id ASC LIMIT 1`,
      );
      const opNo = cand[0]?.opNo ? String(cand[0].opNo) : null;
      if (!opNo) return;
      workerBusy = true;
      try {
        // 条件认领：仍 pending 才转 running（防并发双跑）
        await stQuery(sql`UPDATE st_claw_operations SET status = 'running' WHERE op_no = ${opNo} AND status = 'pending' AND exec_host = 's3'`);
        const check = await stQuery(sql`SELECT status FROM st_claw_operations WHERE op_no = ${opNo} LIMIT 1`);
        if (String(check[0]?.status) !== "running") return; // 被别处抢走/已变化，放弃
        const rows = await stQuery(
          sql`SELECT id, task, instance_key AS instanceKey, ctx_json AS ctxJson FROM st_claw_operations WHERE op_no = ${opNo} LIMIT 1`,
        );
        const op = rows[0];
        if (!op) return;
        const inst = await resolveInstance(op.instanceKey ? String(op.instanceKey) : "main");
        let opCtx: ClawOpCtx | undefined;
        try { opCtx = op.ctxJson ? (JSON.parse(String(op.ctxJson)) as ClawOpCtx) : undefined; } catch { opCtx = undefined; }
        console.log(`[claw-worker] 认领队列单 ${opNo}，开始执行`);
        await runClawTask(opNo, Number(op.id), String(op.task), "claw-worker", inst, opCtx);
      } catch (e) {
        noteSilent("claw.worker.claim", e);
      } finally {
        workerBusy = false;
      }
    })().catch((e) => noteSilent("claw.worker.tick", e));
  }, 10_000);
  console.log("[claw-worker] s3 执行队列轮询已启动（ENABLE_CLAW_WORKER=1）");
}
