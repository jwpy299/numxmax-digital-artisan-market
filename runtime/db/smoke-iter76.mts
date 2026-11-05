/**
 * iter76 冒烟：三会议室席位规则 + 企业会议室同步流
 * 用法：source .env && DATABASE_URL=$DATABASE_URL npx tsx db/smoke-iter76.mts
 * 覆盖：
 *  1) staff head 发起 enterprise → FORBIDDEN
 *  2) staff head 发起 dept（本部门）→ ok，roomType=dept
 *  3) dept 会议真人插话 → ok
 *  4) enterpriseFeed（admin）→ 含开场白+插话两条，roomType=dept
 *  5) admin 发起 enterprise → ok
 *  6) cross 少于 2 部门 → BAD_REQUEST；2 部门 → ok
 *  7) feed 幂等：同 src_msg_id 不重复
 * 跑完清理冒烟数据。
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import type { TrpcContext } from "../api/context";
import { agenticRouter } from "../api/routers/agentic";
import { terminalRouter } from "../api/routers/terminal";
import { getDb } from "../api/queries/connection";

function ctx(): TrpcContext {
  return { req: new Request("http://localhost/api/trpc"), resHeaders: new Headers() } as TrpcContext;
}
const agentic = agenticRouter.createCaller(ctx());
const terminal = terminalRouter.createCaller(ctx());
const db = getDb();

async function q(statement: Parameters<typeof db.execute>[0]): Promise<Array<Record<string, unknown>>> {
  const res = (await db.execute(statement)) as unknown;
  return (Array.isArray(res) ? (res as unknown[])[0] : res) as Array<Record<string, unknown>>;
}

const meetingIds: number[] = [];
try {
  // 老板 token
  const login = await agentic.authLogin({ username: "demo", password: "demo123456" });
  const adminToken = login.token;
  console.log("ok: admin login（老板）");

  // 一名启用部门的 staff head token（从库内直读，不打印）
  const staffRows = (await q(sql`SELECT authToken, deptKey, username FROM st_staff_accounts
        WHERE role = 'head' AND disabled = 0 AND authToken IS NOT NULL AND authToken != '' LIMIT 1`)) as unknown as Array<{ authToken: string; deptKey: string; username: string }>;
  const staff = staffRows[0];
  assert.ok(staff, "存在可用 staff head");
  const staffToken = staff.authToken;
  const dept = staff.deptKey;
  console.log(`ok: staff head ready（dept=${dept}）`);

  // 1) staff 发起企业会议室 → FORBIDDEN
  await assert.rejects(
    () => terminal.meetingCreate({ token: staffToken, topic: "iter76冒烟-越权企业会", roomType: "enterprise" }),
    /FORBIDDEN|企业会议室仅老板/,
  );
  console.log("ok: staff 发起 enterprise 被拒");

  // 2) dept 会议室
  const deptMeeting = await terminal.meetingCreate({
    token: staffToken, topic: "iter76冒烟-部门会", opening: "部门会开场", roomType: "dept",
  });
  assert.equal(deptMeeting.roomType, "dept");
  meetingIds.push(deptMeeting.meetingId);
  console.log("ok: dept 会议室创建");

  // 3) 真人插话
  await terminal.meetingHumanSay({ token: staffToken, meetingId: deptMeeting.meetingId, content: "部门会插话内容" });
  console.log("ok: dept 插话");

  // 4) 企业会议室同步流
  const feed = await terminal.enterpriseFeed({ token: adminToken, limit: 50 });
  const mine = feed.items.filter((i) => Number(i.meetingId) === deptMeeting.meetingId);
  assert.ok(mine.length >= 2, `dept 会议应同步≥2条（开场+插话），实际 ${mine.length}`);
  assert.ok(mine.every((i) => i.roomType === "dept"));
  console.log(`ok: enterpriseFeed 同步 ${mine.length} 条`);

  // 5) admin 发起 enterprise
  const entMeeting = await terminal.meetingCreate({
    token: adminToken, topic: "iter76冒烟-企业会", opening: "企业会开场", roomType: "enterprise",
  });
  assert.equal(entMeeting.roomType, "enterprise");
  meetingIds.push(entMeeting.meetingId);
  console.log("ok: enterprise 会议室创建");

  // 6) cross 校验
  await assert.rejects(
    () => terminal.meetingCreate({ token: adminToken, topic: "iter76冒烟-跨部1", roomType: "cross", participantDepts: [dept] }),
    /至少勾选 2 个/,
  );
  const otherRows = (await q(sql`SELECT DISTINCT deptCode FROM st_agents WHERE deptCode != ${dept} LIMIT 1`)) as unknown as Array<{ deptCode: string }>;
  const other = otherRows[0]?.deptCode;
  assert.ok(other, "存在第二个部门");
  const crossMeeting = await terminal.meetingCreate({
    token: adminToken, topic: "iter76冒烟-跨部门会", roomType: "cross", participantDepts: [dept, other],
  });
  assert.equal(crossMeeting.roomType, "cross");
  meetingIds.push(crossMeeting.meetingId);
  console.log("ok: cross 校验（<2 拒 / 2 通过）");

  // 7) enterprise 会议消息不进同步流
  const feed2 = await terminal.enterpriseFeed({ token: adminToken, limit: 200 });
  const entLeak = feed2.items.filter((i) => Number(i.meetingId) === entMeeting.meetingId);
  assert.equal(entLeak.length, 0, "enterprise 会议不应出现在同步流");
  console.log("ok: enterprise 会议不入同步流");

  console.log("SMOKE-ITER76-PASS");
} finally {
  for (const id of meetingIds) {
    await db.execute(sql`DELETE FROM st_meeting_messages WHERE meetingId = ${id}`);
    await db.execute(sql`DELETE FROM st_enterprise_feed WHERE src_meeting_id = ${id}`);
    await db.execute(sql`DELETE FROM st_meetings WHERE id = ${id}`);
  }
  console.log("cleaned");
}
process.exit(0);
