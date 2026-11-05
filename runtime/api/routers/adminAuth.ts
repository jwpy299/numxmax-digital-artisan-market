/**
 * adminAuth —— M64 超级终端专属注册/登录通道。
 *
 * 背景：超终历史复用 wb_users（工作台体系）+ staff 委派回退，HQ 老板账号
 * 从未在超终登录成功（authToken 空）。本路由给超终一条自己的通道：
 * - st_admin_accounts 独立账号表（与 wb_users 解耦，scrypt 同参数，nt_ 单点 token）；
 * - login          公开：账号/手机号 + 密码 → token（2FA 生效账号须动态码）；
 * - my2fa          原生席：我的 2FA 状态读（{enabled, isSuper}——批七-e 自助面读径，门禁 PR#11-r7-④）；
 * - enroll2fa/confirm2fa/disable2fa  原生席：2FA 登记/确认/停用（密码+码双证）；
 * - reset2fa       super 专属：应急重置他人 2FA（密码+本人码双证+审计钉）；
 * - registerApply  公开：注册申请 → pending（邀请码仅记录不直通，一律人工审批）；
 * - myApplication  公开：手机号+账号名查自己申请状态（自助）；
 * - applications   requireAdmin：待审列表；
 * - review         requireAdmin：approve → 建账号 + 一次性初始密码返回审批人转告；
 *                  reject → 落 reviewNote；
 * - setPassword    超终账号自助改密（旧密码校验 + 全端 token 吊销重签）；
 * - setDisabled    requireAdmin 停用/启用（super 账号不可被停用，防自锁）。
 *
 * requireAdmin 第三层回退见 auth/adminGate.ts + auth/nativeAdmin.ts（st_admin_accounts，adminOrigin:"native"）——R7-c44-⑦：terminal.ts 只是再出口，闸与原生查验已迁 auth 层；
 * 安全纪律：审批通过生成的初始密码只在 review 响应里出现一次；本文件绝不打日志明文密码。
 */
import { randomBytes, timingSafeEqual } from "node:crypto"; // 门禁 PR#9-r27-③：回放判别恒定时比较同引
import { authTokenHash } from "../auth/revocation"; // P3-6 落库哈希单点
import { z } from "zod";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { hashPassword, verifyPassword, newCredential } from "./wbSession";
import { rawRows, warnThrottled } from "../queries/rawRows"; // R7-c44-⑦/R7-c45-①/R7-c106-③/R7-c125-①：直引 canonical+良性告警节流同引（脱敏链随 500 抛出口上收 identity 单点——本文件不再直引）
import { requireAdmin } from "../auth/adminGate";
import { auditUserAction } from "./userAudit"; // 门禁 PR#9-r14-⑥：敏感动作审计钉同引（reset2fa 破窗通道留痕） // R7-c44-⑦：闸直引单源（不经 terminal 再出口）
// R7-c24-①/R7-c25-⑤：原生账号查验下沉 auth/nativeAdmin（归顶部导入块）；本文件再出口保持既有 import 路径
import { findNativeAdminByToken, toAdminAccountRow, isSuperRole, isAdminWhitelistedRole, coerceDisabledFlag, type AdminAccountRow } from "../auth/nativeAdmin"; // 门禁 PR#9-r2-②/r17-①：requireNativeSession 返型回引+enabled 域钉单源同引（域外漂移即抛 fail-closed——isDisabledOrDriftDead 同纪律）
import { newTotpSecret, verifyTotp, totpAt, encryptSecretForStore, decryptSecretFromStore, totpEncKeyConfigured, TotpConfigError, TOTP_DIGITS, TOTP_STEP_SECONDS, TOTP_ALGORITHM, TOTP_CODE_RE } from "../auth/totp"; // 门禁 PR#9-r8-⓪/r9-④/r11-②：静态加密件+就绪判别+配置事故型别同引 // 七-d：TOTP 纯件+协议参数/形状钉同引（门禁 PR#9-⑤/r2-⓪⑥——otpauth URL/schema/校验三方锁步） // R7-c111-⑤：颁证白名单谓词单点同引（isAdminRole 直呼摘除；isSuperRole 留——登录响应推导+setDisabled 在用） // R7-c91-②：admin 判别谓词同引（颁证白名单与原生支同口径） // toAdminAccountRow 复用（R7-c27-②：st_admin_accounts 读取契约全域走类型化映射）+isSuperRole 谓词同引（R7-c81-②）
import { assertNotRevoked, infraUnavailable500, isNoSuchTable, twoFaTableOptionalEnabled, wbThreadUserId, guardInfra } from "../auth/identity"; // 门禁 PR#9-r15-⓪：审计分带键单点同引
import { env } from "../lib/env"; // 门禁 PR#9-r35-⑤：TOTP_ISSUER 归 env 单点
import { SYNC_ADMIN_2FA_SCRIPT, AUTH_LOGIN_FAIL_GENERIC, AUTH_DISABLED_SUPER_MESSAGE, TOTP_ISSUER_DEFAULT, AUTH_2FA_REQUIRED_MESSAGE, TFA_FAIL_MAX, TFA_FAIL_WINDOW_S, TFA_LOCKED_MESSAGE, TFA_TABLE_MISSING_MESSAGE, TFA_CODE_FAIL_MESSAGE, TFA_CODE_FAIL_SETUP_MESSAGE } from "@contracts/authLock"; // 门禁 PR#9-r16-①/r29-①：脚本路径+统一话术+2FA 三件套单源同引 // 门禁 PR#9-r16-①/r26-⓪：迁移脚本路径+统一话术双单源同引 // R7-c140-①：构造器同引（setPassword 免记档档用） // R7-c26-⑨/R7-c28-④/R7-c104-⑧/R7-c125-①：infra 话术+吊销判决+500 抛出口政策单源同引；七-d：isNoSuchTable 同引（2FA 缺表豁免判别）

/** 2FA 失败节流（门禁 PR#9-④ security medium——DB 计数重启不丢，wbInvites 限频同口径）：
 *  窗内 5 败锁至窗末——密码（第一因子）已知前提下 6 位码在线暴破（±1 窗任一时刻 3 码有效，期望 ~3.3e5 次命中）面封死；
 *  窗判在库内（NOW() 与 fail_since 同钟——JS Date 跨时区误限频面封死，wbInvites 2026-09-07 教训同例） */
// 门禁 PR#9-r29-①：节流三件套（TFA_FAIL_MAX/TFA_FAIL_WINDOW_S/TFA_LOCKED_MESSAGE）归 contracts 叶——客户端 429 回落同话术源
const TOTP_ISSUER = env.totpIssuer.trim() || TOTP_ISSUER_DEFAULT; // 门禁 PR#9-r36-④：默认值归契约叶（品牌字=用户可见——验证器 issuer 面；白标演进不再 grep 路由文件）

/** 2FA 步长消费单点（门禁 PR#9-r6-⓪ maintainability medium）：条件 UPDATE（高水位不退）+验数一处——
 *  login/setPassword/reset2fa 经 run2faEnforced 同引（回放闸写句演进不再双抄漂移）；
 *  返 false=同窗码已消费/行已被重置（调用方抛 failMsg——门禁 PR#9-r32-⑥ 注释归正：不再一律 LOGIN_FAIL） */
async function consume2faStep(accountId: number, step: number, tag: string): Promise<boolean> {
  const res = await guardInfra(`[routers/adminAuth] ${tag} 2FA 步长消费失败`, async () => rawRows(
    await getDb().execute(
      sql`UPDATE st_admin_2fa SET last_step = ${step}, fail_count = 0 WHERE account_id = ${accountId} AND enabled = 1 AND (last_step IS NULL OR last_step < ${step})`, // 门禁 PR#9-r27-④ bug low：并发停用/重登记（enabled=0/last_step=NULL）行不回写——消费只落在生效行（在飞登录的 2FA 凭据随重置作废=fail-closed）
    ),
  ));
  return Number(res[0]?.affectedRows ?? 0) > 0;
}

