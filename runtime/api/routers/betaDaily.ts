/**
 * betaDaily —— 每日口令兑换专属邀测码（彭总 2026-10-23 令：阿里悟空口令造势面嫁接进邀测码闸——
 * 每天 N 家企业名额[默认 15，env BETA_DAILY_QUOTA 可调 10-20 区间]，门户公开挂「今日邀测口令」，
 * 口令+手机号+短信验证码 → 自动生成专属 iv_ 邀测码[enterprise 通道]）。
 *
 * 与报名审核链（betaApply 短信发码）并行不替——定向客户面不动，口令链=公开自助造势面。
 *
 * 闸面（纪律钉）：
 * - 口令当日有效（biz_date=CURDATE() 钉——次日换新口令新名额；惰性生成：首个 today/redeem 调用当日无口令则建，uk 撞容 1062=并发双生幂等）；
 * - 名额原子扣（事务内 FOR UPDATE 锁当日行→重评 used<quota→+1——并发不超发；抢完明拒「今日名额已抢完」）；
 * - 一 phone 当日限兑一码（st_beta_invites 当日 enterprise 码计数闸——与报名链日限同库同表不双轨）；
 * - 码=iv_ newCredential 单源生成+sha256 落库+phone 绑定+kind='enterprise'+72h 有效（BETA_DAILY_CODE_TTL_HOURS env 化）；
 * - 明文码仅此一次返回（库 sha256/日志不落——凭证纪律同 betaApply 三面守）；
 * - IP 限流（每 IP 日 5 兑——内存件单进程口径，betaGate rateOk 同族先例；防批量占名额）；
 * - OTP 验真复用 smsVerify 两件（verifySmsCodeOnly 事务外+consumeSmsCodeById 事务内——错验计数不被回滚吞，门禁钉）。
 * SQL 模板串内永不写行尾注释（纪律钉）。
 */
import { randomInt } from "node:crypto";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { rawRows, warnThrottled } from "../queries/rawRows"; // canonical 单源（十一轮票——不经 terminal 摆渡 shim）
import { newCredential, sha256 } from "./wbSession";
import { phoneSchema } from "./smsVerify"; // 单源同口径（smsVerify 出件——不拖 sms 大面依赖图）
import { verifySmsCodeOnly, consumeSmsCodeById } from "./smsVerify";
import { ensureBetaInvites, withBetaInvitePhoneLock } from "./betaInvites";
import { BETA_KINDS } from "@contracts/betaKinds";

/** 当日名额 env 化：彭总口径 10–20 家，默认 15；越界/非法配置回退 15，不静默扩闸或关闸。 */
export const BETA_DAILY_QUOTA_MIN = 10;
export const BETA_DAILY_QUOTA_MAX = 20;
export const BETA_DAILY_QUOTA = (() => {
  const configured = process.env.BETA_DAILY_QUOTA;
  if (configured === undefined) return 15;
  const raw = configured.trim();
  const n = Number(raw);
  if (raw && Number.isInteger(n) && n >= BETA_DAILY_QUOTA_MIN && n <= BETA_DAILY_QUOTA_MAX) return n;
  warnThrottled("betaDaily.quota.invalid", `BETA_DAILY_QUOTA=${raw || "<empty>"} 非法/越界（允许 10–20）——已回退 15，请修配置`);
  return 15;
})();
/** 专属码有效期 env 化默认 72h（兑换后三天内开户——口令造势面的新鲜度钉） */
export const BETA_DAILY_CODE_TTL_HOURS = (() => { const n = Number(process.env.BETA_DAILY_CODE_TTL_HOURS); return Number.isInteger(n) && n >= 1 && n <= 720 ? n : 72; })();
/** 每 IP 日兑上限（内存件单进程口径——防批量占名额；betaGate rateOk 同族先例面） */
export const BETA_DAILY_IP_LIMIT = 5;

