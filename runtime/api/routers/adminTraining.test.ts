import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { PKG_CATALOG } from "@contracts/pkgCatalog";

const dialect = new MySqlDialect();
const RUNNER_SECRET = "r".repeat(32);

async function fresh(opts: { samples?: number; jobRow?: Record<string, unknown>; roles?: string; evalAffected?: number } = {}) {
  vi.resetModules();
  vi.stubEnv("ADMIN_CABIN_ROLES", opts.roles ?? "peng:admin:all,song:tech:tech");
  vi.stubEnv("HQ_FACTORY_IDS", "6380240");
  vi.stubEnv("TRAINING_RUNNER_SECRET", RUNNER_SECRET);
  vi.doMock("../auth/adminGate", () => ({
    requireAdmin: vi.fn(async (token: string) => ({ grant: true, id: token === "tech" ? 2 : 1, username: token === "tech" ? "song" : "peng", displayName: token === "tech" ? "宋" : "彭" })),
    hqFactoryIds: () => [6380240],
  }));
  const captured: string[] = [];
  const capturedParams: unknown[][] = [];
  const execute = vi.fn(async (stmt: unknown) => {
    const q = dialect.sqlToQuery(stmt as never);
    captured.push(q.sql);
    capturedParams.push(q.params);
    if (q.sql.includes("COUNT(*)")) return [[{ n: opts.samples ?? 16 }], []];
    if (q.sql.includes("FROM st_training_jobs") && q.sql.includes("SELECT")) return [opts.jobRow ? [opts.jobRow] : [], []];
    if (q.sql.includes("UPDATE st_training_jobs SET status='training'")) {
      const cur = String(opts.jobRow?.status ?? "");
      return [{ affectedRows: ["ready", "evaluated"].includes(cur) ? 1 : 0 }, []];
    }
    if (q.sql.includes("UPDATE st_training_jobs SET status='evaluated'")) return [{ affectedRows: opts.evalAffected ?? 1 }, []];
    if (q.sql.includes("UPDATE st_training_jobs")) return [{ affectedRows: 1 }, []];
    if (q.sql.includes("INSERT INTO agents")) return [{ insertId: 33 }, []];
    return [[], []];
  });
  vi.doMock("../queries/connection", () => ({
    getDb: () => ({ execute, transaction: async (fn: (tx: { execute: typeof execute }) => unknown) => fn({ execute }) }),
  }));
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  const spawnMock = vi.fn(() => child);
  vi.doMock("node:child_process", () => ({ spawn: spawnMock }));
  vi.doMock("./adminAnalytics", () => ({ writeAdminAudit: vi.fn() }));
  const mod = await import("./adminTraining");
  return { mod, captured, capturedParams, spawnMock, child };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("adminTraining 训练任务面", () => {
  it("build：样本<8=明拒不训", async () => {
    const { mod } = await fresh({ samples: 3 });
    await expect(mod.adminTrainingRouter.createCaller({} as never).build({ token: "boss", pkg: "dept_finance" })).rejects.toThrow("厚度不够");
  });

  it("build：样本够=ready；training 状态不被重建覆盖", async () => {
    const ok = await fresh({ samples: 16 });
    const r = await ok.mod.adminTrainingRouter.createCaller({} as never).build({ token: "boss", pkg: "dept_finance" });
    expect(r.sampleCount).toBe(16);
    const locked = await fresh({ samples: 16, jobRow: { status: "training", sample_count: 9 } });
    await expect(locked.mod.adminTrainingRouter.createCaller({} as never).build({ token: "boss", pkg: "dept_finance" })).rejects.toThrow("不重建");
    expect(locked.captured.some((q) => q.includes("IF(status IN ('training','evaluated','published')"))).toBe(true);
    expect(locked.captured.some((q) => q.includes("eval_score=IF"))).toBe(true);
    expect(locked.captured.some((q) => q.includes("lora_version=IF"))).toBe(true);
    const evaluated = await fresh({ samples: 16, jobRow: { status: "evaluated", sample_count: 12 } });
    await expect(evaluated.mod.adminTrainingRouter.createCaller({} as never).build({ token: "boss", pkg: "dept_finance" })).rejects.toThrow("不重建");
    expect(evaluated.captured.some((q) => q.includes("IF(status IN ('training','evaluated','published')"))).toBe(true);
  });

  it("build：未配置舱角色的 admin 也只有只读权", async () => {
    const { mod } = await fresh({ roles: "" });
    await expect(mod.adminTrainingRouter.createCaller({} as never).build({ token: "boss", pkg: "dept_finance" })).rejects.toThrow("只读");
  });

  it("run：未 build=明拒", async () => {
    const { mod } = await fresh({ jobRow: undefined });
    await expect(mod.adminTrainingRouter.createCaller({} as never).run({ token: "boss", reviewToken: "tech", pkg: "dept_finance" })).rejects.toThrow("先 build");
  });

  it("run：原子认领成功才 spawn；training 并发只 dedup 不重复 spawn", async () => {
    const ok = await fresh({ jobRow: { status: "ready" } });
    const r = await ok.mod.adminTrainingRouter.createCaller({} as never).run({ token: "boss", reviewToken: "tech", pkg: "dept_finance" });
    expect(r.status).toBe("training");
    expect(ok.spawnMock).toHaveBeenCalledTimes(1);
    expect(ok.captured.some((q) => q.includes("AND status IN ('ready','evaluated')"))).toBe(true);
    expect(ok.captured.some((q) => q.includes("eval_score=NULL") && q.includes("heartbeat_at=NOW()"))).toBe(true);
    const dup = await fresh({ jobRow: { status: "training" } });
    const d = await dup.mod.adminTrainingRouter.createCaller({} as never).run({ token: "boss", reviewToken: "tech", pkg: "dept_finance" });
    expect(d.dedup).toBe(true);
    expect(dup.spawnMock).not.toHaveBeenCalled();
  });

  it("evalReport：普通自报无 runner 密钥=拒；正确密钥也须匹配版本状态", async () => {
    const bad = await fresh({ jobRow: { status: "training" } });
    await expect(bad.mod.adminTrainingRouter.createCaller({} as never).evalReport({ pkg: "dept_finance", version: "dept_finance-lora-v1", score: 99, runnerSecret: "x".repeat(32) })).rejects.toThrow("runner 凭证无效");
    const ok = await fresh({ jobRow: { status: "training" } });
    const r = await ok.mod.adminTrainingRouter.createCaller({} as never).evalReport({ pkg: "dept_finance", version: "dept_finance-lora-v1", score: 88, runnerSecret: RUNNER_SECRET });
    expect(r.ok).toBe(true);
    expect(ok.captured.some((q) => q.includes("lora_version=") && q.includes("status='training'"))).toBe(true);
  });

  it("evalReport：同字符数的多字节伪造密钥只返未授权，不触发 timingSafeEqual 长度异常", async () => {
    const { mod } = await fresh({ jobRow: { status: "training" } });
    await expect(mod.adminTrainingRouter.createCaller({} as never).evalReport({ pkg: "dept_finance", version: "dept_finance-lora-v1", score: 99, runnerSecret: "é".repeat(32) })).rejects.toThrow("runner 凭证无效");
  });

  it("run：超时租约先回收；runner 正常退出仍等评测，不直接回 ready", async () => {
    const { mod, captured, child } = await fresh({ jobRow: { status: "ready" } });
    await mod.adminTrainingRouter.createCaller({} as never).run({ token: "boss", reviewToken: "tech", pkg: "dept_finance" });
    expect(captured.some((q) => q.includes("训练租约超时未回写") && q.includes("heartbeat_at < DATE_SUB"))).toBe(true);
    expect(captured.some((q) => q.includes("updated_at < DATE_SUB"))).toBe(false);
    child.emit("exit", 0, null);
    await new Promise((resolve) => setImmediate(resolve));
    expect(captured.some((q) => q.includes("等待评测回写") && !q.includes("status='ready'"))).toBe(true);
    expect(captured.some((q) => q.includes("runner 已退出但未回写评测——可重试"))).toBe(false);
  });

  it("runner 源件入仓：60 秒真实心跳+退出清理，长训练不靠 updated_at 误杀", async () => {
    const script = readFileSync(new URL("../../scripts/run_training.sh", import.meta.url), "utf8");
    expect(script).toContain("sleep 60");
    expect(script).toContain("/proc/$MAIN_PID");
    expect(script).toContain("StrictHostKeyChecking=yes");
    expect(script).not.toContain("StrictHostKeyChecking=no");
    expect(script).toContain("SCNET_KNOWN_HOSTS");
    expect(script).toContain("--defaults-extra-file");
    expect(script).not.toContain("-p\"$DBPW\"");
    expect(script).toContain("report_training_eval.py");
    expect(script).not.toContain("[ -z \"$SCORE\" ] && SCORE=0");
    expect(script).toContain("heartbeat_at=NOW()");
    expect(script).toContain("lora_version='$VER'");
    expect(script).toContain("trap 'kill");
    expect(script).toContain("timeout --signal=TERM --kill-after=10s");
    expect(script).toContain("300 python3");
    expect(script).toContain("60 scp");
    expect(script).toContain("7200 ssh");
    expect(script).toContain("1800 ssh");
    expect(script).toContain('15 "${MYSQL[@]}"');
    expect(script).toContain("对拉评测失败");
    const { mod, captured } = await fresh({ jobRow: { status: "ready" } });
    await mod.adminTrainingRouter.createCaller({} as never).run({ token: "boss", reviewToken: "tech", pkg: "dept_finance" });
    expect(captured.some((q) => q.includes("heartbeat_at DATETIME NULL"))).toBe(true);
  });

  it("publish：未达 evaluated/阈值=明拒不上架", async () => {
    const a = await fresh({ jobRow: { status: "training", eval_score: null, dept: "财务部" } });
    await expect(a.mod.adminTrainingRouter.createCaller({} as never).publish({ token: "boss", reviewToken: "tech", pkg: "dept_finance" })).rejects.toThrow("未达 evaluated");
    const b = await fresh({ jobRow: { status: "evaluated", eval_score: 55, dept: "财务部" } });
    await expect(b.mod.adminTrainingRouter.createCaller({} as never).publish({ token: "boss", reviewToken: "tech", pkg: "dept_finance" })).rejects.toThrow("未达上岗阈值");
  });

  it("publish：空价格配置不允许 0 元上架", async () => {
    const { mod } = await fresh({ jobRow: { status: "evaluated", eval_score: 90, dept: "财务部" } });
    vi.stubEnv("TRAINING_MARKET_MONTHLY_PRICE", " ");
    await expect(mod.adminTrainingRouter.createCaller({} as never).publish({ token: "boss", reviewToken: "tech", pkg: "dept_finance" })).rejects.toThrow("配置无效");
  });

  it("publish：双签同人=明拒", async () => {
    const { mod } = await fresh({ jobRow: { status: "evaluated", eval_score: 90, dept: "财务部" } });
    await expect(mod.adminTrainingRouter.createCaller({} as never).publish({ token: "boss", reviewToken: "boss", pkg: "dept_finance" })).rejects.toThrow("同一人");
  });

  it("publish：事务行锁+agents pending 上架；已发布重复调用只 dedup", async () => {
    const ok = await fresh({ jobRow: { status: "evaluated", eval_score: 90, dept: "财务部" } });
    const r = await ok.mod.adminTrainingRouter.createCaller({} as never).publish({ token: "boss", reviewToken: "tech", pkg: "dept_finance" });
    expect(r.agentId).toBe(33);
    const ins = ok.captured.find((q) => q.includes("INSERT INTO agents"));
    expect(ins).toContain("'pending'");
    expect(ins).toContain("weeklyHireTrend");
    expect(ok.captured.some((q) => q.includes("MAX(CAST(SUBSTRING(code, 5) AS UNSIGNED))"))).toBe(true);
    const trainingSource = readFileSync(new URL("./adminTraining.ts", import.meta.url), "utf8");
    expect(trainingSource).toContain("${cfg.industry}, ${cfg.industryGroup}, ${capability}");
    expect(ok.captured.some((q) => q.includes("FOR UPDATE"))).toBe(true);
    const dup = await fresh({ jobRow: { status: "published", agent_id: 33 } });
    const d = await dup.mod.adminTrainingRouter.createCaller({} as never).publish({ token: "boss", reviewToken: "tech", pkg: "dept_finance" });
    expect(d.dedup).toBe(true);
    expect(dup.captured.some((q) => q.includes("INSERT INTO agents"))).toBe(false);
  });
});


describe("训练包独立命名空间与上传脚本", () => {
  it("协同包不使用空前缀或借用其他部门样本；runner 上传评测与同源脚本", () => {
    const source = readFileSync(new URL("./adminTraining.ts", import.meta.url), "utf8");
    expect(source).toContain('dept_synergy: "dept-synergy"');
    expect(source).toContain('syn_prod_supply: "syn-prod-supply"');
    expect(source).toContain('syn_sales_fin: "syn-sales-fin"');
    expect(source).toContain('syn_quality: "syn-quality"');
    expect(source).toContain('syn_hr_fin: "syn-hr-fin"');
    expect(source).toContain('syn_digital: "syn-digital"');
    expect(source).not.toContain('dept_synergy: ""');
    expect(source).toContain("订阅包缺少独立 station_key——禁止跨部门或全域混训");
    const script = readFileSync(new URL("../../scripts/run_training.sh", import.meta.url), "utf8");
    expect(script).toContain("${SCNET_REMOTE_WORK_ROOT:-/opt/train/sandboxes}/$VER");
    expect(script).toContain("$SAMPLE_OUT.eval.jsonl");
    expect(script).toContain("train_lora.py");
    expect(script).toContain("eval_reviewer.py");
    expect(script).toContain("generation_utils.py");
    expect(script).toContain('bash "$SCRIPT_DIR/start_inference.sh"');
  });
});


describe("训练发布标签与 runner 状态保护", () => {
  it("publish 分离实际包标签和部门；旧 dept 不进入名称，fail_job 只重置 training", async () => {
    const ok = await fresh({ jobRow: { status: "evaluated", eval_score: 90, dept: "财务基础包" } });
    const r = await ok.mod.adminTrainingRouter.createCaller({} as never).publish({ token: "boss", reviewToken: "tech", pkg: "fin_basic" });
    expect(r.ok).toBe(true);
    expect(ok.capturedParams.some((params) => params.includes("财务基础包数字员工（财务部·训练版）"))).toBe(true);
    expect(ok.capturedParams.some((params) => params.includes("财务基础包数字员工（财务基础包·训练版）"))).toBe(false);
    expect(ok.capturedParams.some((params) => params.includes(JSON.stringify(["财务部", "复核", "办公技能包"])))).toBe(true);
    const legacy = await fresh({ jobRow: { status: "evaluated", eval_score: 90, dept: "错误包名" } });
    await legacy.mod.adminTrainingRouter.createCaller({} as never).publish({ token: "boss", reviewToken: "tech", pkg: "dept_finance" });
    expect(legacy.capturedParams.some((params) => params.includes("财务数字员工（财务部·训练版）"))).toBe(true);
    expect(legacy.capturedParams.some((params) => params.includes("错误包名"))).toBe(false);
    const script = readFileSync(new URL("../../scripts/run_training.sh", import.meta.url), "utf8");
    expect(script).toContain("AND status='training'");
    expect(script).not.toContain("lora_version='$VER' AND status='published'");
  });

  it("build 的 dept 只写部门；jobs 按 pkg 修正历史混合列并另返包标签", async () => {
    const built = await fresh({ samples: 16 });
    await built.mod.adminTrainingRouter.createCaller({} as never).build({ token: "boss", pkg: "fin_basic" });
    const insertIndex = built.captured.findIndex((q) => q.includes("INSERT INTO st_training_jobs"));
    expect(insertIndex).toBeGreaterThanOrEqual(0);
    expect(built.capturedParams[insertIndex]).toEqual(expect.arrayContaining(["fin_basic", "财务部"]));
    expect(built.capturedParams[insertIndex]).not.toContain("财务基础包");
    const old = await fresh({ jobRow: { pkg: "fin_basic", dept: "财务基础包", status: "ready" } });
    const jobs = await old.mod.adminTrainingRouter.createCaller({} as never).jobs({ token: "boss" });
    expect(jobs.items[0]).toMatchObject({ pkg: "fin_basic", dept: "财务部", pkgLabel: "财务基础包" });
  });

  it("所有可选部门/协同包都有完整 stationPrefix、包标签和部门标签，全域包不进入训练", async () => {
    const { mod } = await fresh({ samples: 16 });
    const caller = mod.adminTrainingRouter.createCaller({} as never);
    const keys = [
      "dept_finance", "dept_legal", "dept_marketing", "dept_synergy",
      ...PKG_CATALOG.filter((p) => p.packageTier !== "global").map((p) => p.key),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    for (const pkg of keys) {
      const result = await caller.build({ token: "boss", pkg });
      expect(result).toMatchObject({ ok: true, pkg, sampleCount: 16 });
    }
    expect(PKG_CATALOG.filter((p) => p.packageTier === "global").length).toBeGreaterThan(0);
  });
});
