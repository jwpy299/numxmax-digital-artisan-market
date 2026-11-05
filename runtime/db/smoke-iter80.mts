/**
 * iter80 冒烟：L2 租户侧审批中心（部门负责人自助审批）
 * 1) 负责人 token → pandaTenantApprovals 可见本租户 l2 待办
 * 2) 非负责人（staff role）→ FORBIDDEN
 * 3) 负责人批 l2 单 → approved_by=staff:* 留痕
 * 4) 负责人批 l3 单 → FORBIDDEN（需平台超管）
 * 5) 负责人批他厂单（factory_id 非 NULL）→ FORBIDDEN
 * 6) 负责人驳回 l2 单 → rejected + reason 留痕
 * 7) 清理
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import type { TrpcContext } from "../api/context";
import { clawRouter } from "../api/routers/claw";
import { getDb } from "../api/queries/connection";

function ctx(): TrpcContext {
  return { req: new Request("http://localhost/api/trpc"), resHeaders: new Headers() } as TrpcContext;
}
const claw = clawRouter.createCaller(ctx());
const db = getDb();

async function q(statement: Parameters<typeof db.execute>[0]): Promise<Array<Record<string, unknown>>> {
  const res = (await db.execute(statement)) as unknown;
  return (Array.isArray(res) ? (res as unknown[])[0] : res) as Array<Record<string, unknown>>;
}

const OP_L2 = "CLSMK80L2TEST";
const OP_L3 = "CLSMK80L3TEST";
const OP_OTHER = "CLSMK80OTHERT";
const OP_REJ = "CLSMK80REJTST";

try {
  // 取一个负责人 token 与一个普通员工 token
  const heads = await q(sql`SELECT authToken FROM st_staff_accounts WHERE role='head' AND disabled=0 AND authToken IS NOT NULL LIMIT 1`);
  const staffs = await q(sql`SELECT authToken FROM st_staff_accounts WHERE role='staff' AND disabled=0 AND authToken IS NOT NULL LIMIT 1`);
  assert.ok(heads[0]?.authToken, "需至少一个未停用负责人账号");
  const headToken = String(heads[0].authToken);
  const staffToken = staffs[0]?.authToken ? String(staffs[0].authToken) : null;

  // 造四张合成单
  for (const op of [OP_L2, OP_L3, OP_OTHER, OP_REJ]) await q(sql`DELETE FROM st_claw_operations WHERE op_no = ${op}`);
  await q(sql`INSERT INTO st_claw_operations (op_no, instance_key, actor, task, risk, approval_level, status, factory_id)
              VALUES (${OP_L2}, 'smoke-none', 'smoke', 'iter80冒烟l2单', 'low', 'l2_tenant', 'pending', NULL),
                     (${OP_L3}, 'smoke-none', 'smoke', 'iter80冒烟l3单', 'high', 'l3_platform', 'pending', NULL),
                     (${OP_OTHER}, 'smoke-none', 'smoke', 'iter80冒烟他厂单', 'low', 'l2_tenant', 'pending', 999),
                     (${OP_REJ}, 'smoke-none', 'smoke', 'iter80冒烟驳回单', 'low', 'l2_tenant', 'pending', NULL)`);

  // 1) 负责人可见 l2 待办（他厂单不可见）
  const list = await claw.pandaTenantApprovals({ token: headToken });
  const pendNos = list.pending.map((i) => String(i.opNo));
  assert.ok(pendNos.includes(OP_L2), "l2 待办可见");
  assert.ok(pendNos.includes(OP_L3), "l3 待办只读可见");
  assert.ok(!pendNos.includes(OP_OTHER), "他厂单不可见");
  console.log("ok: 负责人待办列表（l2 可批 / l3 只读 / 他厂隔离）");

  // 2) 普通员工 FORBIDDEN
  if (staffToken) {
    await assert.rejects(claw.pandaTenantApprovals({ token: staffToken }), /负责人/, "staff 应被拒");
    console.log("ok: 普通员工无权访问（FORBIDDEN）");
  } else console.log("skip: 无普通员工账号，跳过 staff 负例");

  // 3) 负责人批 l2 → 留痕（s1 无 docker，执行会自然失败，不断言执行结果）
  const appr = await claw.pandaTenantApprove({ token: headToken, opNo: OP_L2 });
  assert.equal(appr.ok, true);
  const stamped = await q(sql`SELECT approved_by, approved_at FROM st_claw_operations WHERE op_no = ${OP_L2}`);
  assert.ok(String(stamped[0]?.approved_by).startsWith("staff:"), "approved_by=staff:* 留痕");
  assert.ok(stamped[0]?.approved_at, "approved_at 留痕");
  console.log("ok: 租户批准 l2 留痕（staff:*）");
  await q(sql`UPDATE st_claw_operations SET status='failed', error='smoke-teardown', finished_at=NOW() WHERE op_no = ${OP_L2}`);

  // 4) 批 l3 → FORBIDDEN
  await assert.rejects(claw.pandaTenantApprove({ token: headToken, opNo: OP_L3 }), /l3/, "l3 应被拒");
  console.log("ok: 租户批 l3 被拒（需平台超管）");

  // 5) 批他厂单 → FORBIDDEN
  await assert.rejects(claw.pandaTenantApprove({ token: headToken, opNo: OP_OTHER }), /其他工厂/, "他厂单应被拒");
  console.log("ok: 跨厂越权被拒（FORBIDDEN）");

  // 6) 驳回 l2 → rejected + reason
  const rej = await claw.pandaTenantReject({ token: headToken, opNo: OP_REJ, reason: "冒烟驳回原因" });
  assert.equal(rej.ok, true);
  const rejd = await q(sql`SELECT status, error, approved_by FROM st_claw_operations WHERE op_no = ${OP_REJ}`);
  assert.equal(String(rejd[0]?.status), "rejected");
  assert.equal(String(rejd[0]?.error), "冒烟驳回原因");
  assert.ok(String(rejd[0]?.approved_by).startsWith("staff:"));
  console.log("ok: 租户驳回留痕（rejected + reason）");

  console.log("SMOKE-ITER80-PASS");
} finally {
  for (const op of [OP_L2, OP_L3, OP_OTHER, OP_REJ]) await q(sql`DELETE FROM st_claw_operations WHERE op_no = ${op}`);
  console.log("cleaned");
}
process.exit(0);
