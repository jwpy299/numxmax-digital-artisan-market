/**
 * smsVerify —— 短信验证码校验/消费共享件（门禁 high 票：agentic ↔ sms 循环依赖断链件）。
 *
 * 循环链真因：sms.ts import sessionInfoEx from './agentic'，agentic.ts 又 import phoneSchema/verifyAndConsumeSmsCode from './sms'
 * ——phoneSchema 是 const，循环下 TDZ 雷。本模块不 import sms/agentic，双仓同引=环断。
 *
 * 两个粒度（门禁 security 票：事务吞 attempts 计数面封死）：
 * - verifySmsCodeOnly（校验+错验计数，事务外直提交）——错验 attempts+1 落库即生效，外层注册事务回滚吞不掉
 *   （爆破计数失效=无限试错面封死）；返回 rowId 供事务内消费；
 * - consumeSmsCodeById（按行原子消费）——事务内调用：UPDATE ... WHERE id AND consumedAt IS NULL，
 *   败方 affected=0 抛错随事务回滚（防重放/并发复用）；
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { timingSafeEqual } from "node:crypto";
import type { getDb } from "../queries/connection"; // 仅类型位引用——type-only 不拉运行时模块（门禁票）
import { wbSmsCodes } from "@db/schema";
import { sha256 } from "./wbSession";
import { rawRows } from "./terminal"; // 行提取仓内惯例
import { ensureBetaInvites } from "./betaInvites"; // 资格码表 ensure 单源
import type { BetaKind } from "@contracts/betaKinds"; // 分流身份枚举跨栈单源直引（主线①搬链——门户仓同构）

export type SmsTxDb = Pick<ReturnType<typeof getDb>, "select" | "execute">;

/** 手机号口径单源（zod）——注册/登录/报名/开户四面同引 */
export const phoneSchema = z
  .string()
  .trim()
  .regex(/^1[3-9]\d{9}$/, "手机号格式不正确");

/** 验证码格式口径单源（6 位数字——sms.ts 生成面 padStart(6,"0")/前端 wbSms.SMS_CODE_RE 同） */
export const SMS_CODE_RE = /^\d{6}$/;

/** 邀测码格式口径单源（iv_+48 位小写 hex——newCredential("iv_") 生成面同构；门禁票：双处内联复刻漂移面封死） */
export const BETA_CODE_RE = /^iv_[0-9a-f]{48}$/;

/** 邀测码格式错误文案单源（门禁票：双注册口重复） */
export const BETA_CODE_MSG = "邀测码格式不正确（iv_ 开头）";

export const SMS_MAX_ATTEMPTS = 5; // 错验 ≥5 作废
const CODE_INVALID = "验证码错误或已过期";
const CODE_VOID = "验证码已失效，请重新获取";

type SmsPurpose = typeof wbSmsCodes.$inferSelect.purpose; // 枚举自适应仓（portal 含 beta_apply / wb 仅 register|login——schema 权威）
type SmsCodeRow = typeof wbSmsCodes.$inferSelect;

/** 取最新码行（SQL 层 ORDER BY id DESC LIMIT 1——门禁 perf 票：不全拉；不限 consumedAt——作废行也取到供 CODE_VOID 判定） */
async function latestCodeRow(
  db: SmsTxDb,
  phone: string,
  purpose: SmsPurpose,
): Promise<SmsCodeRow | null> {
  const rows = await db
    .select()
    .from(wbSmsCodes)
    .where(and(eq(wbSmsCodes.phone, phone), eq(wbSmsCodes.purpose, purpose)))
    .orderBy(desc(wbSmsCodes.id))
    .limit(1);
  return rows[0] ?? null;
}

/** 行级校验（无码/超限/过期/错验计数——错验时 attempts 原子+1 达限作废）；返回收窄非空行（row! 断言面封死——门禁票） */
async function verifyRow(
  db: SmsTxDb,
  row: SmsCodeRow | null,
  code: string,
): Promise<SmsCodeRow> {
  if (!row) {
    throw new TRPCError({ code: "BAD_REQUEST", message: CODE_INVALID });
  }
  // 作废/已用行拦（门禁票：latestCodeRow 不限 consumedAt 后，已消费行会进来——绝不验已用码）
  if (row.consumedAt) {
    throw new TRPCError({ code: "BAD_REQUEST", message: CODE_INVALID });
  }
  if (row.attempts >= SMS_MAX_ATTEMPTS) {
    throw new TRPCError({ code: "BAD_REQUEST", message: CODE_VOID });
  }
  if (new Date(row.expiresAt).getTime() <= Date.now()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: CODE_INVALID });
  }
  const expected = Buffer.from(row.codeHash, "utf8");
  const actual = Buffer.from(sha256(code), "utf8");
  const match =
    expected.length === actual.length && timingSafeEqual(expected, actual);
  if (!match) {
    // 错验：attempts 原子 +1；达到上限同语句作废（consumedAt 置位，防继续爆破）
    // MySQL SET 从左到右求值：IF 里的 attempts 是更新后值——条件不再 +1（off-by-one 门禁票）
    await db.execute(
      sql`UPDATE wb_sms_codes SET attempts = attempts + 1, consumedAt = IF(attempts >= ${SMS_MAX_ATTEMPTS}, NOW(), consumedAt) WHERE id = ${row.id} AND consumedAt IS NULL`,
    );
    throw new TRPCError({ code: "BAD_REQUEST", message: CODE_INVALID });
  }
  return row;
}