/** 口令池（NumX Max 品牌面——彭总 2026-10-23 令：口令以 NumX Max 品牌制定；
 *  四字整句池[悟空「三打白骨精」同构面]：产品语汇[数字员工/组织智能/协同/复核/派活/舱位/工单/生态]+气势面[齐发/挂帅/上岗/就绪]，
 *  当日口令=池内随机取一整句（四字钉——测试面同锚）） */
const CODE_PHRASES = [
  "数字员工", "组织智能", "智能协同", "五舱齐发", "主管挂帅", "复核挂签",
  "派活开工", "员工上岗", "协同共生", "生态共赢", "舱位就绪", "工单直达",
  "组织律动", "智能上岗", "数字军团", "员工矩阵", "生态引擎", "组织引擎",
  "智能矩阵", "协同引擎", "数字生态", "员工生态", "组织共生", "智能共生",
] as const;
/** 品牌池钉面导出（测试钉成员资格用——业务面不消费） */
export const CODE_PHRASES_FOR_TEST: readonly string[] = CODE_PHRASES;

// ─── IP 限流件（内存面——单进程口径钉；重启清零可容[日闸主面在库]）───
const ipHits = new Map<string, string>(); // ip → biz_date:count 串（日界自带——跨日串不配=重置）
function ipRateOk(ip: string, day: string): boolean {
  const cur = ipHits.get(ip) ?? "";
  const n = cur.startsWith(day) ? Number(cur.split(":")[1]) || 0 : 0;
  if (n >= BETA_DAILY_IP_LIMIT) return false;
  ipHits.set(ip, `${day}:${n + 1}`);
  return true;
}

