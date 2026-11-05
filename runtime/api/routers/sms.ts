/**
 * sms —— M25 阿里云短信验证码通道（彭总指令「手机短信注册通道」）。
 *
 * 契约（前后端以任务文档为准，严格一致）：
 * - sms.sendCode（public mutation）入 {phone, purpose:'register'|'login'}
 *   出 {ok:true, ttlSeconds:300}——统一回 ok（号码已注册/未注册等真实原因绝不外泄）；
 *   dev 模式（NODE_ENV!=='production' 且无阿里云 key）出 {ok:true, ttlSeconds:300, devCode:'123456'}
 *   （仅开发环境回显，生产绝不回显）。
 * - sms.registerByPhone（public mutation）入 {phone, code, password(min8), realName?, inviteCode?}
 *   出 SessionInfo 同构（复用 agentic.authRegisterPerson 的 sessionInfoEx 形状 + token nt_）。
 * - sms.loginByPhone（public mutation）入 {phone, code} 出 SessionInfo 同构
 *   （已有账号→登录签发 nt_；无账号→BAD_REQUEST「该手机号尚未注册」不泄露其他）。
 * - 现有 authRegisterPerson/authLogin 不受影响（密码通道并存）。
 *
 * 纪律：
 * - 验证码 6 位数字（crypto randomInt），sha256 落库（wb_sms_codes.codeHash）；
 *   明文仅经短信通道发出，绝不回显、绝不打日志（Dev 通道除外且仅限开发环境）。
 * - AccessKey 只走 .env 环境变量（SMS_ALIYUN_AK_ID/SMS_ALIYUN_AK_SECRET/SMS_SIGN_NAME/
 *   SMS_TEMPLATE_CODE），绝不落代码/日志。
 * - 发送限频：同号 60s≤1、同号同 purpose 当日≤10（DB 计数，重启不丢）；超限 TOO_MANY_REQUESTS。
 * - 校验：未消费+未过期（5min）+attempts<5（每次错验 attempts+1，≥5 作废）；
 *   消费=原子 UPDATE consumedAt（防重放）。
 * - 短信通道注册免身份证（idCardHash 留 NULL，实名核验后补——M14 idCard 通道并存；
 *   M21 数字职业档案不受影响：带 inviteCode 注册即入企时照常写 join 履历）。
 */
