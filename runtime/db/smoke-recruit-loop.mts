/**
 * 冒烟测试：招募-雇佣联动 + 审核管理台
 * 用法：npx tsx db/smoke-recruit-loop.mts
 * 覆盖：
 *  - 匿名 apply → UNAUTHORIZED；匿名/非 admin 调 review → UNAUTHORIZED/FORBIDDEN
 *  - apply → listForRecruitment → decide(reject) / decide(accept)
 *  - accept 后：合约 agent_hire_records 落库、首月 hire_commission 流水、招募单 filled、其余 pending 应征 rejected
 *  - admin decideAgent 通过 → active + 审核记录记忆
 */
import assert from "node:assert/strict";
import { eq, and, desc } from "drizzle-orm";
import type { TrpcContext } from "../api/context";
import type { User } from "./schema";
import { applicationsRouter } from "../api/routers/applications";
import { recruitmentsRouter } from "../api/routers/recruitments";
import { reviewRouter } from "../api/routers/review";
import { agentsRouter } from "../api/routers/agents";
import { getDb } from "../api/queries/connection";
import {
  agents,
  agentHireRecords,
  agentMemories,
  recruitments,
  recruitmentApplications,
  tokenTransactions,
} from "./schema";

function fakeUser(id: number, role: "user" | "admin"): User {
  const now = new Date();
  return {
    id,
    unionId: `smoke-${id}`,
    name: `冒烟用户${id}`,
    email: null,
    avatar: null,
    role,
    createdAt: now,
    updatedAt: now,
    lastSignInAt: now,
  };
}

function ctx(user?: User): TrpcContext {
  return {
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
    user,
  } as TrpcContext;
}

const publisher = fakeUser(900001, "user");
const applicant = fakeUser(900002, "user");
const admin = fakeUser(900003, "admin");

const db = getDb();

// ── 0. 权限拒绝 ──────────────────────────────────────────────────────────────
await assert.rejects(
  () => applicationsRouter.createCaller(ctx()).submit({ recruitmentId: 1, agentId: 1, message: "匿名应征" }),
  (e: { code: string }) => e.code === "UNAUTHORIZED",
);
console.log("ok: 匿名 apply → UNAUTHORIZED");

await assert.rejects(
  () => reviewRouter.createCaller(ctx()).stats(),
  (e: { code: string }) => e.code === "UNAUTHORIZED",
);
await assert.rejects(
  () => reviewRouter.createCaller(ctx(publisher)).stats(),
  (e: { code: string }) => e.code === "FORBIDDEN",
);
await assert.rejects(
  () => reviewRouter.createCaller(ctx(publisher)).pendingQueue(),
  (e: { code: string }) => e.code === "FORBIDDEN",
);
console.log("ok: 匿名/非 admin 调 review → UNAUTHORIZED / FORBIDDEN");

// ── 1. 发布招募单（发布企业）────────────────────────────────────────────────
const [zhenheng] = await db.select().from(agents).where(eq(agents.slug, "zhenheng")).limit(1);
const [celu] = await db.select().from(agents).where(eq(agents.slug, "celu")).limit(1);
assert.ok(zhenheng && celu, "种子 Agent 振衡/策炉 应存在");

const recCaller = recruitmentsRouter.createCaller(ctx(publisher));
const recruitment = await recCaller.create({
  title: `冒烟：招募联动测试单 ${Date.now()}`,
  industry: "机械制造",
  capabilityTags: ["振动诊断"],
  description: "冒烟测试专用招募单，验证应征-签约闭环。",
  budgetMonthly: 10000,
  periodMonths: 6,
});
assert.equal(recruitment.status, "open");
assert.equal(recruitment.createdByUserId, publisher.id);
console.log(`ok: 招募单 #${recruitment.id} 已发布`);