/** 行级原子消费（consumedAt 置位；败方 affected=0 抛错——并发复用/重放封死） */
async function consumeRow(db: SmsTxDb, rowId: number): Promise<void> {
  const upd = await db.execute(
    sql`UPDATE wb_sms_codes SET consumedAt = NOW() WHERE id = ${rowId} AND consumedAt IS NULL`,
  );
  const affected = Number(
    (upd[0] as { affectedRows?: number | string } | undefined)?.affectedRows ??
      0,
  );
  if (affected !== 1) {
    throw new TRPCError({ code: "BAD_REQUEST", message: CODE_INVALID });
  }
}

/** 校验+错验计数（**事务外/独立句柄调**——计数直提交，外层回滚吞不掉）；返回 rowId 供事务内 consumeSmsCodeById */
export async function verifySmsCodeOnly(
  db: SmsTxDb,
  phone: string,
  purpose: SmsPurpose,
  code: string,
): Promise<{ rowId: number }> {
  // 一次查询取最新行（latestCodeRow 单源——作废行也取到供 CODE_VOID 判定）；
  // 同号同 purpose 行数有界（SMS_DAILY_LIMIT=10/天发送限流钉）——JS 侧排序量级安全（perf 票注释钉）
  const last = await latestCodeRow(db, phone, purpose);
  const live = last && !last.consumedAt ? last : null;
  if (!live) {
    // CODE_VOID 死支救活（门禁票）：最新一条「错验达限作废」→ 提示「重新获取」而非笼统「错误或过期」
    if (last && last.consumedAt && last.attempts >= SMS_MAX_ATTEMPTS) {
      throw new TRPCError({ code: "BAD_REQUEST", message: CODE_VOID });
    }
  }
  const row = await verifyRow(db, live, code);
  return { rowId: row.id };
}

/** 按行原子消费（**事务内调**——行 id 来自事务外 verifySmsCodeOnly） */
export async function consumeSmsCodeById(
  db: SmsTxDb,
  rowId: number,
): Promise<void> {
  await consumeRow(db, rowId);
}

/** 内测资格码验真+消费共享件（彭总 2026-10-02 令：注册资格闸——st_beta_invites 面，与 wb_invites 入企码分家；
 *  门禁票：sms.ts/agentic.ts 双处复刻漂移面封死）。两段式同口径：verify 事务外+consume 事务内。
 *  彭总链路钉（主线①搬链——门户仓同构）：kind 分流闸——个人码只许个人注册（registerByPhone/authRegisterPerson）、
 *  企业码只许企业开户（authRegisterEnterprise），串线封死；expectedKind 由调用方按端点身份传入
 *  （三调用面逐个核：sms.ts registerByPhone=inviteCode 判别条件面[注册+入企一步口——invite?enterprise:personal，
 *  与建档 kind 同锚] / agentic.ts authRegisterEnterprise=enterprise / agentic.ts authRegisterPerson=personal——
 *  契约定在全仓仅此三处）。 */
export async function verifyBetaCode(
  db: SmsTxDb,
  betaCode: string,
  phone: string,
  expectedKind: BetaKind,
): Promise<{ betaInvId: number }> {
  // 表自 ensure（门禁票：懒建靠不住——共享件自足，谁调都先有表）
  await ensureBetaInvites();
  // phone 归属核（门禁票：码绑手机号——防转借；签发时 phone 落表）
  const list = rawRows(
    await db.execute(
      sql`SELECT id, kind FROM st_beta_invites WHERE codeHash = ${sha256(betaCode)} AND phone = ${phone} AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > NOW() LIMIT 1`,
    ),
  ) as Array<{ id: number; kind: string | null }>; // rawRows 仓内惯例（[rows]/rows 两形态兼容——形态错配炸面封死）
  if (list.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "邀测码无效/已使用/与手机号不匹配——门户报名审核通过后短信发放",
    });
  }
  // kind 分流闸（彭总链路钉：串线封死——先取行再比 kind=错配能给明路指引）
  // 明路=有意权衡（持码人须已持绑定本手机号的活码[枚举面无放大]，给他通道明路是彭总链路设计意图；
  // 无效/过期/已烧/号不配仍统一中性文案——无码攻击面无新增信息）
  // 闸无条件严面（NumX 终判 2026-10-15：NULL「双通道通用+不可撤销」复合窗口封死——backfill 收口后
  // NULL 行不存在[ensure ALTER 同块 UPDATE 标 personal]；万一残留 NULL=按企业码面严拒[fail-closed——错拒优于错放]）
  if (list[0].kind !== expectedKind) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        list[0].kind === null
          ? "邀测码状态异常——请重新报名获取新码" // NULL 残留=异常面（backfill 收口后不该存在——无通道可归=中性文案不给错配明路，portal#56 复审票）
          : expectedKind === "personal"
            ? "该邀测码为企业报名通道发放——请用企业工作台注册开户"
            : "该邀测码为个人报名通道发放——请用个人工作台注册",
    });
  }
  return { betaInvId: list[0].id };
}

/** 资格码原子消费（事务内——一次性，败方影响行=0） */
export async function consumeBetaCode(
  db: SmsTxDb,
  betaInvId: number,
): Promise<void> {
  const upd = await db.execute(
    sql`UPDATE st_beta_invites SET consumed_at = NOW() WHERE id = ${betaInvId} AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()`,
  );
  const affected = Number(
    (upd[0] as { affectedRows?: number | string } | undefined)?.affectedRows ??
      0,
  );
  if (affected !== 1) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "邀测码无效或已使用——门户报名审核通过后短信发放",
    });
  }
}