let ready: Promise<void> | null = null;
/** 幂等建表（模块级一次性——ensureBetaInvites 同律；热路径不重复 DDL） */
export function ensureBetaDailyCodes(): Promise<void> {
  if (!ready) {
    ready = getDb()
      .execute(sql`CREATE TABLE IF NOT EXISTS st_beta_daily_codes (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        biz_date DATE NOT NULL,
        code_text VARCHAR(64) NOT NULL,
        quota INT NOT NULL,
        used_count INT NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_biz_date (biz_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      .then(() => undefined)
      .catch((e) => { ready = null; throw e; });
  }
  return ready;
}

/** 当日口令行（无=惰性生成——uk 撞 1062 容=并发双生面，重取权威行）；日期标签与 SQL CURDATE 同库同历。 */
export async function todayRow(db: ReturnType<typeof getDb>): Promise<{ id: number; codeText: string; quota: number; usedCount: number; bizDate: string }> {
  await ensureBetaDailyCodes();
  const got = rawRows(await db.execute(sql`SELECT id, code_text, quota, used_count, DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS biz_date FROM st_beta_daily_codes WHERE biz_date = CURDATE() LIMIT 1`)) as Array<Record<string, unknown>>;
  if (got.length > 0) {
    return { id: Number(got[0].id), codeText: String(got[0].code_text), quota: Number(got[0].quota), usedCount: Number(got[0].used_count), bizDate: String(got[0].biz_date) };
  }
  const codeText = CODE_PHRASES[randomInt(CODE_PHRASES.length)]; // 品牌口令池整句取（四字钉）
  await db.execute(sql`INSERT INTO st_beta_daily_codes (biz_date, code_text, quota) VALUES (CURDATE(), ${codeText}, ${BETA_DAILY_QUOTA})`)
    .catch((e: unknown) => { if (Number((e as { errno?: number })?.errno) !== 1062) throw e; }); // 并发双生容——uk 撞=别人已建，重取即可
  const again = rawRows(await db.execute(sql`SELECT id, code_text, quota, used_count, DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS biz_date FROM st_beta_daily_codes WHERE biz_date = CURDATE() LIMIT 1`)) as Array<Record<string, unknown>>;
  if (again.length === 0) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "口令面暂不可用——稍后重试" }); // 建完读不到=库面事故，诚实面不装
  return { id: Number(again[0].id), codeText: String(again[0].code_text), quota: Number(again[0].quota), usedCount: Number(again[0].used_count), bizDate: String(again[0].biz_date) };
}

export const betaDailyRouter = createRouter({
  /** today（公开 query）：门户/注册屏挂口令卡数据源 → { date, codeText, quota, left }（只回口令+余量，别的面不回） */
  today: publicQuery.query(async () => {
    const db = getDb();
    const t = await todayRow(db);
    return { date: t.bizDate, codeText: t.codeText, quota: t.quota, left: Math.max(0, t.quota - t.usedCount) };
  }),

  /** redeem（公开 mutation）：{ codeText, phone, smsCode } → { ok, code }——口令换专属邀测码（明文仅此一次返回） */
  redeem: publicQuery
    .input(z.object({
      codeText: z.string().trim().min(2).max(64),
      phone: phoneSchema,
      smsCode: z.string().trim().regex(/^\d{6}$/, "验证码为 6 位数字"),
    }))
    .mutation(async ({ input, ctx }) => {
      const ip = ctx.clientIp ?? "";
      const db = getDb();
      const t = await todayRow(db);
      if (!ip) {
        warnThrottled("betaDaily.redeem.ip", "来源 IP 不可识别——兑换 fail-closed，请核代理/XFF 配置");
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "无法识别请求来源——请检查网络后重试；持续失败请联系运维" });
      }
      if (!ipRateOk(ip, t.bizDate)) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "操作太频繁——今日兑换次数已用完，明天再来" });
      }
      await ensureBetaInvites(); // 码表自足面（共享件同律——谁调都先有表）
      // OTP 验真事务外（错验计数直提交——外层回滚吞不掉，门禁钉；purpose=register 与开户链同池）
      const { rowId } = await verifySmsCodeOnly(db, input.phone, "register", input.smsCode);
      if (input.codeText !== t.codeText) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "口令不对——以门户「今日邀测口令」为准（每日 0 点换新）" });
      }
      const ivPlain = newCredential("iv_"); // 颁码明文（生成面单源——凭证纪律钉）
      await withBetaInvitePhoneLock(input.phone, async (tx) => {
        // 同一手机号锁内按当日全部签发记录查重+插码；名额行 FOR UPDATE 与 OTP 消费仍同事务，锁序不交叉。
        const dup = rawRows(await tx.execute(sql`SELECT id FROM st_beta_invites WHERE phone = ${input.phone} AND kind = ${BETA_KINDS[1]} AND created_at > CURDATE() LIMIT 1`));
        if (dup.length > 0) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "该手机号今日已兑过专属邀测码——一机一日一码" });
        const locked = rawRows(await tx.execute(sql`SELECT id, quota, used_count FROM st_beta_daily_codes WHERE id = ${t.id} FOR UPDATE`)) as Array<Record<string, unknown>>;
        if (locked.length === 0) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "口令面暂不可用——稍后重试" });
        if (Number(locked[0].used_count) >= Number(locked[0].quota)) {
          throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "今日名额已抢完——明天 0 点新口令新名额" });
        }
        await tx.execute(sql`UPDATE st_beta_daily_codes SET used_count = used_count + 1 WHERE id = ${t.id} AND used_count < quota`);
        await tx.execute(sql`INSERT INTO st_beta_invites (phone, codeHash, expires_at, kind) VALUES (${input.phone}, ${sha256(ivPlain)}, DATE_ADD(NOW(), INTERVAL ${BETA_DAILY_CODE_TTL_HOURS} HOUR), ${BETA_KINDS[1]})`);
        await consumeSmsCodeById(tx, rowId); // OTP 原子消费殿后（锁序：daily 行→码行→OTP——固定序不成交叉环）
      });
      return { ok: true as const, code: ivPlain }; // 明文仅此一次（库 sha256/日志不落——凭证纪律钉）
    }),
});