import { createHmac, randomInt, randomUUID } from "node:crypto";
import { authTokenHash } from "../auth/revocation"; // portal#86 必修：指纹写单点同引
import { emitReport } from "./reportBus";
import { voicePersonaFor, ttsForReply } from "./voiceMedia";
import { z } from "zod";
import { and, eq, gt, gte, or, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import {
  wbSmsCodes,
  wbUsers,
  wbInvites,
  wbFactories,
  wbDeptHeads,
  type WbInvite,
} from "@db/schema";
import { hashPassword, newCredential, sha256 } from "./wbSession";
import { sessionInfoEx } from "./agentic";
import { recordCareerEvent } from "./wbCareer";
import { recordSmsOutbox, yxtSign, yxtTaskId } from "./smsYxt";
// 验码共享件直引（循环断链：smsVerify 不回引 sms/agentic；消费方全直引 smsVerify——re-export 中转面无人用已摘）
import {
  consumeSmsCodeById,
  phoneSchema,
  SMS_CODE_RE,
  verifySmsCodeOnly,
  verifyBetaCode,
  consumeBetaCode,
  BETA_CODE_RE,
  BETA_CODE_MSG,
} from "./smsVerify";
import { isDupEntry, hasCauseChainMatch } from "../lib/dupEntry"; // 1062 撞键+1213/1205 死锁判别同件（dupEntry 单点——双引合引=一处语义一套实现，portal#56 复审钉）
import { rawRows, logQueryError } from "./terminalShared"; // 行提取+脱敏留痕（门户仓惯例面——terminalShared 同件）
import { ensureBetaInvites, withBetaInvitePhoneLock } from "./betaInvites"; // 资格码表 ensure+手机号锁单源
import { BETA_KINDS, type BetaKind } from "@contracts/betaKinds"; // 分流身份枚举跨栈单源直引
import { BETA_DL_BASE, BETA_DL_PERSONAL_PATH, BETA_DL_ENTERPRISE_PATH } from "./betaDlConfig"; // 下载链配置单源件

// ─── 常量与文案（统一口径，绝不泄露真实原因）─────────────────────────────────
export const SMS_CODE_TTL_SECONDS = 300; // 验证码 5 分钟有效
export const SMS_RESEND_INTERVAL_MS = 60_000; // 同号 60s≤1
export const SMS_DAILY_LIMIT = 10; // 同号同 purpose 当日≤10

const RATE_RESEND = "发送太频繁，请稍后再试";
const RATE_DAILY = "今日验证码发送次数已达上限，请明日再试";
const PHONE_DUP = "该手机号已注册，请直接登录";
const PHONE_NOT_REGISTERED = "该手机号尚未注册";
const INVITE_INVALID = "邀请链接无效或已使用";
const SEND_FAILED = "短信发送失败，请稍后再试";

// ─── 内测报名颁码链常量区（主线①搬链——门户仓同构 wb#77 磨好面）────────────────
export const BETA_INVITE_TTL_DAYS = (() => { const n = Number(process.env.BETA_INVITE_TTL_DAYS); return Number.isInteger(n) && n > 0 && n <= 365 ? n : 30; })(); // 邀测码有效期 env 化默认 30 天
export const BETA_APPLY_DAILY_LIMIT = (() => { const n = Number(process.env.BETA_APPLY_DAILY_LIMIT); return Number.isInteger(n) && n > 0 && n <= 100 ? n : 5; })(); // 同号日颁上限 env 化默认 5（防刷颁——邀测码是注册资格物不是 OTP）
const BETA_APPLY_RESEND_MSG = `邀测码已下发，请查收短信（${SMS_RESEND_INTERVAL_MS / 1000} 秒后可重试）`; // 窗挡文案单源
const BETA_APPLY_DAILY_MSG = "今日报名次数已达上限，请明天再来"; // 日限文案单源
const BETA_APPLY_CONCURRENCY_MSG = "操作过于频繁，请稍后再试"; // 并发/死锁重试文案单源
const BETA_APPLY_SEND_FAIL_MSG = "邀测码短信下发失败——请稍后重新获取验证码后重试（原邀测码不受影响）"; // 下发失败文案单源
const BETA_APPLY_FAIL_MSG = "报名失败，请稍后重试"; // 闸查询/事务失败中性文案单源

/** kind→安装包描述查表单源（Record 穷举=编译器盯新增 kind；
 *  personal.label 空串=有意自然文案[个人面无前缀「您的内测邀测码」——明态]） */
const DL_BY_KIND: Record<BetaKind, { path: string; name: string; label: string }> = {
  personal: { path: BETA_DL_PERSONAL_PATH, name: "个人工作台", label: "" },
  enterprise: { path: BETA_DL_ENTERPRISE_PATH, name: "企业工作台", label: "企业" },
};
/** kind 谓词单源（窗/作废两闸同引——日限有意全局不带 kind[防刷闸不因双身份翻倍]） */
const kindCond = (kind: BetaKind) => sql`kind = ${kind}`;
/** 窗谓词含前史码同占（NULL 前史码占窗占日限[防刷面]但不入作废[保语义面——串户陷阱不 reopened]） */
const kindOrLegacyCond = (kind: BetaKind) => sql`(${kindCond(kind)} OR kind IS NULL)`;

/** 活码窗谓词单源（闸前预检/锁内重评同引——谓词漂移=两闸定义不一致面封死）；
 *  按 kind 收窄+前史码同占窗（一 phone 一身份一活码——个人/企业双链互不误杀） */
const betaLiveWindowCond = (phone: string, kind: BetaKind) => sql`phone = ${phone} AND ${kindOrLegacyCond(kind)} AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > NOW() AND created_at > DATE_SUB(NOW(), INTERVAL ${SMS_RESEND_INTERVAL_MS / 1000} SECOND)`;
/** 日限含 revoked/consumed：闸前预检与锁内重评同引，换码循环不得烧共享名额。 */
const betaDailyCond = (phone: string) => sql`phone = ${phone} AND created_at > CURDATE()`;

// ─── SmsProvider 接口与实现 ─────────────────────────────────────────────────
export interface SmsProvider {
  /**
   * 发送验证码明文（仅此一处接触明文；实现方绝不可落库/打日志——
   * DevSmsProvider 除外，且其仅可在开发环境被选中）。
   */
  send(phone: string, code: string): Promise<void>;
  /** 开发固定码：非空=开发通道（响应回显 devCode，仅开发；生产绝不回显） */
  readonly devFixedCode?: string;
  /** 自由文本下发（邀测码等非 OTP 场景——翼讯通/开发通道实现；阿里云模板通道无自由文本面=缺席，betaApply 判缺席报通道不支持） */
  sendText?(phone: string, text: string): Promise<void>;
  /** 通知短信（自定义内容）——仅奕信通支持（msg 自定义文本）；其它通道缺省不发 */
  sendNotice?(phone: string, content: string): Promise<void>;
}

// ─── 阿里云 POP RPC 签名 V1（dysmsapi 2017-05-25 SendSms，零依赖手写）────────
// 算法为公开标准：HMAC-SHA1 + 特殊 URL 编码规则（与官方 aliyun-openapi-nodejs-sdk 一致）：
// 1) percentEncode = encodeURIComponent 后再 replace('+'→'%20','*'→'%2A','%7E'→'~')；
// 2) 参数按 key 字典序排序，拼接为 canonicalizedQueryString（k/v 各自 percentEncode）；
// 3) StringToSign = HTTPMethod + '&' + percentEncode('/') + '&' + percentEncode(query)；
// 4) Signature = Base64(HMAC-SHA1(StringToSign, AccessKeySecret + '&'))。
/** POP 特殊 URL 编码（在 RFC3986 基础上按阿里云规则替换 +、*、~） */
export function percentEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/\+/g, "%20")
    .replace(/\*/g, "%2A")
    .replace(/%7E/g, "~");
}

/** 参数按 key 字典序排序并编码拼接（POP RPC V1 规范） */
export function canonicalQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join("&");
}

/** 计算 Signature（Base64(HMAC-SHA1)；key=AccessKeySecret+'&'） */
export function signAliyunPop(
  params: Record<string, string>,
  accessKeySecret: string,
  httpMethod = "GET",
): string {
  const stringToSign = `${httpMethod}&${percentEncode("/")}&${percentEncode(canonicalQuery(params))}`;
  return createHmac("sha1", `${accessKeySecret}&`)
    .update(stringToSign, "utf8")
    .digest("base64");
}

/** 阿里云短信通道（零依赖：node crypto 签名 + 全局 fetch 发送） */
export class AliyunSmsProvider implements SmsProvider {
  private readonly cfg: {
    accessKeyId: string;
    accessKeySecret: string;
    signName: string;
    templateCode: string;
  };
  constructor(cfg: {
    accessKeyId: string;
    accessKeySecret: string;
    signName: string;
    templateCode: string;
  }) {
    this.cfg = cfg;
  }

