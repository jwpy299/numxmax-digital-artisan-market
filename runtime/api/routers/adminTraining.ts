/**
 * 数字员工训练实时屏：ready→training→evaluated→published；训练/上架写动作按舱角色与 C 级双签收束。
 * 评测只接受 runner 专用密钥，且必须匹配训练版本与 training 状态，普通管理员不能自报分数。
 */
import { timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { rawRows } from "../queries/rawRows";
import { requireAdmin } from "../auth/adminGate";
import { requireCabinAction } from "../auth/cabinGate";
import { requireDualSign } from "../auth/adminDualSign";
import { guardInfra } from "../auth/identity";
import { affectedRowsOf, insertIdOf } from "../lib/dbResult";
import { isDupColumn } from "../lib/dupEntry";
import { hqFactoryId } from "../lib/hq";
import { writeAdminAudit } from "./adminAnalytics";
import { PKG_CATALOG, type PkgDeptKey } from "@contracts/pkgCatalog";

const tokenInput = z.object({ token: z.string().trim().min(1) });
const reviewTokenInput = z.object({ reviewToken: z.string().trim().min(1) });
const LEGACY_PKG_KEYS = ["dept_finance", "dept_legal", "dept_marketing", "dept_synergy"] as const;
const CATALOG_PKG_KEYS = PKG_CATALOG.filter((p) => p.packageTier !== "global").map((p) => p.key);
const PKG_KEYS = [...new Set([...LEGACY_PKG_KEYS, ...CATALOG_PKG_KEYS])] as [string, ...string[]];
const EVAL_PASS_SCORE = 70;
const TRAINING_STALE_MINUTES = (() => {
  const n = Number(process.env.TRAINING_STALE_MINUTES ?? "120");
  return Number.isInteger(n) && n >= 15 && n <= 10_080 ? n : 120;
})();
const DEPT_STATION_PREFIX: Record<PkgDeptKey, string> = {
  finance: "dept-finance",
  sales: "dept-sales",
  production: "dept-production",
  procurement: "dept-procurement",
  quality: "dept-quality",
  hr: "dept-hr",
  research: "dept-research",
  warehouse: "dept-warehouse",
  it: "dept-it",
  legal: "dept-legal",
  admin: "dept-admin",
  cs: "dept-cs",
  marketing: "dept-marketing",
};
const DEPT_MAP: Record<string, string> = {
  dept_finance: "dept-finance",
  dept_legal: "dept-legal",
  dept_marketing: "dept-marketing",
  dept_synergy: "dept-synergy",
  syn_prod_supply: "syn-prod-supply",
  syn_sales_fin: "syn-sales-fin",
  syn_quality: "syn-quality",
  syn_hr_fin: "syn-hr-fin",
  syn_digital: "syn-digital",
  ...Object.fromEntries(PKG_CATALOG.filter((p) => p.deptCode).map((p) => [p.key, DEPT_STATION_PREFIX[p.deptCode!]])),
};
const PKG_LABELS: Record<string, string> = {
  dept_finance: "财务",
  dept_legal: "法务",
  dept_marketing: "市场",
  dept_synergy: "协同",
  ...Object.fromEntries(PKG_CATALOG.map((p) => [p.key, p.name])),
};
const DEPT_LABEL_BY_CODE: Record<PkgDeptKey, string> = {
  finance: "财务部",
  sales: "销售部",
  production: "生产部",
  procurement: "采购部",
  quality: "质检部",
  hr: "人力资源部",
  research: "研发部",
  warehouse: "仓储物流部",
  it: "IT 部",
  legal: "法务部",
  admin: "行政部",
  cs: "客服部",
  marketing: "市场部",
};
const DEPT_LABEL_BY_PKG: Record<string, string> = {
  dept_finance: "财务部",
  dept_legal: "法务部",
  dept_marketing: "市场部",
  dept_synergy: "跨部门协同",
  ...Object.fromEntries(PKG_CATALOG.filter((p) => p.packageTier !== "global").map((p) => [
    p.key,
    p.deptCode ? DEPT_LABEL_BY_CODE[p.deptCode] : (p.scopeLabel || "跨部门协同"),
  ])),
};

type TrainingPkgConfig = { stationPrefix: string; pkgLabel: string; deptLabel: string };
function trainingPkgConfigOrNull(pkg: string): TrainingPkgConfig | null {
  const stationPrefix = DEPT_MAP[pkg];
  const pkgLabel = PKG_LABELS[pkg];
  const deptLabel = DEPT_LABEL_BY_PKG[pkg];
  if (!stationPrefix || !pkgLabel || !deptLabel) return null;
  return { stationPrefix, pkgLabel, deptLabel };
}
function trainingPkgConfig(pkg: string): TrainingPkgConfig {
  const config = trainingPkgConfigOrNull(pkg);
  if (!config) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "订阅包训练映射不完整——禁止跨部门或全域混训" });
  return config;
}

