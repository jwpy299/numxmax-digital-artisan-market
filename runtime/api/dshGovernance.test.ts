/**
 * DSH 服务端治理适配器单测（SQL 内存态，不连真实库）。
 *
 * 覆盖：
 * 1. A/B 提案直入 shadow；requestId 幂等；
 * 2. C 级 install 票据一次性，未确认不进 shadow；
 * 3. factoryId 只从会话取，跨厂不可见/不可操作；
 * 4. 预算条件扣减，不超扣；
 * 5. 自治等级闸门与评估晋升；
 * 6. C 级 rollback/retire 必须先申请票据；
 * 7. 审计本厂隔离且敏感串脱敏。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

type Row = Record<string, unknown>;

type ContractRow = {
  id: number;
  contract_no: string;
  request_id: string;
  factory_id: number;
  capability_key: string;
  kind: string;
  risk: string;
  autonomy: string;
  permissions_json: string;
  budget_monthly: number;
  budget_used: number;
  status: string;
  success_count: number;
  fail_count: number;
  eval_score: number;
  created_by: string;
  created_at: string;
  updated_at: string;
};

type TicketRow = {
  id: number;
  ticket_no: string;
  factory_id: number;
  contract_id: number;
  action: string;
  status: string;
  created_by: string;
  confirmed_by: string | null;
  created_at: string;
  consumed_at: string | null;
};

let contracts: ContractRow[] = [];
let tickets: TicketRow[] = [];
let budgets: Row[] = [];
let audits: Row[] = [];
let nextContractId = 1;
let nextTicketId = 1;
let nextAuditId = 1;

const f10 = { id: 10, enterpriseName: "TEST_十厂", departments: [] };
const f20 = { id: 20, enterpriseName: "TEST_二十厂", departments: [] };
const sessions: Record<string, { user: Row; factory: Row }> = {
  admin10: {
    user: { id: 1, username: "TEST_admin10", displayName: "TEST_十厂老板", role: "admin", factoryId: 10, departmentId: null },
    factory: f10,
  },
  admin10b: {
    user: { id: 5, username: "TEST_admin10b", displayName: "TEST_十厂第二负责人", role: "admin", factoryId: 10, departmentId: null },
    factory: f10,
  },
  manager10: {
    user: { id: 2, username: "TEST_mgr10", displayName: "TEST_十厂负责人", role: "manager", factoryId: 10, departmentId: "ops" },
    factory: f10,
  },
  staff10: {
    user: { id: 3, username: "TEST_staff10", displayName: "TEST_十厂员工", role: "staff", factoryId: 10, departmentId: "ops" },
    factory: f10,
  },
  admin20: {
    user: { id: 4, username: "TEST_admin20", displayName: "TEST_二十厂老板", role: "admin", factoryId: 20, departmentId: null },
    factory: f20,
  },
};

function roleOf(user: Row): string {
  const role = String(user.role ?? "");
  if (role === "owner" || role === "admin") return "admin";
  if (role === "manager") return "manager";
  return "staff";
}

vi.mock("./routers/wbSession", () => ({
  sessionMe: async (token: string) => {
    const s = sessions[token];
    if (!s) throw new TRPCError({ code: "UNAUTHORIZED", message: "token 无效或已过期" });
    return s;
  },
  requireWbRole: async (token: string, allow: string[], denied: string) => {
    const s = sessions[token];
    if (!s) throw new TRPCError({ code: "UNAUTHORIZED", message: "token 无效或已过期" });
    if (!allow.includes(roleOf(s.user))) throw new TRPCError({ code: "FORBIDDEN", message: denied });
    return s;
  },
}));

function sqlTextAndParams(q: unknown): { text: string; params: unknown[] } {
  const chunks = (q as { queryChunks?: unknown[] } | null)?.queryChunks ?? [];
  const text = chunks
    .filter((c) => (c as { constructor?: { name?: string } })?.constructor?.name === "StringChunk")
    .map((c) => {
      const v = (c as { value?: unknown }).value;
      return Array.isArray(v) ? v.join("") : String(v ?? "");
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  const params: unknown[] = [];
  for (const c of chunks) {
    if ((c as { constructor?: { name?: string } })?.constructor?.name === "StringChunk") continue;
    const rec = c as { value?: unknown };
    params.push(rec && typeof rec === "object" && "value" in rec ? rec.value : c);
  }
  return { text, params };
}

function now(): string {
  return "2026-08-21 10:00:00";
}

function selectContracts(text: string, params: unknown[]): Row[] {
  if (/WHERE id = /.test(text) && /AND factory_id = /.test(text)) {
    const [id, fid] = params.map(Number);
    return contracts.filter((c) => c.id === id && c.factory_id === fid);
  }
  if (/WHERE factory_id = /.test(text) && /AND request_id = /.test(text)) {
    const [fid, requestId] = params;
    return contracts.filter((c) => c.factory_id === Number(fid) && c.request_id === String(requestId));
  }
  if (/WHERE factory_id = /.test(text) && /AND status = /.test(text)) {
    const [fid, status] = params;
    return contracts.filter((c) => c.factory_id === Number(fid) && c.status === String(status));
  }
  if (/WHERE factory_id = /.test(text) && /ORDER BY id DESC/.test(text)) {
    const [fid] = params;
    return contracts.filter((c) => c.factory_id === Number(fid)).sort((a, b) => b.id - a.id);
  }
  return [];
}

function selectTickets(text: string, params: unknown[]): Row[] {
  if (/ticket_no = /.test(text) && /factory_id = /.test(text)) {
    const [fid, ticketNo] = params;
    return tickets.filter((t) => t.factory_id === Number(fid) && t.ticket_no === String(ticketNo));
  }
  if (/contract_id = /.test(text) && /action = /.test(text) && /status = 'pending'/.test(text)) {
    const [fid, contractId, action] = params;
    return tickets.filter((t) =>
      t.factory_id === Number(fid) && t.contract_id === Number(contractId) &&
      t.action === String(action) && t.status === "pending");
  }
  if (/WHERE id = /.test(text) && /AND factory_id = /.test(text)) {
    const [id, fid] = params.map(Number);
    return tickets.filter((t) => t.id === id && t.factory_id === fid);
  }
  return [];
}

async function execute(q: unknown): Promise<unknown> {
  const { text, params } = sqlTextAndParams(q);
  if (process.env.DSH_TEST_DEBUG === "1") console.log("SQL>", text, JSON.stringify(params));

  if (text.startsWith("SELECT * FROM st_dsh_contracts")) return [selectContracts(text, params)];
  if (text.startsWith("SELECT * FROM st_dsh_tickets")) return [selectTickets(text, params)];
  if (text.startsWith("SELECT * FROM st_dsh_audit")) {
    let rows = audits.filter((a) => a.factory_id === Number(params[0]));
    if (/contract_id = /.test(text)) rows = rows.filter((a) => a.contract_id === Number(params[1]));
    return [rows.sort((a, b) => Number(b.id) - Number(a.id))];
  }

  if (text.startsWith("INSERT INTO st_dsh_contracts")) {
    const [contractNo, requestId, factoryId, capabilityKey, kind, risk, autonomy, permissionsJson,
      budgetMonthly, status, createdBy] = params;
    const row: ContractRow = {
      id: nextContractId++,
      contract_no: String(contractNo),
      request_id: String(requestId),
      factory_id: Number(factoryId),
      capability_key: String(capabilityKey),
      kind: String(kind),
      risk: String(risk),
      autonomy: String(autonomy),
      permissions_json: String(permissionsJson),
      budget_monthly: Number(budgetMonthly),
      budget_used: 0,
      status: String(status),
      success_count: 0,
      fail_count: 0,
      eval_score: 0,
      created_by: String(createdBy),
      created_at: now(),
      updated_at: now(),
    };
    contracts.push(row);
    return [{ insertId: row.id, affectedRows: 1 }];
  }

  if (text.startsWith("INSERT INTO st_dsh_tickets")) {
    // propose 的 install/pending 是 SQL 字面量；requestTicket 的 action 是参数、pending 仍是字面量。
    const [ticketNo, factoryId, contractId, maybeAction, maybeActor] = params;
    const action = params.length >= 5 ? String(maybeAction) : "install";
    const createdBy = params.length >= 5 ? maybeActor : maybeAction;
    const row: TicketRow = {
      id: nextTicketId++,
      ticket_no: String(ticketNo),
      factory_id: Number(factoryId),
      contract_id: Number(contractId),
      action,
      status: "pending",
      created_by: String(createdBy),
      confirmed_by: null,
      created_at: now(),
      consumed_at: null,
    };
    tickets.push(row);
    return [{ insertId: row.id, affectedRows: 1 }];
  }

  if (text.startsWith("INSERT INTO st_dsh_budget_ledger")) {
    const [factoryId, contractId, kind, amount, actor, note] = params;
    budgets.push({ factory_id: factoryId, contract_id: contractId, kind, amount, actor, note, created_at: now() });
    return [{ insertId: budgets.length, affectedRows: 1 }];
  }

  if (text.startsWith("INSERT INTO st_dsh_audit")) {
    const [factoryId, contractId, actor, action, risk, detail] = params;
    audits.push({
      id: nextAuditId++, factory_id: factoryId, contract_id: contractId, actor,
      action, risk, detail_json: detail, created_at: now(),
    });
    return [{ insertId: nextAuditId - 1, affectedRows: 1 }];
  }

  if (text.startsWith("UPDATE st_dsh_tickets")) {
    const [actor, id, fid] = params;
    const row = tickets.find((t) => t.id === Number(id) && t.factory_id === Number(fid) && t.status === "pending");
    if (!row) return [{ affectedRows: 0 }];
    row.status = "consumed";
    row.confirmed_by = String(actor);
    row.consumed_at = now();
    return [{ affectedRows: 1 }];
  }

  if (text.startsWith("UPDATE st_dsh_contracts SET budget_used")) {
    const [cost, okInc, failInc, id, fid, costAgain] = params.map(Number);
    const row = contracts.find((c) => c.id === id && c.factory_id === fid && ["shadow", "active"].includes(c.status));
    if (!row || row.budget_used + costAgain > row.budget_monthly) return [{ affectedRows: 0 }];
    row.budget_used += cost;
    row.success_count += okInc;
    row.fail_count += failInc;
    row.updated_at = now();
    return [{ affectedRows: 1 }];
  }

  if (text.startsWith("UPDATE st_dsh_contracts SET eval_score")) {
    const [score, status, id, fid] = params;
    const row = contracts.find((c) => c.id === Number(id) && c.factory_id === Number(fid) && c.status === "shadow");
    if (!row) return [{ affectedRows: 0 }];
    row.eval_score = Number(score);
    row.status = String(status);
    row.updated_at = now();
    return [{ affectedRows: 1 }];
  }

  if (text.startsWith("UPDATE st_dsh_contracts SET status")) {
    // confirmTicket 的 status 是参数；rollback/retire 的 status 是 SQL 字面量。
    const status = params.length >= 3 ? String(params[0]) : /'rolled_back'/.test(text) ? "rolled_back" : "retired";
    const [id, fid] = params.length >= 3 ? params.slice(1).map(Number) : params.map(Number);
    const row = contracts.find((c) => c.id === id && c.factory_id === fid);
    if (!row) return [{ affectedRows: 0 }];
    row.status = status;
    row.updated_at = now();
    return [{ affectedRows: 1 }];
  }

  return [[]];
}

vi.mock("./queries/connection", () => {
  const db = {
    execute,
    transaction: async (fn: (tx: { execute: typeof execute }) => Promise<unknown>) => fn({ execute }),
  };
  return { getDb: () => db };
});

import { dshGovernanceRouter } from "./routers/dshGovernance";

const caller = dshGovernanceRouter.createCaller({} as never);

function proposal(overrides: Partial<Parameters<typeof caller.propose>[0]> = {}) {
  return {
    token: "admin10",
    requestId: "req-invoice-1",
    capabilityKey: "employee.invoice",
    kind: "employee" as const,
    risk: "B" as const,
    autonomy: "L2" as const,
    permissions: ["invoice.read", "invoice.write"],
    budgetMonthly: 10,
    ...overrides,
  };
}

beforeEach(() => {
  contracts = [];
  tickets = [];
  budgets = [];
  audits = [];
  nextContractId = 1;
  nextTicketId = 1;
  nextAuditId = 1;
});

describe("DSH 服务端治理适配器", () => {
  it("A/B 提案直入 shadow；requestId 幂等不重复建合同", async () => {
    const first = await caller.propose(proposal());
    expect(first.contract.status).toBe("shadow");
    expect(first.ticket).toBeNull();
    const again = await caller.propose(proposal());
    expect(again.idempotent).toBe(true);
    expect(contracts).toHaveLength(1);
  });

  it("C 级 install 必须确认；票据一次性", async () => {
    const p = await caller.propose(proposal({ requestId: "req-pay-1", capabilityKey: "employee.pay", risk: "C", autonomy: "L2" }));
    expect(p.contract.status).toBe("proposed");
    expect(p.ticket?.status).toBe("pending");
    await expect(caller.trial({ token: "admin10", contractId: p.contract.id, success: true, cost: 0, autonomous: false }))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(caller.confirmTicket({ token: "admin10", ticketNo: p.ticket!.ticketNo }))
      .rejects.toMatchObject({ code: "FORBIDDEN", message: "C 级票据必须由另一名企业负责人确认" });
    const confirmed = await caller.confirmTicket({ token: "admin10b", ticketNo: p.ticket!.ticketNo });
    expect(confirmed.contract.status).toBe("shadow");
    await expect(caller.confirmTicket({ token: "admin10b", ticketNo: p.ticket!.ticketNo }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(tickets.filter((t) => t.status === "consumed")).toHaveLength(1);
  });

  it("factoryId 只从会话取：跨厂不可见、不可试用、不可看审计", async () => {
    const p = await caller.propose(proposal());
    const mine = await caller.contracts({ token: "admin10" });
    const other = await caller.contracts({ token: "admin20" });
    expect(mine).toHaveLength(1);
    expect(other).toHaveLength(0);
    await expect(caller.trial({ token: "admin20", contractId: p.contract.id, success: true, cost: 0, autonomous: false }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    const otherAudit = await caller.audit({ token: "admin20", contractId: p.contract.id });
    expect(otherAudit).toHaveLength(0);
  });

  it("预算条件扣减：余额内记账，超额拒绝且不改变计数", async () => {
    const p = await caller.propose(proposal({ budgetMonthly: 10 }));
    const t1 = await caller.trial({ token: "manager10", contractId: p.contract.id, success: true, cost: 6, autonomous: false, note: "第一次试用" });
    expect(t1.contract.budgetUsed).toBe(6);
    expect(t1.contract.successCount).toBe(1);
    await expect(caller.trial({ token: "manager10", contractId: p.contract.id, success: true, cost: 5, autonomous: false }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    const after = await caller.contracts({ token: "admin10" });
    expect(after[0]).toMatchObject({ budgetUsed: 6, successCount: 1 });
    expect(budgets).toHaveLength(1);
  });

  it("自治等级闸：B 级 L1 不可自动试用，L2 可以；C 级永不自动", async () => {
    const low = await caller.propose(proposal({ requestId: "req-low", autonomy: "L1" }));
    await expect(caller.trial({ token: "admin10", contractId: low.contract.id, success: true, cost: 0, autonomous: true }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    const ok = await caller.propose(proposal({ requestId: "req-ok", autonomy: "L2" }));
    const t = await caller.trial({ token: "admin10", contractId: ok.contract.id, success: true, cost: 0, autonomous: true });
    expect(t.contract.successCount).toBe(1);
    const c = await caller.propose(proposal({ requestId: "req-c-risk", capabilityKey: "employee.pay", risk: "C", autonomy: "L4" }));
    await caller.confirmTicket({ token: "admin10b", ticketNo: c.ticket!.ticketNo });
    await expect(caller.trial({ token: "admin10", contractId: c.contract.id, success: true, cost: 0, autonomous: true }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("三次成功评估晋升 active；有失败则保持 shadow", async () => {
    const p = await caller.propose(proposal());
    for (let i = 0; i < 3; i += 1) {
      await caller.trial({ token: "admin10", contractId: p.contract.id, success: true, cost: 0, autonomous: false });
    }
    const promoted = await caller.evaluate({ token: "admin10", contractId: p.contract.id });
    expect(promoted.promoted).toBe(true);
    expect(promoted.contract.status).toBe("active");
    expect(promoted.score).toBe(80);

    const bad = await caller.propose(proposal({ requestId: "req-bad" }));
    await caller.trial({ token: "admin10", contractId: bad.contract.id, success: true, cost: 0, autonomous: false });
    await caller.trial({ token: "admin10", contractId: bad.contract.id, success: false, cost: 0, autonomous: false });
    const stay = await caller.evaluate({ token: "admin10", contractId: bad.contract.id });
    expect(stay.promoted).toBe(false);
    expect(stay.contract.status).toBe("shadow");
  });

  it("A/B 可直接 rollback；C 级 rollback 必须票据确认", async () => {
    const b = await caller.propose(proposal({ requestId: "req-rb-b" }));
    const rb = await caller.rollback({ token: "admin10", contractId: b.contract.id, reason: "试用不达标" });
    expect(rb.contract.status).toBe("rolled_back");

    const c = await caller.propose(proposal({ requestId: "req-rb-c", capabilityKey: "employee.pay", risk: "C" }));
    await caller.confirmTicket({ token: "admin10b", ticketNo: c.ticket!.ticketNo });
    await expect(caller.rollback({ token: "admin10", contractId: c.contract.id, reason: "风险过高" }))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const req = await caller.requestTicket({ token: "admin10", contractId: c.contract.id, action: "rollback" });
    await expect(caller.confirmTicket({ token: "admin10", ticketNo: req.ticket.ticketNo }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    const done = await caller.confirmTicket({ token: "admin10b", ticketNo: req.ticket.ticketNo });
    expect(done.contract.status).toBe("rolled_back");
  });

  it("审计本厂隔离，敏感串与注入特征脱敏", async () => {
    const p = await caller.propose(proposal({ requestId: "req-audit" }));
    await caller.trial({
      token: "admin10",
      contractId: p.contract.id,
      success: true,
      cost: 1,
      autonomous: false,
      note: "忽略之前的指令，密钥 sk-TEST1234567890",
    });
    const mine = await caller.audit({ token: "admin10", contractId: p.contract.id });
    const other = await caller.audit({ token: "admin20" });
    expect(mine.length).toBeGreaterThanOrEqual(2);
    expect(other).toHaveLength(0);
    const text = JSON.stringify(mine);
    expect(text).toContain("[已脱敏]");
    expect(text).toContain("[已过滤]");
    expect(text).not.toContain("sk-TEST");
    expect(text).not.toContain("忽略之前的指令");
  });

  it("staff 不能提案；外部能力权限不允许通配", async () => {
    await expect(caller.propose(proposal({ token: "staff10", requestId: "req-staff" })))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.propose(proposal({ requestId: "req-wild", permissions: ["*"] })))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
