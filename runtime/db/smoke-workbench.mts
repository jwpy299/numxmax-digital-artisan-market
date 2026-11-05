/**
 * 冒烟测试：灵枢星云智能工作台服务端（agentic / nebulaLink / workbenchMarket / showroomPortal）
 * 用法：npx tsx db/smoke-workbench.mts
 * 覆盖关键链路：
 *  bridgeStatus → register → login → me → createTicket → consume（二次消费必失败）
 *  → issuePublishKey → publishAgent(pending) → certify(listed)（member 被拒）
 *  → hireWithContract(pending) → decide(active)（member 被拒 / owner 通过）
 *  → showroom.status(ready) → request → confirm(published+productCount)
 *  未达标 requestPublication → ok:false+missing/thresholds；authMe 坏 token → null
 * 跑完清理 smoke 产生的数据（保留种子「华辰精工」演示数据）。
 */
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import type { TrpcContext } from "../api/context";
import { agenticRouter } from "../api/routers/agentic";
import { nebulaLinkRouter } from "../api/routers/nebulaLink";
import { workbenchMarketRouter } from "../api/routers/workbenchMarket";
import { showroomPortalRouter } from "../api/routers/showroomPortal";
import { getDb } from "../api/queries/connection";
import {
  wbContracts,
  wbDeptHeads,
  wbFactories,
  wbListings,
  wbPublishKeys,
  wbShowroom,
  wbShowroomProducts,
  wbTickets,
  wbUsers,
} from "./schema";

function ctx(): TrpcContext {
  return {
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
  } as TrpcContext;
}

const agentic = agenticRouter.createCaller(ctx());
const nebula = nebulaLinkRouter.createCaller(ctx());
const market = workbenchMarketRouter.createCaller(ctx());
const showroom = showroomPortalRouter.createCaller(ctx());
const db = getDb();

// 记录 smoke 产生的数据，结束后清理
const cleanup = {
  factoryIds: [] as number[],
  userIds: [] as number[],
  listingIds: [] as number[],
  contractIds: [] as number[],
  publishKeyIds: [] as number[],
  ticketHashes: [] as string[],
};

const runTag = `smoke${Date.now() % 100000}`;

