/**
 * smsYxt —— 翼讯通电信短信平台全接口接入（彭总 2026-10-01 令：「把翼讯通接口文档接入」）。
 *
 * 按翼讯通接口文档 V1.6.7.2 三面接入：
 * ① 发送（sms.ts YixuntongSmsProvider——/http/send，md5(appid+mobile+msg+appkey) 32 小写）；
 * ② 状态报告推送（POST /api/sms-yxt/report——state 数字码 0=成功/3=失败（文档§5.2）；
 *    errorcode 为运营商码 DELIVRD/EXPIRED/UNDELIV/REJECTD（文档§10）；六参验签）；
 * ③ 上行短信推送（POST /api/sms-yxt/mo——六参验签，msgid 去重）。
 * 台账：st_sms_outbox（发送台账·taskid 关联回执；**验证码明文不落库——OTP 掩码（安全钉）**）
 *       st_sms_reports（回执台账·UNIQUE(taskid,mobile) 重推去重；终态纪律：中间态（-1）永不覆盖终态，终态间后到者赢——平台 ≤3 次重推可纠错）
 *       st_sms_mo（上行台账·UNIQUE(msgid) 重推去重——ODKU id=id 仅抑重复键，真数据错误仍抛错回 500）。
 * 纪律：验签 timingSafeEqual 恒时比较（时序钉）；验签不过静默 200 防探测（内部脱敏 warn 留痕——配置漂移可侦测）；
 *       env 未配回 500 触发平台重推（不静默丢数据）；ensureSmsTables 启动预热（boot fire-and-forget，请求路径纯读写）；
 *       翼讯通后台需绑来源 IP+推送地址（挂账 P-YXT-BIND）。
 */
import type { Context } from "hono";
import { createHash, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb } from "../queries/connection";