/** 2FA 强制闸组合单点（门禁 PR#9-r24-② maintainability low）：load→验→消费三连不再 login/setPassword/reset2fa 三处复抄
 *  （只 tag/failMsg 异——漂移面封死）；失败全抛（要码 412/锁 429/错码回放 401）；过闸/未启用皆 void 直返（门禁 PR#9-r31-③——返值零消费）；
 *  回放拒话术随 failMsg（login=LOGIN_FAIL 不泄码态；已认证径=「动态码校验失败」） */
async function run2faEnforced(accountId: number, code: string | undefined, tag: string, failMsg = LOGIN_FAIL): Promise<void> { // 门禁 PR#9-r31-③：返值零消费——签名归 void（true/false 死信号摘除）
  const tfa = await guardInfra(`[routers/adminAuth] ${tag} 2FA 查验失败`, async () => load2fa(accountId));
  if (tfa === null) return; // 未启用=直返（主流程续行）
  const step = await verify2faCode(accountId, tfa, code, tag, failMsg);
  if (!(await consume2faStep(accountId, step, tag))) {
    warnThrottled("adminAuth.2fa-replay", `[routers/adminAuth] 2FA 同窗码回放拒绝（${tag}——步长已消费）`);
    throw new TRPCError({ code: "UNAUTHORIZED", message: failMsg });
  }
}

/** 2FA 校验序列单点（门禁 PR#9-r5-①+r13-④+r14-⑦）：要码→解密（分类单点）→校验→原子认领→败则拒——认领在验后
 *  （服务端故障不烧锁定预算；每尝试必计由认领原子性保证，与验码先后无安全差）；
 *  锁阈/回放闸/失败记账政策不再四份抄（login/setPassword/confirm/disable 同引）；消费写句形态各异归调用方
 *  （login/setPassword 条件消费/confirm 生效写/disable 软停）；failMsg 可换（confirm 装设径给指引话术） */
async function verify2faCode(accountId: number, tfa: { secretStored: string; lastStep: number | null }, code: string | undefined, tag: string, failMsg = LOGIN_FAIL): Promise<number> {
  // 门禁 PR#9-r10-⓪ bug medium：入参收【库存形态】——解密在 guardInfra 裹内进行（形态漂移/错钥/无钥读密文不再裸抛于包裹外
  //  =disable 径裸错面封死；解密单点本件——调用面不再各自调 decryptSecretFromStore）
  if (!code) throw new TRPCError({ code: "PRECONDITION_FAILED", message: AUTH_2FA_REQUIRED_MESSAGE });
  const cleanCode = code.replace(/\s+/g, ""); // 门禁 PR#9-r30-② bug low：归一化在入点一次——verifyTotp 内与回放判别同形态（raw 码双轨判别面封死）
  // 门禁 PR#9-r12-①：解密先走分类单点——TotpConfigError（配置事故）归 412 显因，不被 guardInfra 掩成通用 500
  //  （与 classify2faCatch 政策一致——「掩码盖 triage 线索」面不回开；解密无 DB=1146/exempt 结构性不可达）
  let secretPlain: string;
  try {
    secretPlain = decryptSecretFromStore(tfa.secretStored);
  } catch (e) {
    classify2faCatch(e, `${tag} 解密`); // 恒抛（配置事故 412/余故障掩码 500——"exempt" 不可达）
    throw e; // 门禁 PR#9-r25-⑤：TS 定值终结符（catch 落穿=secretPlain 未赋编译红——结构性不可达但编译需要，勿删）
  }
  const step = await guardInfra(`[routers/adminAuth] ${tag} 校验异常`, async () =>
    verifyTotp(secretPlain, cleanCode, Date.now(), tfa.lastStep));
  // 门禁 PR#9-r13-④ bug medium：认领挪到验码后——服务端故障（配置事故/密文腐化）在验码前抛=不再白烧锁定预算
  //  （故障期真用户被误锁面封死）；防并发暴破不打折——认领单句原子 UPDATE 行锁串行（每尝试必计且 ≤MAX 才放行），
  //  与验码先后无安全差（结果不出仓=无 oracle）；自治提交——错码回滚吞计数面永不沾（PR#9-r7-① 钉）
  if (step === null && tfa.lastStep !== null) {
    // 门禁 PR#9-r27-③ bug low：已消费窗码（成功响应丢失后的良性重试）与真错码分流——回放拒但【不烧锁定预算】
    //  （判别=该码是否命中最近已消费窗的码——恒定时比较；旧于 lastStep 的更早窗码按真错码计——既防预算空烧又不松暴破面）
    const replayed = await guardInfra(`[routers/adminAuth] ${tag} 回放判别失败`, async () => {
      const a = Buffer.from(cleanCode); // 同形态（r30-②）
      const bx = Buffer.from(totpAt(secretPlain, tfa.lastStep as number));
      return a.length === bx.length && timingSafeEqual(a, bx);
    });
    if (replayed) {
      warnThrottled("adminAuth.2fa-replay-reject", `[routers/adminAuth] 2FA 已消费窗码重试拒绝（${tag}——良性重试不烧预算；恒定时判别）`);
      throw new TRPCError({ code: "UNAUTHORIZED", message: failMsg });
    }
  }
  if (step === null) {
    await claim2faAttempt(accountId); // 真错码才计失败（行锁串行 ≤MAX）
    warnThrottled("adminAuth.2fa-code-rejected", `[routers/adminAuth] 2FA 校验失败（${tag}——错码/超窗；计数已在原子认领）`);
    throw new TRPCError({ code: "UNAUTHORIZED", message: failMsg });
  }
  await claim2faAttempt(accountId); // 成功径同过锁闸（锁窗内正确码同拒——锁定判在认领内）
  return step;
}

/** 2FA catch 公共分类单点（门禁 PR#9-r11-②④）：TRPCError 透传/加密配置事故 412 显因/1146 分流（opt-in 生效返 "exempt"
 *  归调用方按端点语义显形，缺省掩码 500）/余故障掩码 500——enroll/confirm/read2faRow 三处 catch 同引（各写各形漂移面封死） */
function classify2faCatch(e: unknown, tag: string): "exempt" {
  if (e instanceof TRPCError) throw e; // 域内透传
  if (e instanceof TotpConfigError) { // 配置事故显因上行（原文=配置指引无敏感值——掩成通用 500 反盖 triage 线索）
    warnThrottled("adminAuth.2fa-enc-key-bad", "[routers/adminAuth] 2FA 加密钥配置事故（形态错/生产缺钥拒写/密文无钥——见显因话术）");
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "服务端 2FA 加密配置未完成——请稍后再试或联系运维" }); // 门禁 PR#9-r33-⑤ security low：客户端话术不嵌 env 变量名（部署密钥配置细节不外泄；变量名只留服务端 warnThrottled 留痕）
  }
  if (isNoSuchTable(e)) {
    if (is2faTableOptional()) {
      warnThrottled("adminAuth.2fa-notable", `[routers/adminAuth] st_admin_2fa 未建+ADMIN_2FA_TABLE_OPTIONAL=1——2FA 面豁免（opt-in 显式担责；上线检查单：${SYNC_ADMIN_2FA_SCRIPT}）`); // 门禁 PR#9-r16-①：脚本路径常量同引
      return "exempt";
    }
    infraUnavailable500(`[routers/adminAuth] ${tag}（2FA 台账缺表，缺省 fail-closed——pre-migration 须 ADMIN_2FA_TABLE_OPTIONAL=1 opt-in）`, e);
  }
  infraUnavailable500(`[routers/adminAuth] ${tag}`, e); // never 型注记=终结（门禁 PR#9-r12-②：尾部 throw 死码摘——我此前注记写错了它的型）
}

/** 失败窗过期谓词片段单源（门禁 PR#9-r21-②）：SET×2+WHERE 三处同引——窗界逻辑不再三份锁步手抄（新鲜实例工厂防 append 污染） */
const tfaWindowExpired = () => sql`fail_since IS NULL OR fail_since < NOW() - INTERVAL ${TFA_FAIL_WINDOW_S} SECOND`;