  async send(phone: string, code: string): Promise<void> {
    const params: Record<string, string> = {
      AccessKeyId: this.cfg.accessKeyId,
      Action: "SendSms",
      Format: "JSON",
      PhoneNumbers: phone,
      RegionId: "cn-hangzhou",
      SignName: this.cfg.signName,
      SignatureMethod: "HMAC-SHA1",
      SignatureNonce: randomUUID(),
      SignatureVersion: "1.0",
      TemplateCode: this.cfg.templateCode,
      TemplateParam: JSON.stringify({ code }),
      // ISO8601 UTC 秒级（yyyy-MM-ddTHH:mm:ssZ）
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      Version: "2017-05-25",
    };
    const signature = signAliyunPop(params, this.cfg.accessKeySecret);
    const url = `https://dysmsapi.aliyuncs.com/?Signature=${percentEncode(signature)}&${canonicalQuery(params)}`;
    let body: { Code?: string } | null = null;
    try {
      const res = await fetch(url);
      body = (await res.json().catch(() => null)) as { Code?: string } | null;
    } catch {
      body = null;
    }
    if (body?.Code !== "OK") {
      // 仅记录阿里云错误码用于排障；AccessKey/签名/明文验证码绝不入日志
      console.warn(`[sms] aliyun SendSms failed: ${body?.Code ?? "network"}`);
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: SEND_FAILED,
      });
    }
  }
}

// ─── 翼讯通通道（彭总 2026-08-24 供《翼讯通接口文档 V1.6.7.2》）────────────────
/**
 * 翼讯通短信平台（sms.189ek.com，JSON 发送口 /http/send）：
 * - sign = md5(appid + mobile + msg原文 + appkey)（32 位小写；msg 原文参与、不编码）；
 * - 发送体 msg 经 URLSearchParams 自动 urlencode（文档要求 utf-8 + urlencode）；
 * - 短信签名前缀【签名】由短信内容自带（运营商硬规）；
 * - resultCode 0=提交成功，非 0 失败（-3=来源 IP 未绑 → 提醒运维去翼讯通后台绑 IP）；
 * - 凭证只走 env（SMS_YXT_APPID/APPKEY/SIGN_NAME），绝不落代码/日志。
 */
export class YixuntongSmsProvider implements SmsProvider {
  // P1-3 门禁：erasableSyntaxOnly 下禁用构造器参数属性，改为显式字段 + 赋值（行为零变化）
  // readonly 与同侪 AliyunSmsProvider 的 `private readonly cfg` 对齐（门禁 portal#31 轮1 票①）
  private readonly cfg: { appid: string; appkey: string; signName: string };
  constructor(cfg: { appid: string; appkey: string; signName: string }) {
    this.cfg = cfg;
  }
  async send(phone: string, code: string): Promise<void> {
    const msg = `【${this.cfg.signName}】您的验证码是${code}，5 分钟内有效。`;
    const sign = yxtSign([this.cfg.appid, phone, msg], this.cfg.appkey); // 签名装配单源（smsYxt.yxtSign）
    const body = new URLSearchParams({
      appid: this.cfg.appid,
      mobile: phone,
      msg,
      sign,
    });
    const res = await fetch("https://sms.189ek.com/http/send", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await res.json().catch(() => null)) as {
      resultCode?: number;
      resultMsg?: string;
      taskid?: string | number;
    } | null;
    if (!res.ok || !j || Number(j.resultCode) !== 0) {
      // -3 来源 IP 限制单独可辨（运维动作：翼讯通后台绑来源 IP）
      const ipBind = j && Number(j.resultCode) === -3;
      throw new Error(
        ipBind ? "yixuntong_ip_unbound" : "yixuntong_send_failed",
      );
    }
    // 发送台账（OTP 显式传码掩码——明文不落库；内部 catch-all 不阻断发送链路）
    // taskid 取值单源 yxtTaskId（文档 §7.3 taskid / §8.3 taskId 写法并存兼容）
    await recordSmsOutbox(
      phone,
      msg,
      yxtTaskId(j as Record<string, unknown>),
      "code",
      code,
    );
  }
  /** 自由文本下发（邀测码下发——iv_ 明文只走短信通道不落日志[台账面 maskOutboxMsg notice 面已掩 iv_ 明文]，
   *  凭证纪律同 send；复用 sendNotice 同签名机制——不双写协议面，主线①搬链门户仓适配钉） */
  async sendText(phone: string, text: string): Promise<void> {
    await this.sendNotice(phone, text);
  }
  /** 通知短信（自定义内容）——奕信通 msg 自由文本（签名+内容），与验证码同签名机制 */
  async sendNotice(phone: string, content: string): Promise<void> {
    const msg = `【${this.cfg.signName}】${content}`;
    const sign = yxtSign([this.cfg.appid, phone, msg], this.cfg.appkey);
    const body = new URLSearchParams({
      appid: this.cfg.appid,
      mobile: phone,
      msg,
      sign,
    });
    const res = await fetch("https://sms.189ek.com/http/send", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await res.json().catch(() => null)) as {
      resultCode?: number;
      taskid?: string | number;
    } | null;
    if (!res.ok || !j || Number(j.resultCode) !== 0) {
      throw new Error("yixuntong_notice_failed");
    }
    await recordSmsOutbox(
      phone,
      msg,
      yxtTaskId(j as Record<string, unknown>),
      "notice",
    );
  }
}

/** 开发通道（仅开发：固定码 123456，打印日志便于联调；生产绝不使用——resolveProvider 守卫） */
export class DevSmsProvider implements SmsProvider {
  readonly devFixedCode = "123456";
  async send(phone: string, code: string): Promise<void> {
    // 仅开发环境回显/打印，生产环境绝不经过本 Provider
    console.log(`[sms:dev] 仅开发环境验证码 phone=${phone} code=${code}`);
  }
  async sendText(phone: string, text: string): Promise<void> {
    // 仅开发环境打印（resolveProvider 守卫=生产不可达同律）——邀测码明文只在开发通道日志面
    console.log(`[sms:dev] 邀测码下发 phone=${phone} text=${text.slice(0, 80)}…`);
  }
}

// ─── Provider 选择（AccessKey 只走 .env 环境变量，绝不落代码/日志）────────────
let providerOverride: SmsProvider | null = null;

