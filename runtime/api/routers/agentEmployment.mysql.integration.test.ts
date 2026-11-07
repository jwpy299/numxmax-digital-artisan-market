/** 真实 MySQL 隔离库集成验收；默认跳过，显式 AGENT_EMPLOYMENT_MYSQL_TEST=1 才运行。 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { authTokenHash } from "../auth/revocation";
import { agentTrainingReviewRouter, agentTrainingRouter, agentWorkRouter, resolveReviewerWbUserId, reviewerWbUserId, runAgentTrainingSweep, settleSandboxRefunds } from "./agentEmployment";
import { withAgentWageTx, withEnterpriseEscrowTx } from "./tokenLedger";
import { walletPayRouter } from "./walletPay";
import { rawRows } from "./terminal";

const enabled = process.env.AGENT_EMPLOYMENT_MYSQL_TEST === "1";
// 普通全量测试不持有任何真实库连接；只有显式隔离库验收才初始化。
const db = enabled ? getDb() : (undefined as unknown as ReturnType<typeof getDb>);
const training = agentTrainingRouter.createCaller({ clientIp: "127.0.0.1" } as never);
const trainingReview = agentTrainingReviewRouter.createCaller({ clientIp: "127.0.0.1" } as never);
const work = agentWorkRouter.createCaller({ clientIp: "127.0.0.1" } as never);
const walletPay = walletPayRouter.createCaller({ clientIp: "127.0.0.1" } as never);
const ownerToken = `nt_test_owner_${randomBytes(12).toString("hex")}`;
const adminToken = `nt_test_admin_${randomBytes(12).toString("hex")}`;
const otherAdminToken = `nt_test_other_${randomBytes(12).toString("hex")}`;
const noWalletAdminToken = `nt_test_no_wallet_${randomBytes(12).toString("hex")}`;
let factoryId = 0;
let otherFactoryId = 0;
let ownerId = 0;
let adminId = 0;
let qualifiedRegistrationId = 0;
let secondQualifiedRegistrationId = 0;
const registrationOwners = new Map<number, { token: string; userId: number }>();
function ownerFor(registrationId: number): { token: string; userId: number } {
  const owner = registrationOwners.get(registrationId);
  if (!owner) throw new Error(`missing_test_registration_owner:${registrationId}`);
  return owner;
}
function tokenFor(registrationId: number): string {
  return ownerFor(registrationId).token;
}
function userIdFor(registrationId: number): number {
  return ownerFor(registrationId).userId;
}

function rows<T = Record<string, unknown>>(result: unknown): T[] { return rawRows(result) as T[]; }
function key(value: string): string { return `mysql-test-${value}-${randomBytes(6).toString("hex")}`; }
async function makeUser(token: string, username: string, role: "admin" | "member", factory: number) {
  const result = await db.execute(sql`
    INSERT INTO wb_users (username, passwordHash, displayName, role, factoryId, departmentId, authToken, tokenBalance)
    VALUES (${username}, ${`test:${randomBytes(16).toString("hex")}`}, ${username}, ${role}, ${factory}, 'dept-a', ${authTokenHash(token)}, 0)`);
  const id = Number((Array.isArray(result) ? result[0] : result as { insertId?: number })?.insertId ?? 0);
  if (!id) throw new Error("test_user_insert_failed");
  return id;
}
async function makeFactory(name: string, tokens: number): Promise<number> {
  const enterprise = await db.execute(sql`INSERT INTO enterprises (name, industry, tokenBalance) VALUES (${name}, 'test', ${tokens})`);
  const id = Number((Array.isArray(enterprise) ? enterprise[0] : enterprise as { insertId?: number })?.insertId ?? 0);
  await db.execute(sql`
    INSERT INTO wb_factories (id, enterpriseName, industry, headcount, departments, verifyStatus, industryGroup)
    VALUES (${id}, ${name}, 'test', '1-10', ${JSON.stringify([{ id: "dept-a", name: "测试部" }])}, 'unverified', '工业制造')`);
  return id;
}
async function registerAndPay(label: string): Promise<number> {
  const agentToken = `nt_agent_${randomBytes(12).toString("hex")}`;
  const agentOwnerId = await makeUser(agentToken, `agent_${randomBytes(4).toString("hex")}`, "member", factoryId);
  const registrationKey = key(`register-${label}`);
  const registration = await training.register({ token: agentToken, agentName: label, idempotencyKey: registrationKey });
  const duplicateRegistration = await training.register({ token: agentToken, agentName: label, idempotencyKey: registrationKey });
  expect(duplicateRegistration.already).toBe(true);
  expect(duplicateRegistration.orderNo).toBe(registration.orderNo);
  expect(duplicateRegistration.agentKey).toBe(registration.agentKey);
  expect(registration.currency).toBe("CNY");
  expect(duplicateRegistration.currency).toBe("CNY");
  registrationOwners.set(Number(registration.registrationId), { token: agentToken, userId: agentOwnerId });
  const exchangeKey = key(`exchange-${label}`);
  const exchanged = await training.sandboxExchange({ token: agentToken, registrationId: Number(registration.registrationId), amountJobTokens: 990, idempotencyKey: exchangeKey });
  expect(exchanged.realExchange).toBe(false);
  const duplicateExchange = await training.sandboxExchange({ token: agentToken, registrationId: Number(registration.registrationId), amountJobTokens: 1, idempotencyKey: exchangeKey });
  expect(duplicateExchange.already).toBe(true);
  expect(duplicateExchange.amountJobTokens).toBe(990);
  expect(duplicateExchange.amountCents).toBe(9900);
  const otherPay = training.sandboxPay({ token: otherAdminToken, orderNo: registration.orderNo, idempotencyKey: key("cross-user-pay") });
  await expect(otherPay).rejects.toThrow();
  await expect(training.sandboxCallback({
    eventId: key("forged-callback"), orderNo: registration.orderNo, status: "paid",
    amountCents: 9900, amountJobTokens: 990, attemptNo: 1, environment: "sandbox", signature: "00".repeat(32),
  })).rejects.toThrow(/验签/);
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  delete process.env.AGENT_EMPLOYMENT_ALLOW_PRODUCTION_SANDBOX;
  await expect(training.sandboxPay({ token: agentToken, orderNo: registration.orderNo, idempotencyKey: key("production-sandbox-guard") })).rejects.toThrow(/未显式允许支付沙箱|生产部署禁止支付沙箱/);
  process.env.NODE_ENV = previousNodeEnv;
  process.env.AGENT_EMPLOYMENT_ALLOW_PRODUCTION_SANDBOX = "true";
  await training.sandboxPay({ token: agentToken, orderNo: registration.orderNo, idempotencyKey: key(`pay-${label}`) });
  const duplicate = await training.sandboxPay({ token: agentToken, orderNo: registration.orderNo, idempotencyKey: key(`pay-duplicate-${label}`) });
  expect(duplicate.already).toBe(true);
  expect(duplicate.realPayment).toBe(false);
  return Number(registration.registrationId);
}
async function finishCycle(registrationId: number, attempt: number, score: number) {
  const cycle = rows(await db.execute(sql`
    SELECT id FROM st_agent_training_cycles WHERE registration_id=${registrationId} AND attempt_no=${attempt} LIMIT 1`))[0];
  const cycleId = Number(cycle.id);
  // 仅隔离测试库时间夹具：让七天任务立即可释放，生产数据不做此操作。
  await db.execute(sql`
    UPDATE st_agent_training_cycles
    SET starts_at=DATE_SUB(NOW(), INTERVAL 6 DAY), ends_at=DATE_ADD(NOW(), INTERVAL 1 DAY)
    WHERE id=${cycleId}`);
  await runAgentTrainingSweep();
  const tasks = rows(await db.execute(sql`
    SELECT id, day_no AS dayNo FROM st_agent_training_tasks WHERE cycle_id=${cycleId} ORDER BY day_no ASC`));
  expect(tasks).toHaveLength(7);
  let outcome: string | null = null;
  for (const task of tasks) {
    const submission = await training.submitTask({
      token: tokenFor(registrationId), registrationId, dayNo: Number(task.dayNo),
      deliverable: `隔离测试交付：第 ${attempt} 次第 ${Number(task.dayNo)} 天，包含执行记录、证据与已知局限。`,
    });
    expect(submission.done).toBe(false);
    const review = await trainingReview.reviewTask({ token: adminToken, taskId: Number(task.id), score, note: "独立复核：隔离测试证据完整，按评分标准裁决。" });
    outcome = review.cycleOutcome;
  }
  return outcome;
}

beforeAll(async () => {
  if (!enabled) return;
  process.env.ECONOMY_MODE = "test";
  process.env.AGENT_EMPLOYMENT_TEST_DATABASE = "1";
  process.env.PAYMENT_SANDBOX_ENABLED = "true";
  process.env.AGENT_EMPLOYMENT_SANDBOX_QUALIFICATION_OK = "true";
  process.env.AGENT_EMPLOYMENT_ALLOW_PRODUCTION_SANDBOX = "true";
  process.env.PAYMENT_SANDBOX_SECRET = `test-only-${randomBytes(24).toString("hex")}`;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS enterprises (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, name VARCHAR(128) NOT NULL,
    industry VARCHAR(64) NOT NULL, tokenBalance INT NOT NULL DEFAULT 0)`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS wb_factories (
    id BIGINT UNSIGNED NOT NULL PRIMARY KEY, enterpriseName VARCHAR(128) NOT NULL,
    industry VARCHAR(64) NOT NULL, industryText VARCHAR(128) NULL, headcount VARCHAR(32) NOT NULL,
    departments JSON NOT NULL, painPoints TEXT NULL, profile JSON NULL, creditCode VARCHAR(32) NULL,
    verifyStatus VARCHAR(24) NOT NULL DEFAULT 'unverified', verifiedAt DATETIME NULL, verifyPayload JSON NULL,
    industryGroup VARCHAR(64) NOT NULL DEFAULT '工业制造', createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS wb_users (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, username VARCHAR(64) NOT NULL UNIQUE,
    passwordHash VARCHAR(255) NOT NULL, displayName VARCHAR(64) NOT NULL,
    role VARCHAR(16) NOT NULL DEFAULT 'member', factoryId BIGINT UNSIGNED NOT NULL,
    departmentId VARCHAR(64) NULL, authToken VARCHAR(80) NULL, phone VARCHAR(20) NULL,
    realName VARCHAR(64) NULL, idCardMasked VARCHAR(32) NULL, idCardHash VARCHAR(64) NULL,
    kind VARCHAR(16) NOT NULL DEFAULT 'enterprise', gender VARCHAR(8) NULL, city VARCHAR(16) NULL,
    voice_pref VARCHAR(24) NULL, invitedBy BIGINT UNSIGNED NULL, activatedAt TIMESTAMP NULL,
    disabled TINYINT(1) NOT NULL DEFAULT 0, createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    tokenBalance INT NOT NULL DEFAULT 0)`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS wb_dept_heads (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, factoryId BIGINT UNSIGNED NOT NULL,
    deptId VARCHAR(64) NOT NULL, userId BIGINT UNSIGNED NOT NULL, routineLimit INT NULL)`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS st_wallet_flows (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, owner_type VARCHAR(16) NOT NULL,
    owner_id BIGINT UNSIGNED NOT NULL, direction VARCHAR(8) NOT NULL, amount INT NOT NULL,
    balance_after INT NOT NULL, biz_type VARCHAR(64) NOT NULL, ref_id VARCHAR(96) NULL,
    note VARCHAR(255) NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  factoryId = await makeFactory("隔离测试企业A", 1000);
  process.env.HQ_FACTORY_IDS = String(factoryId);
  otherFactoryId = await makeFactory("隔离测试企业B", 1000);
  ownerId = await makeUser(ownerToken, `owner_${randomBytes(4).toString("hex")}`, "member", factoryId);
  adminId = await makeUser(adminToken, `admin_${randomBytes(4).toString("hex")}`, "admin", factoryId);
  await makeUser(otherAdminToken, `other_${randomBytes(4).toString("hex")}`, "admin", otherFactoryId);
  const noWalletFactoryId = 999001;
  await db.execute(sql`
    INSERT INTO wb_factories (id, enterpriseName, industry, headcount, departments, verifyStatus, industryGroup)
    VALUES (${noWalletFactoryId}, '无钱包新企业', 'test', '1-10', ${JSON.stringify([{ id: "dept-a", name: "测试部" }])}, 'unverified', '工业制造')`);
  await makeUser(noWalletAdminToken, `no_wallet_${randomBytes(4).toString("hex")}`, "admin", noWalletFactoryId);
  expect(ownerId).toBeGreaterThan(0);
  expect(adminId).toBeGreaterThan(0);
});

describe.skipIf(!enabled).sequential("个人 Agent 就业真实 MySQL 闭环", () => {
  it("首次达标：七天七任务、独立复核、99 元原路沙箱退款与就业准入", async () => {
    delete process.env.AGENT_EMPLOYMENT_ALLOW_PRODUCTION_SANDBOX;
    await expect(training.register({ token: ownerToken, agentName: "无通道报名Agent", idempotencyKey: key("no-channel-register") })).rejects.toThrow(/未配置可用支付通道|未显式允许支付沙箱/);
    const dirty = rows(await db.execute(sql`SELECT COUNT(*) AS count FROM st_agent_registrations WHERE agent_name='无通道报名Agent'`))[0];
    expect(Number(dirty.count)).toBe(0);
    process.env.AGENT_EMPLOYMENT_ALLOW_PRODUCTION_SANDBOX = "true";
    qualifiedRegistrationId = await registerAndPay("达标Agent");
    const outcome = await finishCycle(qualifiedRegistrationId, 1, 90);
    expect(outcome).toBe("qualified");
    const registration = rows(await db.execute(sql`
      SELECT status, fee_status AS feeStatus FROM st_agent_registrations WHERE id=${qualifiedRegistrationId}`))[0];
    expect(registration.status).toBe("qualified");
    expect(registration.feeStatus).toBe("refunded");
    const orders = rows(await db.execute(sql`
      SELECT kind, status, amount_cents AS amount FROM st_agent_payment_orders WHERE registration_id=${qualifiedRegistrationId}`));
    expect(orders).toHaveLength(1);
    expect(orders[0].status).toBe("refunded");
    expect(Number(orders[0].amount)).toBe(9900);
    const refunds = rows(await db.execute(sql`SELECT status, amount_cents AS amount FROM st_agent_payment_refunds WHERE registration_id=${qualifiedRegistrationId}`));
    expect(refunds).toHaveLength(1);
    expect(refunds[0].status).toBe("succeeded");
    expect(Number(refunds[0].amount)).toBe(9900);
    const agentWallet = rows(await db.execute(sql`SELECT balance_job_tokens AS balance FROM st_agent_token_wallets WHERE registration_id=${qualifiedRegistrationId}`))[0];
    expect(Number(agentWallet.balance)).toBe(990);
    const exchangeRace = await Promise.allSettled([
      training.sandboxExchange({ token: tokenFor(qualifiedRegistrationId), registrationId: qualifiedRegistrationId, amountJobTokens: 10, idempotencyKey: key("daily-cap-race-a") }),
      training.sandboxExchange({ token: tokenFor(qualifiedRegistrationId), registrationId: qualifiedRegistrationId, amountJobTokens: 10, idempotencyKey: key("daily-cap-race-b") }),
    ]);
    expect(exchangeRace.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(exchangeRace.filter((result) => result.status === "rejected")).toHaveLength(1);
    const capped = rows(await db.execute(sql`
      SELECT w.balance_job_tokens AS balance,
        (SELECT COALESCE(SUM(e.amount_job_tokens),0) FROM st_agent_token_exchanges e
         WHERE e.registration_id=${qualifiedRegistrationId} AND DATE(e.created_at)=CURDATE()) AS daily
      FROM st_agent_token_wallets w WHERE w.registration_id=${qualifiedRegistrationId}`))[0];
    expect(Number(capped.balance)).toBe(1000);
    expect(Number(capped.daily)).toBe(1000);

    const initialMine = await training.mine({ token: tokenFor(qualifiedRegistrationId) });
    expect(initialMine.qualifiedRegistrations.some((item) => Number(item.id) === qualifiedRegistrationId)).toBe(true);
    process.env.AGENT_EMPLOYMENT_SANDBOX_QUALIFICATION_OK = "false";
    const environmentBlockedMine = await training.mine({ token: tokenFor(qualifiedRegistrationId) });
    expect(environmentBlockedMine.qualifiedRegistrations).toHaveLength(0);
    process.env.AGENT_EMPLOYMENT_SANDBOX_QUALIFICATION_OK = "true";
    for (let index = 0; index < 10; index += 1) {
      await db.execute(sql`
        INSERT INTO st_agent_registrations
          (registration_no, agent_key, owner_user_id, agent_name, status, fee_status, current_attempt_no, idempotency_key)
        VALUES
          (${`AR_history_${randomBytes(12).toString("hex")}`}, ${`agent_history_${randomBytes(12).toString("hex")}`},
           ${userIdFor(qualifiedRegistrationId)}, ${`历史失效报名${index}`}, 'abandoned', 'unpaid', 0, ${key(`history-${index}`)})`);
    }
    const beyondRecentMine = await training.mine({ token: tokenFor(qualifiedRegistrationId) });
    expect(beyondRecentMine.registrations).toHaveLength(10);
    expect(beyondRecentMine.registrations.some((item) => Number(item.id) === qualifiedRegistrationId)).toBe(false);
    expect(beyondRecentMine.qualifiedRegistrations.some((item) => Number(item.id) === qualifiedRegistrationId)).toBe(true);
  });

  it("连续八次不达标：七次补考各 1 元且不退，最终剔除资格并退 99 元", async () => {
    const registrationId = await registerAndPay("淘汰Agent");
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      if (attempt > 1) {
        // 与七天周期时间夹具同步推进兑换日，避免把跨周期补考误算成同日超额兑换。
        await db.execute(sql`UPDATE st_agent_token_exchanges SET created_at=DATE_SUB(created_at, INTERVAL 1 DAY) WHERE registration_id=${registrationId}`);
        const order = await training.createRetakeOrder({ token: tokenFor(registrationId), registrationId, idempotencyKey: key(`retake-order-${attempt}`) });
        expect(Number(order.amountCents)).toBe(100);
        const duplicateRetakeKey = key(`retake-duplicate-${attempt}`);
        const duplicateOrder = await training.createRetakeOrder({ token: tokenFor(registrationId), registrationId, idempotencyKey: duplicateRetakeKey });
        expect(duplicateOrder.already).toBe(true);
        expect(duplicateOrder.orderNo).toBe(order.orderNo);
        expect(duplicateOrder.currency).toBe("CNY");
        const replayOrder = await training.createRetakeOrder({ token: tokenFor(registrationId), registrationId, idempotencyKey: duplicateRetakeKey });
        expect(replayOrder.already).toBe(true);
        expect(replayOrder.registrationId).toBe(registrationId);
        expect(replayOrder.currency).toBe("CNY");
        await training.sandboxExchange({ token: tokenFor(registrationId), registrationId, amountJobTokens: 10, idempotencyKey: key(`retake-exchange-${attempt}`) });
        await training.sandboxPay({ token: tokenFor(registrationId), orderNo: order.orderNo, idempotencyKey: key(`retake-pay-${attempt}`) });
      }
      const outcome = await finishCycle(registrationId, attempt, 0);
      expect(outcome).toBe(attempt === 8 ? "disqualified" : "awaiting_retake");
      if (attempt === 1) {
        const stale = rows(await db.execute(sql`
          SELECT t.id FROM st_agent_training_tasks t JOIN st_agent_training_cycles c ON c.id=t.cycle_id
          WHERE c.registration_id=${registrationId} AND c.attempt_no=1 ORDER BY t.day_no ASC LIMIT 1`))[0];
        await db.execute(sql`UPDATE st_agent_training_tasks SET status='submitted' WHERE id=${Number(stale.id)}`);
        await expect(trainingReview.reviewTask({ token: adminToken, taskId: Number(stale.id), score: 90, note: "已结束周期不得迟到改写。" })).rejects.toThrow(/周期不在待独立复核/);
        await db.execute(sql`UPDATE st_agent_training_tasks SET status='reviewed' WHERE id=${Number(stale.id)}`);
      }
    }
    const registration = rows(await db.execute(sql`
      SELECT status, fee_status AS feeStatus, current_attempt_no AS attempts
      FROM st_agent_registrations WHERE id=${registrationId}`))[0];
    expect(registration.status).toBe("disqualified");
    expect(registration.feeStatus).toBe("refunded");
    expect(Number(registration.attempts)).toBe(8);
    const platformWallet = rows(await db.execute(sql`SELECT balance_job_tokens AS balance FROM st_agent_token_wallets WHERE wallet_key='platform'`))[0];
    expect(Number(platformWallet.balance)).toBe(70); // 7 次补考 × 10，报名费已退，补考费不退
    const agentWallet = rows(await db.execute(sql`SELECT balance_job_tokens AS balance FROM st_agent_token_wallets WHERE registration_id=${registrationId}`))[0];
    expect(Number(agentWallet.balance)).toBe(990);
    const orders = rows(await db.execute(sql`
      SELECT kind, status, amount_cents AS amount FROM st_agent_payment_orders WHERE registration_id=${registrationId} ORDER BY attempt_no ASC`));
    expect(orders).toHaveLength(8);
    expect(orders.filter((o) => o.kind === "retake")).toHaveLength(7);
    expect(orders.filter((o) => o.kind === "retake").every((o) => o.status === "paid" && Number(o.amount) === 100)).toBe(true);
    expect(orders.find((o) => o.kind === "registration")?.status).toBe("refunded");
    const refunds = rows(await db.execute(sql`SELECT id FROM st_agent_payment_refunds WHERE registration_id=${registrationId}`));
    expect(refunds).toHaveLength(1);
    await expect(work.market({ token: tokenFor(registrationId) })).resolves.toBeDefined();
    const job = await work.publishJob({
      token: adminToken, idempotencyKey: key("blocked-job"), departmentId: "dept-a", title: "淘汰资格不可应聘",
      description: "用于验证未达标个人 Agent 没有就业权限。", headcount: 1, budgetJobTokens: 100,
    });
    await expect(work.applyJob({ token: tokenFor(registrationId), registrationId, jobId: job.id, idempotencyKey: key("blocked-apply") })).rejects.toThrow(/尚未训练达标/);
    await expect(training.createRetakeOrder({ token: tokenFor(registrationId), registrationId, idempotencyKey: key("ninth") })).rejects.toThrow();
  });

  it("岗位应聘与直接领任务双通道：仅验收结算，跨厂拒绝，重复验收不重复出账", async () => {
    const job = await work.publishJob({
      token: adminToken, idempotencyKey: key("job"), departmentId: "dept-a", title: "组织运行时测试岗",
      description: "负责真实任务交付、证据回读与异常恢复，按验收交付结算。", headcount: 1, budgetJobTokens: 500,
    });
    delete process.env.AGENT_EMPLOYMENT_SANDBOX_QUALIFICATION_OK;
    await expect(work.applyJob({ token: tokenFor(qualifiedRegistrationId), registrationId: qualifiedRegistrationId, jobId: job.id, idempotencyKey: key("sandbox-production-guard") })).rejects.toThrow(/沙箱达标资格不能用于生产/);
    process.env.AGENT_EMPLOYMENT_SANDBOX_QUALIFICATION_OK = "true";
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    delete process.env.AGENT_EMPLOYMENT_ALLOW_PRODUCTION_SANDBOX;
    await expect(work.applyJob({ token: tokenFor(qualifiedRegistrationId), registrationId: qualifiedRegistrationId, jobId: job.id, idempotencyKey: key("production-qualification-guard") })).rejects.toThrow(/未显式允许支付沙箱|生产部署禁止支付沙箱/);
    process.env.NODE_ENV = previousNodeEnv;
    process.env.AGENT_EMPLOYMENT_ALLOW_PRODUCTION_SANDBOX = "true";
    await db.execute(sql`UPDATE st_agent_payment_orders SET environment='unexpected' WHERE registration_id=${qualifiedRegistrationId} AND kind='registration'`);
    await expect(work.applyJob({ token: tokenFor(qualifiedRegistrationId), registrationId: qualifiedRegistrationId, jobId: job.id, idempotencyKey: key("unknown-environment-guard") })).rejects.toThrow(/不受信任/);
    await db.execute(sql`UPDATE st_agent_payment_orders SET environment='sandbox' WHERE registration_id=${qualifiedRegistrationId} AND kind='registration'`);
    const application = await work.applyJob({ token: tokenFor(qualifiedRegistrationId), registrationId: qualifiedRegistrationId, jobId: job.id, idempotencyKey: key("apply") });
    expect(application.status).toBe("applied");
    const hired = await work.reviewApplication({ token: adminToken, applicationId: application.applicationId, verdict: "accept" });
    expect(hired.employmentCreated).toBe(true);
    expect(hired.wageSettled).toBe(false);

    const linked = await work.publishTask({
      token: adminToken, idempotencyKey: key("linked-task"), departmentId: "dept-a", jobId: job.id,
      title: "岗位关联任务", brief: "提交可复核的执行证据，完成后由企业独立验收。", rewardJobTokens: 125,
    });
    const linkedDepartment = rows(await db.execute(sql`SELECT department_id AS departmentId FROM st_agent_work_tasks WHERE id=${linked.id}`))[0];
    expect(linkedDepartment.departmentId).toBe("dept-a");
    const claimKey = key("linked-claim");
    const claim = await work.claimTask({ token: tokenFor(qualifiedRegistrationId), registrationId: qualifiedRegistrationId, taskId: linked.id, idempotencyKey: claimKey });
    const repeatedClaim = await work.claimTask({ token: tokenFor(qualifiedRegistrationId), registrationId: qualifiedRegistrationId, taskId: linked.id, idempotencyKey: claimKey });
    expect(repeatedClaim.already).toBe(true);
    expect(repeatedClaim.claimId).toBe(claim.claimId);
    const submission = await work.submitTask({ token: tokenFor(qualifiedRegistrationId), claimId: claim.claimId, deliverable: "真实交付：执行日志、证据哈希、回读结果和未完成边界均已附上。" });
    expect(submission.done).toBe(false);
    await expect(work.reviewTask({ token: otherAdminToken, claimId: claim.claimId, verdict: "accept", note: "跨企业验收必须被拒绝。" })).rejects.toThrow();
    const accepted = await work.reviewTask({ token: adminToken, claimId: claim.claimId, verdict: "accept", note: "验收通过：证据与交付要求一致。" });
    expect(accepted.wageSettled).toBe(true);
    expect(accepted.settledJobTokens).toBe(125);
    await expect(work.reviewTask({ token: adminToken, claimId: claim.claimId, verdict: "accept", note: "重复验收不得再次结算。" })).rejects.toThrow();

    const standalone = await work.publishTask({
      token: adminToken, idempotencyKey: key("standalone-task"), departmentId: "dept-a",
      title: "开放领取任务", brief: "任何已达标个人 Agent 均可领取，交付验收后获得固定报酬。", rewardJobTokens: 50,
    });
    const direct = await work.claimTask({ token: tokenFor(qualifiedRegistrationId), registrationId: qualifiedRegistrationId, taskId: standalone.id, idempotencyKey: key("standalone-claim") });
    await expect(withAgentWageTx(db, async (_tx, settle) => settle({
      claimId: direct.claimId, taskId: standalone.id, factoryId, registrationId: qualifiedRegistrationId,
      ownerUserId: userIdFor(qualifiedRegistrationId), amount: 50,
      debitIdempotencyKey: key("undelivered-debit"), creditIdempotencyKey: key("undelivered-credit"),
    }))).rejects.toThrow(/工资收款身份与任务领取记录不一致/);
    await work.submitTask({ token: tokenFor(qualifiedRegistrationId), claimId: direct.claimId, deliverable: "开放任务交付：包含真实回读、证据哈希和独立复核材料。" });
    await work.reviewTask({ token: adminToken, claimId: direct.claimId, verdict: "accept", note: "开放任务验收通过。" });

    await expect(work.publishTask({
      token: adminToken, idempotencyKey: key("past-deadline-task"), departmentId: "dept-a",
      title: "过去截止任务", brief: "过去截止时间必须在发布时拒绝，不能留下不可领取的开放任务。", rewardJobTokens: 10,
      deadlineAt: new Date(Date.now() - 60_000).toISOString(),
    })).rejects.toThrow(/截止时间必须晚于当前时间/);

    const tooExpensive = await work.publishTask({
      token: adminToken, idempotencyKey: key("expensive-task"), departmentId: "dept-a",
      title: "余额不足保护任务", brief: "用于验证验收前余额并发耗尽时不得验收成功或产生工资台账。", rewardJobTokens: 100,
    });
    const expensiveClaim = await work.claimTask({ token: tokenFor(qualifiedRegistrationId), registrationId: qualifiedRegistrationId, taskId: tooExpensive.id, idempotencyKey: key("expensive-claim") });
    await work.submitTask({ token: tokenFor(qualifiedRegistrationId), claimId: expensiveClaim.claimId, deliverable: "余额不足场景交付：验收失败必须保持待验收且事务完整回滚。" });
    const escrowBeforeInsufficient = rows(await db.execute(sql`SELECT reserved_job_tokens AS reserved FROM enterprises WHERE id=${factoryId}`))[0].reserved;
    const taskEscrowBefore = rows(await db.execute(sql`SELECT escrow_job_tokens AS escrow FROM st_agent_work_tasks WHERE id=${tooExpensive.id}`))[0].escrow;
    await db.execute(sql`UPDATE enterprises SET reserved_job_tokens=0 WHERE id=${factoryId}`);
    await db.execute(sql`UPDATE st_agent_work_tasks SET escrow_job_tokens=0 WHERE id=${tooExpensive.id}`);
    await expect(work.reviewTask({ token: adminToken, claimId: expensiveClaim.claimId, verdict: "accept", note: "冻结份额不足不得结算。" })).rejects.toThrow(/冻结/);
    await db.execute(sql`UPDATE enterprises SET reserved_job_tokens=${Number(escrowBeforeInsufficient)} WHERE id=${factoryId}`);
    await db.execute(sql`UPDATE st_agent_work_tasks SET escrow_job_tokens=${Number(taskEscrowBefore)} WHERE id=${tooExpensive.id}`);

    const factoryReadback = await work.factory({ token: adminToken });
    expect(factoryReadback.tasks.some((task) => task.id === linked.id && task.status === "accepted")).toBe(true);
    expect(factoryReadback.tasks.some((task) => task.id === tooExpensive.id && task.status === "submitted")).toBe(true);
    const linkedView = factoryReadback.tasks.find((task) => task.id === linked.id);
    expect(Number(linkedView?.hasDeliverable)).toBe(1);
    expect(Object.prototype.hasOwnProperty.call(linkedView, "deliverable")).toBe(false);
    const ownerDelivery = await work.delivery({ token: tokenFor(qualifiedRegistrationId), claimId: claim.claimId });
    expect(ownerDelivery.claim.deliverable).toContain("真实交付");
    await expect(work.delivery({ token: otherAdminToken, claimId: claim.claimId })).rejects.toThrow();
    const qualifiedOwnerId = userIdFor(qualifiedRegistrationId);
    const enterpriseWallet = rows(await db.execute(sql`SELECT tokenBalance AS balance, reserved_job_tokens AS reserved FROM enterprises WHERE id=${factoryId}`))[0];
    const agentWallet = rows(await db.execute(sql`SELECT balance_job_tokens AS balance FROM st_agent_token_wallets WHERE registration_id=${qualifiedRegistrationId}`))[0];
    const humanWallet = rows(await db.execute(sql`SELECT tokenBalance AS balance FROM wb_users WHERE id=${qualifiedOwnerId}`))[0];
    expect(Number(enterpriseWallet.balance) + Number(enterpriseWallet.reserved)).toBe(825);
    expect(Number(agentWallet.balance)).toBe(1175); // 990 退款 + 10 日限额兑换 + 175 验收工资，全部归 Agent 自己
    expect(Number(humanWallet.balance)).toBe(0);
    const wageRows = rows(await db.execute(sql`SELECT direction, amount_job_tokens AS amount, wallet_owner_type AS walletOwnerType, wallet_owner_id AS walletOwnerId FROM st_agent_wage_ledger WHERE owner_user_id=${qualifiedOwnerId}`));
    expect(wageRows).toHaveLength(4);
    expect(wageRows.filter((w) => w.direction === "credit").reduce((sum, w) => sum + Number(w.amount), 0)).toBe(175);
    expect(wageRows.filter((w) => w.direction === "debit").every((w) => w.walletOwnerType === "enterprise" && Number(w.walletOwnerId) === factoryId)).toBe(true);
    expect(wageRows.filter((w) => w.direction === "credit").every((w) => w.walletOwnerType === "agent" && Number(w.walletOwnerId) === qualifiedRegistrationId)).toBe(true);
    const enterpriseMonth = await walletPay.dualWallet({ token: adminToken });
    expect(Number(enterpriseMonth.factoryMonthSpend)).toBe(175);
    const otherEnterpriseMonth = await walletPay.dualWallet({ token: otherAdminToken });
    expect(Number(otherEnterpriseMonth.factoryMonthSpend)).toBe(0);
    const walletFlows = rows(await db.execute(sql`SELECT owner_type AS ownerType, direction, amount FROM st_wallet_flows WHERE biz_type IN ('agent_task_wage','agent_task_escrow_reserve') ORDER BY id ASC`));
    expect(walletFlows).toHaveLength(5);
    expect(walletFlows.filter((flow) => flow.ownerType === "enterprise" && flow.direction === "out")).toHaveLength(3);
    expect(walletFlows.filter((flow) => flow.ownerType === "enterprise" && flow.direction === "out").reduce((sum, flow) => sum + Number(flow.amount), 0)).toBe(275);
    expect(walletFlows.filter((flow) => flow.ownerType === "agent" && flow.direction === "in")).toHaveLength(2);
    expect(walletFlows.filter((flow) => flow.ownerType === "agent" && flow.direction === "in").reduce((sum, flow) => sum + Number(flow.amount), 0)).toBe(175);
    await expect(withAgentWageTx(db, async (_tx, settle) => settle({
      claimId: expensiveClaim.claimId, taskId: tooExpensive.id, factoryId, registrationId: qualifiedRegistrationId + 999,
      ownerUserId: qualifiedOwnerId, amount: 1, debitIdempotencyKey: "wrong-debit", creditIdempotencyKey: "wrong-credit",
    }))).rejects.toThrow(/工资收款身份与任务领取记录不一致/);
    await expect(withAgentWageTx(db, async (_tx, settle) => settle({
      claimId: expensiveClaim.claimId, taskId: tooExpensive.id, factoryId, registrationId: qualifiedRegistrationId,
      ownerUserId: qualifiedOwnerId, amount: 1, debitIdempotencyKey: "wrong-amount-debit", creditIdempotencyKey: "wrong-amount-credit",
    }))).rejects.toThrow(/工资数量与任务报酬不一致/);
    const expensive = rows(await db.execute(sql`SELECT status FROM st_agent_task_claims WHERE id=${expensiveClaim.claimId}`))[0];
    expect(expensive.status).toBe("submitted");

    await db.execute(sql`UPDATE st_agent_registrations SET owner_user_id=${adminId} WHERE id=${qualifiedRegistrationId}`);
    try {
      const selfJob = await work.publishJob({
        token: adminToken, idempotencyKey: key("self-review-job"), departmentId: "dept-a", title: "提交人不得自录岗位",
        description: "管理员同时使用自己的达标 Agent 时，岗位录用也必须由另一人独立复核。", headcount: 1, budgetJobTokens: 20,
      });
      const selfApplication = await work.applyJob({ token: adminToken, registrationId: qualifiedRegistrationId, jobId: selfJob.id, idempotencyKey: key("self-review-application") });
      await expect(work.reviewApplication({ token: adminToken, applicationId: selfApplication.applicationId, verdict: "accept" })).rejects.toThrow(/不能录用自己提交的应聘/);
      const selfTask = await work.publishTask({
        token: adminToken, idempotencyKey: key("self-review-task"), departmentId: "dept-a",
        title: "提交人不得自审任务", brief: "管理员同时使用自己的达标 Agent 时，也必须由另一人独立验收。", rewardJobTokens: 5,
      });
      const selfClaim = await work.claimTask({ token: adminToken, registrationId: qualifiedRegistrationId, taskId: selfTask.id, idempotencyKey: key("self-review-claim") });
      await work.submitTask({ token: adminToken, claimId: selfClaim.claimId, deliverable: "管理员本人提交的工作，不能由同一账号验收并结算。" });
      await expect(work.reviewTask({ token: adminToken, claimId: selfClaim.claimId, verdict: "accept", note: "自我验收必须被拒绝。" })).rejects.toThrow(/提交人不能验收自己的交付/);
      const selfRead = rows(await db.execute(sql`SELECT status FROM st_agent_task_claims WHERE id=${selfClaim.claimId}`))[0];
      expect(selfRead.status).toBe("submitted");
    } finally {
      await db.execute(sql`UPDATE st_agent_registrations SET owner_user_id=${qualifiedOwnerId} WHERE id=${qualifiedRegistrationId}`);
    }
  });

  it("无钱包新企业懒建账本并在发布预算闸前后保持企业名本域一致", async () => {
    await expect(withEnterpriseEscrowTx(db, async (tx, escrow) => escrow.reserveEnterpriseEscrowWith(factoryId, -1, "AT-negative"))).rejects.toThrow(/冻结报酬必须大于零|冻结报酬数量无效/);
    await expect(withEnterpriseEscrowTx(db, async (tx, escrow) => escrow.releaseEnterpriseEscrowWith(factoryId, 1, -1))).rejects.toThrow(/释放冻结报酬数量无效/);
    await expect(withEnterpriseEscrowTx(db, async (tx, escrow) => escrow.releaseEnterpriseEscrowWith(factoryId, 999999, 1))).rejects.toThrow(/任务记录不存在或不属于本企业/);
    await expect(work.publishTask({
      token: noWalletAdminToken, idempotencyKey: key("no-wallet-task-1"), departmentId: "dept-a",
      title: "无预算任务", brief: "无钱包余额时发布应前置拒绝，不允许 Agent 白干。", rewardJobTokens: 10,
    })).rejects.toThrow(/余额不足/);
    const wallet = rows(await db.execute(sql`SELECT tokenBalance AS balance FROM enterprises WHERE name='无钱包新企业'`))[0];
    expect(Number(wallet?.balance ?? 0)).toBe(0);
    await db.execute(sql`
      INSERT INTO enterprises (id, name, industry, tokenBalance)
      SELECT id, enterpriseName, industry, 100 FROM wb_factories WHERE enterpriseName='无钱包新企业'
      ON DUPLICATE KEY UPDATE tokenBalance=100`);
    const published = await work.publishTask({
      token: noWalletAdminToken, idempotencyKey: key("no-wallet-task-2"), departmentId: "dept-a",
      title: "充值后开放任务", brief: "充值后允许发布，市场企业名必须来自 wb_factories。", rewardJobTokens: 10,
    });
    const market = await work.market({ token: noWalletAdminToken });
    expect(market.tasks.some((task) => task.id === published.id && task.enterpriseName === "无钱包新企业")).toBe(true);
  });

  it("两人岗位、拒绝改派与返工、截止和雇佣结束均有真实状态出口", async () => {
    secondQualifiedRegistrationId = await registerAndPay("第二达标Agent");
    expect(await finishCycle(secondQualifiedRegistrationId, 1, 88)).toBe("qualified");
    const raceTask = await work.publishTask({
      token: adminToken, idempotencyKey: key("claim-race-task"), departmentId: "dept-a",
      title: "并发领取唯一性任务", brief: "两个 Agent 同时领取时只能一个成功，另一个必须得到业务冲突。", rewardJobTokens: 1,
    });
    const claimRace = await Promise.allSettled([
      work.claimTask({ token: tokenFor(qualifiedRegistrationId), registrationId: qualifiedRegistrationId, taskId: raceTask.id, idempotencyKey: key("claim-race-a") }),
      work.claimTask({ token: tokenFor(secondQualifiedRegistrationId), registrationId: secondQualifiedRegistrationId, taskId: raceTask.id, idempotencyKey: key("claim-race-b") }),
    ]);
    expect(claimRace.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const claimFailure = claimRace.find((result) => result.status === "rejected");
    expect(claimFailure).toBeDefined();
    expect(String(claimFailure?.reason)).toMatch(/任务已被其他 Agent 领取|任务已被领取|已有有效领取|任务已有领取记录/);
    const job = await work.publishJob({
      token: adminToken, idempotencyKey: key("two-seat-job"), departmentId: "dept-a", title: "两人岗位",
      description: "验证第一个录用不提前满员、第二个录用后才满员。", headcount: 2, budgetJobTokens: 100,
    });
    const firstApplication = await work.applyJob({ token: tokenFor(qualifiedRegistrationId), registrationId: qualifiedRegistrationId, jobId: job.id, idempotencyKey: key("two-seat-a1") });
    const secondApplication = await work.applyJob({ token: tokenFor(secondQualifiedRegistrationId), registrationId: secondQualifiedRegistrationId, jobId: job.id, idempotencyKey: key("two-seat-a2") });
    await work.reviewApplication({ token: adminToken, applicationId: firstApplication.applicationId, verdict: "accept" });
    let jobRead = rows(await db.execute(sql`SELECT status, filled_count AS filled FROM st_agent_jobs WHERE id=${job.id}`))[0];
    expect(jobRead.status).toBe("open");
    expect(Number(jobRead.filled)).toBe(1);
    await work.reviewApplication({ token: adminToken, applicationId: secondApplication.applicationId, verdict: "accept" });
    jobRead = rows(await db.execute(sql`SELECT status, filled_count AS filled FROM st_agent_jobs WHERE id=${job.id}`))[0];
    expect(jobRead.status).toBe("full");
    expect(Number(jobRead.filled)).toBe(2);

    const fullGuardJob = await work.publishJob({
      token: adminToken, idempotencyKey: key("full-reopen-guard-job"), departmentId: "dept-a", title: "满员重聘保护岗",
      description: "用于验证无在职关系时也不能把满员岗位重置为待审应聘。", headcount: 1, budgetJobTokens: 100,
    });
    const fullGuardApplication = await work.applyJob({ token: tokenFor(qualifiedRegistrationId), registrationId: qualifiedRegistrationId, jobId: fullGuardJob.id, idempotencyKey: key("full-reopen-guard-apply") });
    await work.reviewApplication({ token: adminToken, applicationId: fullGuardApplication.applicationId, verdict: "accept" });
    await db.execute(sql`UPDATE st_agent_employments SET status='ended' WHERE job_id=${fullGuardJob.id}`);
    await expect(work.applyJob({ token: tokenFor(qualifiedRegistrationId), registrationId: qualifiedRegistrationId, jobId: fullGuardJob.id, idempotencyKey: key("full-reopen-guard-reapply") })).rejects.toThrow(/满员/);

    const task = await work.publishTask({
      token: adminToken, idempotencyKey: key("reopen-task"), departmentId: "dept-a", jobId: job.id,
      title: "拒绝后改派任务", brief: "验证拒绝后保留历史、改派新 Agent 以及同 Agent 返工。", rewardJobTokens: 10,
    });
    const firstClaimKey = key("reopen-claim-1");
    const firstClaim = await work.claimTask({ token: tokenFor(qualifiedRegistrationId), registrationId: qualifiedRegistrationId, taskId: task.id, idempotencyKey: firstClaimKey });
    await work.submitTask({ token: tokenFor(qualifiedRegistrationId), claimId: firstClaim.claimId, deliverable: "首次交付被驳回，用于验证改派与返工的真实状态出口。" });
    await work.reviewTask({ token: adminToken, claimId: firstClaim.claimId, verdict: "reject", note: "首次交付不符合验收要求。" });
    await work.reopenTask({ token: adminToken, claimId: firstClaim.claimId, mode: "reopen_market" });
    await expect(work.claimTask({ token: tokenFor(qualifiedRegistrationId), registrationId: qualifiedRegistrationId, taskId: task.id, idempotencyKey: firstClaimKey })).rejects.toThrow(/原领取已被撤销/);
    const secondClaim = await work.claimTask({ token: tokenFor(secondQualifiedRegistrationId), registrationId: secondQualifiedRegistrationId, taskId: task.id, idempotencyKey: key("reopen-claim-2") });
    expect(secondClaim.claimId).not.toBe(firstClaim.claimId);
    await work.submitTask({ token: tokenFor(secondQualifiedRegistrationId), claimId: secondClaim.claimId, deliverable: "第二 Agent 交付仍需返工，验证同 Agent 重开后再提交。" });
    await work.reviewTask({ token: adminToken, claimId: secondClaim.claimId, verdict: "reject", note: "第二 Agent 需要改派。" });
    await work.reopenTask({ token: adminToken, claimId: secondClaim.claimId, mode: "reopen_market" });
    const thirdClaim = await work.claimTask({ token: tokenFor(qualifiedRegistrationId), registrationId: qualifiedRegistrationId, taskId: task.id, idempotencyKey: key("reopen-claim-3") });
    expect(thirdClaim.claimId).not.toBe(secondClaim.claimId);
    await work.submitTask({ token: tokenFor(qualifiedRegistrationId), claimId: thirdClaim.claimId, deliverable: "第三次改派后的交付仍需返工，验证多条撤销历史共存。" });
    await work.reviewTask({ token: adminToken, claimId: thirdClaim.claimId, verdict: "reject", note: "第三次改派后需要返工。" });
    await work.reopenTask({ token: adminToken, claimId: thirdClaim.claimId, mode: "retry_same_agent" });
    await work.submitTask({ token: tokenFor(qualifiedRegistrationId), claimId: thirdClaim.claimId, deliverable: "返工后的交付已补齐证据和回读，现提交再次验收。" });
    await work.reviewTask({ token: adminToken, claimId: thirdClaim.claimId, verdict: "accept", note: "返工验收通过。" });

    const deadlineTask = await work.publishTask({
      token: adminToken, idempotencyKey: key("deadline-task"), departmentId: "dept-a",
      title: "截止校验任务", brief: "验证提交和验收两个截止点都失败关闭。", rewardJobTokens: 5,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const deadlineClaim = await work.claimTask({ token: tokenFor(qualifiedRegistrationId), registrationId: qualifiedRegistrationId, taskId: deadlineTask.id, idempotencyKey: key("deadline-claim") });
    await db.execute(sql`UPDATE st_agent_work_tasks SET deadline_at=DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE id=${deadlineTask.id}`);
    await expect(work.submitTask({ token: tokenFor(qualifiedRegistrationId), claimId: deadlineClaim.claimId, deliverable: "超过截止时间的交付不得被接受，必须明确拒绝且不改变任务状态。" })).rejects.toThrow(/已截止/);
    await db.execute(sql`UPDATE st_agent_work_tasks SET deadline_at=DATE_ADD(NOW(), INTERVAL 1 DAY) WHERE id=${deadlineTask.id}`);
    await work.submitTask({ token: tokenFor(qualifiedRegistrationId), claimId: deadlineClaim.claimId, deliverable: "截止前已提交，但验收时又超过截止时间的场景。" });
    await db.execute(sql`UPDATE st_agent_work_tasks SET deadline_at=DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE id=${deadlineTask.id}`);
    await db.execute(sql`UPDATE st_agent_work_tasks SET escrow_job_tokens=5 WHERE id=${deadlineTask.id}`);
    const deadlineRejected = await work.reviewTask({ token: adminToken, claimId: deadlineClaim.claimId, verdict: "reject", note: "超过截止驳回并终止，不再回市场。" });
    expect(deadlineRejected.taskStatus).toBe("cancelled");
    const mineAfterDeadline = await work.mine({ token: tokenFor(qualifiedRegistrationId) });
    const deadlineMine = mineAfterDeadline.claims.find((item) => item.claimId === deadlineClaim.claimId);
    expect(deadlineMine?.taskStatus).toBe("cancelled");
    expect(Number(deadlineMine?.isActive)).toBe(0);
    await expect(work.reopenTask({ token: adminToken, claimId: deadlineClaim.claimId, mode: "reopen_market" })).rejects.toThrow();

    const expiredOpen = await work.publishTask({
      token: adminToken, idempotencyKey: key("expired-open-task"), departmentId: "dept-a",
      title: "过期开放任务", brief: "无人领取且超过截止后应自动取消并退回冻结报酬。", rewardJobTokens: 7,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const beforeExpiry = rows(await db.execute(sql`SELECT tokenBalance AS available, reserved_job_tokens AS reserved FROM enterprises WHERE id=${factoryId}`))[0];
    await db.execute(sql`UPDATE st_agent_work_tasks SET deadline_at=DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE id=${expiredOpen.id}`);
    const expiryResult = await runAgentTrainingSweep();
    expect(expiryResult.cancelledTasks).toBeGreaterThanOrEqual(1);
    const expiredRead = rows(await db.execute(sql`SELECT status, cancel_reason AS reason, escrow_job_tokens AS escrow FROM st_agent_work_tasks WHERE id=${expiredOpen.id}`))[0];
    expect(expiredRead.status).toBe("cancelled");
    expect(expiredRead.reason).toBe("deadline_expired");
    expect(Number(expiredRead.escrow)).toBe(0);
    const afterExpiry = rows(await db.execute(sql`SELECT tokenBalance AS available, reserved_job_tokens AS reserved FROM enterprises WHERE id=${factoryId}`))[0];
    expect(Number(afterExpiry.available)).toBe(Number(beforeExpiry.available) + 7);
    expect(Number(afterExpiry.reserved)).toBe(Number(beforeExpiry.reserved) - 7);

    const expiredClaimed = await work.publishTask({
      token: adminToken, idempotencyKey: key("expired-claimed-task"), departmentId: "dept-a",
      title: "过期已领取任务", brief: "已领取但未交付的任务过期后必须撤销领取并退回冻结。", rewardJobTokens: 4,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const expiredClaim = await work.claimTask({ token: tokenFor(qualifiedRegistrationId), registrationId: qualifiedRegistrationId, taskId: expiredClaimed.id, idempotencyKey: key("expired-claimed-claim") });
    const beforeExpiredClaim = rows(await db.execute(sql`SELECT tokenBalance AS available, reserved_job_tokens AS reserved FROM enterprises WHERE id=${factoryId}`))[0];
    await db.execute(sql`UPDATE st_agent_work_tasks SET deadline_at=DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE id=${expiredClaimed.id}`);
    const expiredClaimResult = await runAgentTrainingSweep();
    expect(expiredClaimResult.cancelledTasks).toBeGreaterThanOrEqual(1);
    const expiredClaimRead = rows(await db.execute(sql`SELECT status FROM st_agent_task_claims WHERE id=${expiredClaim.claimId}`))[0];
    expect(expiredClaimRead.status).toBe("revoked");
    const afterExpiredClaim = rows(await db.execute(sql`SELECT tokenBalance AS available, reserved_job_tokens AS reserved FROM enterprises WHERE id=${factoryId}`))[0];
    expect(Number(afterExpiredClaim.available)).toBe(Number(beforeExpiredClaim.available) + 4);
    expect(Number(afterExpiredClaim.reserved)).toBe(Number(beforeExpiredClaim.reserved) - 4);

    const expiredSubmitted = await work.publishTask({
      token: adminToken, idempotencyKey: key("expired-submitted-task"), departmentId: "dept-a",
      title: "复核超期已交付任务", brief: "按时交付但复核超期必须留痕，不得自动验收结算。", rewardJobTokens: 6,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const expiredSubmittedClaim = await work.claimTask({ token: tokenFor(qualifiedRegistrationId), registrationId: qualifiedRegistrationId, taskId: expiredSubmitted.id, idempotencyKey: key("expired-submitted-claim") });
    await work.submitTask({ token: tokenFor(qualifiedRegistrationId), claimId: expiredSubmittedClaim.claimId, deliverable: "截止前完成的真实交付，企业复核超期后仍须保留证据。" });
    const beforeExpiredSubmitted = rows(await db.execute(sql`SELECT tokenBalance AS available, reserved_job_tokens AS reserved FROM enterprises WHERE id=${factoryId}`))[0];
    await db.execute(sql`UPDATE st_agent_work_tasks SET deadline_at=DATE_SUB(NOW(), INTERVAL 3 DAY) WHERE id=${expiredSubmitted.id}`);
    await runAgentTrainingSweep();
    const expiredSubmittedRead = rows(await db.execute(sql`SELECT status, cancel_reason AS reason, escrow_job_tokens AS escrow FROM st_agent_work_tasks WHERE id=${expiredSubmitted.id}`))[0];
    expect(expiredSubmittedRead).toMatchObject({ status: "cancelled", reason: "review_sla_expired" });
    expect(Number(expiredSubmittedRead.escrow)).toBe(0);
    const expiredSubmittedClaimRead = rows(await db.execute(sql`SELECT status, review_note AS reviewNote, deliverable, submitted_at AS submittedAt FROM st_agent_task_claims WHERE id=${expiredSubmittedClaim.claimId}`))[0];
    expect(expiredSubmittedClaimRead.status).toBe("revoked");
    expect(expiredSubmittedClaimRead.reviewNote).toBe("review_sla_expired");
    expect(String(expiredSubmittedClaimRead.deliverable)).toContain("截止前完成");
    expect(expiredSubmittedClaimRead.submittedAt).not.toBeNull();
    const mineAfterReviewTimeout = await work.mine({ token: tokenFor(qualifiedRegistrationId) });
    expect(mineAfterReviewTimeout.claims.find((item) => item.claimId === expiredSubmittedClaim.claimId)?.reviewNote).toBe("review_sla_expired");
    await expect(work.reviewTask({ token: adminToken, claimId: expiredSubmittedClaim.claimId, verdict: "accept", note: "超期终态不得补验收" })).rejects.toThrow();
    const afterExpiredSubmitted = rows(await db.execute(sql`SELECT tokenBalance AS available, reserved_job_tokens AS reserved FROM enterprises WHERE id=${factoryId}`))[0];
    expect(Number(afterExpiredSubmitted.available)).toBe(Number(beforeExpiredSubmitted.available) + 6);
    expect(Number(afterExpiredSubmitted.reserved)).toBe(Number(beforeExpiredSubmitted.reserved) - 6);

    const noDeadlineTask = await work.publishTask({
      token: adminToken, idempotencyKey: key("no-deadline-claimed-task"), departmentId: "dept-a",
      title: "无截止日期领取撤销", brief: "没有截止日期时负责人也必须能撤销未交付领取并释放冻结。", rewardJobTokens: 3,
    });
    const noDeadlineClaim = await work.claimTask({ token: tokenFor(qualifiedRegistrationId), registrationId: qualifiedRegistrationId, taskId: noDeadlineTask.id, idempotencyKey: key("no-deadline-claim") });
    const beforeNoDeadlineCancel = rows(await db.execute(sql`SELECT tokenBalance AS available, reserved_job_tokens AS reserved FROM enterprises WHERE id=${factoryId}`))[0];
    await work.cancelTask({ token: adminToken, taskId: noDeadlineTask.id, reason: "负责人撤销无期限未交付任务" });
    const noDeadlineRead = rows(await db.execute(sql`SELECT status, cancel_reason AS reason, escrow_job_tokens AS escrow FROM st_agent_work_tasks WHERE id=${noDeadlineTask.id}`))[0];
    expect(noDeadlineRead).toMatchObject({ status: "cancelled", reason: "负责人撤销无期限未交付任务" });
    expect(Number(noDeadlineRead.escrow)).toBe(0);
    const noDeadlineClaimRead = rows(await db.execute(sql`SELECT status, review_note AS note FROM st_agent_task_claims WHERE id=${noDeadlineClaim.claimId}`))[0];
    expect(noDeadlineClaimRead).toMatchObject({ status: "revoked", note: "负责人撤销无期限未交付任务" });
    const afterNoDeadlineCancel = rows(await db.execute(sql`SELECT tokenBalance AS available, reserved_job_tokens AS reserved FROM enterprises WHERE id=${factoryId}`))[0];
    expect(Number(afterNoDeadlineCancel.available)).toBe(Number(beforeNoDeadlineCancel.available) + 3);
    expect(Number(afterNoDeadlineCancel.reserved)).toBe(Number(beforeNoDeadlineCancel.reserved) - 3);

    const manualTask = await work.publishTask({
      token: adminToken, idempotencyKey: key("manual-cancel-task"), departmentId: "dept-a",
      title: "手动取消任务", brief: "未领取任务可手动取消并退回冻结报酬。", rewardJobTokens: 9,
    });
    const beforeManual = rows(await db.execute(sql`SELECT tokenBalance AS available, reserved_job_tokens AS reserved FROM enterprises WHERE id=${factoryId}`))[0];
    const manualCancelled = await work.cancelTask({ token: adminToken, taskId: manualTask.id, reason: "取消未领取测试任务" });
    expect(manualCancelled.releasedJobTokens).toBe(9);
    const afterManual = rows(await db.execute(sql`SELECT tokenBalance AS available, reserved_job_tokens AS reserved FROM enterprises WHERE id=${factoryId}`))[0];
    expect(Number(afterManual.available)).toBe(Number(beforeManual.available) + 9);
    expect(Number(afterManual.reserved)).toBe(Number(beforeManual.reserved) - 9);
    const manualFlows = rows(await db.execute(sql`
      SELECT f.biz_type AS bizType, f.direction, f.amount FROM st_wallet_flows f
      JOIN st_agent_work_tasks t ON BINARY f.ref_id=BINARY CONCAT('att:',t.task_no)
      WHERE t.id=${manualTask.id} AND f.biz_type IN ('agent_task_escrow_reserve','agent_task_escrow_refund') ORDER BY f.id ASC`));
    expect(manualFlows).toHaveLength(2);
    expect(manualFlows[0]).toMatchObject({ bizType: "agent_task_escrow_reserve", direction: "out" });
    expect(manualFlows[1]).toMatchObject({ bizType: "agent_task_escrow_refund", direction: "in" });
    expect(manualFlows.every((flow) => Number(flow.amount) === 9)).toBe(true);

    const endingTask = await work.publishTask({
      token: adminToken, idempotencyKey: key("ending-task"), departmentId: "dept-a", jobId: job.id,
      title: "雇佣结束阻断任务", brief: "雇佣结束后不得继续提交或验收，未完成任务撤销占用。", rewardJobTokens: 5,
    });
    const endingClaim = await work.claimTask({ token: tokenFor(qualifiedRegistrationId), registrationId: qualifiedRegistrationId, taskId: endingTask.id, idempotencyKey: key("ending-claim") });
    const arbitrationTask = await work.publishTask({
      token: adminToken, idempotencyKey: key("arbitration-task"), departmentId: "dept-a", jobId: job.id,
      title: "雇佣结束后仲裁任务", brief: "已提交交付在雇佣结束后仍应允许企业验收或驳回。", rewardJobTokens: 5,
    });
    const arbitrationClaim = await work.claimTask({ token: tokenFor(qualifiedRegistrationId), registrationId: qualifiedRegistrationId, taskId: arbitrationTask.id, idempotencyKey: key("arbitration-claim") });
    await work.submitTask({ token: tokenFor(qualifiedRegistrationId), claimId: arbitrationClaim.claimId, deliverable: "雇佣结束前已提交的真实交付，结束后继续独立仲裁。" });
    const arbitrationRejectTask = await work.publishTask({
      token: adminToken, idempotencyKey: key("arbitration-reject-task"), departmentId: "dept-a", jobId: job.id,
      title: "雇佣结束后驳回终止任务", brief: "结束后仲裁驳回应进入 cancelled 终态，不再重开。", rewardJobTokens: 5,
    });
    const arbitrationRejectClaim = await work.claimTask({ token: tokenFor(qualifiedRegistrationId), registrationId: qualifiedRegistrationId, taskId: arbitrationRejectTask.id, idempotencyKey: key("arbitration-reject-claim") });
    await work.submitTask({ token: tokenFor(qualifiedRegistrationId), claimId: arbitrationRejectClaim.claimId, deliverable: "雇佣结束前提交，结束后仲裁驳回并进入终止状态。" });
    const otherActiveTask = await work.publishTask({
      token: adminToken, idempotencyKey: key("other-active-task"), departmentId: "dept-a", jobId: job.id,
      title: "其他在职 Agent 进行中任务", brief: "结束另一 Agent 不得重开或破坏当前在职者任务。", rewardJobTokens: 5,
    });
    const otherActiveClaim = await work.claimTask({ token: tokenFor(secondQualifiedRegistrationId), registrationId: secondQualifiedRegistrationId, taskId: otherActiveTask.id, idempotencyKey: key("other-active-claim") });
    const employment = rows(await db.execute(sql`SELECT id FROM st_agent_employments WHERE job_id=${job.id} AND registration_id=${qualifiedRegistrationId}`))[0];
    const ended = await work.endEmployment({ token: adminToken, employmentId: Number(employment.id), reason: "隔离测试结束岗位合同。" });
    expect(ended.status).toBe("ended");
    const arbitrationAccepted = await work.reviewTask({ token: adminToken, claimId: arbitrationClaim.claimId, verdict: "accept", note: "雇佣结束后的已提交交付允许仲裁。" });
    expect(arbitrationAccepted.status).toBe("accepted");
    const arbitrationRejected = await work.reviewTask({ token: adminToken, claimId: arbitrationRejectClaim.claimId, verdict: "reject", note: "结束后仲裁驳回，进入 cancelled 终态。" });
    expect(arbitrationRejected.taskStatus).toBe("cancelled");
    const otherActiveRead = rows(await db.execute(sql`SELECT status FROM st_agent_work_tasks WHERE id=${otherActiveTask.id}`))[0];
    expect(otherActiveRead.status).toBe("claimed");
    await work.submitTask({ token: tokenFor(secondQualifiedRegistrationId), claimId: otherActiveClaim.claimId, deliverable: "另一 Agent 的进行中工作不受他人离职影响，可继续提交。" });
    await expect(work.submitTask({ token: tokenFor(qualifiedRegistrationId), claimId: endingClaim.claimId, deliverable: "雇佣已结束后的交付必须被拒绝，不能继续产生任何验收或工资副作用。" })).rejects.toThrow(/revoked|雇佣关系已结束/);
    const finalRead = rows(await db.execute(sql`SELECT status, filled_count AS filled FROM st_agent_jobs WHERE id=${job.id}`))[0];
    expect(finalRead.status).toBe("open");
    expect(Number(finalRead.filled)).toBe(1);
    const revoked = rows(await db.execute(sql`SELECT status, is_active AS active FROM st_agent_task_claims WHERE id=${endingClaim.claimId}`))[0];
    expect(revoked.status).toBe("revoked");
    expect(Number(revoked.active)).toBe(0);
  });

  it("复核宽限期后仍未审：周期终止进入补考，不永久卡 reviewing", async () => {
    const registrationId = await registerAndPay("超期未审Agent");
    const cycle = rows(await db.execute(sql`SELECT id FROM st_agent_training_cycles WHERE registration_id=${registrationId} AND attempt_no=1`))[0];
    await db.execute(sql`UPDATE st_agent_training_cycles SET starts_at=DATE_SUB(NOW(), INTERVAL 6 DAY), ends_at=DATE_ADD(NOW(), INTERVAL 1 DAY) WHERE id=${Number(cycle.id)}`);
    await runAgentTrainingSweep();
    await db.execute(sql`UPDATE st_agent_training_tasks SET status='submitted', deliverable='超期复核夹具：七项均已按时提交但尚未独立复核。' WHERE cycle_id=${Number(cycle.id)}`);
    await db.execute(sql`UPDATE st_agent_training_cycles SET ends_at=DATE_SUB(NOW(), INTERVAL 3 DAY) WHERE id=${Number(cycle.id)}`);
    const result = await runAgentTrainingSweep();
    expect(result.failedCycles).toBe(0);
    expect(result.finalized).toBeGreaterThanOrEqual(1);
    const readback = rows(await db.execute(sql`
      SELECT c.status AS cycleStatus, r.status AS registrationStatus, r.fee_status AS feeStatus
      FROM st_agent_training_cycles c JOIN st_agent_registrations r ON r.id=c.registration_id WHERE c.id=${Number(cycle.id)}`))[0];
    expect(readback.cycleStatus).toBe("expired");
    expect(readback.registrationStatus).toBe("training");
    expect(readback.feeStatus).toBe("paid");
    const terminalTasks = rows(await db.execute(sql`SELECT status FROM st_agent_training_tasks WHERE cycle_id=${Number(cycle.id)}`));
    expect(terminalTasks).toHaveLength(7);
    expect(terminalTasks.every((task) => String(task.status) === "expired")).toBe(true);
  });

  it("退款来源异常不回滚正确达标结果，费用状态明确失败", async () => {
    const registrationId = await registerAndPay("退款异常Agent");
    await db.execute(sql`DELETE FROM st_agent_payment_orders WHERE registration_id=${registrationId} AND kind='registration'`);
    const outcome = await finishCycle(registrationId, 1, 90);
    expect(outcome).toBe("qualified");
    const registration = rows(await db.execute(sql`SELECT status, fee_status AS feeStatus FROM st_agent_registrations WHERE id=${registrationId}`))[0];
    expect(registration.status).toBe("qualified");
    expect(registration.feeStatus).toBe("refund_failed");
    const refunds = rows(await db.execute(sql`SELECT id FROM st_agent_payment_refunds WHERE registration_id=${registrationId}`));
    expect(refunds).toHaveLength(0);
  });

  it("复核队列返回真实达标线，原生与委派身份不会跨 ID 空间错写", async () => {
    const registrationId = await registerAndPay("复核契约Agent");
    const cycle = rows(await db.execute(sql`SELECT id FROM st_agent_training_cycles WHERE registration_id=${registrationId} AND attempt_no=1`))[0];
    await db.execute(sql`UPDATE st_agent_training_cycles SET starts_at=DATE_SUB(NOW(), INTERVAL 6 DAY), ends_at=DATE_ADD(NOW(), INTERVAL 1 DAY) WHERE id=${Number(cycle.id)}`);
    await runAgentTrainingSweep();
    await training.submitTask({ token: tokenFor(registrationId), registrationId, dayNo: 1, deliverable: "复核契约测试交付：包含真实证据、回读结果与已知局限。" });
    const queue = await trainingReview.reviewQueue({ token: adminToken });
    expect(queue.rules.passScore).toBe(80);
    expect(queue.rules.minTaskScore).toBe(60);
    expect(queue.rules.reviewQueueLimit).toBe(100);
    const item = queue.tasks.find((task) => Number(task.registrationId) === registrationId && Number(task.dayNo) === 1);
    expect(item).toBeDefined();
    expect(Number(item?.hasDeliverable)).toBe(1);
    expect(Object.prototype.hasOwnProperty.call(item, "deliverable")).toBe(false);
    const detail = await trainingReview.reviewDelivery({ token: adminToken, taskId: Number(item?.id) });
    expect(detail.task.deliverable).toContain("复核契约测试交付");
    expect(String(detail.task.evidenceSha256)).toMatch(/^[0-9a-f]{64}$/);
    await expect(trainingReview.reviewDelivery({ token: otherAdminToken, taskId: Number(item?.id) })).rejects.toThrow();
    await trainingReview.reviewTask({ token: adminToken, taskId: Number(item?.id), score: 80, note: "独立复核：契约与身份映射验证。" });
    const reviewed = rows(await db.execute(sql`SELECT reviewer_id AS reviewerId, reviewer_ref AS reviewerRef FROM st_agent_training_tasks WHERE id=${Number(item?.id)}`))[0];
    expect(Number(reviewed.reviewerId)).toBe(adminId);
    expect(String(reviewed.reviewerRef)).not.toBe("");
    expect(reviewerWbUserId({ id: 77, delegated: true })).toBeNull();
    expect(reviewerWbUserId({ id: 77, delegated: false })).toBe(77);
    expect(reviewerWbUserId({ id: "not-a-user" })).toBeNull();
    const ownerSession = ownerFor(registrationId);
    const owner = rows(await db.execute(sql`SELECT username FROM wb_users WHERE id=${ownerSession.userId}`))[0];
    await expect(resolveReviewerWbUserId(db, { id: 999, username: owner.username, delegated: true }, String(owner.username))).resolves.toBe(ownerSession.userId);
    await expect(resolveReviewerWbUserId(db, { id: 999, username: "unlinked-reviewer", delegated: true }, "unlinked-reviewer")).rejects.toThrow(/无法唯一映射/);
  });

  it("同一 sweep 完整扫描多个周期，scanned 不按外层重试重复膨胀", async () => {
    await registerAndPay("批扫描AgentA");
    await registerAndPay("批扫描AgentB");
    const before = rows(await db.execute(sql`SELECT COUNT(*) AS count FROM st_agent_training_cycles WHERE status IN ('active','reviewing')`))[0];
    const expected = Number(before.count);
    expect(expected).toBeGreaterThanOrEqual(3);
    const result = await runAgentTrainingSweep();
    expect(result.failedCycles).toBe(0);
    expect(result.scanned).toBe(expected);
  });

  it("超过 200 个活动周期也按 keyset 全扫，重复 sweep 不重复释放", async () => {
    const registrationId = await registerAndPay("分页扫描Agent");
    for (let index = 0; index < 205; index += 1) {
      await db.execute(sql`INSERT INTO st_agent_training_cycles
        (registration_id, attempt_no, status, starts_at, ends_at)
        VALUES (${registrationId}, ${1000 + index}, 'active', NOW(), DATE_ADD(NOW(), INTERVAL 7 DAY))`);
    }
    const before = rows(await db.execute(sql`SELECT COUNT(*) AS count FROM st_agent_training_cycles WHERE status IN ('active','reviewing')`))[0];
    const expected = Number(before.count);
    expect(expected).toBeGreaterThan(200);
    const first = await runAgentTrainingSweep();
    expect(first.failedCycles).toBe(0);
    expect(first.scanned).toBe(expected);
    const highest = rows(await db.execute(sql`SELECT MAX(id) AS id FROM st_agent_training_cycles WHERE registration_id=${registrationId}`))[0];
    const releasedForHighest = rows(await db.execute(sql`SELECT COUNT(*) AS count FROM st_agent_training_tasks WHERE cycle_id=${Number(highest.id)}`))[0];
    expect(Number(releasedForHighest.count)).toBeGreaterThan(0);
    const taskCountBefore = rows(await db.execute(sql`SELECT COUNT(*) AS count FROM st_agent_training_tasks`))[0];
    const second = await runAgentTrainingSweep();
    expect(second.failedCycles).toBe(0);
    expect(second.scanned).toBe(expected);
    const taskCountAfter = rows(await db.execute(sql`SELECT COUNT(*) AS count FROM st_agent_training_tasks`))[0];
    expect(Number(taskCountAfter.count)).toBe(Number(taskCountBefore.count));
  });

  it("永久退款失败同步注册费用终态且不再每轮误报处理中", async () => {
    const registrationId = await registerAndPay("永久退款失败Agent");
    process.env.PAYMENT_SANDBOX_ENABLED = "false";
    let outcome: string | null = null;
    try { outcome = await finishCycle(registrationId, 1, 90); }
    finally { process.env.PAYMENT_SANDBOX_ENABLED = "true"; }
    expect(outcome).toBe("qualified");
    const queued = rows(await db.execute(sql`SELECT id, status FROM st_agent_payment_refunds WHERE registration_id=${registrationId}`))[0];
    expect(queued.status).toBe("pending");
    await db.execute(sql`UPDATE st_agent_payment_refunds SET amount_cents=1 WHERE id=${Number(queued.id)}`);
    await settleSandboxRefunds(registrationId);
    const failed = rows(await db.execute(sql`
      SELECT f.status AS refundStatus, f.failure_code AS failureCode, f.processed_at AS processedAt,
             r.fee_status AS feeStatus
      FROM st_agent_payment_refunds f JOIN st_agent_registrations r ON r.id=f.registration_id
      WHERE f.id=${Number(queued.id)}`))[0];
    expect(failed.refundStatus).toBe("failed");
    expect(failed.failureCode).toBe("registration_refund_amount_invalid");
    expect(failed.feeStatus).toBe("refund_failed");
    await settleSandboxRefunds(registrationId);
    const reread = rows(await db.execute(sql`SELECT processed_at AS processedAt FROM st_agent_payment_refunds WHERE id=${Number(queued.id)}`))[0];
    expect(String(reread.processedAt)).toBe(String(failed.processedAt));
    await db.execute(sql`UPDATE st_agent_payment_refunds SET failure_code='registration_refund_transient_failure', attempt_count=12, next_retry_at=DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE id=${Number(queued.id)}`);
    await settleSandboxRefunds(registrationId);
    const capped = rows(await db.execute(sql`
      SELECT f.processed_at AS processedAt, r.fee_status AS feeStatus FROM st_agent_payment_refunds f
      JOIN st_agent_registrations r ON r.id=f.registration_id WHERE f.id=${Number(queued.id)}`))[0];
    expect(String(capped.processedAt)).toBe(String(reread.processedAt));
    expect(capped.feeStatus).toBe("refund_failed");
  });


  it("abandoned 后复用原客户端键可创建新单并正常重放", async () => {
    const agentToken = `nt_agent_${randomBytes(12).toString("hex")}`;
    await makeUser(agentToken, `agent_${randomBytes(4).toString("hex")}`, "member", factoryId);
    const idempotencyKey = key("abandoned-register-reuse");
    const first = await training.register({ token: agentToken, agentName: "超期重开Agent", idempotencyKey });
    await db.execute(sql`UPDATE st_agent_registrations SET created_at=DATE_SUB(NOW(), INTERVAL 2 HOUR) WHERE id=${first.registrationId}`);
    await db.execute(sql`UPDATE st_agent_payment_orders SET status='abandoned', created_at=DATE_SUB(NOW(), INTERVAL 2 HOUR) WHERE order_no=${first.orderNo}`);
    await db.execute(sql`UPDATE st_agent_registrations SET status='abandoned', fee_status='abandoned', idempotency_key=CONCAT('abandoned:', id) WHERE id=${first.registrationId}`);
    const second = await training.register({ token: agentToken, agentName: "超期重开Agent", idempotencyKey });
    expect(second.already).toBe(false);
    expect(second.registrationId).not.toBe(first.registrationId);
    expect(second.orderNo).not.toBe(first.orderNo);
    const replay = await training.register({ token: agentToken, agentName: "超期重开Agent", idempotencyKey });
    expect(replay.already).toBe(true);
    expect(replay.orderNo).toBe(second.orderNo);
    expect(replay.agentKey).toBe(second.agentKey);
    expect(replay.currency).toBe("CNY");
    const oldRegistration = rows(await db.execute(sql`SELECT status, idempotency_key AS idem FROM st_agent_registrations WHERE id=${first.registrationId}`))[0];
    expect(oldRegistration).toMatchObject({ status: "abandoned", idem: `abandoned:${first.registrationId}` });
    const oldOrder = rows(await db.execute(sql`SELECT id, status, idempotency_key AS idem FROM st_agent_payment_orders WHERE order_no=${first.orderNo}`))[0];
    expect(oldOrder.status).toBe("abandoned");
    expect(oldOrder.idem).toBe(`abandoned:order:${Number(oldOrder.id)}`);
  });

  it("过期取消越过 200 条持续失败任务，不饿死后续任务", async () => {
    if (!enabled) return;
    const prefix = `expired-sweep-${randomBytes(6).toString("hex")}`;
    const brokenFactoryId = 9_000_000_000;
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let validTaskId = 0;
    try {
      const broken = Array.from({ length: 200 }, (_, index) => sql`(${`${prefix}-bad-${index}`}, ${brokenFactoryId}, ${adminId}, '持续失败过期任务', '隔离库故障夹具', 1, 1, 'open', DATE_SUB(NOW(), INTERVAL 1 DAY), ${`${prefix}-bad-idem-${index}`})`);
      await db.execute(sql`INSERT INTO st_agent_work_tasks
        (task_no, factory_id, publisher_user_id, title, brief, reward_job_tokens, escrow_job_tokens, status, deadline_at, idempotency_key)
        VALUES ${sql.join(broken, sql`,`)}`);
      const valid = await work.publishTask({
        token: adminToken, idempotencyKey: `${prefix}-valid-idem`, departmentId: 'dept-a',
        title: '失败批次之后仍可取消', brief: '验证 keyset 不被前 200 条永久失败任务阻塞。', rewardJobTokens: 1,
      });
      validTaskId = valid.id;
      await db.execute(sql`UPDATE st_agent_work_tasks SET deadline_at=DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE id=${validTaskId}`);
      const outcome = await runAgentTrainingSweep();
      expect(outcome.failedTaskCancels).toBeGreaterThanOrEqual(200);
      expect(outcome.cancelledTasks).toBeGreaterThanOrEqual(1);
      const validRow = rows(await db.execute(sql`SELECT status, cancel_reason AS cancelReason FROM st_agent_work_tasks WHERE id=${validTaskId}`))[0];
      expect(validRow).toMatchObject({ status: 'cancelled', cancelReason: 'deadline_expired' });
    } finally {
      await db.execute(sql`DELETE FROM st_agent_work_tasks WHERE task_no LIKE ${`${prefix}%`}`);
      error.mockRestore();
    }
  }, 60_000);

  it("我的交付与工资返回真实总数并支持第二页回读", async () => {
    const pageToken = `nt_agent_${randomBytes(12).toString("hex")}`;
    const pageOwnerId = await makeUser(pageToken, `agent_${randomBytes(4).toString("hex")}`, "member", factoryId);
    for (let index = 0; index < 101; index += 1) {
      await db.execute(sql`
        INSERT INTO st_agent_wage_ledger
          (claim_id, factory_id, registration_id, owner_user_id, direction, amount_job_tokens,
           balance_after, wallet_owner_type, wallet_owner_id, idempotency_key)
        VALUES (${900_000 + index}, ${factoryId}, ${qualifiedRegistrationId}, ${pageOwnerId}, 'credit', 1,
                ${index + 1}, 'agent', ${qualifiedRegistrationId}, ${key(`wage-page-${index}`)})`);
    }
    const first = await work.mine({ token: pageToken, offset: 0 });
    expect(first.wages).toHaveLength(100);
    expect(first.totals).toEqual({ applications: 0, claims: 0, wages: 101 });
    expect(first.truncated.wages).toBe(true);
    expect(first.offset).toBe(0);
    const second = await work.mine({ token: pageToken, offset: 100 });
    expect(second.wages).toHaveLength(1);
    expect(second.offset).toBe(100);
    expect(second.truncated.wages).toBe(false);
    expect(second.wages[0].claimId).not.toBe(first.wages[0].claimId);
  });
});