/** 尝试原子认领（门禁 PR#9-r2-① security medium——先读后验竞态封死：锁判+计数合一句 UPDATE 行锁内完成，
 *  并发暴破不再各读旧计数齐过闸——并发下每窗有效猜测数恒 ≤TFA_FAIL_MAX）；affectedRows=0 即锁定（429 不落校验）；
 *  成功路径清计数归 consume/confirm/soft-disable 各写句（fail_count=0 同句）；窗判在库内同钟 */
async function claim2faAttempt(accountId: number): Promise<void> {
  const res = await guardInfra("[routers/adminAuth] 2FA 尝试认领失败", async () => rawRows(
    await getDb().execute(
      sql`UPDATE st_admin_2fa SET
            fail_count = IF(${tfaWindowExpired()}, 1, fail_count + 1),
            fail_since = IF(${tfaWindowExpired()}, NOW(), fail_since)
          WHERE account_id = ${accountId}
            AND (${tfaWindowExpired()} OR fail_count < ${TFA_FAIL_MAX})`, // 门禁 PR#9-r21-②：窗判谓词单源三引
    ),
  ));
  if (Number(res[0]?.affectedRows ?? 0) === 0) {
    // 门禁 PR#9-r8-② bug medium：零行歧义拆解——无行（未登记）≠锁定（话术张冠李戴面封死）；罕路径才付补探针
    const probe = await guardInfra("[routers/adminAuth] 2FA 认领零行分辨失败", async () => rawRows(
      await getDb().execute(sql`SELECT account_id FROM st_admin_2fa WHERE account_id = ${accountId} LIMIT 1`),
    ));
    if (!probe[0]) throw new TRPCError({ code: "CONFLICT", message: "无待确认的 2FA 登记（未登记或已停用）" });
    warnThrottled("adminAuth.2fa-locked", "[routers/adminAuth] 2FA 失败超限锁定中（原子认领拒——并发暴破面封死）");
    throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: TFA_LOCKED_MESSAGE });
  }
}

/** 2FA 缺表政策（门禁 PR#9-② security medium + r2-⑤ 升档）：缺省 fail-closed——已上线后被删/改名/错路由（同 1146）若豁免=
 *  全员 2FA 静默关闭仅凭密码登录面；豁免须显式 ADMIN_2FA_TABLE_OPTIONAL=1 且【非生产环境】（谓词归 identity 单点
 *  twoFaTableOptionalEnabled——与吊销台账旗同政策族；生产+旗在场=配置错配，boot 启动显形即抛） */
const is2faTableOptional = twoFaTableOptionalEnabled;

/** 2FA 行读取（门禁 PR#9-r30-③ maintainability low）：判别联合三态——ok=行在/none=真无行/exempt=缺表豁免态
 *  （豁免不再坍缩成 null 冒充无行——confirm/disable 在豁免环境给 412 装表指引（与 enroll 同族），不再「无待确认」误导；
 *  login 径 exempt→未启用语义不动）；缺省 fail-closed 500 显因；余故障抛上行（调用方 guardInfra 裹） */
type TwoFaRead = { kind: "ok"; row: Record<string, unknown> } | { kind: "none" } | { kind: "exempt" };
async function read2faRow(statement: ReturnType<typeof sql>): Promise<TwoFaRead> {
  try {
    const rows = rawRows(await getDb().execute(statement));
    return rows[0] ? { kind: "ok", row: rows[0] } : { kind: "none" };
  } catch (e) {
    classify2faCatch(e, "2FA 台账读取") satisfies "exempt"; // 编译期型钉（r24-① 口径）
    return { kind: "exempt" };
  }
}

const LOGIN_FAIL = AUTH_LOGIN_FAIL_GENERIC; // 门禁 PR#9-r25-③/r26-⓪：跨层契约归 contracts 叶单源（客户端 wbSession 同引——双端编译期锁步）
/** 动态码入参形状单点（门禁 PR#9-r2-⑥）：regex 从 TOTP_CODE_RE 同引（TOTP_DIGITS 派生——位数演进不再三处静默失同步）；
 *  空白分隔 transform 容忍（扫码器分组显示形态——「123 456」归一为「123456」） */
const totpCodeInput = z.string().transform((s) => s.replace(/\s+/g, "")).pipe(z.string().regex(TOTP_CODE_RE, `动态码为 ${TOTP_DIGITS} 位数字`));

/** 2FA 行→库存形态映射单点（门禁 PR#9-r11-⑦）：String/lastStep 归一不再逐端点复抄（load2fa/disable 同引） */
function map2faRow(r: Record<string, unknown>): { secretStored: string; lastStep: number | null } {
  // 门禁 PR#9-r19-③ bug low：secret_b32 缺值/非串钉——String(null)="null" 字面量流入解密=误导性 base32 报错面封死
  //  （列改名/坏迁移/半步写=schema 漂移显形 fail-loud；调用方 guardInfra 裹=掩码 500+留痕）
  const stored = r.secret_b32;
  if (typeof stored !== "string" || stored.trim() === "") throw new Error("[routers/adminAuth] st_admin_2fa.secret_b32 缺值/非串——schema 漂移面");
  // 门禁 PR#9-r20-③ bug low：last_step 裸 Number()=NaN 漂移会静默缴回放闸（w <= NaN 恒假=高水位失效）——域钉 fail-loud
  //  （安全整数+非负；列重建为非数值型/脏数据=漂移显形 500，不再假放行）
  const ls = r.last_step;
  if (ls === null || ls === undefined || ls === "") return { secretStored: stored, lastStep: null };
  // 拆序不嵌套三元（仓规——nativeAdmin 同例）
  let n: number;
  if (typeof ls === "number") {
    n = ls;
  } else if (/^\d+$/.test(String(ls).trim())) {
    n = Number(String(ls).trim()); // 字符串数字域钉（前导零容忍——adminGate 同纪律）
  } else {
    n = NaN; // 域外串/对象=漂移（下方闸接住）
  }
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("[routers/adminAuth] st_admin_2fa.last_step 域外漂移（非安全非负整数）——schema/数据漂移面");
  return { secretStored: stored, lastStep: n };
}

/** 2FA 状态读取（七-d）：enabled=1 才返（登记未确认/停用=null）；缺表政策归 read2faRow 单点 */
async function load2fa(accountId: number): Promise<{ secretStored: string; lastStep: number | null } | null> { // 门禁 PR#9-r10-⓪：库存形态出（解密归 verify2faCode 内单点）
  const rr = await read2faRow(sql`SELECT secret_b32, last_step, enabled FROM st_admin_2fa WHERE account_id = ${accountId} LIMIT 1`);
  if (rr.kind !== "ok") return null; // none/exempt 同归未启用（login 径豁免语义——门禁 PR#9-r30-③：判别联合承载，不再坍缩冒充无行）
  const r = rr.row;
  // 门禁 PR#9-r17-① security medium：enabled 域钉 fail-closed——域外漂移值（2/-1/NaN）不再被当「未启用」静默跳二要素
  //  （同仓旗列纪律同引：coerceDisabledFlag 域外即抛——漂移=系统性故障显形 500，不归 login 免码放行）
  if (coerceDisabledFlag(r.enabled, "st_admin_2fa.enabled", "[routers/adminAuth]") !== 1) return null;
  return map2faRow(r); // 门禁 PR#9-r11-⑦：映射单点同引
}

export { findNativeAdminByToken };

/** 原生席会话闸单点（门禁 PR#9-r2-② maintainability+r2-③ security low）：吊销判决→会话查验（guardInfra 免双记）
 *  →停用判→颁证白名单（isAdminWhitelistedRole——token 仍有效但角色已漂移非 admin/super 的残余会话不得操 2FA/改密）；
 *  enroll2fa/confirm2fa/disable2fa/setPassword/reset2fa/my2fa 六端点同引（门禁 PR#11-r7-④ 归正：清单随消费面演进）——
 *  鉴权政策演进只改本点（抄三份漏一份面封死） */
async function requireNativeSession(token: string): Promise<AdminAccountRow> {
  await assertNotRevoked(token); // 台账判决先行（吊销 token 不得改 2FA/密码）
  const account = await guardInfra("[routers/adminAuth] 原生席会话查验失败", async () => findNativeAdminByToken(token), { log: false });
  if (!account || account.disabled === 1) throw new TRPCError({ code: "UNAUTHORIZED", message: "会话无效" });
  if (!isAdminWhitelistedRole(account.role)) throw new TRPCError({ code: "UNAUTHORIZED", message: "会话无效" }); // 颁证白名单第二守点（统一「会话无效」不泄角色态）
  return account;
}