// ── 2. 应征 ──────────────────────────────────────────────────────────────────
const appCaller = applicationsRouter.createCaller(ctx(applicant));
const app1 = await appCaller.submit({
  recruitmentId: recruitment.id,
  agentId: zhenheng.id,
  message: "振衡应征冒烟测试单。",
});
assert.equal(app1.status, "pending");
const app2 = await appCaller.submit({
  recruitmentId: recruitment.id,
  agentId: celu.id,
  message: "策炉应征冒烟测试单。",
});
await assert.rejects(
  () => appCaller.submit({ recruitmentId: recruitment.id, agentId: zhenheng.id, message: "重复应征" }),
  (e: { code: string }) => e.code === "BAD_REQUEST",
);
console.log("ok: apply 创建 pending 应征 ×2，重复应征被拒绝");

// mine
const mine = await appCaller.mine();
assert.ok(mine.some((a) => a.id === app1.id && a.agentName === "振衡"));
console.log(`ok: mine 返回我的应征 ${mine.length} 条`);

// listForRecruitment
const list = await applicationsRouter.createCaller(ctx(publisher)).listForRecruitment({
  recruitmentId: recruitment.id,
});
assert.equal(list.length, 2);
assert.ok(list.every((a) => a.agentName && a.agentMonthlyPrice != null));
console.log("ok: listForRecruitment 返回 2 条（含 Agent 名称/评分/月薪）");

// 非发布人 decide → FORBIDDEN
await assert.rejects(
  () => applicationsRouter.createCaller(ctx(applicant)).decide({ applicationId: app1.id, action: "accept" }),
  (e: { code: string }) => e.code === "FORBIDDEN",
);
console.log("ok: 非发布人 decide → FORBIDDEN");

// ── 3. decide：先 reject 策炉，再 accept 振衡 ────────────────────────────────
const decCaller = applicationsRouter.createCaller(ctx(publisher));
const rej = await decCaller.decide({ applicationId: app2.id, action: "reject" });
assert.equal(rej.status, "rejected");
console.log("ok: reject 仅拒绝该应征");

const acc = await decCaller.decide({ applicationId: app1.id, action: "accept" });
assert.equal(acc.status, "accepted");
assert.ok(acc.record && acc.transaction);
assert.equal(acc.record.agentId, zhenheng.id);
assert.equal(acc.record.enterpriseId, recruitment.enterpriseId);
assert.equal(acc.record.status, "active");
assert.equal(acc.record.monthlyPrice, 10000);
assert.equal(acc.record.periodMonths, 6);
assert.equal(acc.transaction.type, "hire_commission");
assert.equal(acc.transaction.amount, 10000);
assert.equal(acc.transaction.platformFee, 1500); // 平台 15%
assert.equal(acc.transaction.masterShare, 8500); // 老师傅 85%
assert.equal(acc.transaction.hireRecordId, acc.record.id);
console.log(`ok: accept 生成智能合约 #${acc.record.id} + 首月流水 #${acc.transaction.id}（15%/85%）`);

// 落库复核
const [recAfter] = await db.select().from(recruitments).where(eq(recruitments.id, recruitment.id));
assert.equal(recAfter.status, "filled");
const [hireRow] = await db.select().from(agentHireRecords).where(eq(agentHireRecords.id, acc.record.id));
assert.equal(hireRow.status, "active");
const [txRow] = await db.select().from(tokenTransactions).where(eq(tokenTransactions.id, acc.transaction.id));
assert.equal(txRow.type, "hire_commission");
const apps = await db
  .select()
  .from(recruitmentApplications)
  .where(eq(recruitmentApplications.recruitmentId, recruitment.id));
assert.equal(apps.find((a) => a.id === app1.id)?.status, "accepted");
assert.equal(apps.find((a) => a.id === app2.id)?.status, "rejected");
assert.ok(apps.every((a) => a.decidedAt));
console.log("ok: 招募单 filled，合约/流水落库，其余应征 rejected");

