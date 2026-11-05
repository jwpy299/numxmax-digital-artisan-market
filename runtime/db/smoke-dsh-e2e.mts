/**
 * DSH 端到端联调冒烟：移动端真实客户端 → HTTP → tRPC(fetch adapter) → wbSession → mysql2 → MariaDB。
 * 关键：链路里的客户端就是移动端仓库 src/dsh/serverGovernance.ts 本体（跨仓绝对路径引入），
 * 不是重写一份模拟调用——验的是真代码对真服务端。
 *
 * 边界：只连沙箱库 dsh_smoke（127.0.0.1:3399），一次性 token 仅本脚本使用，不接触生产。
 *
 * 用法：
 *   DATABASE_URL="mysql://root:@127.0.0.1:3399/dsh_smoke" \
 *     node node_modules/tsx/dist/cli.mjs db/smoke-dsh-e2e.mts
 */
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "mysql://root:@127.0.0.1:3399/dsh_smoke";

const MOBILE_CLIENT = "/mnt/agents/output/lingshu-app/repo/src/dsh/serverGovernance.ts";

type Row = Record<string, unknown>;
const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok: !!ok, detail });
  console.log(ok ? "PASS" : "FAIL", "|", name, detail ? `| ${detail}` : "");
}

async function main(): Promise<void> {
  const { fetchRequestHandler } = await import("@trpc/server/adapters/fetch");
  const { appRouter } = await import("../api/router");
  const { createContext } = await import("../api/context");
  const { getDb } = await import("../api/queries/connection");
  const { sql } = await import("drizzle-orm");
  const { createDshGovernanceClient } = await import(MOBILE_CLIENT);
  const db = getDb();
  const exec = (q: unknown) => db.execute(q as never);

  // ── 种子（与 rc.8 同口径，但走完整 appRouter）──────────────────────────
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
  const T = { admin10: tok(), admin10b: tok(), staff10: tok(), admin20: tok() };
  await exec(sql`
    INSERT INTO wb_factories (id, enterpriseName, industry, headcount, departments)
    VALUES (10, '联调十厂', '电子', '50-100', JSON_ARRAY(JSON_OBJECT('id','d1','name','生产部'))),
           (20, '联调二十厂', '纺织', '50-100', JSON_ARRAY(JSON_OBJECT('id','d1','name','车间')))
  `);
  await exec(sql`
    INSERT INTO wb_users (username, passwordHash, displayName, role, factoryId, authToken)
    VALUES ('E2E_admin10', 'x:x', '十厂负责人甲', 'admin', 10, ${T.admin10}),
           ('E2E_admin10b', 'x:x', '十厂负责人乙', 'admin', 10, ${T.admin10b}),
           ('E2E_staff10', 'x:x', '十厂员工', 'member', 10, ${T.staff10}),
           ('E2E_admin20', 'x:x', '二十厂负责人', 'admin', 20, ${T.admin20})
  `);

  // ── 起服务（完整 appRouter，与生产同构）────────────────────────────────
  const http: Server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers.set(k, v);
      }
      const fr = new Request(`http://127.0.0.1:4400${req.url ?? "/"}`, {
        method: req.method ?? "POST",
        headers,
        body: body.length ? body : undefined,
      });
      const out = await fetchRequestHandler({
        endpoint: "/api/trpc",
        req: fr,
        router: appRouter,
        createContext: (opts) => createContext({ ...opts, clientIp: req.socket.remoteAddress ?? "" }),
        allowMethodOverride: true,
      });
      res.statusCode = out.status;
      out.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(Buffer.from(await out.arrayBuffer()));
    })().catch((err) => {
      res.statusCode = 500;
      res.end(String(err));
    });
  });
  await new Promise<void>((resolve) => http.listen(4400, "127.0.0.1", resolve));
  console.log("e2e server on http://127.0.0.1:4400/api/trpc (完整 appRouter)");

  // 移动端客户端本体，指向联调服务
  const gov = createDshGovernanceClient({ baseUrl: "http://127.0.0.1:4400" });

  try {
    // e1 A 级全生命周期：提案→3 次试用→评估晋升 active
    const p1 = await gov.propose(T.admin10, {
      requestId: "e2e-req-a1", capabilityKey: "skill.invoice.assist", kind: "skill",
      risk: "A", autonomy: "L2", permissions: ["invoice.issue"], budgetMonthly: 100,
    });
    check("e1 A 级提案直入 shadow", p1.ok && !p1.idempotent && p1.contract.status === "shadow",
      `id=${p1.contract.id} no=${p1.contract.contractNo}`);

    const p1r = await gov.propose(T.admin10, {
      requestId: "e2e-req-a1", capabilityKey: "skill.invoice.assist", kind: "skill",
      risk: "A", autonomy: "L2", permissions: ["invoice.issue"], budgetMonthly: 100,
    });
    check("e2 移动端重试幂等命中原合同", p1r.idempotent && p1r.contract.id === p1.contract.id);

    for (let i = 0; i < 3; i += 1) {
      await gov.trial(T.admin10, { contractId: p1.contract.id, success: true, cost: 30, note: `联调试用${i + 1}` });
    }
    const list1 = await gov.contracts(T.admin10);
    const a1 = list1.find((c: { id: number }) => c.id === p1.contract.id);
    check("e3 三次试用预算 90/100 成败 3/0", !!a1 && a1.budgetUsed === 90 && a1.successCount === 3 && a1.failCount === 0);

    let overBudget = "";
    try {
      await gov.trial(T.admin10, { contractId: p1.contract.id, success: true, cost: 20 });
    } catch (err) {
      overBudget = err instanceof Error ? err.message : String(err);
    }
    check("e4 超预算被服务端拒绝且文案透出", overBudget.includes("预算不足"), overBudget);

    const ev = await gov.evaluate(T.admin10, p1.contract.id);
    check("e5 服务端评估晋升 active", ev.promoted && ev.contract.status === "active" && ev.score >= 80,
      `score=${ev.score}`);

    // e6 staff 无提案权
    let staffMsg = "";
    try {
      await gov.propose(T.staff10, {
        requestId: "e2e-req-staff", capabilityKey: "skill.x.y", kind: "skill",
        risk: "A", autonomy: "L0", permissions: [], budgetMonthly: 0,
      });
    } catch (err) {
      staffMsg = err instanceof Error ? err.message : String(err);
    }
    check("e6 staff 提案被拒", staffMsg.includes("仅企业负责人"), staffMsg);

    // e7-e10 C 级双签全链
    const pc = await gov.propose(T.admin10, {
      requestId: "e2e-req-c1", capabilityKey: "employee.pay.operator", kind: "employee",
      risk: "C", autonomy: "L2", permissions: ["pay.issue"], budgetMonthly: 500,
    });
    check("e7 C 级提案待确认并签发 install 票据", pc.contract.status === "proposed" && !!pc.ticket,
      `ticket=${pc.ticket?.ticketNo ?? ""}`);

    let selfMsg = "";
    try {
      await gov.confirmTicket(T.admin10, pc.ticket!.ticketNo);
    } catch (err) {
      selfMsg = err instanceof Error ? err.message : String(err);
    }
    check("e8 发起人自确认被双签拦截", selfMsg.includes("另一名"), selfMsg);

    const cc = await gov.confirmTicket(T.admin10b, pc.ticket!.ticketNo);
    check("e9 第二负责人确认入 shadow", cc.contract.status === "shadow");

    let reuseMsg = "";
    try {
      await gov.confirmTicket(T.admin10b, pc.ticket!.ticketNo);
    } catch (err) {
      reuseMsg = err instanceof Error ? err.message : String(err);
    }
    check("e10 票据一次性", reuseMsg.includes("票据无效"), reuseMsg);

    // e11 C 级回滚票据双签闭环
    const rt = await gov.requestTicket(T.admin10, pc.contract.id, "rollback");
    const rc = await gov.confirmTicket(T.admin10b, rt.ticket.ticketNo);
    check("e11 C 级回滚双签闭环", rc.contract.status === "rolled_back");

    // e12 跨厂不可见
    const list20 = await gov.contracts(T.admin20);
    check("e12 跨厂合同不可见", list20.length === 0);

    // e13 审计脱敏（移动端 audit 读回验证）
    await gov.trial(T.admin10, { contractId: p1.contract.id, success: true, cost: 0, note: "调试 sk-FAKE9f8e7d6c5b4a token= abc" });
    const audit = await gov.audit(T.admin10, p1.contract.id);
    const joined = audit.map((a: { detail: string }) => a.detail).join("\n");
    check("e13 审计可读且密钥样式串脱敏", audit.length > 0 && !joined.includes("sk-FAKE9f8e7d6c5b4a") && joined.includes("[已脱敏]"),
      `audit=${audit.length} 条`);

    // e14 缺 token 客户端直拒不发请求
    let noTok = "";
    try {
      await gov.contracts("");
    } catch (err) {
      noTok = err instanceof Error ? err.message : String(err);
    }
    check("e14 缺 token 客户端直拒", noTok.includes("登录态"), noTok);
  } finally {
    http.close();
  }
}

main()
  .then(() => {
    const fails = results.filter((r) => !r.ok);
    console.log("=".repeat(60));
    console.log(`DSH 端到端联调：${results.length - fails.length} PASS / ${fails.length} FAIL`);
    process.exit(fails.length ? 1 : 0);
  })
  .catch((err) => {
    console.error("E2E_FATAL", err);
    process.exit(2);
  });