const APPLY_CONCURRENT_REVIEWED = "该申请已被并发审结——请刷新核对状态"; // R7-c158-④/R7-c159-③：并发审结话术单源（驳回/通过两支同引不双抄——内联复抄摘除）
// R7-c44-⑧：APPLY_FAIL 死常量摘除（registerApply infra 支归 infraUnavailable 单点后零消费）

/** 一次性初始密码：12 位可读口令（字母+数字，去易混字符），仅 review 响应出现一次 */
function genInitialPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const buf = randomBytes(12);
  return [...buf].map((b) => chars[b % chars.length]).join("");
}

export const adminAuthRouter = createRouter({
  /** 我的 2FA 状态（批七-e 自助面读径）：原生席专属——{enabled, isSuper}（门禁 PR#11-r9-③ doc 归正：
   *  isSuper 驱动调用方破窗面板显隐；缺表豁免径 exempt/none 同归 false——login 径语义同构） */
  my2fa: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const account = await requireNativeSession(input.token);
      const tfa = await guardInfra("[routers/adminAuth] my2fa 查验失败", async () => load2fa(account.id));
      // 门禁 PR#11-r7-⑤ bug low：isSuper 随读出参——服务端知道角色（客户端 session 恒 admin 辨不出 super）——
      //  破窗面板按本位渲（非 super 的原生席不再看见一个恒 FORBIDDEN 的表单）
      return { enabled: tfa !== null, isSuper: isSuperRole(account.role) };
    }),

  /** 超终原生登录：username 或 phone + password → nt_ token（单点，重签覆盖） */
  login: publicQuery
    .input(
      z.object({
        identifier: z.string().trim().min(1, "请输入账号").max(64, "账号最长 64 位"), // 门禁 PR#9-r37 供给侧：长度帽带中文话术（默认英文 zod internals 不透面——中文钉有货可供）
        password: z.string().min(1, "请输入密码").max(128, "密码最长 128 位"),
        totpCode: totpCodeInput.optional(), // 七-d：2FA 生效账号的动态码（未启用不传；形状钉走 totpCodeInput 单点——门禁 PR#9-③/r2-⑥）
      }),
    )
    .mutation(async ({ input }) => {
      // R7-c29-② security medium：查询+映射同包（同 registerApply 整包口径）——schema 漂移最可能炸在 SELECT 本身
      //  （列改名/缺列），裸 Drizzle 错误同样会经 tRPC 默认格式化透给未认证调用方；整 try 走脱敏 500（INFRA 话术单源）
      // R7-c92-②/R7-c102-④/R7-c103-①：查询与映射分轨——查询 infra 仍 500 显因（M65 不折叠）；
      //  行映射漂移=系统性故障嫌疑——走脱敏 500 显因（401 会把系统性漂移报成「密码错误」=全员被锁无告警面封死）；
      //  脱敏留痕单点不泄细节给未认证面
      const rows = await guardInfra("[routers/adminAuth] login 查验失败（schema 漂移/infra）", async () => rawRows(
        await getDb().execute(
          sql`SELECT id, username, phone, passwordHash, displayName, role, disabled
              FROM st_admin_accounts
              WHERE username = ${input.identifier} OR phone = ${input.identifier}
              LIMIT 1`, // R7-c48-⑧/R7-c49-①/R7-c51-⑧：本查询本就不含 authToken（历史如此）——真改动在映射契约摘帽（AdminAccountRow.authToken?: never）；措辞修正不冒充安全回归
        ),
      )); // R7-c104-③：包裹器单点收编
      // R7-c92-②→R7-c102-④/R7-c104-③：行映射漂移=系统性故障嫌疑——500 显因不冒充登录失败（包裹器单点收编；
      //  401 会把系统性漂移报成「密码错误」——全员被锁还无任何告警级信号；脱敏留痕单点不泄细节给未认证面）
      const row = await guardInfra("[routers/adminAuth] login 行映射漂移（schema/数据漂移）", async () =>
        rows[0] !== undefined ? toAdminAccountRow(rows[0]) : undefined); // R7-c27-②：类型化映射复用（不再 as unknown as 谎 shape）
      // 账号不存在与密码错误统一口径，不泄露账号是否存在
      if (!row || !verifyPassword(input.password, row.passwordHash)) { // R7-c47-④：收窄后不再防御性强转
        throw new TRPCError({ code: "UNAUTHORIZED", message: LOGIN_FAIL });
      }
      if (row.disabled === 1) { // R7-c47-④：mapper 恒产 finite number
        throw new TRPCError({ code: "UNAUTHORIZED", message: AUTH_DISABLED_SUPER_MESSAGE }); // 门禁 PR#9-r36-⑥：归叶（白名单同叶同引）
      }
      // R7-c91-② bug medium：颁证即守白名单——role 非 admin/super 的行不颁 nt_ 令牌（旧口径密码对就颁→
      //  requireAdmin 原生支白名单拒=登录成功但管理面全 401=M65 症状复活面封死）；与原生支同一谓词对同引
      //  （isAdminRole/isSuperRole——utf8mb4_ci 对齐）；统一 LOGIN_FAIL 话术不泄露账号态（与密码错误同口径）
      if (!isAdminWhitelistedRole(row.role)) { // R7-c111-⑤：白名单复合走谓词单点（两颁证点锁步）
        // R7-c106-③：白名单拒绝服务端节流留痕（客户端话术不变不泄账号态——永久静默锁死无告警面封死）
        warnThrottled("adminAuth.login-role-rejected", "[routers/adminAuth] 登录角色白名单拒绝（role 非 admin/super——schema/数据漂移面，存在静默锁死风险）");
        throw new TRPCError({ code: "UNAUTHORIZED", message: LOGIN_FAIL });
      }
      // 七-d：2FA 生效账号须过二要素（密码已过才到这——明示弹码窗非账号态 oracle；窗码校验失败/回放=统一 LOGIN_FAIL 不泄码态）；
      //  缺表政策（门禁 PR#9-r16-②/r26-① 注释归正——旧注「pre-migration 良性豁免」口径已废）：缺省 fail-closed 显因 500——
      //  豁免须显式 ADMIN_2FA_TABLE_OPTIONAL=1 且显式非生产（read2faRow/classify2faCatch 单点承载；boot 在场体检钉在册）
      // 门禁 PR#9-⓪ security high：load2fa/verifyTotp 同裹 guardInfra——裸 Drizzle/base32 错不再经 tRPC 默认格式化
      //  逐字回显未认证调用方（与同文件 SELECT/映射/令牌写回同口径）；PR#9-④：校验前锁闸+失败记账
      // 门禁 PR#9-r24-②：强制闸组合归 run2faEnforced 单点——load→验→消费一处（login 径话术=LOGIN_FAIL 不泄码态；
      //  缺码 412 弹码窗/锁 429/错码回放 401 政策不变）
      await run2faEnforced(row.id, input.totpCode, "login 2FA");
      const token = newCredential("nt_");
      // R7-c32-④ security high/R7-c104-③：令牌写回包裹走 guardInfra 单点——Drizzle 错误内嵌 SQL+绑定参数（新鲜 nt_ token+账号 id），
      //  tRPC 默认 errorFormatter 逐字回显未认证调用方；脱敏留痕+INFRA 500（与 SELECT/映射同口径）
      await guardInfra("[routers/adminAuth] login 令牌写回失败（infra/schema 漂移）", async () => {
        await getDb().execute(
          sql`UPDATE st_admin_accounts SET authToken = ${authTokenHash(token)}, lastLoginAt = NOW() WHERE id = ${row.id}`, // R7-c48-⑨：mapper 恒产 number；P3-6 落库只存指纹
        );
      });
      return {
        token,
        username: row.username,
        displayName: row.displayName,
        role: isSuperRole(row.role) ? ("super" as const) : ("admin" as const), // R7-c47-④/R7-c82-⑤：收窄后不再防御性强转；super 判别走谓词单源（登录响应与 setDisabled/authLock 闸同引——"Super" 库存值三处不再分歧）
        adminOrigin: "native" as const,
      };
    }),

  /** 注册申请：一律 pending 人工审批；username 唯一预检（账号表+在途申请） */
  registerApply: publicQuery
    .input(
      z.object({
        username: z.string().trim().min(3, "账号至少 3 位").max(64)
          .regex(/^[A-Za-z0-9_一-龥-]+$/, "账号仅限字母/数字/下划线/中文/短横"),
        phone: z.string().trim().regex(/^1\d{10}$/, "请输入 11 位手机号"),
        displayName: z.string().trim().min(1, "请输入姓名").max(64),
        reason: z.string().trim().max(500).default(""),
        inviteCode: z.string().trim().max(64).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      // R7-c104-③：包裹器单点收编（TRPC 域内错误透传不裹——CONFLICT 重名 409 不变 500）
      return guardInfra("[routers/adminAuth] registerApply 失败（infra/schema 漂移）", async () => {
        const dupAccount = rawRows(
          await getDb().execute(
            sql`SELECT id FROM st_admin_accounts WHERE username = ${input.username} LIMIT 1`,
          ),
        );
        if (dupAccount.length > 0) {
          throw new TRPCError({ code: "CONFLICT", message: "该账号名已被使用" });
        }
        const dupPending = rawRows(
          await getDb().execute(
            sql`SELECT id FROM st_admin_applications
                WHERE username = ${input.username} AND status = 'pending' LIMIT 1`,
          ),
        );
        if (dupPending.length > 0) {
          throw new TRPCError({ code: "CONFLICT", message: "该账号名已有待审申请，请耐心等待" });
        }
        await getDb().execute(
          sql`INSERT INTO st_admin_applications (username, phone, displayName, reason, inviteCode, status)
              VALUES (${input.username}, ${input.phone}, ${input.displayName}, ${input.reason},
                      ${input.inviteCode ?? null}, 'pending')`,
        );
        return { ok: true as const, status: "pending" as const };
      });
    }),

  /** 自助查询我的申请状态（phone+username 双因子匹配，防枚举他人申请）——R7-c45-⑨：infra/schema 失败走脱敏 500（公开端点裸 Drizzle 错内嵌 SQL+双因子参数不透调用方） */
  myApplication: publicQuery
    .input(
      z.object({
        username: z.string().trim().min(1).max(64),
        phone: z.string().trim().regex(/^1\d{10}$/),
      }),
    )
    .query(async ({ input }) => {
      // R7-c45-⑨/R7-c104-③ security：查询包裹走 guardInfra 单点——公开端点裸 Drizzle 错内嵌 SQL+双因子参数不透调用方
      const rows = await guardInfra("[routers/adminAuth] myApplication 查验失败", async () => rawRows(
        await getDb().execute(
          sql`SELECT status, reviewNote, createdAt, reviewedAt FROM st_admin_applications
              WHERE username = ${input.username} AND phone = ${input.phone}
              ORDER BY id DESC LIMIT 1`,
        ),
      ));
      const row = rows[0];
      if (!row) return { found: false as const };
      return {
        found: true as const,
        status: String(row.status),
        reviewNote: row.reviewNote == null ? null : String(row.reviewNote),
        createdAt: row.createdAt ? new Date(String(row.createdAt)).toISOString() : null,
        reviewedAt: row.reviewedAt ? new Date(String(row.reviewedAt)).toISOString() : null,
      };
    }),

  /** 待审申请列表（requireAdmin） */
  applications: publicQuery
    .input(z.object({ token: z.string().trim().min(1), status: z.enum(["pending", "approved", "rejected", "all"]).default("pending") }))
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      const rows = await guardInfra("[routers/adminAuth] applications 查验失败", async () => rawRows(
        await getDb().execute(
          input.status === "all"
            ? sql`SELECT id, username, phone, displayName, reason, inviteCode, status, reviewedBy, reviewedAt, reviewNote, createdAt
                  FROM st_admin_applications ORDER BY id DESC LIMIT 100`
            : sql`SELECT id, username, phone, displayName, reason, inviteCode, status, reviewedBy, reviewedAt, reviewNote, createdAt
                  FROM st_admin_applications WHERE status = ${input.status} ORDER BY id DESC LIMIT 100`,
        ),
      )); // R7-c117-⑦：收编包裹器单点
      return {
        items: rows.map((r) => ({
          id: Number(r.id),
          username: String(r.username),
          phone: String(r.phone),
          displayName: String(r.displayName),
          reason: String(r.reason ?? ""),
          inviteCode: r.inviteCode == null ? null : String(r.inviteCode),
          status: String(r.status),
          reviewedBy: r.reviewedBy == null ? null : String(r.reviewedBy),
          reviewedAt: r.reviewedAt ? new Date(String(r.reviewedAt)).toISOString() : null,
          reviewNote: r.reviewNote == null ? null : String(r.reviewNote),
          createdAt: r.createdAt ? new Date(String(r.createdAt)).toISOString() : null,
        })),
      };
    }),

  /**
   * 审批：approve → 建账号 + 一次性初始密码（仅本响应出现一次，审批人转告申请人）；
   * reject → 落 reviewNote。双重检查：申请须 pending 且账号名未被占用。
   */
  review: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        applicationId: z.number().int().positive(),
        decision: z.enum(["approve", "reject"]),
        reviewNote: z.string().trim().max(300).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const admin = await requireAdmin(input.token);
      const reviewer = String((admin as { username?: string }).username ?? "admin");
      const rows = await guardInfra("[routers/adminAuth] review 查验失败", async () => rawRows(
        await getDb().execute(
          sql`SELECT id, username, phone, displayName, status FROM st_admin_applications
              WHERE id = ${input.applicationId} LIMIT 1`,
        ),
      )); // R7-c117-⑦
      const appl = rows[0];
      if (!appl) throw new TRPCError({ code: "NOT_FOUND", message: "申请不存在" });
      if (String(appl.status) !== "pending") {
        throw new TRPCError({ code: "CONFLICT", message: "该申请已审结" });
      }
      if (input.decision === "reject") {
        await guardInfra("[routers/adminAuth] review 驳回写回失败", async () => { // R7-c123-⑤：裸 UPDATE 裹单点——raw driver 错（内嵌 SQL+reviewer/reviewNote 绑定参数）不再绕脱敏链直泄客户端
          const rejected = rawRows(await getDb().execute(
            sql`UPDATE st_admin_applications
                SET status = 'rejected', reviewedBy = ${reviewer}, reviewedAt = NOW(), reviewNote = ${input.reviewNote ?? null}
                WHERE id = ${input.applicationId} AND status = 'pending'`,
          ));
          // R7-c132-④：驳回支对称验数——并发审结（他审先结）不再静默覆盖终态
          if (Number(rejected[0]?.affectedRows ?? 0) === 0) {
            throw new TRPCError({ code: "CONFLICT", message: APPLY_CONCURRENT_REVIEWED });
          }
        });
        return { ok: true as const, decision: "rejected" as const };
      }
      // approve：重名终检+开户+审结三写合一事务（R7-c131-④ bug low：非事务双写=INSERT 成/审结 UPDATE 败=
      //  账号已建而一次性初始密码永不回传（只随成功响应出现）+申请滞留 pending 且重试被重名闸挡=死锁态面封死；
      //  事务内终检=并发窗闭死——三写提交/回滚同生共死；审结 UPDATE 带 status='pending' 谓词=并发双审幂等闸）
      const initialPassword = genInitialPassword();
      const initialPasswordHash = hashPassword(initialPassword); // R7-c136-⑤ perf low：scryptSync 阻塞出事务窗——池连接+行锁不占 hashing 全程（事件循环同窗口不再阻塞）
      await guardInfra("[routers/adminAuth] review 开户审结事务失败", async () => {
        await getDb().transaction(async (tx) => {
          const dup = rawRows(await tx.execute(
            sql`SELECT id FROM st_admin_accounts WHERE username = ${String(appl.username)} LIMIT 1`,
          ));
          if (dup.length > 0) {
            throw new TRPCError({ code: "CONFLICT", message: "账号名已被占用，请驳回并注明" }); // 域内错误透传不裹（guardInfra 同纪律）+事务回滚
          }
          await tx.execute(
            sql`INSERT INTO st_admin_accounts (username, phone, passwordHash, displayName, role, disabled)
                VALUES (${String(appl.username)}, ${String(appl.phone)}, ${initialPasswordHash},
                        ${String(appl.displayName)}, 'admin', 0)`,
          );
          const approved = rawRows(await tx.execute(
            sql`UPDATE st_admin_applications
                SET status = 'approved', reviewedBy = ${reviewer}, reviewedAt = NOW(), reviewNote = ${input.reviewNote ?? null}
                WHERE id = ${input.applicationId} AND status = 'pending'`,
          ));
          // R7-c132-④ bug medium：幂等闸须验数——0 行命中=并发审结（他审已结）→ CONFLICT 抛回滚（开户随事务撤销——
          //  不再「申请 rejected 而账号已建」静默授权面；谓词不验数=闸空转面封死）
          if (Number(approved[0]?.affectedRows ?? 0) === 0) {
            throw new TRPCError({ code: "CONFLICT", message: APPLY_CONCURRENT_REVIEWED });
          }
        });
      }); // R7-c117-⑦/R7-c131-④：包裹器单点收编+事务化
      return {
        ok: true as const,
        decision: "approved" as const,
        username: String(appl.username),
        /** 一次性初始密码：仅此响应出现，请立即转告申请人并提醒首登改密 */
        initialPassword,
      };
    }),

  /** 自助改密：旧密码校验 + 重签 token（旧 token 吊销） */
  setPassword: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        oldPassword: z.string().min(1).max(128),
        newPassword: z.string().min(8, "新密码至少 8 位").max(128),
        totpCode: totpCodeInput.optional(), // 门禁 PR#9-r4-①：已启用 2FA 账号改密须过二要素（未启用不传）
      }),
    )
    .mutation(async ({ input }) => {
      // R7-c104-⑧/R7-c106-⑥/R7-c140-①→门禁 PR#9-r3-⑤：序幕四合归 requireNativeSession 单点（台账判决先行——
      //  行内清理降级窗内本端点是复活通道=假吊销面封死；查验 guardInfra 免双记+停用判+颁证白名单第二守点，
      //  helper 注释承诺的四端点同引在此兑现——「抄三份漏一份」面封死）
      const account = await requireNativeSession(input.token);
      if (!verifyPassword(input.oldPassword, account.passwordHash)) { // R7-c47-④：收窄后不再防御性强转（toAdminAccountRow 恒产非空 string）
        throw new TRPCError({ code: "UNAUTHORIZED", message: "原密码错误" });
      }
      // 门禁 PR#9-r4-① security medium：改密=重签 nt_ 的敏感凭据操作——已启用 2FA 账号须同口径过动态码
      //  （盗 token+旧密码即可轮换密码锁死真主的面封死；与 disable2fa 同构——原子认领+校验+消费回放闸）
      await run2faEnforced(account.id, input.totpCode, "setPassword 2FA", TFA_CODE_FAIL_MESSAGE); // 门禁 PR#9-r24-②：组合单点同引（话术归正口径不变——旧密码已过验无 oracle 要护）
      const newToken = newCredential("nt_");
      // R7-c39-⑩ security medium/R7-c111-④：写回包裹走 guardInfra 单点——Drizzle 错误内嵌 SQL+绑定参数（新 nt_ token+新密码 hash），
      //  tRPC 默认格式化逐字回显=泄密面封死（与同文件其余处理器同构——不手抄形态）
      await guardInfra("[routers/adminAuth] setPassword 写回失败", async () => {
        await getDb().execute(
          sql`UPDATE st_admin_accounts SET passwordHash = ${hashPassword(input.newPassword)}, authToken = ${authTokenHash(newToken)}
              WHERE id = ${account.id}`, // R7-c48-⑨：同上；P3-6 落库只存指纹
        );
      });
      return { ok: true as const, token: newToken };
    }),

  /** 七-d 2FA 登记：颁新密钥（已生效→先停用再重登记）；otpauth URL+密钥仅此响应出现一次（明文一次纪律）；
   *  门禁 PR#9-r9-⑦ security medium：密码复验在闸（泄露/借用 nt_ 不再够绑攻击者密钥——凭据轮换级操作同 setPassword 口径） */
  enroll2fa: publicQuery
    .input(z.object({ token: z.string().trim().min(1), password: z.string().min(1, "请输入密码").max(128) }))
    .mutation(async ({ input }) => {
      const account = await requireNativeSession(input.token); // 门禁 PR#9-r2-②③：会话闸单点（吊销/查验/停用/白名单一处）
      if (!verifyPassword(input.password, account.passwordHash)) throw new TRPCError({ code: "UNAUTHORIZED", message: LOGIN_FAIL }); // 门禁 PR#9-r9-⑦：密码复验（统一话术不泄账号态）
      const secret = newTotpSecret(); // 密钥生成先于写（明文一次纪律——响应外不落）
      // 先查后写改同事务 FOR UPDATE（门禁 PR#9-r5-② bug medium——check-then-write 竞态封死：并发 enroll/confirm
      //  不再从 SELECT→UPSERT 缝挤入覆盖已生效密钥；行锁串行化=「已生效行拦在 upsert 前」不变式原子兑现）；
      //  缺表 412 显因先于 500 掩码
      try {
        // 门禁 PR#9-r10-① bug low：缺钥判别挪进 try——形态错（非 64hex）不再裸抛于包裹外（进 catch 分类链显形）
        if (!totpEncKeyConfigured()) { // 门禁 PR#9-r9-④：判别归 totp 单点
          // 门禁 PR#9-r13-⑤：话术两态诚实——「明文入库」只在显式 dev/test 为真；生产/未设=紧随的 encryptSecretForStore 拒写（误导 triage 面封死）
          warnThrottled("adminAuth.2fa-enc-key-absent", "[routers/adminAuth] TOTP_SECRET_ENC_KEY 未配置——显式 dev/test 将明文入库；其余环境本 enroll 将被拒写（fail-closed）。上线检查单：必配本项（门禁 PR#9-r9-③/r13-⑥）");
        }
        // 门禁 PR#9-r9-⑤：加密一次两处绑定（双调=双 IV 各加一遍——冗余+误读面封死）；加密在事务外成值（纯件不占行锁窗）
        const storedSecret = encryptSecretForStore(secret);
        await getDb().transaction(async (tx) => {
          const existing = rawRows(await tx.execute(sql`SELECT enabled FROM st_admin_2fa WHERE account_id = ${account.id} FOR UPDATE`));
          if (existing[0] && coerceDisabledFlag(existing[0].enabled, "st_admin_2fa.enabled", "[routers/adminAuth]") === 1) throw new TRPCError({ code: "CONFLICT", message: "2FA 已生效——请先停用再重新登记" }); // 门禁 PR#9-r17-①/r18-②：域钉同引（域内抛在 try 内——catch 分类链掩码在位）
          await tx.execute(
            sql`INSERT INTO st_admin_2fa (account_id, secret_b32, enabled, last_step, enrolled_at)
                VALUES (${account.id}, ${storedSecret}, 0, NULL, NOW())
                ON DUPLICATE KEY UPDATE secret_b32 = ${storedSecret}, enabled = 0, last_step = NULL, enrolled_at = NOW(), verified_at = NULL, fail_count = 0, fail_since = NULL`, // 门禁 PR#9-r6-④/r8-⓪：重登记清节流列+静态加密单点（无钥明文=告警下行）
          );
        });
      } catch (e) {
        // 门禁 PR#9-r11-②④：分类归单点；缺表无论豁免与否=装表指引 412（enroll 是装表动作面——无豁免语义）
        if (isNoSuchTable(e)) {
          warnThrottled("adminAuth.2fa-enroll-notable", "[routers/adminAuth] enroll2fa 时 st_admin_2fa 未建——装表指引上行");
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: TFA_TABLE_MISSING_MESSAGE }); // 门禁 PR#9-r16-①：脚本路径常量同引
        }
        classify2faCatch(e, "enroll2fa 失败"); // TRPCError 透传/配置事故 412/余故障掩码 500
        throw e; // 型别兜底——exempt 结构性不可达（1146 已在上方拦截）；本行防「分类返 exempt 后漏写库照返密钥」事故级面
      }
      return {
        secret, // 仅此响应出现一次（请立即扫码/入钥匙串——库只留 base32 形态，本字段不落日志）
        otpauthUrl: `otpauth://totp/${encodeURIComponent(TOTP_ISSUER)}:${encodeURIComponent(account.username)}?secret=${secret}&issuer=${encodeURIComponent(TOTP_ISSUER)}&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}&algorithm=${TOTP_ALGORITHM.toUpperCase()}`, // 门禁 PR#9-r33-④ bug low：issuer 同过 encodeURIComponent——env 可覆后带空格/保留字的白标值不再产畸形 otpauth URI // 门禁 PR#9-⑤/r2-⓪：协议参数+算法同引 totp 常量单源（URI 大写形态派生）
      };
    }),

  /** 七-d 2FA 确认启用：首个动态码验真（防登记错钥）；生效起点=消费当前步长（回放闸同步起闸）；
   *  门禁 PR#9-r9-⑦ security medium：密码复验在闸（确认=密钥启用点——泄露 token 不够，还须本人口令） */
  confirm2fa: publicQuery
    .input(z.object({ token: z.string().trim().min(1), code: totpCodeInput, password: z.string().min(1, "请输入密码").max(128) })) // 形状钉单点+密码复验同 enroll 口径
    .mutation(async ({ input }) => {
      const account = await requireNativeSession(input.token); // 门禁 PR#9-r2-②③：会话闸单点
      if (!verifyPassword(input.password, account.passwordHash)) throw new TRPCError({ code: "UNAUTHORIZED", message: LOGIN_FAIL }); // 门禁 PR#9-r9-⑦：密码复验（统一话术不泄账号态）
      // 门禁 PR#9-r13-④ bug medium 重排：读→验（纯件）→认领→条件写——配置事故/密文腐化在认领前抛=故障不烧锁定预算；
      //  错码=认领计次后拒（自治提交不回吞，PR#9-r7-①）；密钥同一性进写句守卫（secret_b32 条件——并发 enroll 轮换
      //  不再「启用用户从未见过的密钥」（r6-① 面由条件写锁死，FOR UPDATE 长事务退役——行锁窗归零）
      const rr = await guardInfra("[routers/adminAuth] confirm2fa 查验失败", () =>
        read2faRow(sql`SELECT secret_b32, enabled, verified_at FROM st_admin_2fa WHERE account_id = ${account.id} LIMIT 1`)); // 缺表政策单点同引（判别联合）
      // 门禁 PR#9-r30-③：豁免态=装表指引 412（与 enroll 同族——豁免环境不再报「无待确认」误导）；真无行=CONFLICT
      if (rr.kind === "exempt") throw new TRPCError({ code: "PRECONDITION_FAILED", message: TFA_TABLE_MISSING_MESSAGE });
      if (rr.kind !== "ok") throw new TRPCError({ code: "CONFLICT", message: "无待确认的 2FA 登记（未登记或已生效）" });
      const rec = rr.row;
      // 门禁 PR#9-r18-④ security medium：域钉裹 guardInfra——裸调抛的 Error 带表/列名诊断会逐字透给调用方（无自定义
      //  errorFormatter 仓情）；掩码 500+服务端留痕=fail-closed 显形且不外泄
      const recEnabled = await guardInfra("[routers/adminAuth] confirm2fa enabled 域钉", async () => coerceDisabledFlag(rec.enabled, "st_admin_2fa.enabled", "[routers/adminAuth]")); // r17-①：域钉同引
      // 门禁 PR#9-r17-⓪ security medium：verified_at 非空=软停/重置过的旧行——不再当「待确认」放行（旧密钥复活闸封死：
      //  持旧密钥者交旧码即把 enabled 置回 1=绕过 enroll 颁新钥面）；停用后须 enroll 重颁（upsert 置 verified_at=NULL 全新登记）
      if (recEnabled === 1 || (rec.verified_at !== null && rec.verified_at !== undefined)) { // 门禁 PR#9-r19-②：显式括号——复活闸语义不押隐式优先级（追加条件静默翻面封死）
        throw new TRPCError({ code: "CONFLICT", message: "无待确认的 2FA 登记（已生效/已停用——停用后须重新 enroll 颁新密钥，旧密钥不复活）" });
      }
      // 门禁 PR#9-r20-②：行映射归 map2faRow 单点（缺值钉随行——String(null)="null" 字面量不再流入校验/写句）；
      //  confirm 不取 last_step 列——映射内缺值即 null（新登记无已消费步语义不变，r5-⓪ 口径）
      const recMapped = await guardInfra("[routers/adminAuth] confirm2fa 行映射失败", async () => map2faRow(rec));
      // 校验序列归 verify2faCode 单点（门禁 PR#9-r14-③——解密→验→认领→败拒政策不再两处各写）
      const s = await verify2faCode(account.id, { secretStored: recMapped.secretStored, lastStep: null }, input.code, "confirm2fa", TFA_CODE_FAIL_SETUP_MESSAGE);
      // 生效写回带三条件（enabled=0 待确认态+secret_b32 同一性+last_step 高水位不退）——并发双确认/密钥轮换/旧窗回写
      //  全拿 0 行=CONFLICT 显形（门禁 PR#9-r5-⑥/r6-① 合流）
      const applied = await guardInfra("[routers/adminAuth] confirm2fa 生效写回失败", async () => rawRows(
        await getDb().execute(
          sql`UPDATE st_admin_2fa SET enabled = 1, verified_at = NOW(), last_step = ${s}, fail_count = 0
              WHERE account_id = ${account.id} AND enabled = 0 AND verified_at IS NULL AND secret_b32 = ${recMapped.secretStored} AND (last_step IS NULL OR last_step < ${s})`, // 门禁 PR#9-r20-②：写句密钥同一性同引映射单点（钉后值=被验值） // 门禁 PR#9-r17-⓪：verified_at IS NULL 进写句守卫（软停行复活面行级锁死）
        ),
      ));
      if (Number(applied[0]?.affectedRows ?? 0) === 0) throw new TRPCError({ code: "CONFLICT", message: "登记已被并发确认或密钥已轮换——请刷新后核对" });
      return { ok: true as const };
    }),

  /** 七-d 2FA 应急重置（门禁 PR#9-r14-⑥ other low）：super 专属——管理员丢/换验证器=全 2FA 面永久锁死面的破窗通道；
   *  软停留痕（登记/确认史不删）+审计钉（敏感动作留 st_user_audit——谁重置了谁可查）；目标账号停用行/无登记=CONFLICT 显形 */
  reset2fa: publicQuery
    .input(z.object({ token: z.string().trim().min(1), accountId: z.number().int().positive(), password: z.string().min(1, "请输入密码").max(128), totpCode: totpCodeInput.optional() })) // 门禁 PR#9-r16-⓪/r21-④：密码复验+本人 2FA 码（已启用者）
    .mutation(async ({ input }) => {
      const actor = await requireNativeSession(input.token);
      if (!verifyPassword(input.password, actor.passwordHash)) throw new TRPCError({ code: "UNAUTHORIZED", message: LOGIN_FAIL }); // 门禁 PR#9-r16-⓪ security low：破窗通道须本人复验——泄露的 super token 单件不再够拆他人 2FA
      if (!isSuperRole(actor.role)) throw new TRPCError({ code: "FORBIDDEN", message: "仅超级管理员可重置他人二次验证" });
      // 门禁 PR#9-r22-⓪ bug low：零成本入参判全数挪 2FA 消费前——自靶打错 id 不再白烧当前窗码（高水位被误推面封死）
      if (input.accountId === actor.id) throw new TRPCError({ code: "BAD_REQUEST", message: "自助停用请走 disable2fa（须动态码+密码双证）——本端点只重置他人" });
      // 门禁 PR#9-r21-④ security medium：本端点权级高于 setPassword/disable2fa（拆他人二要素）——actor 自身已启用 2FA 时
      //  须同口径过本人动态码（super token+密码双泄仍不够——第三件在场证明）；消费步长归 consume2faStep 单点
      await run2faEnforced(actor.id, input.totpCode, "reset2fa actor 2FA", TFA_CODE_FAIL_MESSAGE); // 门禁 PR#9-r24-②：组合单点同引（actor 未启用=直返 false 不拦）
      const done = await guardInfra("[routers/adminAuth] reset2fa 软停失败", async () => rawRows(
        await getDb().execute(
          sql`UPDATE st_admin_2fa SET enabled = 0, last_step = NULL, fail_count = 0, fail_since = NULL WHERE account_id = ${input.accountId} AND enabled = 1`,
        ),
      ));
      if (Number(done[0]?.affectedRows ?? 0) === 0) throw new TRPCError({ code: "CONFLICT", message: "该账号当前无生效中的 2FA（未启用/已停用）" });
      // 审计钉（敏感动作——fire-and-forget 不阻塞主链，userAudit 纪律）
      // 门禁 PR#9-r15-⓪ bug medium：user_id 系 wb 空间键——原生席裸 id 撞 wb 同号（stats24h 聚合叠人面）；
      //  走 wbThreadUserId 分带单点（原生带经 adminOrigin 判别——authLock 同口径），operatorOrigin 消歧留底
      auditUserAction({ userId: wbThreadUserId({ id: actor.id, adminOrigin: "native" }), userName: actor.username, action: "admin.2fa.reset", targetType: "admin_account", targetId: input.accountId, detail: { operatorOrigin: "native", note: "super 应急重置 2FA（软停——史不删）" } });
      return { ok: true as const };
    }),

  /** 七-d 2FA 停用：须持当前动态码+密码双证（停用=逆向操作同敏级——门禁 PR#9-r11-③：泄露 token+被看中继的当前码不再够拆 2FA）；
   *  软停留痕（门禁 PR#9-r2-④——登记/确认史不删） */
  disable2fa: publicQuery
    .input(z.object({ token: z.string().trim().min(1), code: totpCodeInput, password: z.string().min(1, "请输入密码").max(128) })) // 门禁 PR#9-r2-⑥/r11-③：形状钉+密码复验
    .mutation(async ({ input }) => {
      const account = await requireNativeSession(input.token); // 门禁 PR#9-r2-②③：会话闸单点
      if (!verifyPassword(input.password, account.passwordHash)) throw new TRPCError({ code: "UNAUTHORIZED", message: LOGIN_FAIL }); // 门禁 PR#9-r11-③：密码复验（统一话术不泄账号态）
      const rr = await guardInfra("[routers/adminAuth] disable2fa 查验失败", () =>
        read2faRow(sql`SELECT secret_b32, last_step, enabled FROM st_admin_2fa WHERE account_id = ${account.id} LIMIT 1`)); // 门禁 PR#9-r5-⑤/r30-③：判别联合同引
      if (rr.kind === "exempt") throw new TRPCError({ code: "PRECONDITION_FAILED", message: TFA_TABLE_MISSING_MESSAGE }); // 豁免环境装表指引（与 enroll 同族——不再「未启用」误导）
      if (rr.kind !== "ok") throw new TRPCError({ code: "CONFLICT", message: "该账号未启用 2FA" });
      const rec = rr.row;
      // 门禁 PR#9-r18-②：域钉归队（r17 只落了 load2fa/confirm——本径 Number()!==1 会把域外漂移静默当未启用 409=漂移无告警面）；
      //  guardInfra 裹——裸 Error 带 schema 诊断不逐字回显客户端（r18-④ 同纪律）
      const recEnabled = await guardInfra("[routers/adminAuth] disable2fa enabled 域钉", async () => coerceDisabledFlag(rec.enabled, "st_admin_2fa.enabled", "[routers/adminAuth]"));
      if (recEnabled !== 1) throw new TRPCError({ code: "CONFLICT", message: "该账号未启用 2FA" });
      const tfa = await guardInfra("[routers/adminAuth] disable2fa 行映射失败", async () => map2faRow(rec)); // 门禁 PR#9-r19-③：缺值钉抛点裹住（schema 诊断不裸泄）
      await verify2faCode(account.id, tfa, input.code, "disable2fa", TFA_CODE_FAIL_MESSAGE); // 门禁 PR#9-r11-⑦：行映射单点同引（解密在 helper 包裹内）；验真即可——软停写句 last_step=NULL 不消费步长；码错给码话术非 LOGIN_FAIL（r14-⑤ 陈旧注释归正：本端点已有密码复验——无未认证 oracle 要护）
      // 门禁 PR#9-r2-④ security 史观：软停不删行——enrolled_at/verified_at/失败计数留痕可查（谁何时开过 2FA=审计面；
      //  与 setDisabled/吊销台账同纪律）；重登记径=enroll upsert 覆盖（软停行 enabled=0 不拦）
      const done = await guardInfra("[routers/adminAuth] disable2fa 软停写回失败", async () => rawRows(
        await getDb().execute(sql`UPDATE st_admin_2fa SET enabled = 0, last_step = NULL, fail_count = 0, fail_since = NULL WHERE account_id = ${account.id} AND enabled = 1`), // 门禁 PR#9-r33-⑥：行态守卫
      ));
      // 门禁 PR#9-r36-⑦ bug low：软停验数——0 行=读后再被并发翻转/重置=状态冲突显形（不再闷答 ok:true——
      //  consume2faStep/reset2fa 同纪律；行态守卫+验数双件合拢）
      if (Number(done[0]?.affectedRows ?? 0) === 0) throw new TRPCError({ code: "CONFLICT", message: "该账号 2FA 状态已变化（并发操作）——请刷新后重试" });
      return { ok: true as const };
    }),

  /** 停用/启用（requireAdmin；super 不可停用防自锁） */
  setDisabled: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        accountId: z.number().int().positive(),
        disabled: z.boolean(),
      }),
    )
    .mutation(async ({ input }) => {
      await requireAdmin(input.token);
      const rows = await guardInfra("[routers/adminAuth] setDisabled 查验失败", async () => rawRows(
        await getDb().execute(
          sql`SELECT id, role FROM st_admin_accounts WHERE id = ${input.accountId} LIMIT 1`,
        ),
      )); // R7-c117-⑦
      const target = rows[0];
      if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "账号不存在" });
      if (input.disabled && isSuperRole(target.role)) { // R7-c81-②：判别走谓词单源（utf8mb4_ci 对齐——与 authLock 防自锁闸同引不漂移）
        throw new TRPCError({ code: "FORBIDDEN", message: "超管账号不可停用" });
      }
      await guardInfra("[routers/adminAuth] setDisabled 写回失败", async () => {
        await getDb().execute(
          input.disabled
            ? sql`UPDATE st_admin_accounts SET disabled = 1, authToken = NULL WHERE id = ${input.accountId}`
            : sql`UPDATE st_admin_accounts SET disabled = 0 WHERE id = ${input.accountId}`,
        );
      }); // R7-c117-⑦
      return { ok: true as const, accountId: input.accountId, disabled: input.disabled };
    }),

  /** 账号列表（requireAdmin；脱敏无 hash） */
  accounts: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      await requireAdmin(input.token);
      const rows = await guardInfra("[routers/adminAuth] accounts 查验失败", async () => rawRows(
        await getDb().execute(
          sql`SELECT id, username, phone, displayName, role, disabled, lastLoginAt, createdAt
              FROM st_admin_accounts ORDER BY id ASC LIMIT 200`,
        ),
      )); // R7-c117-⑦
      return {
        items: rows.map((r) => ({
          id: Number(r.id),
          username: String(r.username),
          phone: r.phone == null ? null : String(r.phone),
          displayName: String(r.displayName),
          role: String(r.role),
          disabled: Number(r.disabled) === 1,
          lastLoginAt: r.lastLoginAt ? new Date(String(r.lastLoginAt)).toISOString() : null,
          createdAt: r.createdAt ? new Date(String(r.createdAt)).toISOString() : null,
        })),
      };
    }),
});
