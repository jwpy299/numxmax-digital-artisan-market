/**
 * verifyBetaCode kind 分流闸直钉（主线①搬链门户仓——彭总链路钉：个人码只许个人注册/企业码只许企业开户=串线封死；
 * NumX 终判面：NULL 两端点皆严拒[backfill 收口后闸回无条件严面]）。
 * stub db 直钉（不连库）——闸逻辑单点 verifyBetaCode 四形态全钉。
 */
import { describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

const dialect = new MySqlDialect();
function gatedDb(rows: Array<Record<string, unknown>>) {
  const captured: string[] = [];
  const db = {
    execute: async (stmt: unknown) => {
      const q = dialect.sqlToQuery(stmt as never);
      captured.push(q.sql);
      if (q.sql.includes("UPDATE st_beta_invites SET consumed_at")) return [{ affectedRows: 1 }, []];
      return [rows, []];
    },
  };
  return { db, captured };
}

// connection 打桩（ensureBetaInvites 的 DDL 面走 getDb——mock 吞 DDL；闸 SELECT 走各例 stubDb 夹具）
vi.mock("../queries/connection", () => ({
  getDb: () => ({ execute: async () => [[{ affectedRows: 1 }], []] }),
}));

import { verifyBetaCode, consumeBetaCode } from "./smsVerify";

const BETA_CODE = `iv_${"b".repeat(48)}`;
const PHONE = "13800001111";

describe("verifyBetaCode kind 分流闸（门户仓直钉）", () => {
  it("个人码走个人口=放", async () => {
    const stubDb = { execute: async () => [[{ id: 7, kind: "personal" }]] };
    const r = await verifyBetaCode(stubDb as never, BETA_CODE, PHONE, "personal");
    expect(r.betaInvId).toBe(7);
  });

  it("企业码走个人口=拒（明路指引）", async () => {
    const stubDb = { execute: async () => [[{ id: 7, kind: "enterprise" }]] };
    await expect(verifyBetaCode(stubDb as never, BETA_CODE, PHONE, "personal")).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "该邀测码为企业报名通道发放——请用企业工作台注册开户",
    });
  });

  it("个人码走企业口=拒（明路指引）", async () => {
    const stubDb = { execute: async () => [[{ id: 7, kind: "personal" }]] };
    await expect(verifyBetaCode(stubDb as never, BETA_CODE, PHONE, "enterprise")).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "该邀测码为个人报名通道发放——请用个人工作台注册",
    });
  });

  it("NULL 残留行=两端点皆严拒（NumX 终判钉：backfill 收口后 NULL 不该存在——fail-closed 错拒优于错放）", async () => {
    const stubDb = { execute: async () => [[{ id: 7, kind: null }]] };
    await expect(verifyBetaCode(stubDb as never, BETA_CODE, PHONE, "enterprise")).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(verifyBetaCode(stubDb as never, BETA_CODE, PHONE, "personal")).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("码无效/已用/号不配=统一中性文案（无码攻击面无新增信息）", async () => {
    const stubDb = { execute: async () => [[]] };
    await expect(verifyBetaCode(stubDb as never, BETA_CODE, PHONE, "personal")).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "邀测码无效/已使用/与手机号不匹配——门户报名审核通过后短信发放",
    });
  });

  it("吊销行=与无效码同一中性文案；验真 SELECT 与消费 UPDATE 都带 revoked_at", async () => {
    const { db, captured } = gatedDb([]);
    await expect(verifyBetaCode(db as never, BETA_CODE, PHONE, "enterprise")).rejects.toThrow("邀测码无效");
    await consumeBetaCode(db as never, 7);
    expect(captured.length).toBe(2);
    for (const sql of captured) expect(sql).toContain("revoked_at IS NULL");
  });
});
