/**
 * evoArm 执行官施工臂（M58）单测——沙箱演练闸全链。
 *
 * 闸点：
 * 1. EVO_ARM_ENABLED 缺省/非 1 → fail-closed 精确拒绝（生产默认关）；
 * 2. 施工对象必须是 st_releases 的 draft（不存在 NOT_FOUND / 非 draft 前置拒绝）；
 * 3. 工作区强制 /tmp 前缀（越界配置精确拒绝）；
 * 4. mock 执行器全链：分支 arm/rls-<id>、指令脱敏落账、提交、diff 收集、审计落库；
 * 5. codex 轨诚实报错：未配统一网关 / 二进制缺席均 ok:false，绝不假成功；
 * 6. report 只回 action='arm:run' 流水。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";

// ─── 内存假库：st_releases + st_release_audit ────────────────────────────────
type RelRow = { id: number; channel: string; version: string; status: string; created_by: string };
type AudRow = { id: number; release_id: number | null; channel: string | null;
  actor: string; action: string; detail: string | null; created_at: string };

let releases: RelRow[];
let audits: AudRow[];
let seq: number;

function resetState() {
  releases = [
    { id: 501, channel: "server", version: "v9.9.9", status: "draft", created_by: "boss" },
    { id: 502, channel: "wb", version: "v1.5.0", status: "verified", created_by: "boss" },
  ];
  audits = [];
  seq = 900;
}

vi.mock("./queries/connection", async () => {
  const { MySqlDialect } = await import("drizzle-orm/mysql-core");
  const dialect = new MySqlDialect();
  return {
    getDb: () => ({
      execute: async (stmt: unknown) => {
        const q = dialect.sqlToQuery(stmt as never);
        const text = q.sql.trim().replace(/\s+/g, " ");
        const params = q.params as unknown[];
        if (text.includes("FROM st_releases") && text.includes("WHERE id = ?")) {
          return [releases.filter((r) => r.id === Number(params[0]))];
        }
        if (text.startsWith("INSERT INTO st_release_audit")) {
          // VALUES (?, ?, ?, 'arm:run', ?)：action 为字面量，不入参
          audits.push({ id: seq++, release_id: (params[0] as number) ?? null,
            channel: (params[1] as string) ?? null, actor: String(params[2]),
            action: "arm:run", detail: (params[3] as string) ?? null,
            created_at: "2026-08-22 09:00:00" });
          return [{ insertId: seq, affectedRows: 1 }];
        }
        if (text.includes("FROM st_release_audit WHERE release_id = ? AND action = 'arm:run'")) {
          return [audits.filter((a) => a.action === "arm:run" && a.release_id === Number(params[0]))
            .reverse().slice(0, Number(params[1]))];
        }
        if (text.includes("FROM st_release_audit WHERE action = 'arm:run'")) {
          return [audits.filter((a) => a.action === "arm:run").reverse()
            .slice(0, Number(params[0]))];
        }
        throw new Error(`unmocked SQL: ${text}`);
      },
    }),
  };
});

vi.mock("./routers/terminal", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./routers/terminal")>();
  return {
    ...orig,
    requireHqAdmin: async (token: string) => {
      if (token === "hq_boss") return { id: 1, username: "boss", role: "admin", factoryId: 6290209 };
      throw new Error("需要管理员权限");
    },
  };
});

import { evoArmRouter } from "./routers/evoArm";

const caller = evoArmRouter.createCaller({} as never);
const WS = `/tmp/evo-arm-test-${process.pid}`;

beforeEach(() => {
  resetState();
  rmSync(WS, { recursive: true, force: true });
  vi.stubEnv("EVO_ARM_ENABLED", "1");
  vi.stubEnv("EVO_ARM_WORKSPACE", WS);
  vi.stubEnv("EVO_ARM_EXECUTOR", "mock");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(WS, { recursive: true, force: true });
});

describe("安全闸（fail-closed）", () => {
  it("EVO_ARM_ENABLED 缺省 → PRECONDITION_FAILED", async () => {
    vi.stubEnv("EVO_ARM_ENABLED", "");
    await expect(caller.run({ token: "hq_boss", releaseId: 501, instruction: "演练指令一" }))
      .rejects.toThrow("施工臂仅沙箱演练开放");
  });

  it("非管理员 token → 拒", async () => {
    await expect(caller.run({ token: "bad", releaseId: 501, instruction: "演练指令一" }))
      .rejects.toThrow("需要管理员权限");
  });

  it("提案不存在 → NOT_FOUND；非 draft → 前置拒绝", async () => {
    await expect(caller.run({ token: "hq_boss", releaseId: 999, instruction: "演练指令一" }))
      .rejects.toThrow("版本提案不存在");
    await expect(caller.run({ token: "hq_boss", releaseId: 502, instruction: "演练指令一" }))
      .rejects.toThrow("施工对象必须是 draft 提案");
  });

  it("工作区越界（非 /tmp 前缀）→ 精确拒绝", async () => {
    vi.stubEnv("EVO_ARM_WORKSPACE", "/etc/evo-arm");
    await expect(caller.run({ token: "hq_boss", releaseId: 501, instruction: "演练指令一" }))
      .rejects.toThrow("施工臂工作区必须在 /tmp 下");
  });
});

describe("mock 执行器全链", () => {
  it("分支/台账/提交/diff/审计五环齐落", async () => {
    const r = await caller.run({ token: "hq_boss", releaseId: 501, instruction: "给启动页加加载态" });
    expect(r.ok).toBe(true);
    expect(r.executor).toBe("mock");
    expect(r.branch).toBe("arm/rls-501");
    expect(r.diffStat).toBeTruthy();
    // 台账落工作区
    const log = readFileSync(`${WS}/ARM_CHANGELOG.md`, "utf8");
    expect(log).toContain("release #501");
    expect(log).toContain("给启动页加加载态");
    // 审计落库
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("arm:run");
    expect(audits[0].actor).toBe("boss");
    expect(audits[0].detail).toContain("arm/rls-501");
  });

  it("指令脱敏：st_ 敏感串遮蔽后落账，绝不进工作区", async () => {
    const r = await caller.run({ token: "hq_boss", releaseId: 501,
      instruction: "检查 st_ABCdef123456 的引用并清理" });
    expect(r.ok).toBe(true);
    const log = readFileSync(`${WS}/ARM_CHANGELOG.md`, "utf8");
    expect(log).toContain("[已遮蔽]");
    expect(log).not.toContain("st_ABCdef123456");
  });

  it("工作区幂等复用：二次施工不重复 init，台账追加", async () => {
    await caller.run({ token: "hq_boss", releaseId: 501, instruction: "第一次施工演练" });
    expect(existsSync(`${WS}/.git`)).toBe(true);
    await caller.run({ token: "hq_boss", releaseId: 501, instruction: "第二次施工演练" });
    const log = readFileSync(`${WS}/ARM_CHANGELOG.md`, "utf8");
    expect(log).toContain("第一次施工演练");
    expect(log).toContain("第二次施工演练");
  });
});

describe("codex 执行器诚实报错", () => {
  it("未配海禛云统一网关（IDOICTOS_BASE_URL/KEY）→ ok:false", async () => {
    vi.stubEnv("EVO_ARM_EXECUTOR", "codex");
    vi.stubEnv("IDOICTOS_BASE_URL", "");
    vi.stubEnv("IDOICTOS_API_KEY", "");
    const r = await caller.run({ token: "hq_boss", releaseId: 501, instruction: "演练指令一" });
    expect(r.ok).toBe(false);
    expect(r.executor).toBe("codex");
    expect(r.error).toContain("IDOICTOS_BASE_URL");
  });

  it("codex 二进制缺席 → ok:false 指明上架路径", async () => {
    vi.stubEnv("EVO_ARM_EXECUTOR", "codex");
    vi.stubEnv("IDOICTOS_BASE_URL", "http://127.0.0.1:9");
    vi.stubEnv("IDOICTOS_API_KEY", "dummy-key");
    vi.stubEnv("EVO_ARM_CODEX_BIN", "codex-definitely-absent-bin");
    const r = await caller.run({ token: "hq_boss", releaseId: 501, instruction: "演练指令一" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("不在场");
  });
});

describe("施工台账 report", () => {
  it("只回 action='arm:run' 流水，按提案过滤", async () => {
    await caller.run({ token: "hq_boss", releaseId: 501, instruction: "演练指令一" });
    audits.push({ id: seq++, release_id: 501, channel: "server", actor: "boss",
      action: "propose", detail: "非臂流水", created_at: "2026-08-22 08:00:00" });
    const all = await caller.report({ token: "hq_boss" });
    expect(all.items.every((x) => x.detail?.includes("arm/rls-501") || x.detail === null)).toBe(true);
    expect(all.items.some((x) => x.detail?.includes("非臂流水"))).toBe(false);
    const filtered = await caller.report({ token: "hq_boss", releaseId: 501 });
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0].actor).toBe("boss");
  });
});