/** 测试注入 mock Provider（生产代码不调用） */
export function setSmsProviderForTest(p: SmsProvider | null): void {
  providerOverride = p;
}

/** 发通知短信（自定义内容）——仅奕信通通道支持（sendNotice 可选方法）；
 *  其它通道/失败一律静默 false（调用方不阻断主链——审批照过，短信是增强面） */
export async function sendSmsNotice(
  phone: string,
  content: string,
): Promise<boolean> {
  try {
    const p = resolveProvider();
    if (typeof p.sendNotice !== "function") return false;
    await p.sendNotice(phone, content);
    return true;
  } catch {
    return false;
  }
}

function resolveProvider(): SmsProvider {
  if (providerOverride) return providerOverride;
  // 翼讯通优先（彭总 2026-08-24 选型）
  const yxtAppid = process.env.SMS_YXT_APPID;
  const yxtAppkey = process.env.SMS_YXT_APPKEY;
  const yxtSignName = process.env.SMS_YXT_SIGN_NAME; // 不与 smsYxt.yxtSign 签名装配助手撞名（no-shadow 钉）
  if (yxtAppid && yxtAppkey && yxtSignName) {
    return new YixuntongSmsProvider({
      appid: yxtAppid,
      appkey: yxtAppkey,
      signName: yxtSignName,
    });
  }
  const accessKeyId = process.env.SMS_ALIYUN_AK_ID;
  const accessKeySecret = process.env.SMS_ALIYUN_AK_SECRET;
  const signName = process.env.SMS_SIGN_NAME;
  const templateCode = process.env.SMS_TEMPLATE_CODE;
  if (accessKeyId && accessKeySecret && signName && templateCode) {
    return new AliyunSmsProvider({
      accessKeyId,
      accessKeySecret,
      signName,
      templateCode,
    });
  }
  // 无阿里云 key：仅开发环境回退 Dev 通道（固定码 123456），生产拒绝服务
  if (process.env.NODE_ENV !== "production") return new DevSmsProvider();
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "短信服务未配置",
  });
}

/** 邀请码待使用判定（与 wbInvites.inviteStatus 同口径：consumed>revoked>expired>pending） */
function invitePending(inv: WbInvite, now: Date): boolean {
  return (
    !inv.consumedAt &&
    !inv.revokedAt &&
    new Date(inv.expiresAt).getTime() > now.getTime()
  );
}