try {
  // ── 0. bridgeStatus 自检 ────────────────────────────────────────────────
  const bs = await nebula.bridgeStatus();
  assert.equal(bs.source, "craftsman-market");
  assert.deepEqual(bs.supportedTargets, ["/dept", "/dashboard", "/market", "/showroom", "/skillmall", "/org"]);
  assert.equal(bs.ticketTtlSeconds, 300);
  assert.equal(bs.requiresLogin, true);
  console.log("ok: bridgeStatus 返回文档核实值（TTL=300, requiresLogin=true）");

  // ── 1. authRegister：新企业 + admin ─────────────────────────────────────
  const reg = await agentic.authRegister({
    username: `wb_${runTag}`,
    password: "smoke-pass-123",
    enterpriseName: `冒烟精工${runTag}`,
    industry: "机械制造",
    industryText: "冒烟测试",
    headcount: "50-200",
    departments: ["车间"],
    painPoints: "冒烟测试痛点",
    displayName: "冒烟主管",
  });
  assert.ok(reg.token.startsWith("nt_"), "注册重颁 nt_ token");
  assert.equal(reg.role, "admin");
  assert.equal(reg.generatedBy, "agentic.authRegister");
  assert.equal(reg.deptCount, 1);
  assert.equal(reg.bootstrapped, true);
  cleanup.factoryIds.push(reg.factoryId);
  console.log(`ok: authRegister 企业 #${reg.factoryId}（admin, deptCount=1, bootstrapped）`);

  // ── 2. authLogin（种子 demo）+ authMe ───────────────────────────────────
  const login = await agentic.authLogin({ username: "demo", password: "demo123456" });
  assert.ok(login.token.startsWith("nt_"));
  assert.equal(login.enterpriseName, "华辰精工");
  assert.equal(login.role, "admin");
  console.log("ok: authLogin demo → nt_ token（华辰精工 admin）");

  const me = await agentic.authMe({ token: login.token });
  assert.ok(me && me.user.username === "demo" && me.profile?.enterpriseName === "华辰精工");
  const meBad = await agentic.authMe({ token: "example-token-not-a-credential" });
  assert.equal(meBad, null, "authMe 坏 token 必须返回 null");
  console.log("ok: authMe 好 token → {user,profile}；坏 token → null");

  // enterpriseDirectory / enterpriseActiveProfile / orgMembers
  const dir = await agentic.enterpriseDirectory();
  assert.ok(dir.some((f) => f.enterpriseName === "华辰精工" && f.departments.length === 3));
  const prof = await agentic.enterpriseActiveProfile({ factoryId: login.factoryId });
  assert.equal(prof?.departments.length, 3);
  const members = await agentic.orgMembers({ token: login.token, factoryId: login.factoryId });
  assert.ok(members.some((m) => m.username === "lijing" && m.memberRole === "dept_head"));
  assert.ok(members.some((m) => m.username === "zhangwei" && m.deptName === "生产部"));
  console.log("ok: enterpriseDirectory / enterpriseActiveProfile / orgMembers（李静=dept_head）");

  // employeeRegister：deptId 非真实部门 → BAD_REQUEST（迭代 21 起需带 admin token）
  await assert.rejects(
    () =>
      agentic.employeeRegister({
        token: reg.token,
        username: `emp_${runTag}`,
        password: "smoke-pass-123",
        displayName: "冒烟员工",
        factoryId: reg.factoryId,
        deptId: "d99",
      }),
    (e: { code: string }) => e.code === "BAD_REQUEST",
  );
  // headRegister：写 dept_heads（迭代 21 起仅 admin/owner）
  const head = await agentic.headRegister({
    token: reg.token,
    username: `emp_${runTag}`,
    password: "smoke-pass-123",
    displayName: "冒烟负责人",
    factoryId: reg.factoryId,
    deptId: "d1",
    routineLimit: 5,
  });
  assert.equal(head.deptName, "车间");
  assert.ok(head.token.startsWith("nt_"));
  console.log("ok: employeeRegister 假部门被拒；headRegister 成功并写 dept_heads");

  // ── 3. createWorkbenchTicket → consume（含二次消费必失败）────────────────
  const ticket = await nebula.createWorkbenchTicket({ token: login.token, target: "/market" });
  assert.match(ticket.ticket, /^st_[0-9a-f]{48}$/);
  assert.equal(ticket.target, "/market");
  assert.ok(ticket.entryUrl.startsWith("/wb/bridge?ticket="));
  assert.ok(ticket.entryUrl.includes(encodeURIComponent(ticket.ticket)));
  assert.ok(ticket.expiresAt.getTime() - Date.now() > 290_000);
  cleanup.ticketHashes.push(ticket.ticket);
  console.log(`ok: createWorkbenchTicket → st_+48hex, entryUrl=${ticket.entryUrl.slice(0, 24)}…`);

  const consumed = await nebula.consumeWorkbenchTicket({ ticket: ticket.ticket });
  assert.ok(consumed.token.startsWith("nt_"), "消费后重颁 nt_ token");
  assert.equal(consumed.username, "demo");
  assert.equal(consumed.target, "/market");
  assert.equal(consumed.enterpriseName, "华辰精工");
  assert.equal(consumed.profileSummary.deptCount, 3);
  console.log("ok: consumeWorkbenchTicket → 新 nt_ token + profileSummary");

  // 旧 token 立即失效（单点有效）
  const oldMe = await agentic.authMe({ token: login.token });
  assert.equal(oldMe, null, "ticket 消费后旧 token 必须失效");
  // 二次消费必失败（统一口径）
  await assert.rejects(
    () => nebula.consumeWorkbenchTicket({ ticket: ticket.ticket }),
    (e: { code: string; message: string }) =>
      e.code === "BAD_REQUEST" && e.message === "ticket 无效或已过期",
  );
  // 不存在的 ticket 同一口径
  await assert.rejects(
    () => nebula.consumeWorkbenchTicket({ ticket: `st_${"0".repeat(48)}` }),
    (e: { code: string; message: string }) =>
      e.code === "BAD_REQUEST" && e.message === "ticket 无效或已过期",
  );
  console.log("ok: 二次消费/不存在 ticket 统一「ticket 无效或已过期」；旧 token 失效");

  const token = consumed.token; // 后续均用消费后的新 token

  // ── 4. issuePublishKey / myPublishKeys / revokePublishKey ───────────────
  const pk = await market.issuePublishKey({ token, assetType: "agent", expiresDays: 7 });
  assert.match(pk.publishKey, /^pk_[0-9a-f]{48}$/);
  cleanup.publishKeyIds.push(pk.keyId);
  const pk2 = await market.issuePublishKey({ token, assetType: "skill" });
  cleanup.publishKeyIds.push(pk2.keyId);
  const keys = await market.myPublishKeys({ token });
  assert.equal(keys.length, 2);
  assert.ok(keys.every((k) => !("keyHash" in k) && !("publishKey" in k)), "元数据不含 hash/明文");
  const revoked = await market.revokePublishKey({ token, keyId: pk2.keyId });
  assert.equal(revoked.status, "revoked");
  // 已吊销密钥上架必失败
  await assert.rejects(
    () =>
      market.publishSkillFromWorkbench({
        token,
        publishKey: pk2.publishKey,
        title: "冒烟技能",
        category: "测试",
        description: "已吊销密钥上架应失败",
        delivery: "API",
        pricingModel: "per_call",
        price: 10,
      }),
    (e: { code: string }) => e.code === "BAD_REQUEST",
  );
  console.log("ok: issuePublishKey pk_+48hex / myPublishKeys 无 hash / revoke 后上架被拒");

  // ── 5. publishAgent(pending) → certify（member 被拒 → admin listed）──────
  const pub = await market.publishAgentFromWorkbench({
    token,
    publishKey: pk.publishKey,
    title: `冒烟巡检智能体${runTag}`,
    capabilities: ["巡检调度", "冒烟测试"],
    employmentType: "长期雇佣",
    pricingModel: "monthly",
    price: 8800,
    description: "冒烟测试用智能体，验证上架两段式。",
  });
  assert.equal(pub.status, "pending");
  assert.ok(pub.geneEventId);
  cleanup.listingIds.push(pub.agentId);
  console.log(`ok: publishAgentFromWorkbench → pending（geneEventId=${pub.geneEventId}）`);

  const zw = await agentic.authLogin({ username: "zhangwei", password: "demo123456" });
  await assert.rejects(
    () => market.certifyAgent({ token: zw.token, listingId: pub.agentId, approve: true }),
    (e: { code: string }) => e.code === "FORBIDDEN",
  );
  console.log("ok: member 调 certifyAgent → FORBIDDEN");

  const cert = await market.certifyAgent({ token, listingId: pub.agentId, approve: true });
  assert.equal(cert.status, "listed");
  console.log("ok: admin certifyAgent → listed");

  // ── 6. hireWithContract(pending) → decide（member 被拒 → owner active）───
  const hire = await market.hireAgentWithContract({
    token,
    listingId: pub.agentId,
    roleScope: "冒烟车间巡检",
    workMode: "7×24 远程值守",
    trialDays: 7,
    note: "冒烟测试合同",
  });
  assert.equal(hire.hires, 1);
  assert.ok(hire.geneEventId);
  cleanup.contractIds.push(hire.contractId);
  const myContracts = await market.myHireContracts({ token });
  assert.ok(myContracts.some((c) => c.id === hire.contractId && c.status === "pending"));
  console.log(`ok: hireAgentWithContract → pending 合同 #${hire.contractId}（hires=1）`);

  await assert.rejects(
    () => market.decideHireContract({ token: zw.token, contractId: hire.contractId, approve: true }),
    (e: { code: string }) => e.code === "FORBIDDEN",
  );
  const lj = await agentic.authLogin({ username: "lijing", password: "demo123456" });
  const decided = await market.decideHireContract({ token: lj.token, contractId: hire.contractId, approve: true });
  assert.equal(decided.status, "active");
  console.log("ok: member decide → FORBIDDEN；owner decide → active");

  // pending 上架不可招募（两段式）
  const [pendingListing] = await db
    .select()
    .from(wbListings)
    .where(eq(wbListings.title, "焊缝质检智能体"))
    .limit(1);
  await assert.rejects(
    () =>
      market.hireAgentWithContract({
        token,
        listingId: pendingListing.id,
        roleScope: "x",
        workMode: "y",
      }),
    (e: { code: string }) => e.code === "BAD_REQUEST",
  );
  console.log("ok: pending 上架招募被拒（需 listed）");

  // ── 7. showroom：status(ready) → request → confirm(published) ───────────
  const st1 = await showroom.status({ token });
  assert.equal(st1.enterpriseName, "华辰精工");
  assert.equal(st1.ready, true, `种子企业应达标（score=${st1.learning.score}）`);
  assert.equal(st1.learning.score, 100);
  assert.deepEqual(st1.learning.missing, []);
  console.log(`ok: showroom.status ready=true score=${st1.learning.score}（metrics=${JSON.stringify(st1.learning.metrics)}）`);

  // 未达标分支：冒烟新企业（1 成员 / 1 部门 / 0 listed）
  const stNew = await showroom.status({ token: reg.token });
  assert.equal(stNew.ready, false);
  const reqFail = await showroom.requestPublication({ token: reg.token });
  assert.equal(reqFail.ok, false);
  assert.equal(reqFail.status, "learning");
  assert.ok("missing" in reqFail && reqFail.missing!.length > 0);
  assert.ok("thresholds" in reqFail && reqFail.thresholds!.readyScore === 80);
  console.log(`ok: 未达标 requestPublication → ok:false（score=${reqFail.score}, missing=${reqFail.missing?.length} 项）`);

  const req = await showroom.requestPublication({ token });
  assert.equal(req.ok, true);
  assert.equal(req.status, "pending_confirm");
  console.log("ok: 达标 requestPublication → pending_confirm");

  // learning 状态下 confirm 必被拒（另用新企业验证状态机约束）
  await assert.rejects(
    () => showroom.confirmPublication({ token: reg.token }),
    (e: { code: string }) => e.code === "BAD_REQUEST",
  );

  const confirmed = await showroom.confirmPublication({ token });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.status, "published");
  // 华辰精工 listed = 种子 2 + 冒烟新审核 1 = 3
  assert.equal(confirmed.productCount, 3);
  const products = await db
    .select()
    .from(wbShowroomProducts)
    .where(eq(wbShowroomProducts.factoryId, login.factoryId));
  assert.equal(products.length, 3);
  console.log(`ok: confirmPublication → published，productCount=${confirmed.productCount}（真实生成 wb_showroom_products）`);

  // published 后 reject 必被拒
  await assert.rejects(
    () => showroom.rejectPublication({ token }),
    (e: { code: string }) => e.code === "BAD_REQUEST",
  );
  console.log("ok: 状态机约束（非 pending_confirm 不可 confirm/reject）");

  console.log("\n✅ 工作台冒烟测试全部通过");
} finally {
  // ── 清理 smoke 数据（保留种子）──────────────────────────────────────────
  // 1) 冒烟新企业及其全部数据
  for (const fid of cleanup.factoryIds) {
    await db.delete(wbShowroomProducts).where(eq(wbShowroomProducts.factoryId, fid));
    await db.delete(wbShowroom).where(eq(wbShowroom.factoryId, fid));
    await db.delete(wbContracts).where(eq(wbContracts.factoryId, fid));
    await db.delete(wbListings).where(eq(wbListings.factoryId, fid));
    await db.delete(wbPublishKeys).where(eq(wbPublishKeys.factoryId, fid));
    await db.delete(wbTickets).where(eq(wbTickets.factoryId, fid));
    await db.delete(wbDeptHeads).where(eq(wbDeptHeads.factoryId, fid));
    await db.delete(wbUsers).where(eq(wbUsers.factoryId, fid));
    await db.delete(wbFactories).where(eq(wbFactories.id, fid));
  }
  // 2) 种子企业上 smoke 产生的行
  if (cleanup.contractIds.length)
    await db.delete(wbContracts).where(inArray(wbContracts.id, cleanup.contractIds));
  if (cleanup.listingIds.length)
    await db.delete(wbListings).where(inArray(wbListings.id, cleanup.listingIds));
  if (cleanup.publishKeyIds.length)
    await db.delete(wbPublishKeys).where(inArray(wbPublishKeys.id, cleanup.publishKeyIds));
  if (cleanup.ticketHashes.length) {
    const { createHash } = await import("node:crypto");
    for (const t of cleanup.ticketHashes) {
      const h = createHash("sha256").update(t, "utf8").digest("hex");
      await db.delete(wbTickets).where(eq(wbTickets.ticketHash, h));
    }
  }
  // 3) 复原种子企业 showroom 为 learning（清除 smoke 发布的商品与状态）
  const [seedFactory] = await db
    .select()
    .from(wbFactories)
    .where(eq(wbFactories.enterpriseName, "华辰精工"))
    .limit(1);
  if (seedFactory) {
    await db.delete(wbShowroomProducts).where(eq(wbShowroomProducts.factoryId, seedFactory.id));
    await db
      .update(wbShowroom)
      .set({
        status: "learning",
        score: 100,
        metrics: { memberCount: 3, departmentCount: 3, listedCount: 2 },
        thresholds: { memberCount: 3, departmentCount: 2, listedCount: 1, readyScore: 80 },
        requestedAt: null,
        decidedAt: null,
        productCount: 0,
      })
      .where(eq(wbShowroom.factoryId, seedFactory.id));
    // 4) 种子用户 token 置空（smoke 登录/消费重颁过）
    await db.update(wbUsers).set({ authToken: null }).where(eq(wbUsers.factoryId, seedFactory.id));
  }
  console.log("cleanup: smoke 数据已清理，种子保留并复原（showroom=learning, 种子用户 token 置空）");
  process.exit(0);
}