/** 幂等建表三面（boot 启动预热一次；运行期兜底幂等——热路径不重复 DDL） */
let tablesReady: Promise<void> | null = null;
export function ensureSmsTables(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    // 无库环境（单测/离线）短路——对齐 ensureOpsTables 纪律，import 即预热也绝不误触连接
    return Promise.resolve();
  }
  if (!tablesReady) {
    tablesReady = (async () => {
      // outbox.taskid 列宽 64：远超文档上限（§4.3 ≤11/§5.2 ≤18）——普通关联索引非唯一，钳制只是防御面不撞键
      await getDb().execute(sql`
        CREATE TABLE IF NOT EXISTS st_sms_outbox (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          phone VARCHAR(32) NOT NULL,
          msg VARCHAR(1000) NOT NULL,
          taskid VARCHAR(64) NOT NULL DEFAULT '',
          kind ENUM('code','notice') NOT NULL DEFAULT 'code',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          KEY idx_taskid (taskid),
          KEY idx_phone (phone)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
      await getDb().execute(sql`
        CREATE TABLE IF NOT EXISTS st_sms_reports (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          taskid VARCHAR(64) NOT NULL,
          mobile VARCHAR(32) NOT NULL,
          state SMALLINT NOT NULL,
          errorcode VARCHAR(16) NOT NULL,
          ismgmsgid VARCHAR(64) NOT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uk_task_mobile (taskid, mobile)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
      await getDb().execute(sql`
        CREATE TABLE IF NOT EXISTS st_sms_mo (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          msgid VARCHAR(64) NOT NULL,
          mobile VARCHAR(32) NOT NULL,
          servicenumber VARCHAR(32) NOT NULL,
          msg VARCHAR(500) NOT NULL,
          uptime VARCHAR(14) NOT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uk_msgid (msgid),
          KEY idx_mobile (mobile)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    })().catch((e) => {
      tablesReady = null;
      throw e;
    });
  }
  return tablesReady;
}

function env() {
  return {
    appid: process.env.SMS_YXT_APPID ?? "",
    appkey: process.env.SMS_YXT_APPKEY ?? "",
  };
}

function md5(s: string): string {
  return createHash("md5").update(s, "utf8").digest("hex");
}

/** 翼讯通签名装配单源（接口文档：md5(字段按序拼接 + appkey) 32 位小写）——send/report/mo 三面同引，字段序改动只动调用点 */
export function yxtSign(parts: string[], appkey: string): string {
  return md5(parts.join("") + appkey);
}

/** 平台响应 taskid 取值单源——文档 §7.3 返回示例用 taskid、§8.3 状态列表却用 taskId，三写法兼容防静默空键台账脱链 */
export function yxtTaskId(resp: Record<string, unknown>): string {
  return String(resp.taskid ?? resp.taskId ?? resp.task_id ?? "");
}

/** 日志注入防护：请求可控值入日志前剥全部控制字符（含 CR/LF/TAB/ESC——防伪造/污染日志行） */
export function logSafe(v: string): string {
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\x00-\x1f\x7f]/g, "");
}

/** 入库长度钳制（非键字段对齐 DDL 列宽——超长钳断不抛错，防 500 重推风暴）；
 *  reports/mo 的唯一键字段（taskid/mobile/msgid）绝不钳制（reports.taskid 与 outbox 同宽 64——跨台账同键同宽钉）——截断会让不同键塌成同行=无感丢数据，走 keyFit 守卫；
 *  outbox.taskid 是普通关联索引（非唯一）且列宽 64 远超文档上限 18——钳制只是防御面，不会撞键 */
export function clamp(v: string, n: number): string {
  return v.length > n ? v.slice(0, n) : v;
}

/** 唯一键字段守卫：空/超长都拒（空撞空键合并、超长截断撞前缀合并，同属无感丢数据线）——返回 false 时调用方跳过+warn */
function keyFit(v: string, n: number): boolean {
  return v !== "" && v.length <= n;
}

/** 恒时签名比对（时序钉：=== 短路泄漏前缀长度） */
function signEq(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

async function readBody(c: Context): Promise<Record<string, string>> {
  try {
    const text = await c.req.text();
    if (text.trim().startsWith("{")) {
      const j = JSON.parse(text) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(j).map(([k, v]) => [k, String(v ?? "")]));
    }
    return Object.fromEntries(new URLSearchParams(text).entries());
  } catch (e) {
    // 解析失败显形（脱敏+截断）——JSON.parse 的 message 会嵌请求体片段（CWE-117 旁路），必须过 logSafe
    console.warn("[sms-yxt] body parse failed:", clamp(logSafe(String((e as Error)?.message ?? e)), 120));
    return {};
  }
}

/** 推送验签公共件——三分态：ok 放行 / bad-sign 静默 200 防探测（warn 脱敏留痕）/ misconfig 回 500（平台 ≤3 次重推，配置修好即恢复） */
type PushVerdict = "ok" | "bad-sign" | "misconfig";
function verifyPush(appidFromBody: string, signFromBody: string, expectSign: string): PushVerdict {
  const { appid, appkey } = env();
  if (appid === "" || appkey === "") {
    console.error("[sms-yxt] SMS_YXT_* 未配置——推送验签不可用（部署面显形，回 500 触发平台重推）");
    return "misconfig";
  }
  // appid 是公开接入标识（非密钥），等值比较即可；密钥 appkey 只经 sign 走 timingSafeEqual 恒时比较
  return appidFromBody === appid && signEq(signFromBody, expectSign) ? "ok" : "bad-sign";
}

/** 日志安全值（脱敏+截断单源——入日志的请求可控值一律过它） */
function logVal(v: string, n = 64): string {
  return clamp(logSafe(v), n);
}

/** 推送处理器公共脚手架（report/mo 同引——验签三分态+唯一键守卫纪律真单源，新增守卫只改 keys 表）。
 *  返回 null 放行；否则为已决定的短回路响应。 */
// bad-sign 连击计数（按端点 tag 分键，互不误触阈值；进程级启发式——单进程部署面，多进程横向扩容时改共享存储）；
// 单次探测 warn 安静，≥3 连击 error 显形（协议漂移/密钥轮换持续丢弃不再只是一行日志）；该端点验签通过即归零
const badSignStreak = new Map<string, number>();

function pushGate(c: Context, b: Record<string, string>, signParts: string[], keys: Array<[string, number]>, tag: string): Response | null {
  const verdict = verifyPush(b.appid ?? "", b.sign ?? "", yxtSign(signParts, env().appkey));
  if (verdict === "misconfig") return c.text("ERROR", 500);
  if (verdict === "bad-sign") {
    const streak = (badSignStreak.get(tag) ?? 0) + 1;
    badSignStreak.set(tag, streak);
    const line = `[sms-yxt] ${tag} sign/appid mismatch dropped (${keys.map(([k]) => k + "=" + logVal(b[k] ?? "")).join(", ")})`;
    if (streak >= 3) {
      console.error(`${line} streak=${streak}——疑似推送协议漂移/appkey 轮换，持续丢弃中（运维面排查）`);
    } else {
      console.warn(line);
    }
    return c.text("OK");
  }
  badSignStreak.set(tag, 0);
  for (const [k, width] of keys) {
    const v = b[k] ?? "";
    if (!keyFit(v, width)) {
      // 空/超长键撞 UNIQUE 空键/前缀合并=无感丢数据——跳过+warn 显形（不落库）
      console.warn(`[sms-yxt] ${tag} key unfit dropped (${k}=${logVal(v)})`);
      return c.text("OK");
    }
  }
  return null;
}

/** 台账掩码助手（OTP 明文不落库——安全钉；每分支独立可测）。
 *  code 面：调用方显式传 otp 且 verbatim 命中→精确替换；未命中（模板措辞漂移）→warn 显形+OTP 长度区间（6-8 位）数字串兜底掩码。
 *  notice 面：掩 iv_ 邀请码——一次性凭证与 wb_invites sha256 姿态对齐，不落明文。 */
export function maskOutboxMsg(kind: "code" | "notice", msg: string, otp?: string): string {
  if (kind === "code") {
    if (otp && msg.includes(otp)) return msg.split(otp).join("[OTP已掩码]");
    if (otp) console.warn("[sms-yxt] otp not found verbatim in msg——fallback 数字串掩码（模板措辞漂移显形）");
    // 独立 OTP 长度区间（6-8 位）掩码：否定环视防长单号中段误伤（14 位单号整体不匹配）
    return msg.replace(/(?<!\d)\d{6,8}(?!\d)/g, "[OTP已掩码]");
  }
  return msg.replace(/iv_[A-Za-z0-9]+/g, "iv_[已掩码]");
}

/** 发送台账落库（内部 catch-all 不阻断发送链路；非键字段钳制对齐列宽）。
 *  OTP 安全钉编译期化：kind='code' 必传 otp（重载签名钉死——未来调用方忘传直接编译红，不靠口头约定） */
export async function recordSmsOutbox(phone: string, msg: string, taskid: string, kind: "code", otp: string): Promise<void>;
export async function recordSmsOutbox(phone: string, msg: string, taskid: string, kind: "notice"): Promise<void>;
export async function recordSmsOutbox(phone: string, msg: string, taskid: string, kind: "code" | "notice", otp?: string): Promise<void> {
  try {
    await ensureSmsTables();
    const safeMsg = maskOutboxMsg(kind, msg, otp);
    await getDb().execute(sql`
      INSERT INTO st_sms_outbox (phone, msg, taskid, kind) VALUES (${clamp(phone, 32)}, ${clamp(safeMsg, 1000)}, ${clamp(taskid, 64)}, ${kind})`);
  } catch (e) {
    // 驱动错误信息可回显请求可控值（CWE-117）——入日志一律过 logSafe+截断
    console.error("[sms-yxt] outbox record failed:", clamp(logSafe(String((e as Error)?.message ?? e)), 200)); // error 级——台账退化与推送面同响度
  }
}

/** POST /api/sms-yxt/report —— 状态报告推送（六参验签：appid+taskid+mobile+state+errorcode+ismgmsgid） */
export async function smsYxtReportHandler(c: Context): Promise<Response> {
  const b = await readBody(c);
  const { appid = "", taskid = "", mobile = "", state = "", errorcode = "", ismgmsgid = "" } = b; // sign 由 pushGate 从原始 body 取（三分态单源）
  const gate = pushGate(c, b, [appid, taskid, mobile, state, errorcode, ismgmsgid], [["taskid", 64], ["mobile", 32]], "report");
  if (gate) return gate;
  try {
    await ensureSmsTables();
    // state 仅 0（成功）/3（失败）合法（文档§5.2）——其它存 -1 显形（失败与成功不混淆钉），原始值 warn 留痕可排查
    let stateNum: number;
    if (state === "0") {
      stateNum = 0;
    } else if (state === "3") {
      stateNum = 3;
    } else {
      stateNum = -1;
      console.warn(`[sms-yxt] unknown report state: ${logVal(state)} (taskid=${logVal(taskid)}, mobile=${logVal(mobile)})`);
    }
    // 终态纪律单语句 ODKU（不用 SELECT FOR UPDATE 事务——RR 空档间隙锁+并发插入意向锁=死锁雷）：
    // 条件 state = -1 OR VALUES(state) <> -1 序无关（终态恒赢：终态来报无条件覆盖；中间态来报仅当库存也为中间态才覆盖——永不盖终态），
    // 任意赋值序都不反转纪律；单行 ODKU 原子落库，并发重推安全。
    // errorcode 空且 state 非预期 → 存 RAW_ 原文（台账可辨「平台推了非预期码」与「未到终态」——原始码不只活在 warn 里）
    const errStore = clamp(errorcode || (stateNum === -1 ? `RAW_${state}` : ""), 16);
    await getDb().execute(sql`
      INSERT INTO st_sms_reports (taskid, mobile, state, errorcode, ismgmsgid)
      VALUES (${taskid}, ${mobile}, ${stateNum}, ${errStore}, ${clamp(ismgmsgid, 64)})
      ON DUPLICATE KEY UPDATE
        state = IF(state = -1 OR VALUES(state) <> -1, VALUES(state), state),
        errorcode = IF(state = -1 OR VALUES(state) <> -1, VALUES(errorcode), errorcode),
        ismgmsgid = IF(state = -1 OR VALUES(state) <> -1, VALUES(ismgmsgid), ismgmsgid)`);
  } catch (e) {
    console.error("[sms-yxt] report record failed:", clamp(logSafe(String((e as Error)?.message ?? e)), 200));
    // 已验签但落库失败——回 500 让平台重推（≤3 次）；验签不过走 pushGate 静默 200 防探测
    return c.text("ERROR", 500);
  }
  return c.text("OK");
}

/** POST /api/sms-yxt/mo —— 上行短信推送（六参验签：appid+msgid+mobile+servicenumber+msg+uptime） */
export async function smsYxtMoHandler(c: Context): Promise<Response> {
  const b = await readBody(c);
  const { appid = "", msgid = "", mobile = "", servicenumber = "", msg = "", uptime = "" } = b; // sign 同上
  const gate = pushGate(c, b, [appid, msgid, mobile, servicenumber, msg, uptime], [["msgid", 64]], "mo");
  if (gate) return gate;
  try {
    await ensureSmsTables();
    // ODKU id=id 仅抑重复键（重推去重）；真数据错误仍抛错→catch 回 500 触发平台重推
    await getDb().execute(sql`
      INSERT INTO st_sms_mo (msgid, mobile, servicenumber, msg, uptime)
      VALUES (${msgid}, ${clamp(mobile, 32)}, ${clamp(servicenumber, 32)}, ${clamp(msg, 500)}, ${clamp(uptime, 14)})
      ON DUPLICATE KEY UPDATE id = id`);
  } catch (e) {
    console.error("[sms-yxt] mo record failed:", clamp(logSafe(String((e as Error)?.message ?? e)), 200));
    return c.text("ERROR", 500);
  }
  return c.text("OK");
}