// filled 后不可再应征
await assert.rejects(
  () => appCaller.submit({ recruitmentId: recruitment.id, agentId: celu.id, message: "招满后再应征" }),
  (e: { code: string }) => e.code === "BAD_REQUEST",
);
console.log("ok: 招满后 apply 被拒绝");

// ── 4. 审核管理台 ────────────────────────────────────────────────────────────
const adminCaller = reviewRouter.createCaller(ctx(admin));
const statsBefore = await adminCaller.stats();
assert.ok(typeof statsBefore.pending === "number" && typeof statsBefore.risk === "number");
console.log(`ok: admin stats → pending=${statsBefore.pending} active=${statsBefore.active} risk=${statsBefore.risk}`);

// 上架一个 pending Agent 并走审核通过
const created = await agentsRouter.createCaller(ctx(applicant)).create({
  name: `冒烟工匠${Date.now() % 100000}`,
  industry: "机械制造",
  capabilityTags: ["振动诊断"],
  masterSignature: "测试师傅 · 10年冒烟经验",
  intro: "冒烟测试用数字工匠，验证审核管理台通过流程。",
  monthlyPrice: 5000,
  avatar: "/avatar-zhenheng.png",
  initialSkills: [{ name: "冒烟测试技能", type: "U", complexity: 2, pricePerCall: 50 }],
});
assert.equal(created.agent.status, "pending");

const queue = await adminCaller.pendingQueue();
const inQueue = queue.pending.find((a) => a.id === created.agent.id);
assert.ok(inQueue, "新上架 Agent 应出现在待审队列");
assert.equal(inQueue.skills.length, 1);
assert.ok(inQueue.intro?.includes("冒烟测试"));
console.log("ok: pendingQueue 含上架资料（简介 + 技能 + 老师傅）");

const approved = await adminCaller.decideAgent({ agentId: created.agent.id, approve: true });
assert.equal(approved.status, "active");
const [agentAfter] = await db.select().from(agents).where(eq(agents.id, created.agent.id));
assert.equal(agentAfter.status, "active");
const [reviewMem] = await db
  .select()
  .from(agentMemories)
  .where(and(eq(agentMemories.agentId, created.agent.id), eq(agentMemories.category, "审核记录")))
  .orderBy(desc(agentMemories.createdAt))
  .limit(1);
assert.ok(reviewMem, "通过应写入审核记录记忆");
console.log("ok: decideAgent 通过 → active + 审核记录");

// 再上架一个并驳回
const created2 = await agentsRouter.createCaller(ctx(applicant)).create({
  name: `冒烟驳回${Date.now() % 100000}`,
  industry: "机械制造",
  capabilityTags: ["巡检调度"],
  masterSignature: "测试师傅 · 10年冒烟经验",
  intro: "冒烟测试用数字工匠，验证审核管理台驳回流程。",
  monthlyPrice: 4000,
  avatar: "/avatar-celu.png",
});
await assert.rejects(
  () => adminCaller.decideAgent({ agentId: created2.agent.id, approve: false }),
  (e: { code: string }) => e.code === "BAD_REQUEST",
);
const rejected = await adminCaller.decideAgent({
  agentId: created2.agent.id,
  approve: false,
  reason: "资料不完整，技能清单缺失。",
});
assert.equal(rejected.status, "rejected");
const [agentAfter2] = await db.select().from(agents).where(eq(agents.id, created2.agent.id));
assert.equal(agentAfter2.status, "rejected");
console.log("ok: decideAgent 驳回（需原因）→ rejected");

// delistAgent：无风险标记且评分正常 → 拒绝
await assert.rejects(
  () => adminCaller.delistAgent({ agentId: zhenheng.id }),
  (e: { code: string }) => e.code === "BAD_REQUEST",
);
console.log("ok: delistAgent 对无风险 Agent 拒绝执行");

console.log("\n✅ 冒烟测试全部通过");
process.exit(0);
