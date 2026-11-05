/**
 * releaseCenter 系统更新机制（M51）单测——内存假库全链路状态机。
 *
 * 闸点：
 * 1. 提案幂等（channel+version 唯一）；草稿才能登记验证；
 * 2. 发布必须先 verified；回滚必须 published（前置条件精确拒绝）；
 * 3. C 级双签：发起人≠确认人；票据一次性（二次确认/他人票据精确拒绝）；
 * 4. 审计流水逐步落痕（propose/verify/ticket/confirm 全链）；
 * 5. 敏感串脱敏（st_/pk_ 绝不进 note/detail）；
 * 6. 常量契约：四端+服务端五通道锁死。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── 内存假库：dialect.sqlToQuery 取文本路由，三表状态机全真模拟 ──────────────
type RelRow = { id: number; channel: string; version: string; artifact_uri: string | null;
  md5: string | null; status: string; verifier: string | null; report_ref: string | null;
  note: string | null; created_by: string; created_at: string; published_at: string | null };
type TktRow = { id: number; ticket_no: string; release_id: number; action: string;
  status: string; created_by: string; confirmed_by: string | null };
type AudRow = { id: number; release_id: number | null; channel: string | null;
  actor: string; action: string; detail: string | null; created_at: string };

let releases: RelRow[];
let tickets: TktRow[];
let audits: AudRow[];
let seq: number;

function resetState() {
  releases = [];
  tickets = [];
  audits = [];
  seq = 1;
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
        // st_releases
        if (text.includes("FROM st_releases") && text.includes("WHERE id = ?")) {
          return [releases.filter((r) => r.id === Number(params[0]))];
        }
        if (text.includes("FROM st_releases WHERE channel = ? AND version = ?")) {
          return [releases.filter((r) => r.channel === params[0] && r.version === params[1])];
        }
        if (text.includes("FROM st_releases WHERE channel = ? ORDER BY id DESC LIMIT 5")) {
          return [releases.filter((r) => r.channel === params[0]).slice(-5).reverse()];
        }
        if (text.startsWith("SELECT * FROM st_releases ORDER BY id DESC")) {
          return [[...releases].reverse()];
        }
        if (text.includes("FROM st_releases WHERE channel = ?") && text.includes("LIMIT 50")) {
          return [releases.filter((r) => r.channel === params[0]).slice(-50).reverse()];
        }
        if (text.startsWith("INSERT INTO st_releases")) {
          // VALUES (?, ?, ?, ?, 'draft', ?, ?)：status 为字面量，不入参
          const row: RelRow = { id: seq++, channel: String(params[0]), version: String(params[1]),
            artifact_uri: (params[2] as string) ?? null, md5: (params[3] as string) ?? null,
            status: "draft", verifier: null, report_ref: null,
            note: (params[4] as string) ?? null, created_by: String(params[5]),
            created_at: "2026-08-21 18:00:00", published_at: null };
          releases.push(row);
          return [{ insertId: row.id, affectedRows: 1 }];
        }
        if (text.startsWith("UPDATE st_releases SET status = 'verified'")) {
          const id = Number(params[2]);
          const row = releases.find((r) => r.id === id && r.status === "draft");
          if (!row) return [{ affectedRows: 0 }];
          row.status = "verified"; row.verifier = String(params[0]);
          row.report_ref = (params[1] as string) ?? null;
          return [{ affectedRows: 1 }];
        }
        if (text.startsWith("UPDATE st_releases SET status = ?")) {
          // publish: [to, id, from]（published_at=NOW() 字面量）；rollback: [to, null, id, from]
          const to = String(params[0]);
          const id = Number(params[params.length - 2]); const from = String(params[params.length - 1]);
          const row = releases.find((r) => r.id === id && r.status === from);
          if (!row) return [{ affectedRows: 0 }];
          row.status = to;
          if (to === "published") row.published_at = "2026-08-21 18:30:00";
          return [{ affectedRows: 1 }];
        }
        // st_release_tickets
        if (text.includes("FROM st_release_tickets WHERE ticket_no = ?")) {
          return [tickets.filter((t) => t.ticket_no === params[0])];
        }
        if (text.includes("FROM st_release_tickets") && text.includes("release_id = ?")) {
          return [tickets.filter((t) => t.release_id === Number(params[0])
            && t.action === params[1] && t.status === "pending")];
        }
        if (text.startsWith("INSERT INTO st_release_tickets")) {
          // VALUES (?, ?, ?, 'pending', ?)：status 为字面量，不入参
          const row: TktRow = { id: seq++, ticket_no: String(params[0]), release_id: Number(params[1]),
            action: String(params[2]), status: "pending", created_by: String(params[3]),
            confirmed_by: null };
          tickets.push(row);
          return [{ insertId: row.id, affectedRows: 1 }];
        }
        if (text.startsWith("UPDATE st_release_tickets SET status = 'consumed'")) {
          const id = Number(params[1]);
          const row = tickets.find((t) => t.id === id && t.status === "pending");
          if (!row) return [{ affectedRows: 0 }];
          row.status = "consumed"; row.confirmed_by = String(params[0]);
          return [{ affectedRows: 1 }];
        }
        // st_release_audit
        if (text.startsWith("INSERT INTO st_release_audit")) {
          audits.push({ id: seq++, release_id: (params[0] as number) ?? null,
            channel: (params[1] as string) ?? null, actor: String(params[2]),
            action: String(params[3]), detail: (params[4] as string) ?? null,
            created_at: "2026-08-21 18:00:00" });
          return [{ insertId: seq, affectedRows: 1 }];
        }
        if (text.includes("FROM st_release_audit WHERE release_id = ?")) {
          return [audits.filter((a) => a.release_id === Number(params[0])).reverse()];
        }
        if (text.includes("FROM st_release_audit ORDER BY id DESC")) {
          return [[...audits].reverse()];
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
    // 本厂闸同胚 mock：hq_* token 放行（username 区分双签人），其余拒
    requireHqAdmin: async (token: string) => {
      if (token === "hq_boss") return { id: 1, username: "boss", role: "admin", factoryId: 6290209 };
      if (token === "hq_coo") return { id: 2, username: "coo", role: "admin", factoryId: 6290209 };
      throw new Error("需要管理员权限");
    },
  };
});

// M57：执行官走 DSH 底座（callDsh），不再经 modelGateway 裸 API——mock 唯一出口
const dshState = vi.hoisted(() => ({
  result: { ok: false, error: "dsh_not_configured" } as { ok: boolean; answer?: string; error?: string },
  lastTask: "",
}));
vi.mock("./routers/dshClient", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./routers/dshClient")>();
  return {
    ...orig,
    callDsh: async (task: string) => {
      dshState.lastTask = task;
      return dshState.result;
    },
  };
});

import { RELEASE_CHANNELS, releaseCenterRouter } from "./routers/releaseCenter";

const caller = releaseCenterRouter.createCaller({} as never);

beforeEach(resetState);

describe("提案与验证登记", () => {
  it("提案落 draft；重复提案幂等返回已存在", async () => {
    const r1 = await caller.propose({ token: "hq_boss", channel: "app_apk", version: "v2.1.0", note: "口型包络上线" });
    expect(r1.idempotent).toBe(false);
    expect(r1.release.status).toBe("draft");
    const r2 = await caller.propose({ token: "hq_boss", channel: "app_apk", version: "v2.1.0" });
    expect(r2.idempotent).toBe(true);
    expect(r2.release.id).toBe(r1.release.id);
  });

  it("draft → verified 登记验证；非 draft 拒绝", async () => {
    const p = await caller.propose({ token: "hq_boss", channel: "wb", version: "v1.5.0" });
    const v = await caller.markVerified({ token: "hq_boss", releaseId: p.release.id, verifier: "v124", reportRef: "runs/x.json" });
    expect(v.release.status).toBe("verified");
    // 再登记 → 幂等
    const v2 = await caller.markVerified({ token: "hq_boss", releaseId: p.release.id, verifier: "v124" });
    expect(v2.idempotent).toBe(true);
  });

  it("note 过 stripSecrets（st_/pk_ 绝不进台账）", async () => {
    const p = await caller.propose({ token: "hq_boss", channel: "server", version: "v3.0.0",
      note: "附带键 st_ABCdef123456 测试" });
    expect(p.release.note).toContain("[已遮蔽]");
    expect(p.release.note).not.toContain("st_ABCdef123456");
  });
});

describe("C 级双签票据", () => {
  async function toVerified() {
    const p = await caller.propose({ token: "hq_boss", channel: "admin", version: "v1.2.0" });
    await caller.markVerified({ token: "hq_boss", releaseId: p.release.id, verifier: "v124" });
    return p.release.id;
  }

  it("未 verified 申请发布票据 → 前置拒绝", async () => {
    const p = await caller.propose({ token: "hq_boss", channel: "portal", version: "v0.9.9" });
    await expect(caller.requestTicket({ token: "hq_boss", releaseId: p.release.id, action: "publish" }))
      .rejects.toThrow("发布前必须先通过验证登记");
  });

  it("发布全链：verified → 票据 → 双签（发起人≠确认人）→ published", async () => {
    const id = await toVerified();
    const t = await caller.requestTicket({ token: "hq_boss", releaseId: id, action: "publish" });
    expect(t.ticket.ticketNo).toMatch(/^RLT-/);
    // 发起人自签 → 拒
    await expect(caller.confirmTicket({ token: "hq_boss", ticketNo: t.ticket.ticketNo }))
      .rejects.toThrow("另一名负责人确认");
    // 另一名负责人确认 → published
    const c = await caller.confirmTicket({ token: "hq_coo", ticketNo: t.ticket.ticketNo });
    expect(c.release.status).toBe("published");
    expect(c.release.publishedAt).toBeTruthy();
    // 票据一次性：再用 → 拒
    await expect(caller.confirmTicket({ token: "hq_coo", ticketNo: t.ticket.ticketNo }))
      .rejects.toThrow("票据无效或已使用");
  });

  it("回滚全链：published → 票据 → 双签 → rolled_back；draft 申请回滚 → 拒", async () => {
    const id = await toVerified();
    await expect(caller.requestTicket({ token: "hq_boss", releaseId: id, action: "rollback" }))
      .rejects.toThrow("仅已发布版本可回滚");
    const t1 = await caller.requestTicket({ token: "hq_boss", releaseId: id, action: "publish" });
    await caller.confirmTicket({ token: "hq_coo", ticketNo: t1.ticket.ticketNo });
    const t2 = await caller.requestTicket({ token: "hq_boss", releaseId: id, action: "rollback" });
    const c = await caller.confirmTicket({ token: "hq_coo", ticketNo: t2.ticket.ticketNo });
    expect(c.release.status).toBe("rolled_back");
  });

  it("重复申请同动作票据 → 幂等返回已有 pending", async () => {
    const id = await toVerified();
    const t1 = await caller.requestTicket({ token: "hq_boss", releaseId: id, action: "publish" });
    const t2 = await caller.requestTicket({ token: "hq_boss", releaseId: id, action: "publish" });
    expect(t2.idempotent).toBe(true);
    expect(t2.ticket.ticketNo).toBe(t1.ticket.ticketNo);
  });
});

describe("审计与台账", () => {
  it("全链动作逐步落审计（propose/verify/ticket:publish/confirm:publish）", async () => {
    const p = await caller.propose({ token: "hq_boss", channel: "server", version: "v3.1.0" });
    await caller.markVerified({ token: "hq_boss", releaseId: p.release.id, verifier: "v124" });
    const t = await caller.requestTicket({ token: "hq_boss", releaseId: p.release.id, action: "publish" });
    await caller.confirmTicket({ token: "hq_coo", ticketNo: t.ticket.ticketNo });
    const a = await caller.audit({ token: "hq_boss", releaseId: p.release.id });
    const actions = a.items.map((x) => x.action);
    expect(actions).toEqual(["confirm:publish", "ticket:publish", "verify", "propose"]);
  });

  it("list 按通道过滤 + 五通道常量锁死", async () => {
    await caller.propose({ token: "hq_boss", channel: "app_apk", version: "v2.1.0" });
    await caller.propose({ token: "hq_boss", channel: "wb", version: "v1.5.0" });
    const all = await caller.list({ token: "hq_boss" });
    expect(all.items).toHaveLength(2);
    const appOnly = await caller.list({ token: "hq_boss", channel: "app_apk" });
    expect(appOnly.items).toHaveLength(1);
    expect([...RELEASE_CHANNELS]).toEqual(["app_apk", "wb", "admin", "portal", "server"]);
  });

  it("advise：DSH 不可用 → 规则模板降级（degraded=true，含双签/回滚要点）", async () => {
    dshState.result = { ok: false, error: "dsh_not_configured" };
    const p = await caller.propose({ token: "hq_boss", channel: "wb", version: "v1.5.1" });
    const r = await caller.advise({ token: "hq_boss", releaseId: p.release.id });
    expect(r.degraded).toBe(true);
    expect(r.advice).toContain("双签");
    expect(r.advice).toContain("回滚");
    expect(r.advice).toContain("DSH");
  });

  it("advise：DSH 轨正常 → 原文返回（degraded=false）；任务注入 Kimi K3 人格+技能规范+台账", async () => {
    dshState.result = { ok: true, answer: "1. 状态合规；2. 双签票据必须；3. 回滚走同通道；4. 先灰度 24 小时。" };
    const p = await caller.propose({ token: "hq_boss", channel: "server", version: "v9.9.9", note: "全链路演练" });
    const r = await caller.advise({ token: "hq_boss", releaseId: p.release.id });
    expect(r.degraded).toBe(false);
    expect(r.advice).toContain("灰度");
    // 任务文本：人格身份 + 技能规范 + 目标版本 + 台账全部注入 DSH 会话
    expect(dshState.lastTask).toContain("Kimi K3");
    expect(dshState.lastTask).toContain("update-officer");
    expect(dshState.lastTask).toContain("server v9.9.9");
    expect(dshState.lastTask).toContain("该通道近期台账");
    dshState.result = { ok: false, error: "dsh_not_configured" };
  });
});