export const smsRouter = createRouter({
  /**
   * sendCode（public mutation）：{phone, purpose} → {ok:true, ttlSeconds:300}。
   * 统一回 ok——不查 wb_users，号码已注册/未注册等真实原因绝不外泄；
   * dev 模式（无阿里云 key 且 NODE_ENV!=='production'）附带 devCode:'123456'（仅开发回显）。
   */
  sendCode: publicQuery
    .input(
      z.object({
        phone: phoneSchema,
        purpose: z.enum(["register", "login", "beta_apply"]),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const now = Date.now();
      // 限频一：同号 60s≤1（任意 purpose；DB 计数，重启不丢）
      const recent = await db
        .select({ id: wbSmsCodes.id })
        .from(wbSmsCodes)
        .where(
          and(
            eq(wbSmsCodes.phone, input.phone),
            gt(wbSmsCodes.createdAt, new Date(now - SMS_RESEND_INTERVAL_MS)),
          ),
        );
      if (recent.length > 0) {
        // v182 幂等重发（彭总实锤：客户端超时重试撞 60s 窗 → 用户见「频繁操作」但首码其实已发）
        // 窗口内已有未消费有效码 → 直接复用回 ok（同一枚码），不再发新的、绝不报错
        const live = await db
          .select({ id: wbSmsCodes.id, consumedAt: wbSmsCodes.consumedAt })
          .from(wbSmsCodes)
          .where(
            and(
              eq(wbSmsCodes.phone, input.phone),
              gte(wbSmsCodes.createdAt, new Date(now - 5 * 60_000)),
            ),
          );
        const hasLive = live.some((c) => c.consumedAt == null);
        if (hasLive)
          return { ok: true as const, ttlSeconds: 300, reused: true as const };
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: RATE_RESEND,
        });
      }
      // 限频二：同号同 purpose 当日≤10
      const dayStart = new Date(now);
      dayStart.setHours(0, 0, 0, 0);
      const today = await db
        .select({ id: wbSmsCodes.id })
        .from(wbSmsCodes)
        .where(
          and(
            eq(wbSmsCodes.phone, input.phone),
            eq(wbSmsCodes.purpose, input.purpose),
            gte(wbSmsCodes.createdAt, dayStart),
          ),
        );
      if (today.length >= SMS_DAILY_LIMIT) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: RATE_DAILY });
      }
      const provider = resolveProvider();
      // 6 位数字码（crypto randomInt）；Dev 通道固定 123456（仅开发）
      const code =
        provider.devFixedCode ??
        String(randomInt(0, 1_000_000)).padStart(6, "0");
      await provider.send(input.phone, code); // 明文仅此经短信通道发出，绝不回显/打日志
      // sha256 落库（发送成功才落，失败不留占频行）
      await db.insert(wbSmsCodes).values({
        phone: input.phone,
        codeHash: sha256(code),
        purpose: input.purpose,
        expiresAt: new Date(now + SMS_CODE_TTL_SECONDS * 1000),
      });
      return {
        ok: true as const,
        ttlSeconds: SMS_CODE_TTL_SECONDS,
        // devCode 仅开发通道回显（生产 provider.devFixedCode 恒为空，绝不回显）
        ...(provider.devFixedCode ? { devCode: provider.devFixedCode } : {}),
      };
    }),

  /** betaApply（public mutation）：{phone, code, kind} → {ok:true}——门户报名：手机号+短信验证码验真+报名身份必填（个人/企业） → 自动颁 iv_ 邀测码 → 翼讯通短信按身份分流下发（彭总 2026-10-11 令：报名成功自动发码链彻底打通；彭总链路钉：kind 分流）。
   * 凭证纪律三面守：iv_ 明文只活在本函数内存+短信通道——库 sha256(codeHash)/响应/日志三不落（verifyBetaCode 验真同 sha256 单源同源）；
   * 一 phone 一身份一活码（按 kind 收窄——重颁作废旧同身份码，跨身份不误杀[二十二轮票]；consumed_at=注册消费，revoked_at=换码/管理吊销）；60s 窗按 kind 收窄+前史码同占窗（同号同身份 60s≤1），日限保持全局（同号当日≤BETA_APPLY_DAILY_LIMIT——防刷颁不因双身份翻倍[二十八轮 security 票]）；NULL 前史码占窗不入作废=TTL 自然日落）。
   */
  betaApply: publicQuery
    .input(z.object({
      phone: phoneSchema,
      code: z.string().trim().regex(SMS_CODE_RE, "验证码格式不正确"),
      kind: z.enum(BETA_KINDS), // 报名身份必填（OCR wb#77 二十轮票：缺省 personal=旧缓存 bundle 静默错发个人码面——必填拒出声可刷新恢复；枚举引 BETA_KINDS 单源）
    }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await ensureBetaInvites(); // 表自足（共享件同律——谁调都先有表）
      // 验真最先行（公开端点防 phone-state oracle：闸在验码前=未认证探任意 phone 三态（60s 内有码/日限尽/码无效）面封死，门禁 security 钉；
      //  verifySmsCodeOnly 不消费行=被闸挡不烧 consume——attempts 暴力闸内化；60s 窗挡 attempts+1 可接受写明）
      const { rowId } = await verifySmsCodeOnly(db, input.phone, "register", input.code); // 短信验证码验真（SMS_MAX_ATTEMPTS=5 闸内化——registerByPhone 同形：verify 事务外）
      const ivPlain = newCredential("iv_"); // 颁码明文（iv_=48hex 生成面单源 newCredential——wbInvites 先例；BETA_CODE_RE 同构不漂移，门禁钉）
      // 能力闸（通道无 sendText=不烧 OTP、不落未送达行、不占日限槽——后置=破坏性不可逆面封死，门禁 high 钉；验码后判=通道配置态不额外泄）
      const provider = resolveProvider();
      if (!provider.sendText) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "当前短信通道不支持邀测码下发，请联系运维" });
      }
      // 限频双闸（闸查询 try/catch 中性化——驱动/连接错裸透=SQL+绑定 phone 回客户端泄漏面封死，门禁 security 钉；窗走常量单源谓词）
      let recent: Array<Record<string, unknown>>;
      try {
        recent = rawRows(await db.execute(sql`SELECT id FROM st_beta_invites WHERE ${betaLiveWindowCond(input.phone, input.kind)} LIMIT 1`)); // 活码窗谓词走单源（门禁钉；窗走常量+按 kind 收窄[二十二轮票]）
      } catch (e) {
        logQueryError("[sms] betaApply 60s 窗闸查询失败（脱敏留痕——SQL+phone 不透客户端）", e);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: BETA_APPLY_FAIL_MSG });
      }
      if (recent.length > 0) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: BETA_APPLY_RESEND_MSG });
      }
      let todayRows: Array<Record<string, unknown>>;
      try {
        todayRows = rawRows(await db.execute(sql`SELECT COUNT(*) AS n FROM st_beta_invites WHERE ${betaDailyCond(input.phone)}`)); // 日限全局（OCR wb#77 二十八轮 security·med 票：per-kind 翻倍=防刷闸中立化[5+5/日]——一 phone 全局≤BETA_APPLY_DAILY_LIMIT；双身份正常用=各占槽不互挤误杀）
      } catch (e) {
        logQueryError("[sms] betaApply 日限闸查询失败（脱敏留痕——SQL+phone 不透客户端）", e);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: BETA_APPLY_FAIL_MSG });
      }
      if (Number((todayRows[0] as { n?: unknown } | undefined)?.n ?? 0) >= BETA_APPLY_DAILY_LIMIT) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: BETA_APPLY_DAILY_MSG }); // 文案走单源常量（RATE_DAILY 同律，门禁钉）
      }
      let newInviteId: number | null = null; // ack 缺 insertId=null 形（不伪造 0——门禁 med 钉）
      try {
        await withBetaInvitePhoneLock(input.phone, async (tx) => {
        // 一活码串行化+换码通道保留（④⑤联解）+锁序对齐兄弟注册流（registerByPhone/authRegisterPerson 皆先 st_beta_invites 后 OTP——先 OTP 后 beta 窗=跨流 2 表死锁环面封死，门禁 med 钉）：
        //  FOR UPDATE 锁本 phone 全部未消费行（idx_phone next-key lock 挡并发插）——锁内重评 60s 窗：
        //  窗内有未过期活码=并发败方（前者已颁新码在窗内=挡）；窗后/过期=放行换码（作废旧插新——「已下发未用码 30 天后永锁换码面」与「作废旧 UPDATE 恒空死码面」双封死，门禁 high/low 钉）
        const todayLocked = rawRows(await tx.execute(sql`SELECT COUNT(*) AS n FROM st_beta_invites WHERE ${betaDailyCond(input.phone)} FOR UPDATE`));
        if (Number((todayLocked[0] as { n?: unknown } | undefined)?.n ?? 0) >= BETA_APPLY_DAILY_LIMIT) {
          throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: BETA_APPLY_DAILY_MSG });
        }
        const recentLocked = rawRows(await tx.execute(sql`SELECT id FROM st_beta_invites WHERE ${betaLiveWindowCond(input.phone, input.kind)} FOR UPDATE`)); // 谓词走单源（与闸前对齐名实一致，门禁钉）
        if (recentLocked.length > 0) {
          throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: BETA_APPLY_RESEND_MSG });
        }
        await consumeSmsCodeById(tx, rowId); // OTP 原子消费在 beta 窗锁后（锁序兄弟同构=跨流死锁环面封死；一次性——并发抢验败方影响行=0）
        // 作废旧码挪下发成功后（旧码活到新码送达=sendText 失败用户不失旧码——先落账后下发的「OTP 已烧+旧码已终+用户两头空」面封死，门禁 med 钉；锁内重评已挡并发败方）
        const insRes = await tx.execute(sql`INSERT INTO st_beta_invites (phone, codeHash, expires_at, kind) VALUES (${input.phone}, ${sha256(ivPlain)}, DATE_ADD(NOW(), INTERVAL ${BETA_INVITE_TTL_DAYS} DAY), ${input.kind})`); // sha256 落库+kind 落（码带身份——彭总链路钉；created_at 走列默认）
        const insId = ((Array.isArray(insRes) ? insRes[0] : {}) as { insertId?: unknown })?.insertId;
        const insIdNum = Number(insId); newInviteId = Number.isInteger(insIdNum) && insIdNum > 0 ? insIdNum : null; // 缺/0/NaN 同归 null（正整数守卫——假 0 使未送达删除变 no-op 且跳 ack 留痕=占槽面静默复活面封死，门禁钉；scalarOfRows positive 仓约同律）
        if (newInviteId === null) logQueryError("[sms] 邀测码写 ack 缺 insertId（未送达删除面失行 id——ack 形变基建事故留痕不静默）", new Error("ack_no_insert_id"));
        });
      } catch (e) {
        if (e instanceof TRPCError) throw e; // 业务错直透（锁内重评/consume 面文案——不裹中性）
        if (hasCauseChainMatch(e, { errno: 1213 }) || hasCauseChainMatch(e, { errno: 1205 })) { // 间隙锁死锁/锁超时=并发败方面——映射窗挡文案（驱动错透 500=无意义报错面封死，门禁 med 钉）
          throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: BETA_APPLY_CONCURRENCY_MSG }); // 死锁分支中性重试文案走单源（1213/1205 回滚=本请求未下发——复用「已下发」文案=用户空等短信面封死，门禁钉）
        }
        logQueryError("[sms] betaApply 事务失败（明细服务端留痕——DrizzleQueryError 含 SQL+绑定参数（phone/codeHash）不透客户端，门禁 security 钉）", e);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: BETA_APPLY_FAIL_MSG }); // 中性文案走单源（裸驱动错透=SQL+params 回客户端=phone+codeHash 泄漏面封死，门禁 security 钉）
      }
      // 事务外下发（明文出域点=短信通道单面）：iv_ 明文只走短信通道（不落日志——sendText 实现纪律同 send）
      try {
        // 短信文案按 kind 分流（彭总链路钉：码+对应工作台桌面端安装包链接——个人码→personal.exe/企业码→enterprise.exe）
        // 直链 exe 不带 ?code=（OCR wb#77 复审 security 票：惰性参数零功能+iv_ 明文落 nginx access log/浏览器历史=
        // 凭证三不落纪律违；码在短信上文照输——/dl 包装页落地后恢复带码[P-DL-WRAPPER 挂账在案]）
        const dl = DL_BY_KIND[input.kind]; // 查表单源（二十轮票——Record 穷举取代三分枝）
        const dlUrl = `${BETA_DL_BASE}${dl.path}`;
        await provider.sendText(input.phone,
          // 文案诚实面（宣称≠实现纪律钉：直链 exe 收不到 ?code=——「码已带」是假话；码在短信上文=用户注册时照输，/dl 包装页落地后再改回带码口径）
          `您的${dl.label}内测邀测码是 ${ivPlain}，${BETA_INVITE_TTL_DAYS} 天内有效。下载${dl.name}：${dlUrl}。注册时输入上方邀测码+本手机号，请勿泄露。`);
      } catch (e) {
        logQueryError("[sms] 邀测码下发失败（脱敏留痕——通道/传输形态不透客户端；原 e 未用零诊断迹面封死，门禁钉）", e);
        // 下发失败=hard-delete 未送达行（行消失=60s 窗/日限两闸自然不占槽=用户可立即重试——sendCode「发送成功才落库」同精神；consumed_at 作废形=闸查询不滤 consumed 时仍占槽=「5 次失败锁当日+误导已下发」面封死，门禁 high 钉；未送达行 sha256 不可读+从未到达用户=删除无痕正确）
        // 未送达行按 codeHash 精确删（uk_codehash 唯一=只中本次插入行——ack id 正/缺两形同轨；旧码此刻未作废（挪下发成功后）=按 phone 全删未消费行=误伤仍有效旧码+与「原邀测码不受影响」矛盾面封死，门禁 med 钉）
        await db.execute(sql`DELETE FROM st_beta_invites WHERE codeHash = ${sha256(ivPlain)} AND consumed_at IS NULL`).catch((e2) => logQueryError("[sms] 邀测码未送达删除失败（下轮重发作废面同兜底）", e2));
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: BETA_APPLY_SEND_FAIL_MSG }); // 中性文案走单源（yixuntong_send_failed 内部词不透+OTP 已烧需新码写明；旧码未动=用户不失旧码，门禁 med/security 双钉）
      }
      // 下发成功才作废旧码（旧码活到新码送达——新码 id 除外；id 缺失跳过=两活码并存温和面=consumeBetaCode 一次性先用先赢+留痕，门禁 med 钉）
      if (newInviteId !== null) {
        await db.execute(sql`UPDATE st_beta_invites SET revoked_at = NOW() WHERE phone = ${input.phone} AND ${kindCond(input.kind)} AND consumed_at IS NULL AND revoked_at IS NULL AND id <> ${newInviteId}`).catch((e2) => logQueryError("[sms] 作废旧邀测码失败（两活码并存温和面——先用先赢，下轮换码同兜底）", e2)); // 作废按 kind 收窄（二十二轮 bug·med 票：跨身份误杀面封死——企业码持有者再报名个人码不烧企业码；谓词走 kindCond 单源[二十三轮票]）
      }
      return { ok: true as const }; // 响应不返明文（iv_ 只在短信通道）
    }),

  /**
   * registerByPhone（public mutation）：{phone, code, password(min8), realName?, inviteCode?}
   * → SessionInfo 同构（sessionInfoEx 形状 + token nt_）。
   * 建档与 authRegisterPerson 同构：username=phone、kind=person、factoryId=0、role=member；
   * 短信通道免身份证（idCardHash 留 NULL，实名核验经 M14 idCard 通道后补，M21 职业档案不受影响）。
   * inviteCode 选传：复用 wbInvites accept 入企逻辑——注册+入企一步完成，同事务
   * （消费验证码→消费邀请码→建档（factoryId/deptId/role 取自邀请）→manager 双写
   * wb_dept_heads→M21 join 履历→签发 nt_），任一步失败整体回滚，无孤立行。
   * 手机号已注册 → BAD_REQUEST「该手机号已注册，请直接登录」。
   */
  registerByPhone: publicQuery
    .input(
      z.object({
        phone: phoneSchema,
        code: z.string().trim().regex(SMS_CODE_RE, "验证码格式不正确"),
        password: z.string().min(8, "密码至少 8 位").max(128),
        realName: z.string().trim().min(1).max(64).optional(),
        // v162 注册男女模块（彭总令）：男=男声「兄弟…征战天下」/女=女声「姐妹…揽尽荣华」
        gender: z.enum(["male", "female"]).optional(),
        // v170 注册城市模块（人机共生大屏点亮归属：佛山/肇庆先行；不选=待点亮）
        city: z.enum(["foshan", "zhaoqing"]).optional(),
        inviteCode: z
          .string()
          .trim()
          .regex(/^iv_[0-9a-f]{48}$/, "邀请码格式不正确")
          .optional(),
        // 封闭内测闸（彭总 2026-10-02 令：个人注册同要邀测码）——betaCode 资格码必填（st_beta_invites 面，与 inviteCode 入企码分家）
        betaCode: z.string().trim().regex(BETA_CODE_RE, BETA_CODE_MSG),
        // 裂变推荐码（⑤收尾）：推荐人手机号——与 iv_ 入职码并存不冲突；
        // 注册即绑 invitedBy（referral 返佣管线认定列），推荐人不存在静默忽略不阻注册
        referrerPhone: phoneSchema.optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      // 预检：手机号已注册（与 authRegisterPerson 同口径：phone 或 username 命中）
      const [dup] = await db
        .select({ id: wbUsers.id })
        .from(wbUsers)
        .where(
          or(eq(wbUsers.phone, input.phone), eq(wbUsers.username, input.phone)),
        )
        .limit(1);
      if (dup) {
        throw new TRPCError({ code: "BAD_REQUEST", message: PHONE_DUP });
      }
      // 裂变推荐人预查（静默：号不存在/是自己=不绑，不阻注册主链）
      let referrerId: number | null = null;
      if (input.referrerPhone && input.referrerPhone !== input.phone) {
        const [ref] = await db
          .select({ id: wbUsers.id })
          .from(wbUsers)
          .where(eq(wbUsers.phone, input.referrerPhone))
          .limit(1);
        referrerId = ref ? Number(ref.id) : null;
      }
      // inviteCode 预检（事务前读；一次性消费仍在事务内原子置位）——先验邀请再资格闸（NumX 终判面：
      // 原始 inviteCode 在场判别=无效邀请会以 kind 错配文案压过真实 INVITE_INVALID[错误优先级颠倒]；validated inv 才是判别锚）
      let inv: WbInvite | undefined;
      let factory: typeof wbFactories.$inferSelect | undefined;
      if (input.inviteCode) {
        const [hit] = await db
          .select()
          .from(wbInvites)
          .where(eq(wbInvites.codeHash, sha256(input.inviteCode)))
          .limit(1);
        if (!hit || !invitePending(hit, new Date())) {
          throw new TRPCError({ code: "BAD_REQUEST", message: INVITE_INVALID });
        }
        inv = hit;
        const [fac] = await db
          .select()
          .from(wbFactories)
          .where(eq(wbFactories.id, inv.factoryId))
          .limit(1);
        if (!fac) {
          throw new TRPCError({ code: "BAD_REQUEST", message: INVITE_INVALID });
        }
        factory = fac;
      }
      // betaCode 资格闸预检（共享件 verifyBetaCode——彭总令：注册必填；kind 闸按 validated inv 判别=
      // 注册+入企一步口[invite?enterprise:personal——判别锚与建档 kind 同源]，NumX 终判面门户仓同搬）
      const { betaInvId } = await verifyBetaCode(db, input.betaCode, input.phone, inv ? "enterprise" : "personal");
      const invite = inv;
      const fac = factory;
      const deptName =
        fac?.departments.find((d) => d.id === invite?.deptId)?.name ?? null;
      let userId = 0;
      let token = "";
      try {
        // 验码两段式（门禁票：合体进事务=错验 attempts 计数随回滚吞掉）——校验+计数事务外直提交，消费事务内按 rowId
        const { rowId: smsRowId } = await verifySmsCodeOnly(
          db,
          input.phone,
          "register",
          input.code,
        );
        await db.transaction(async (tx) => {
          // 原子消费（事务内：注册失败码不被消耗——败方 affected=0 随回滚）
          await consumeBetaCode(tx, betaInvId); // 邀测码消费（同事务——一次性）
          await consumeSmsCodeById(tx, smsRowId);
          if (invite) {
            // 原子置 consumedAt：一次性消费，并发抢用/过期败方影响行=0 → CONFLICT
            const upd = await tx.execute(
              sql`UPDATE wb_invites SET consumedAt = NOW() WHERE id = ${invite.id} AND consumedAt IS NULL AND revokedAt IS NULL AND expiresAt > NOW()`,
            );
            const affected = Number(
              (upd[0] as { affectedRows?: number | string } | undefined)
                ?.affectedRows ?? 0,
            );
            if (affected !== 1) {
              throw new TRPCError({
                code: "CONFLICT",
                message: "邀请已被使用或已过期，请联系管理员重新邀请",
              });
            }
          }
          const [{ id }] = await tx
            .insert(wbUsers)
            .values({
              username: input.phone,
              phone: input.phone,
              passwordHash: hashPassword(input.password),
              displayName: input.realName ?? `用户${input.phone.slice(-4)}`,
              realName: input.realName ?? null,
              role: invite ? invite.role : "member",
              kind: invite ? "enterprise" : "person",
              factoryId: invite ? invite.factoryId : 0,
              departmentId: invite ? invite.deptId : null,
              invitedBy: invite ? invite.inviterId : referrerId,
              activatedAt: invite ? new Date() : null,
              // v162 性别落档（音色/开场白按此分）
              ...(input.gender ? { gender: input.gender } : {}),
            })
            .$returningId();
          userId = id;
          // v170 城市归属落档（大屏点亮事实源；city 列由 sync-screen-city 幂等建立，缺列静默不挡注册）
          if (input.city) {
            await tx
              .execute(
                sql`UPDATE wb_users SET city=${input.city} WHERE id=${id}`,
              )
              .catch(() => undefined);
          }
          // v162 灵枢上线第一句话（分性别，彭总令）：男「兄弟，今天起灵枢陪你征战天下」/女「姐妹，今天起灵枢伴你揽尽荣华」
          if (input.gender) {
            const line =
              input.gender === "female"
                ? "姐妹，今天起灵枢伴你揽尽荣华。"
                : "兄弟，今天起灵枢陪你征战天下。";
            const voicePersona = voicePersonaFor("lingshu", input.gender);
            void (async () => {
              const tts = await ttsForReply(line, voicePersona).catch(
                () => null,
              );
              await emitReport({
                audience: "personal",
                userId: id,
                level: "info",
                sourceRing: "onboard",
                title: "灵枢已上线",
                body:
                  line +
                  (tts?.url
                    ? `
[语音] ${tts.url}`
                    : ""),
                actionUrl: tts?.url ?? undefined,
                dedupeKey: `onboard-first-${id}`,
              }).catch(() => {});
            })();
          }
          // manager 双写 wb_dept_heads（读取侧 normalizeRole 与 dept_heads 命中取并集）
          if (invite && invite.role === "manager") {
            await tx.insert(wbDeptHeads).values({
              factoryId: invite.factoryId,
              deptId: invite.deptId,
              userId,
            });
          }
          // M21 join 钩子：入编即写 pending 履历，同事务同生共死
          if (invite) {
            await recordCareerEvent(
              userId,
              invite.factoryId,
              "join",
              deptName,
              invite.role,
              tx,
            );
          }
          // 签发 nt_ token（自动登录，单点有效）
          token = newCredential("nt_");
          await tx
            .update(wbUsers)
            .set({ authToken: authTokenHash(token) }) // portal#86 必修：落库只存指纹（明文不落库[凭证纪律——与 wb P3-6 同面]）
            .where(eq(wbUsers.id, userId));
        });
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        // 预检后唯一键被抢注（username/phone 唯一索引兜底）→ 业务错误而非 500——isDupEntry 共享件（drizzle 0.45 的 1062 在 cause 链，顶层 message 会漏——门禁票）
        if (isDupEntry(err)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: PHONE_DUP });
        }
        throw err;
      }
      const [user] = await db
        .select()
        .from(wbUsers)
        .where(eq(wbUsers.id, userId))
        .limit(1);
      return sessionInfoEx(user, fac, token);
    }),

  /**
   * loginByPhone（public mutation）：{phone, code} → SessionInfo 同构。
   * 按 phone 查 wb_users（factoryId=0 个人或企业成员皆可登）；无账号 →
   * BAD_REQUEST「该手机号尚未注册」（不泄露其他）；disabled 拒绝。
   * 重颁 nt_ token（单点有效，旧 token 失效）。
   */
  loginByPhone: publicQuery
    .input(
      z.object({
        phone: phoneSchema,
        code: z.string().trim().regex(SMS_CODE_RE, "验证码格式不正确"),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      let userId = 0;
      let token = "";
      // 验码两段式（同 register 面：计数事务外直提交，消费事务内按 rowId）
      const { rowId: smsRowId } = await verifySmsCodeOnly(
        db,
        input.phone,
        "login",
        input.code,
      );
      await db.transaction(async (tx) => {
        await consumeSmsCodeById(tx, smsRowId);
        const [user] = await tx
          .select()
          .from(wbUsers)
          .where(eq(wbUsers.phone, input.phone))
          .limit(1);
        if (!user) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: PHONE_NOT_REGISTERED,
          });
        }
        if (user.disabled) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "账号已停用，请联系管理员",
          });
        }
        userId = user.id;
        token = newCredential("nt_");
        await tx
          .update(wbUsers)
          .set({ authToken: authTokenHash(token) }) // portal#86 必修：落库只存指纹（明文不落库[凭证纪律——与 wb P3-6 同面]）
          .where(eq(wbUsers.id, userId));
      });
      const [user] = await db
        .select()
        .from(wbUsers)
        .where(eq(wbUsers.id, userId))
        .limit(1);
      const [factory] = await db
        .select()
        .from(wbFactories)
        .where(eq(wbFactories.id, user.factoryId))
        .limit(1);
      return sessionInfoEx(user, factory, token);
    }),
});