let ready: Promise<void> | null = null;
function ensureTrainingJobs(): Promise<void> {
  if (!ready) {
    ready = getDb()
      .execute(sql`CREATE TABLE IF NOT EXISTS st_training_jobs (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        pkg VARCHAR(40) NOT NULL,
        dept VARCHAR(48) NOT NULL DEFAULT '',
        status VARCHAR(16) NOT NULL DEFAULT 'ready',
        sample_count INT NOT NULL DEFAULT 0,
        lora_version VARCHAR(40) NOT NULL DEFAULT '',
        eval_score INT NULL,
        heartbeat_at DATETIME NULL,
        agent_id BIGINT NULL,
        note VARCHAR(300) NOT NULL DEFAULT '',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_pkg (pkg)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      .then(async () => {
        await getDb().execute(sql`ALTER TABLE st_training_jobs ADD COLUMN heartbeat_at DATETIME NULL AFTER eval_score`)
          .catch((e: unknown) => { if (!isDupColumn(e)) throw e; });
      })
      .catch((e) => { ready = null; throw e; });
  }
  return ready;
}

function trainingSamplesTable(): string {
  const table = (process.env.TRAINING_SAMPLES_TABLE ?? "dsh_sandbox.nh_training_samples").trim();
  if (!/^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(table)) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "TRAINING_SAMPLES_TABLE 配置无效——须为 schema.table" });
  }
  return table;
}

async function trainingSampleCount(db: ReturnType<typeof getDb>, stationKeyPrefix: string): Promise<number> {
  if (!stationKeyPrefix) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "该订阅包缺少独立 station_key——禁止跨部门或全域混训" });
  const table = trainingSamplesTable();
  try {
    const factoryId = hqFactoryId();
    const rows = rawRows(await db.execute(
      sql`SELECT COUNT(*) AS n FROM ${sql.raw(table)} WHERE factory_id=${factoryId} AND station_key LIKE ${`${stationKeyPrefix}%`}`,
    ));
    return Number(rows[0]?.n ?? 0);
  } catch (e) {
    const errno = Number((e as { errno?: number })?.errno ?? 0);
    if (errno === 1049 || errno === 1146) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: `训练样本库表未接入：${table}——请先部署样本采集与授权` });
    }
    throw e;
  }
}

function secretOk(plain: string): boolean {
  const actual = Buffer.from(plain);
  const expected = Buffer.from(process.env.TRAINING_RUNNER_SECRET ?? "");
  if (expected.length < 32 || actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function marketConfig() {
  const masterId = Number(process.env.TRAINING_MARKET_MASTER_ID ?? "1");
  const monthlyPrice = Number(process.env.TRAINING_MARKET_MONTHLY_PRICE ?? "800");
  if (!Number.isInteger(masterId) || masterId <= 0 || !Number.isFinite(monthlyPrice) || monthlyPrice <= 0) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "训练上架配置无效——请核 masterId/价格" });
  }
  return {
    masterId,
    monthlyPrice,
    avatar: process.env.TRAINING_AGENT_AVATAR ?? "/avatar-chimou.png",
    industry: process.env.TRAINING_INDUSTRY ?? "装备制造",
    industryGroup: process.env.TRAINING_INDUSTRY_GROUP ?? "工业制造",
  };
}

function markRunnerFailed(pkg: string, version: string, note: string): void {
  void getDb().execute(sql`UPDATE st_training_jobs SET status='ready', note=${note.slice(0, 300)} WHERE pkg=${pkg} AND lora_version=${version} AND status='training'`).catch(() => undefined);
  writeAdminAudit(0, "training-runner", "adminTraining.runner", pkg, { version, note }); // 0=系统 runner，非人类管理员占位
}

function spawnTrainingRunner(pkg: string, version: string, stationPrefix: string, factoryId: number): void {
  const runnerPath = process.env.TRAINING_RUNNER_PATH ?? "scripts/run_training.sh";
  const child = spawn("bash", [runnerPath, pkg, version], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      TRAINING_STATION_PREFIX: stationPrefix,
      TRAINING_FACTORY_ID: String(factoryId),
    },
  });
  child.once("error", () => markRunnerFailed(pkg, version, "runner 启动失败——已回到可重试状态"));
  child.once("exit", (code, signal) => {
    if (code !== 0) {
      markRunnerFailed(pkg, version, `runner 异常退出（code=${code ?? "null"}/signal=${signal ?? "none"}）——已回到可重试状态`);
      return;
    }
    // 正常退出不等于评测完成：runner 可能先后台训练、再异步回写；保持 training，超时由租约回收，避免新旧版本并发互踩。
    void getDb().execute(sql`UPDATE st_training_jobs SET heartbeat_at=NOW(), note='runner 已退出，等待评测回写；超时未回写将由租约回收' WHERE pkg=${pkg} AND lora_version=${version} AND status='training'`).catch(() => undefined);
  });
  child.unref();
}

export const adminTrainingRouter = createRouter({
  jobs: publicQuery.input(tokenInput).query(async ({ input }) => {
    return guardInfra("adminTraining.jobs", async () => {
      await requireAdmin(input.token);
      await ensureTrainingJobs();
      const rows = rawRows(await getDb().execute(sql`SELECT id, pkg, dept, status, sample_count, lora_version, eval_score, heartbeat_at, agent_id, note, updated_at FROM st_training_jobs ORDER BY id`)) as Array<Record<string, unknown>>;
      const items = rows.map((row) => {
        const pkg = String(row.pkg ?? "");
        const config = trainingPkgConfigOrNull(pkg);
        return { ...row, dept: config?.deptLabel ?? String(row.dept ?? ""), pkgLabel: config?.pkgLabel ?? pkg };
      });
      return { items, evalPassScore: EVAL_PASS_SCORE };
    });
  }),

  build: publicQuery
    .input(tokenInput.extend({ pkg: z.enum(PKG_KEYS) }))
    .mutation(async ({ input }) => {
      return guardInfra("adminTraining.build", async () => {
        const actor = await requireCabinAction(input.token, "training");
        await ensureTrainingJobs();
        const db = getDb();
        const config = trainingPkgConfig(input.pkg);
        const n = await trainingSampleCount(db, config.stationPrefix);
        if (n < 8) throw new TRPCError({ code: "BAD_REQUEST", message: `该包样本 ${n} 件<8——训练厚度不够不训（攒够复核批注再开任务）` });
        await db.execute(sql`INSERT INTO st_training_jobs (pkg, dept, status, sample_count) VALUES (${input.pkg}, ${config.deptLabel}, 'ready', ${n}) ON DUPLICATE KEY UPDATE dept=IF(status IN ('training','evaluated','published'),dept,VALUES(dept)), eval_score=IF(status IN ('training','evaluated','published'),eval_score,NULL), lora_version=IF(status IN ('training','evaluated','published'),lora_version,''), status=IF(status IN ('training','evaluated','published'),status,'ready'), sample_count=IF(status IN ('training','evaluated','published'),sample_count,VALUES(sample_count))`);
        const after = rawRows(await db.execute(sql`SELECT status, sample_count FROM st_training_jobs WHERE pkg=${input.pkg} LIMIT 1`));
        const status = String(after[0]?.status ?? "");
        if (["training", "evaluated", "published"].includes(status)) throw new TRPCError({ code: "CONFLICT", message: "训练中/评测完成或已上架任务不重建——状态保持不变" });
        writeAdminAudit(actor.auditId, actor.username, "adminTraining.build", input.pkg, { sampleCount: n });
        return { ok: true as const, pkg: input.pkg, sampleCount: Number(after[0]?.sample_count ?? n) };
      });
    }),

  run: publicQuery
    .input(tokenInput.extend({ pkg: z.enum(PKG_KEYS), ...reviewTokenInput.shape }))
    .mutation(async ({ input }) => {
      return guardInfra("adminTraining.run", async () => {
        const sign = await requireDualSign(input.token, input.reviewToken, "training");
        const config = trainingPkgConfig(input.pkg);
        const factoryId = hqFactoryId();
        await ensureTrainingJobs();
        const db = getDb();
        // API 重启/runner 失联后的恢复面：只回收超过租约的旧 training，正常长任务仍 dedup，不重复 spawn。
        await db.execute(sql`UPDATE st_training_jobs SET status='ready', note='训练租约超时未回写——已回收，可重试' WHERE pkg=${input.pkg} AND status='training' AND (heartbeat_at IS NULL OR heartbeat_at < DATE_SUB(NOW(), INTERVAL ${TRAINING_STALE_MINUTES} MINUTE))`);
        const version = `${input.pkg}-lora-v${Date.now().toString(36)}`;
        const claim = await db.execute(sql`UPDATE st_training_jobs SET status='training', lora_version=${version}, eval_score=NULL, heartbeat_at=NOW(), note='' WHERE pkg=${input.pkg} AND status IN ('ready','evaluated')`);
        if (affectedRowsOf(claim) !== 1) {
          const rows = rawRows(await db.execute(sql`SELECT status FROM st_training_jobs WHERE pkg=${input.pkg} LIMIT 1`));
          const cur = String(rows[0]?.status ?? "");
          if (cur === "training") return { ok: true as const, pkg: input.pkg, status: "training", dedup: true };
          throw new TRPCError({ code: "BAD_REQUEST", message: "先 build 备样本，且当前状态须可启动训练" });
        }
        // spawn 的 ENOENT 走异步 error 事件（spawnTrainingRunner 内已处理），不写无效的同步 catch 假守卫。
        spawnTrainingRunner(input.pkg, version, config.stationPrefix, factoryId);
        writeAdminAudit(sign.operatorId, sign.operator, "adminTraining.run", input.pkg, { version, reviewer: sign.reviewer, reviewerId: sign.reviewerId });
        return { ok: true as const, pkg: input.pkg, status: "training", version };
      });
    }),

  evalReport: publicQuery
    .input(z.object({
      pkg: z.enum(PKG_KEYS),
      version: z.string().trim().min(5).max(40),
      score: z.number().int().min(0).max(100),
      note: z.string().trim().max(300).optional(),
      runnerSecret: z.string().min(32).max(256),
    }))
    .mutation(async ({ input }) => {
      return guardInfra("adminTraining.evalReport", async () => {
        if (!secretOk(input.runnerSecret)) throw new TRPCError({ code: "UNAUTHORIZED", message: "runner 凭证无效" });
        await ensureTrainingJobs();
        const db = getDb();
        const upd = await db.execute(sql`UPDATE st_training_jobs SET status='evaluated', eval_score=${input.score}, heartbeat_at=NOW(), note=${input.note ?? ""} WHERE pkg=${input.pkg} AND lora_version=${input.version} AND status='training'`);
        if (affectedRowsOf(upd) !== 1) throw new TRPCError({ code: "CONFLICT", message: "训练版本或状态不匹配——评测不回写" });
        writeAdminAudit(0, "training-runner", "adminTraining.evalReport", input.pkg, { version: input.version, score: input.score }); // 系统 runner 留痕
        return { ok: true as const, score: input.score };
      });
    }),

  publish: publicQuery
    .input(tokenInput.extend({ pkg: z.enum(PKG_KEYS), ...reviewTokenInput.shape }))
    .mutation(async ({ input }) => {
      return guardInfra("adminTraining.publish", async () => {
        const sign = await requireDualSign(input.token, input.reviewToken, "training");
        const config = trainingPkgConfig(input.pkg);
        await ensureTrainingJobs();
        const db = getDb();
        const result = await db.transaction(async (tx) => {
          const rows = rawRows(await tx.execute(sql`SELECT status, eval_score, agent_id FROM st_training_jobs WHERE pkg=${input.pkg} LIMIT 1 FOR UPDATE`)) as Array<Record<string, unknown>>;
          const row = rows[0] as { status?: string; eval_score?: number | null; agent_id?: number | null } | undefined;
          if (row?.status === "published") return { dedup: true as const, agentId: Number(row.agent_id ?? 0) || null };
          if (!row || row.status !== "evaluated") throw new TRPCError({ code: "BAD_REQUEST", message: "先训练并评测——未达 evaluated 面不许上架" });
          const score = Number(row.eval_score ?? 0);
          if (score < EVAL_PASS_SCORE) throw new TRPCError({ code: "BAD_REQUEST", message: `评测 ${score}<${EVAL_PASS_SCORE} 分——未达上岗阈值，继续攒样再训，不上架` });
          const cfg = marketConfig();
          const name = `${config.pkgLabel}数字员工（${config.deptLabel}·训练版）`;
          const slug = `${input.pkg.replace(/_/g, "-")}-trained`;
          const codeRows = rawRows(await tx.execute(sql`SELECT MAX(CAST(SUBSTRING(code, 5) AS UNSIGNED)) AS max_code FROM agents WHERE code REGEXP '^ART-[0-9]+$'`)) as Array<Record<string, unknown>>;
          const nextCode = Number(codeRows[0]?.max_code ?? 0) + 1;
          if (!Number.isSafeInteger(nextCode) || nextCode <= 0) throw new Error("ART 编号序列无效");
          const code = `ART-${String(nextCode).padStart(4, "0")}`;
          const capability = JSON.stringify([config.deptLabel, "复核", "办公技能包"]);
          const intro = `按${config.deptLabel}订阅包训练上岗的数字员工：${config.pkgLabel}。复核批注回流训练+LoRA 微调达标（评测 ${score} 分≥${EVAL_PASS_SCORE} 分阈值）——主管拆解派活+复核岗把口+真件交付。`;
          const ins = await tx.execute(sql`INSERT INTO agents (slug, code, name, avatar, intro_text, industry, industryGroup, capabilityTags, masterId, status, monthlyPrice, suggestedPrice, weeklyHireTrend) VALUES (${slug}, ${code}, ${name}, ${cfg.avatar}, ${intro}, ${cfg.industry}, ${cfg.industryGroup}, ${capability}, ${cfg.masterId}, 'pending', ${cfg.monthlyPrice}, ${cfg.monthlyPrice}, '[]')`);
          const agentId = insertIdOf(ins);
          if (!agentId) throw new Error("agents 上架未返回有效 id");
          const upd = await tx.execute(sql`UPDATE st_training_jobs SET status='published', agent_id=${agentId} WHERE pkg=${input.pkg} AND status='evaluated'`);
          if (affectedRowsOf(upd) !== 1) throw new Error("训练任务发布状态竞争——事务回滚");
          return { dedup: false as const, agentId };
        });
        if (!result.dedup) writeAdminAudit(sign.operatorId, sign.operator, "adminTraining.publish", input.pkg, { agentId: result.agentId, reviewer: sign.reviewer, reviewerId: sign.reviewerId });
        return { ok: true as const, pkg: input.pkg, status: "published", agentId: result.agentId, dedup: result.dedup };
      });
    }),
});
