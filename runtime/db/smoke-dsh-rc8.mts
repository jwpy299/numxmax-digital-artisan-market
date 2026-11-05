/**
 * DSH rc.8 测试环境冒烟（沙箱内真实 MariaDB + 真实 tRPC HTTP 链路）。
 *
 * 链路：HTTP → tRPC standalone → dshGovernanceRouter → wbSession 鉴权 → mysql2 → MariaDB。
 * 边界：只连沙箱库 dsh_smoke（127.0.0.1:3399），不接触生产；一次性 token 仅本脚本使用。
 *
 * 用法：
 *   DATABASE_URL="mysql://root:@127.0.0.1:3399/dsh_smoke" \
 *     node node_modules/tsx/dist/cli.mjs db/smoke-dsh-rc8.mts
 */
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "mysql://root:@127.0.0.1:3399/dsh_smoke";

type Row = Record<string, unknown>;
const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok: !!ok, detail });
  console.log(ok ? "PASS" : "FAIL", "|", name, detail ? `| ${detail}` : "");
}

async function main(): Promise<void> {
  const { fetchRequestHandler } = await import("@trpc/server/adapters/fetch");
  const { dshGovernanceRouter } = await import("../api/routers/dshGovernance");
  const { createContext } = await import("../api/context");
  const { getDb } = await import("../api/queries/connection");
  const { sql } = await import("drizzle-orm");
  const db = getDb();
  const exec = (q: unknown) => db.execute(q as never);

  // ── 种子：最小 wb_users / wb_factories（列与 drizzle schema 对齐）──────────
  await exec(sql`
    CREATE TABLE IF NOT EXISTS wb_factories (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      enterpriseName VARCHAR(128) NOT NULL,
      industry VARCHAR(64) NOT NULL,
      industryText VARCHAR(128) NULL,
      headcount VARCHAR(32) NOT NULL,
      departments JSON NOT NULL,
      painPoints TEXT NULL,
      profile JSON NULL,
      creditCode VARCHAR(32) NULL,
      verifyStatus VARCHAR(24) NOT NULL DEFAULT 'unverified',
      verifiedAt TIMESTAMP NULL,
      verifyPayload JSON NULL,
      industryGroup VARCHAR(32) NOT NULL DEFAULT '工业制造',
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await exec(sql`
    CREATE TABLE IF NOT EXISTS wb_users (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(64) NOT NULL UNIQUE,
      passwordHash VARCHAR(255) NOT NULL,
      displayName VARCHAR(64) NOT NULL,
      role ENUM('admin','owner','manager','staff','member') NOT NULL DEFAULT 'member',
      factoryId BIGINT UNSIGNED NOT NULL,
      departmentId VARCHAR(64) NULL,
      authToken VARCHAR(80) NULL,
      phone VARCHAR(20) NULL,
      realName VARCHAR(64) NULL,
      idCardMasked VARCHAR(32) NULL,
      idCardHash VARCHAR(64) NULL,
      kind ENUM('person','enterprise') NOT NULL DEFAULT 'enterprise',
      invitedBy BIGINT UNSIGNED NULL,
      activatedAt TIMESTAMP NULL,
      disabled TINYINT(1) NOT NULL DEFAULT 0,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await exec(sql`DELETE FROM wb_users`);
  await exec(sql`DELETE FROM wb_factories`);
  await exec(sql`DELETE FROM st_dsh_audit`);
  await exec(sql`DELETE FROM st_dsh_budget_ledger`);
  await exec(sql`DELETE FROM st_dsh_tickets`);
  await exec(sql`DELETE FROM st_dsh_contracts`);

  const tok = () => `nt_${randomBytes(24).toString("hex")}`;
  const T = { admin10: tok(), admin10b: tok(), manager10: tok(), staff10: tok(), admin20: tok() };
  await exec(sql`
    INSERT INTO wb_factories (id, enterpriseName, industry, headcount, departments)
    VALUES (10, '冒烟十厂', '电子', '50-100', JSON_ARRAY(JSON_OBJECT('id','d1','name','生产部'))),
           (20, '冒烟二十厂', '纺织', '50-100', JSON_ARRAY(JSON_OBJECT('id','d1','name','车间')))
  `);
  await exec(sql`
    INSERT INTO wb_users (username, passwordHash, displayName, role, factoryId, authToken)
    VALUES ('SMK_admin10', 'x:x', '十厂负责人甲', 'admin', 10, ${T.admin10}),
           ('SMK_admin10b', 'x:x', '十厂负责人乙', 'admin', 10, ${T.admin10b}),
           ('SMK_manager10', 'x:x', '十厂部门负责人', 'manager', 10, ${T.manager10}),
           ('SMK_staff10', 'x:x', '十厂员工', 'member', 10, ${T.staff10}),
           ('SMK_admin20', 'x:x', '二十厂负责人', 'admin', 20, ${T.admin20})
  `);

  // ── 起真实 HTTP 服务（与生产同构：fetch adapter + createContext + methodOverride）──
  const http: Server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers.set(k, v);
      }
      const fr = new Request(`http://127.0.0.1:4399${req.url ?? "/"}`, {
        method: req.method ?? "POST",
        headers,
        body: body.length ? body : undefined,
      });
      const out = await fetchRequestHandler({
        endpoint: "",
        req: fr,
        router: dshGovernanceRouter,
        createContext: (opts) => createContext({ ...opts, clientIp: req.socket.remoteAddress ?? "" }),
        allowMethodOverride: true, // 与 boot.ts 同口径：query 也允许 POST body
      });
      res.statusCode = out.status;
      out.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(Buffer.from(await out.arrayBuffer()));
    })().catch((err) => {
      res.statusCode = 500;
      res.end(String(err));
    });
  });
  await new Promise<void>((resolve) => http.listen(4399, "127.0.0.1", resolve));
  console.log("smoke server on http://127.0.0.1:4399/ (fetch adapter, 与生产同构)");

  interface TrpcReply {
    result?: { data?: { json?: unknown } };
    error?: { json?: { message?: string; data?: { code?: string } } };
  }
  async function call(proc: string, input: Row): Promise<TrpcReply> {
    const res = await fetch(`http://127.0.0.1:4399/${proc}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: input }), // tRPC v11 信封
    });
    return (await res.json()) as TrpcReply;
  }
  const data = (r: TrpcReply) => (r.result?.data?.json ?? {}) as Row;
  const errCode = (r: TrpcReply) => String(r.error?.json?.data?.code ?? "");

  try {
    // s1 A 级提案直入 shadow
    const p1 = data(await call("propose", {
      token: T.admin10, requestId: "smk-req-a1", capabilityKey: "skill.ocr.invoice",
      kind: "skill", risk: "A", autonomy: "L2", permissions: ["ocr.read"], budgetMonthly: 100,
    }));
    const aId = Number((p1.contract as Row)?.id ?? 0);
    check("s1 A 级提案直入 shadow", p1.ok === true && p1.idempotent === false
      && String((p1.contract as Row)?.status) === "shadow" && aId > 0, `contract=${aId}`);

    // s2 幂等重放
    const p2 = data(await call("propose", {
      token: T.admin10, requestId: "smk-req-a1", capabilityKey: "skill.ocr.invoice",
      kind: "skill", risk: "A", autonomy: "L2", permissions: ["ocr.read"], budgetMonthly: 100,
    }));
    check("s2 同 requestId 幂等返回原合同", p2.idempotent === true
      && Number((p2.contract as Row)?.id) === aId);

    // s2b 并发同 requestId：撞唯一键后回补幂等（M1 修复验证）
    const [c1, c2] = await Promise.all([
      call("propose", {
        token: T.admin10, requestId: "smk-req-race", capabilityKey: "skill.race.demo",
        kind: "skill", risk: "B", autonomy: "L2", permissions: [], budgetMonthly: 10,
      }),
      call("propose", {
        token: T.admin10, requestId: "smk-req-race", capabilityKey: "skill.race.demo",
        kind: "skill", risk: "B", autonomy: "L2", permissions: [], budgetMonthly: 10,
      }),
    ]);
    const raceIds = [Number((data(c1).contract as Row)?.id), Number((data(c2).contract as Row)?.id)];
    check("s2b 并发同 requestId 不 500 且同合同", !c1.error && !c2.error
      && raceIds[0] > 0 && raceIds[0] === raceIds[1], `ids=${raceIds.join("/")}`);

    // s3 staff 无提案权
    const p3 = await call("propose", {
      token: T.staff10, requestId: "smk-req-staff", capabilityKey: "skill.x.y",
      kind: "skill", risk: "A", autonomy: "L0", permissions: [], budgetMonthly: 0,
    });
    check("s3 staff 提案被拒", errCode(p3) === "FORBIDDEN", p3.error?.json?.message ?? "");

    // s4 C 级提案 → proposed + install 票据
    const p4 = data(await call("propose", {
      token: T.admin10, requestId: "smk-req-c1", capabilityKey: "employee.finance.auditor",
      kind: "employee", risk: "C", autonomy: "L2", permissions: ["finance.read"], budgetMonthly: 500,
    }));
    const cId = Number((p4.contract as Row)?.id ?? 0);
    const installTicket = String((p4.ticket as Row)?.ticketNo ?? "");
    check("s4 C 级提案待确认并签发票据", String((p4.contract as Row)?.status) === "proposed"
      && installTicket.length > 0, `contract=${cId}`);

    // s5 发起人自确认被拒（双签）
    const p5 = await call("confirmTicket", { token: T.admin10, ticketNo: installTicket });
    check("s5 C 级发起人自确认被拒", errCode(p5) === "FORBIDDEN", p5.error?.json?.message ?? "");

    // s6 另一名本厂 admin 双签通过 → shadow
    const p6 = data(await call("confirmTicket", { token: T.admin10b, ticketNo: installTicket }));
    check("s6 第二负责人确认后入 shadow", String((p6.contract as Row)?.status) === "shadow");

    // s7 票据一次性
    const p7 = await call("confirmTicket", { token: T.admin10b, ticketNo: installTicket });
    check("s7 票据不可复用", errCode(p7) === "FORBIDDEN", p7.error?.json?.message ?? "");

    // s8 A 级三次成功试用 + 预算扣减
    let trialOk = true;
    for (let i = 0; i < 3; i += 1) {
      const t = data(await call("trial", { token: T.manager10, contractId: aId, success: true, cost: 30, note: `试用${i + 1}` }));
      trialOk = trialOk && t.ok === true;
    }
    const after3 = data(await call("contracts", { token: T.admin10 }));
    const aRow = (after3 as unknown as Row[]).find((r) => Number(r.id) === aId) as Row;
    check("s8 三次试用成功且预算扣 90", trialOk && Number(aRow?.budgetUsed) === 90
      && Number(aRow?.successCount) === 3, `used=${aRow?.budgetUsed}`);

    // s9 超预算拒绝且不加账
    const t9 = await call("trial", { token: T.manager10, contractId: aId, success: true, cost: 20 });
    const aRow2 = (data(await call("contracts", { token: T.admin10 })) as unknown as Row[])
      .find((r) => Number(r.id) === aId) as Row;
    check("s9 超预算拒绝且预算不变", errCode(t9) === "FORBIDDEN" && Number(aRow2?.budgetUsed) === 90,
      t9.error?.json?.message ?? "");

    // s10 评估晋升 active
    const e10 = data(await call("evaluate", { token: T.admin10, contractId: aId }));
    check("s10 三次成功零失败晋升 active", e10.promoted === true && Number(e10.score) >= 80
      && String((e10.contract as Row)?.status) === "active", `score=${e10.score}`);

    // s11 C 级自治试用被拒
    const t11 = await call("trial", { token: T.admin10, contractId: cId, success: true, autonomous: true });
    check("s11 C 级自治试用被拒", errCode(t11) === "FORBIDDEN", t11.error?.json?.message ?? "");

    // s12 C 级人工试用三次成功（budget 500，cost 0）
    let cTrial = true;
    for (let i = 0; i < 3; i += 1) {
      const t = data(await call("trial", { token: T.admin10, contractId: cId, success: true, cost: 0 }));
      cTrial = cTrial && t.ok === true;
    }
    check("s12 C 级 shadow 人工试用可记账", cTrial);

    // s13 C 级直接回滚被拒
    const r13 = await call("rollback", { token: T.admin10, contractId: cId, reason: "沙箱回滚演练" });
    check("s13 C 级无票据直接回滚被拒", errCode(r13) === "PRECONDITION_FAILED", r13.error?.json?.message ?? "");

    // s14 C 级回滚票据 + 双签 → rolled_back
    const rt = data(await call("requestTicket", { token: T.admin10, contractId: cId, action: "rollback" }));
    const rbTicket = String((rt.ticket as Row)?.ticketNo ?? "");
    const rbSelf = await call("confirmTicket", { token: T.admin10, ticketNo: rbTicket });
    const rbDual = data(await call("confirmTicket", { token: T.admin10b, ticketNo: rbTicket }));
    check("s14 C 级回滚双签闭环", rbTicket.length > 0 && errCode(rbSelf) === "FORBIDDEN"
      && String((rbDual.contract as Row)?.status) === "rolled_back");

    // s15 跨厂不可见不可操作
    const list20 = data(await call("contracts", { token: T.admin20 })) as unknown as Row[];
    const t15 = await call("trial", { token: T.admin20, contractId: aId, success: true, cost: 0 });
    check("s15 跨厂合同不可见不可试用", list20.length === 0 && errCode(t15) === "FORBIDDEN");

    // s16 审计脱敏：note 带密钥样式串，审计不得留明文
    await call("trial", {
      token: T.manager10, contractId: aId, success: true, cost: 0,
      note: "调试 sk-FAKE9f8e7d6c5b4a token= abc123",
    });
    const audit10 = data(await call("audit", { token: T.admin10, contractId: aId })) as unknown as Row[];
    const joined = audit10.map((r) => String(r.detail)).join("\n");
    check("s16 审计落盘且密钥样式串已脱敏", audit10.length > 0
      && !joined.includes("sk-FAKE9f8e7d6c5b4a") && joined.includes("[已脱敏]"));

    // s17 审计跨厂隔离
    const audit20 = data(await call("audit", { token: T.admin20 })) as unknown as Row[];
    check("s17 跨厂审计不可见", audit20.length === 0);

    // s18 预算台账：合同 A 恰 3 笔 debit 共 90
    const ledger = await exec(sql`
      SELECT kind, amount FROM st_dsh_budget_ledger WHERE contract_id = ${aId}
    `) as unknown;
    const lrows = (Array.isArray(ledger) && Array.isArray((ledger as Row[])[0])
      ? (ledger as Row[])[0] : ledger) as Row[];
    const debits = lrows.filter((r) => String(r.kind) === "debit");
    const sum = debits.reduce((s, r) => s + Number(r.amount), 0);
    check("s18 预算台账 3 笔 debit 共 90", debits.length === 3 && sum === 90, `sum=${sum}`);
  } finally {
    http.close();
  }
}

main()
  .then(() => {
    const fails = results.filter((r) => !r.ok);
    console.log("=".repeat(60));
    console.log(`rc.8 冒烟：${results.length - fails.length} PASS / ${fails.length} FAIL`);
    process.exit(fails.length ? 1 : 0);
  })
  .catch((err) => {
    console.error("SMOKE_FATAL", err);
    process.exit(2);
  });
