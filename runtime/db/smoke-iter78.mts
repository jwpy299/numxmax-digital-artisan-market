/**
 * iter78 冒烟：Panda 四角色席位 + 分级审批流
 * 1) 平台级四席位已种子（co/ex/va/ev）
 * 2) upsert 租户席位 → 列表可见；重复 upsert 不重复（唯一键）
 * 3) toggle 停用/启用
 * 4) 造 pending 操作单（l3_platform）→ pandaApprovals 可见
 * 5) pandaApprove → approved_by/at 留痕（实例不存在会报错，但审批戳已落）
 * 6) 清理
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import type { TrpcContext } from "../api/context";
import { agenticRouter } from "../api/routers/agentic";
import { clawRouter } from "../api/routers/claw";
import { getDb } from "../api/queries/connection";

function ctx(): TrpcContext {
  return { req: new Request("http://localhost/api/trpc"), resHeaders: new Headers() } as TrpcContext;
}
const agentic = agenticRouter.createCaller(ctx());
const claw = clawRouter.createCaller(ctx());
const db = getDb();

async function q(statement: Parameters<typeof db.execute>[0]): Promise<Array<Record<string, unknown>>> {
  const res = (await db.execute(statement)) as unknown;
  return (Array.isArray(res) ? (res as unknown[])[0] : res) as Array<Record<string, unknown>>;
}

const OP = "CLSMK78TEST01";
let memberId = 0;
try {
  const login = await agentic.authLogin({ username: "demo", password: "demo123456" });
  const token = login.token;

  // 1) 平台四席位
  const seats = await claw.pandaMembers({ token });
  const roles = seats.items.map((s) => String(s.role));
  for (const r of ["co", "ex", "va", "ev"]) assert.ok(roles.includes(r), `缺平台席位 ${r}`);
  console.log("ok: 平台四席位 co/ex/va/ev 齐备");

  // 2) 租户席位 upsert 幂等
  await claw.pandaMemberUpsert({ token, factoryId: 1, role: "co", refType: "staff", refKey: "smoke-head", duty: "冒烟席位" });
  await claw.pandaMemberUpsert({ token, factoryId: 1, role: "co", refType: "staff", refKey: "smoke-head", duty: "冒烟席位v2" });
  const tenant = await claw.pandaMembers({ token, factoryId: 1 });
  const mine = tenant.items.filter((s) => String(s.refKey) === "smoke-head");
  assert.equal(mine.length, 1, "唯一键防重复");
  assert.equal(String(mine[0].duty), "冒烟席位v2", "upsert 更新职责");
  memberId = Number(mine[0].id);
  console.log("ok: 租户席位 upsert 幂等");

  // 3) toggle
  await claw.pandaMemberToggle({ token, id: memberId, enabled: false });
  await claw.pandaMemberToggle({ token, id: memberId, enabled: true });
  console.log("ok: 席位停用/启用");

  // 4) 造 pending 单（l3）→ 审批列表可见
  await q(sql`DELETE FROM st_claw_operations WHERE op_no = ${OP}`);
  await q(sql`INSERT INTO st_claw_operations (op_no, instance_key, actor, task, domain, risk, approval_level, status)
              VALUES (${OP}, 'smoke-none', 'smoke', 'iter78冒烟审批单', NULL, 'high', 'l3_platform', 'pending')`);
  const pend = await claw.pandaApprovals({ token, level: "l3_platform" });
  assert.ok(pend.items.some((i) => String(i.opNo) === OP), "审批列表可见");
  console.log("ok: l3 待审批单可见");

  // 5) pandaApprove：审批戳必须留痕；执行层环境相关（未知实例回落 main，s1 无 docker 会自然失败），不断言执行结果
  const appr = await claw.pandaApprove({ token, opNo: OP });
  assert.equal(appr.ok, true);
  const stamped = await q(sql`SELECT approved_by, approved_at, status FROM st_claw_operations WHERE op_no = ${OP}`);
  assert.ok(stamped[0]?.approved_by, "approved_by 留痕");
  assert.ok(stamped[0]?.approved_at, "approved_at 留痕");
  console.log(`ok: pandaApprove 审批留痕（status=${String(stamped[0]?.status)}）`);
  // 立即把执行态单收尾，避免占用实例互斥锁
  await q(sql`UPDATE st_claw_operations SET status = 'failed', error = 'smoke-teardown', finished_at = NOW() WHERE op_no = ${OP}`);

  console.log("SMOKE-ITER78-PASS");
} finally {
  await q(sql`DELETE FROM st_claw_operations WHERE op_no = ${OP}`);
  if (memberId) await q(sql`DELETE FROM st_panda_members WHERE id = ${memberId}`);
  console.log("cleaned");
}
process.exit(0);
