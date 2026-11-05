/**
 * requireAdmin 单源（批七-c R7-c23-② security medium 收口）：admin.ts/terminal.ts 双副本合一——
 *  吊销上提+分派前判决+产线取行+委派/原生回退全链只此一处（安全闸双副本分歧=缺口根源，钉死不再分叉）。
 * 钉注：
 * - ADMIN_DELEGATE_USERNAMES 迁移本层（原 terminal.ts——委派名单即策略，与闸同层）；R7-c76-⑨：terminal.ts 仅再出口 requireAdmin（名单不再出口——无外部 import 依赖，注不谎称再出口）；
 * - 现依赖边实况（R7-c52-⑥）：adminAuth → adminGate + nativeAdmin + queries/rawRows（不经 terminal）；terminal 只是再出口——环早已不存在；
 * - rejected 语义（R7-c23-③）：wb_users admin 行形状闸不过（disabled/空 hash/厂号非法）即硬 401 不落入回退支
 *   （停用不给复活通道——旧支内即拒语义）；role!=="admin" 行照常 invalid 走回退（同旧口径）。
 */
import { sql } from "drizzle-orm";
import { authTokenHash, authTokenPlaintextGuard } from "./revocation"; // P3-6 落库哈希单点+明文腿守卫（去重合并）
import { HQ_COMPANY_NAME_DEFAULT } from "@contracts/constants"; // R7-c105-②：公司名缺省值单源同引
import { normalizeCiText } from "@contracts/authLock"; // R7-c136-②：归一化单点同引（委派归集缺名判——大小写/口音/空白同值）
import { TRPCError } from "@trpc/server";
import { getDb } from "../queries/connection";
import { rawRows, logQueryErrorThrottled, warnThrottled, renderLogValue } from "../queries/rawRows"; // 仓级 canonical 单点+脱敏链+良性告警节流单点同引（R7-c84-②③）
import { assertNotRevoked, authenticateAdmin, resolveRevocation, ADMIN_REQUIRED_MESSAGE, INFRA_UNAVAILABLE_MESSAGE, infraError500, isDelegatedSeat, throwForAdminAuthFailure, isNoSuchTable, type SafeWbUser, type RevocationVerdict } from "./identity"; // R7-c56-②/R7-c78-④/R7-c80-④/R7-c98-③/R7-c99-⑤：同模块单条 import（仓规）——映射单点+判别判决型+缺表判别+403 泛词同引（委派支缺表降级在消费——旧注释「不再消费」尾巴摘除）
import { findNativeAdminByToken, coerceFiniteId, coerceDisabledFlag, coerceNonEmptyString, isHeadRole, isAdminWhitelistedRole } from "./nativeAdmin"; // R7-c87-⑧：head 判别谓词同引 // R7-c24-①/R7-c40-⑥/R7-c62-⑥/R7-c72-③/R7-c82-⑩/R7-c83-⑦：原生查验+字段闸+域闸+非空串闸+角色判别谓词群共享单点同层直引

// R7-c74-④/R7-c84-②③：时限节流走共享单点 warnThrottled（rawRows）——本地旗组退役（手写节流三处漂移面封死）

/** 委派授予拒绝诊断道（R7-c34-①/R7-c76-⑧/R7-c100-④/R7-c139-⑤ 收口定论）：raw 值在场性先于强转——但漂移只授不夺：
 *  委派支只能【授予】委派权限（失败/漂移绝不授权任何人）；诊断道专用——无标记回流（R7-c121-④：返型收窄 void，
 *  三调用点全弃返回值=死面摘除防误读）；命中行漂移=委派席健康未实证，调用点直抛 500 留会话（不 401 踢活席；
 *  委派行命中后原生支与本席无关，不绕弯）；留痕走脱敏节流链（透因进 triage 不丢——delegate.id 非整数/NaN 等具体因） */
function delegateDrift(reasonTag: string, e: unknown): void {
  // R7-c139-⑤：形参系【因标签】非字段名（coerceDelegateRow/role-unreachable）——措辞对齐实况（真字段标签在原始错误消息里；
  //  旧「委派行 ${field} 非法（schema 漂移）」会把判决分歧误报成列漂移——triage 找不存在的列=误导面封死）
  logQueryErrorThrottled(`[auth/adminGate] 委派授予拒绝（因=${reasonTag}）——命中行不可信/判决分歧，调用点直抛 500 留会话（不走原生支）`, e); // R7-c102-⑥：日志对齐实况（漂移行不降级不短路——triage 不再被误导）
}

/** 委派/原生合成身份（治理席回退支产物）：无 factoryId 等 wb_users 列——R7-c24-② 联合类型钉死，
 *  消费端读 wb_users 专有列须先判 delegated 在场（旧 as unknown as WbUser 全关类型检查，admin.factoryId 静默 undefined 曾破「不能禁用本厂」守护） */
interface DelegatedBase {
  readonly id: number;
  readonly username: string;
  readonly displayName: string;
  readonly role: "admin";
  readonly delegated: true;
}
/** 治理席合成身份（R7-c84-⑤ maintainability medium 收口）：判别联合——原生席 adminOrigin 必填（构造端漏标即编译红，
 *  wbThreadUserId 错带落 staff 段=撞号面复活的「注释自律」面升级为编译期闸）；委派席显式无标记 */
export type DelegatedAdminIdentity =
  | (DelegatedBase & { readonly adminOrigin: "native" })   // 原生超终席（st_admin_accounts 序列 → +2e12 带）
  | (DelegatedBase & { readonly adminOrigin?: undefined }); // 委派席（st_staff_accounts 序列 → +1e12 带）

/** 平台账号治理席谓词（R7-c42-⑪）：wb 行 vs 委派/原生合成身份的判别单点——"delegated" in admin 手写判定不双抄
 *  （撞号面消费端经本谓词——新增站点不再自己写 in 判定漂移） */
export function isPlatformAdmin(admin: SafeWbUser | DelegatedAdminIdentity): admin is SafeWbUser { // R7-c45-③/R7-c65-⑧：值语义对齐 isDelegatedSeat（delegated:false 两谓词不再分歧——键在性 vs 值判定漂移面封死）
  return !isDelegatedSeat(admin);
}

/** 超级终端限定话术单源（R7-c83-⑧）：HQ 闸 401 显因——内联字面量不再散（requireHqAdmin 同引） */
// R7-c95-⑤/R7-c98-④/R7-c99-④：调用时读 env（与 hqFactoryIds/adminDelegateUsernames 同政策——模块载入期读=热修滞后面封死）；
//  公司名走 HQ_COMPANY_NAME（缺省=现值行为零变化，测试断言不破）；零外部消费不出口（幻影出口不养）
function hqTerminalOnlyMessage(): string {
  return `超级终端仅对${process.env.HQ_COMPANY_NAME || HQ_COMPANY_NAME_DEFAULT}开放`; // R7-c105-②/R7-c121-⑧：缺省值走 contracts 单源——空串亦回落（模板行 HQ_COMPANY_NAME= 不再出「仅对开放」半句）
}

/** 委派行校验+取值单源（R7-c129-⑧ maintainability）：授予判决（judgeDelegateRow/isGrantableDelegateRow）与闸侧授予取值同出本点——
 *  双轨各校验=单侧改动静默改写授予面/漂移归因面封死；throws 错误消息自带字段标签（delegate.* 系 nativeAdmin 字段闸构造——
 *  闸侧透因留痕直用）；停用（disabled===1 合法域否定）不抛——由调用方判（闸侧 401/boot 报告不授予列） */
function coerceDelegateRow(r: Record<string, unknown>): { id: number; username: string; displayName: string; disabled: 0 | 1 } {
  const id = coerceFiniteId(r.id, "delegate.id", 1, "[auth/adminGate]"); // R7-c124-⑥：tag 补全——漂移归因本文件（默认 [auth/nativeAdmin] 标签会把 st_staff_accounts 值误记到 st_admin_accounts 道）
  const username = coerceNonEmptyString(r.username, "delegate.username", "[auth/adminGate]"); // 同上
  const displayName = coerceNonEmptyString(r.displayName, "delegate.displayName", "[auth/adminGate]"); // 同上
  const disabled = coerceDisabledFlag(r.disabled, "delegate.disabled", "[auth/adminGate]"); // 同上
  return { id, username, displayName, disabled };
}

/** 委派授予判决单源（R7-c135-③ maintainability）：闸侧运行期授予与 boot 委派报告同判决——typed reason 分出
 *  「不授予」因（drift=字段漂移/disabled=停用/role=非 head），运行期按因分流（401/500+透因留痕）不再内联重推；
 *  谓词 isGrantableDelegateRow 即本判决的布尔投影（report 与闸锁死=同函数） */
type DelegateJudgment =
  | { grant: true; id: number; username: string; displayName: string }
  | { grant: false; reason: "disabled" }
  | { grant: false; reason: "role" }
  | { grant: false; reason: "drift"; error: unknown };
function judgeDelegateRow(r: Record<string, unknown>): DelegateJudgment {
  try {
    const d = coerceDelegateRow(r);
    if (d.disabled === 1) return { grant: false, reason: "disabled" };
    if (!isHeadRole(r.role)) return { grant: false, reason: "role" };
    return { grant: true, id: d.id, username: d.username, displayName: d.displayName };
  } catch (e) {
    return { grant: false, reason: "drift", error: e };
  }
}

/** 委派授予谓词单源（R7-c114-⑤/R7-c116-③/R7-c135-③）：boot 委派报告同引——判决即 judgeDelegateRow 布尔投影
 *  （head 角色+id≥1+disabled=0+username/displayName 非空；漂移即不授予——fail-closed 与闸同口径）；本谓词纯判不记 */
function isGrantableDelegateRow(r: Record<string, unknown>): boolean { // R7-c139-④：零外部消费实证摘出口（boot 经 collectDelegateBindings 间接消费——幻影出口不养）
  // R7-c117-⑤/R7-c118-③/R7-c129-⑧/R7-c135-③ bug medium：死条件摘除+停用 fail-closed——判决单源（judgeDelegateRow）投影；
  //  校验+取值走 coerceDelegateRow（与闸侧授予取值一体——双轨漂移面封死）
  return judgeDelegateRow(r).grant;
}

/** 全域吊销权谓词单源（R7-c80-② security medium）：wb 平台 admin 或原生超终席（adminOrigin==="native"）才持——
 *  委派 staff 席（COO/CMO 读救通道）不持全域吊销权；authLock.revoke 同引——内联复合表达式漂移/重构=未授权批量踢会话原语面封死 */
export function canRevokeTokens(admin: SafeWbUser | DelegatedAdminIdentity): boolean {
  return isPlatformAdmin(admin) || admin.adminOrigin === "native";
}

// R7-c65-⑦/R7-c66-④/R7-c83-⑪：isDelegatedSeat 上收 identity 叶——再出口零消费实证摘除（全仓直引 identity——幻影出口不养）


/** P-ID-SPACE 挂账钉（R7-c56-⑤）：委派/原生治理席的 id 属 st_staff/st_admin 序列，与 wb_users.id 撞号——
 *  治理席线程归属闸（assertWbRowIdentity/assertActorWbRow）曾据此硬拒治理席写 wb 空间线程，但那是彭总/COO 的 nt_ 在产面
 *  （产品回归）——全撤恢复在产行为；撞号面归挂账 P-ID-SPACE（收口方案：st_staff_chat_threads 命名空间分表/品牌 WbUserId 型，
 *  待彭总定）；现存消费端不经判别直读 admin.id 写 wb 空间表的已知面：evo/opsCenter/skillShop/walletPay/wbBilling 的
 *  writeAdminAudit 与各 userId 写入点（~15 处） */

/** 委派管理员名单（迭代 39/M65 期定的治理读救通道）：来源=部署面 env ADMIN_DELEGATE_USERNAMES（逗号分隔）——
 *  R7-c24-⑦/R7-c35-④ security 收口：来源名单收敛到 env（生产唯一口径）；
 *  诚实钉：仓内存量字面量待清理挂账（测试夹具已脱敏为假账号；dist/ 被追踪旧产物仍内嵌旧名单——dist 清理归 P-DIST-PII 专项，生产部署走 CD-1 本地构建不受影响）；
 *  调用时读 env（不缓存——配置热修/测试钉同 hqFactoryIds 口径）；未配=空名单（委派支整支关闭，fail-closed 不静默——
 *  登录主链 wb_users/原生支不受影响；上线检查单：CD-1 /etc/nebula-secrets/nebula.env 已配）。
 *  ⚠️ 仓内历史真名账号已留 git 史——轮换账号另行安全治理（P-DELEGATE-PII） */
/** CSV 环境列表解析步单点（R7-c127-①）：split→trim→滤空——adminDelegateUsernames/hqFactoryIds 同引
 *  （空白/空项处理口径漂移=委派白名单静默变形面封死）；调用时读 env 政策归调用方（本助手不缓存） */
function splitEnvList(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function adminDelegateUsernames(): readonly string[] { // R7-c84-④→R7-c108-②：boot 委派绑定报告成真消费端——再出口恢复（报告与闸同源锁步）
  // R7-c106-⑤ security low 登记：委派权限绑【可变 username】——名单内 head 账号被删+同名新建=新号静默继承全域委派权（按名继承特权面）；
  //  纪律：名单内用户名绝不回收复用（删号即退役其名）；演进向不可变绑定（账号 id/委派标记列）挂账 P-DELEGATE-IDBIND
  return splitEnvList("ADMIN_DELEGATE_USERNAMES"); // R7-c127-①：CSV 解析步共享单点（trim/空项口径双处锁步——单侧变体漂移面封死）
}

/**
 * 管理员鉴权：吊销台账分派前判决 → wb_users admin 产线（取行+disabled+passwordHash+品牌一次做完）→
 * 委派回退（名单内 head staff）→ M64 超终原生回退（st_admin_accounts，nt_ token）。
 * 迭代 39：委派回退——持名单内 staff token 放行，displayName 标注「委派管理员」留痕。
 * M65：导出供回归闸直测（nt_ 踢出事故修复的集成验证），行为零变化。
 */
export async function requireAdmin(token: string, out?: { verdict?: RevocationVerdict }): Promise<SafeWbUser | DelegatedAdminIdentity> { // R7-c45-③/R7-c102-①：wb 支凭据列不出闸；out 袋带回吊销判决（双轨端点复用——每请求吊销查询恒一次不变式回补）
  // R7-c19-①/R7-c21-①/R7-c23-② security high 收口：吊销查验上提+三支分派前统一判决——wb_users/委派 staff/超终原生（st_admin_accounts）凭证全盖
  //  （旧闸只挂 admin 支，revoked 凭证经回退支拿全量权限=缺口；infra 失败回退支不再静默放过）；ER_NO_SUCH_TABLE 降级不 500（表未建=无吊销可存）
  const rev = await resolveRevocation(token); // 品牌判别结果下传产线复用——每请求吊销查询恒一次
  if (out) out.verdict = rev; // R7-c102-①：出参袋（调用方同请求复用——探针/员工轨不再重查）
  await assertNotRevoked(token, rev); // 分派前统一出口：revoked→401 / ledger_unavailable→500 显因
  // R7-c22-②/R7-c23-③：wb_users admin 支产线一次做完（取行+闸+品牌）；rejected（admin 行被形状闸拒）硬 401 不落回退支
  //  （R7-c79-x：db 死声明摘除——委派查询随治理席单点内聚 getDb 直调）
  const r = await authenticateAdmin(token, rev);
  if (r.ok) return r.row;
  // R7-c56-②/R7-c68-③/R7-c78-④：非 ok 非 invalid 全走映射单点 throwForAdminAuthFailure（rejected→401 ADMIN_REQUIRED 硬拒；
  //  revoked/ledger 正常由上方 assertNotRevoked 独判到不了这里——漏达也按单点显因封死，绝不静默落入回退支；
  //  invariant 活性钉=adminGate.test「台账 infra 失败→500 不折叠 401」用例；r.reason 过了本行只剩 invalid）
  if (r.reason !== "invalid") throwForAdminAuthFailure(r);
  // R7-c99-②→回退（四套件反向钉实证）：requireAdmin 的 invalid→401 系全仓既有契约（approvals/wbBilling/streamChat/authLock
  //  反向钉——admin 端点非 admin 恒 401、跨厂隔离载其上行）；cabinGate 403 留页系写闸新场景刻意分支（其头注载明）——
  //  两闸不锁步系【分场景刻意】，本 PR 不改 requireAdmin 产线在产行为（rowFound 子态供 cabinGate 等写闸消费）

  // 第二层+第三层：治理席回退（委派 staff + 超终原生）走单点（R7-c79-x——cabinGate 活席复核/staffTrack 探针治理席臂同源不双抄）
  const seat = await governanceSeatFallback(token, rev); // R7-c80-④：verdict 复用（台账零重查）
  if (seat) return seat;
  throw new TRPCError({ code: "UNAUTHORIZED", message: ADMIN_REQUIRED_MESSAGE });
}

/** 治理席回退支单点（R7-c79-x）：委派 staff + 超终原生两支——requireAdmin 回退位/cabinGate 活席复核/staffTrack 探针三方同引；
 *  不调吊销台账/wb（调用方上游已判——复核零重复查询，R7-c78 轮 perf 罚单收口）；返 null=两支全灭（无命中）；
 *  只授不夺，双路分立（R7-c98-③/R7-c100-④ 定论）：委派【查询】失败→降级无命中续走原生支（末位 delegateDown 500 留会话——
 *  不 401 误踢、不短路 nt_ 原生回退）；命中行字段【漂移】→ 直抛 500 留会话（委派行命中后原生支与本席无关——不绕弯）；
 *  两路都不授权半截身份（M65 事故类面封死） */
export async function governanceSeatFallback(token: string, verdict?: RevocationVerdict): Promise<DelegatedAdminIdentity | null> { // R7-c79-x：cabinGate/staffTrack 同引出口
  // R7-c80-④⑤ security medium：台账判决内置——但【授前判】不【入场判】：先探席位表再判吊销——四表皆空=死会话与台账无关
  //  （台账 infra 抖动时「谁都无行」的纯死 token 不被 500 压住 401 清会话——actor 测试钉）；席位命中才在授予前过台账
  //  （吊销治理席=死——台账命中即死契约不破）；verdict 传入即复用（品牌+指纹双验零重查），不传自查（staffTrack 探针臂）
  // 委派回退——指定 COO/CMO 负责人账号持 staff token
  // R7-c24-⑨/R7-c25-①：名单调用时读 env（函数口径）；空名单（未配 env）短路——sql.join([]) 会渲出 IN () 语法错
  const delegates = adminDelegateUsernames();
  const delegateIds = adminDelegateIds(); // R7-c131-⑤：不可变 id 键通道同读（双轨并集——名单全空=通道关闭）
  if (delegates.length === 0 && delegateIds.length === 0) { // R7-c29-⑥/R7-c74-④/R7-c84-②/R7-c131-⑤：双名单全空=委派读救通道静默关闭——共享节流单点（窗内一次；勿只靠部署检查单）
    warnThrottled("adminGate.delegate-env", "[auth/adminGate] ADMIN_DELEGATE_USERNAMES/ADMIN_DELEGATE_IDS 均未配置——委派治理读救通道整支关闭（fail-closed；上线检查单 CD-1 secrets）");
  }
  // R7-c79-① 仓规：async/await 不混 Promise 链（.catch 手法退役——`rawRows(await ...catch(...))` 优先级误读面+风格混用面同收）
  let staffRows: Array<Record<string, unknown>> = [];
  let delegateDown = false; // R7-c98-③ bug medium：委派支非缺表故障显式记账——瞬时故障不再折叠成 401 误踢委派席（末位 500 留会话）
  if (delegates.length > 0 || delegateIds.length > 0) {
    try {
      staffRows = rawRows(
        await getDb().execute(
          // R7-c124-⑤/R7-c131-⑤ security medium 收口：委派身份双键并集——可变 username 轨（过渡）+不可变 id 轨
          //  （P-DELEGATE-IDBIND 落地件：id 命中即免疫删号重建同名继承——新号 id 不同不命中；username 轨残余面：
          //   运维纪律（删名单账号先摘名单/其名退役不复用）+boot 报告留痕照旧）；双名单并集=OR 语义
          sql`SELECT ${sql.raw(DELEGATE_ROW_COLS)} FROM st_staff_accounts
              WHERE (authToken = ${authTokenHash(token)} OR (authToken = ${token} AND ${authTokenPlaintextGuard()})) AND ${delegateKeyCond(delegates, delegateIds)}
              LIMIT 1`, // R7-c137-②：投影列单点同引
        ),
      );
    } catch (e) {
      // R7-c72-④/R7-c98-③ 两轮收口：缺表（1146 pre-migration 良性）→ 降级「无委派命中」（原生回退不短路，良性道节流告警）；
      //  其余故障（transient infra/列漂移）→ 记 delegateDown 继续走原生支——委派支只授不夺（失败绝不授权任何人）；
      //  原生支也未中时末位 500 显因（M65：委派席不被瞬时故障 401 清会话误踢）；原始 Drizzle 错误不裸传——脱敏节流留痕
      if (isNoSuchTable(e)) {
        warnThrottled("adminGate.delegate-notable", "[auth/adminGate] st_staff_accounts 未建——委派支降级无命中（pre-migration 良性；原生回退不短路）");
      } else {
        delegateDown = true; // 只记账不 return——控制流继续走原生支（缺表/故障都不短路 nt_ 原生回退）
        // R7-c104-①：1146 良性道不再双通道（incident 道只在真故障记——「infra/漂移」标签不误标良性缺表，triage 不被污染）
        logQueryErrorThrottled("[auth/adminGate] 委派支查验失败（infra/漂移——继续走原生支；原生未中则末位 500 留会话）", e);
      }
    }
  }
  const staff = staffRows[0];
  // R7-c42-⑩/R7-c43-⑤：名单命中但 role!=="head"（未正确配 role 的委派账号）留痕——否则与「无委派命中」不可分（误配难诊断）
  const staffRole = staff !== undefined && typeof staff.role === "string" ? staff.role : undefined; // R7-c44-④/R7-c56-④：单点求值；非串值不织入 "null"/"undefined" 假名
  const isHead = staff !== undefined && isHeadRole(staff.role); // R7-c87-⑧：head 判别走谓词单源（utf8mb4_ci 对齐——"Head"/"HEAD"/带空白不误伤读救通道；staffRole 变量留供告警显真值）
  if (staff !== undefined && !isHead) { // R7-c63-④/R7-c72-⑤/R7-c84-②：命中非 head 告警（role NULL/非串=漂移也算命中）——共享节流单点
    const safeRole = renderLogValue(staffRole, 32); // R7-c74-③/R7-c75-②/R7-c106-⑨/R7-c152-①：渲值标记走单点（预归一形 staffRole——空/缺/非串同词，双词汇表分歧面封死）
    warnThrottled("adminGate.delegate-role", `[auth/adminGate] 委派名单命中但 role=${safeRole}（非 head）——委派账号误配面`); // R7-c49-⑥/R7-c84-②：良性配置态走共享节流 warn 道——不占事故指标通道
  }
  // R7-c32-③/R7-c34-①：委派支与 nativeAdmin 同硬度——raw 值在场性先于强转（null/undefined/"" 一律炸显因；
  //  Number(null/"")=0 静默当「未停用」/id=0 入产线合成身份是 fail-open 面；守卫存在意义即吸 schema 漂移）
  if (isHead) { // R7-c87-⑧/R7-c115-⑤：授予判别同谓词；isHead 已含 staff!==undefined（冗余合取摘除——安全支更清）
    // R7-c34-①/R7-c40-⑥/R7-c48-④/R7-c69-⑤/R7-c129-⑧/R7-c135-③：授予判决走 judgeDelegateRow 单源（boot 报告同判决——
    //  运行期/报告漂移面封死；校验+取值经 coerceDelegateRow 同出一体；guardDelegate 逐字段复评退役——漂移透因由判决携回原错
    //  （字段标签在错误消息里））；分流保序（c115 钉）：停用确证 401 先于一切 / 域外漂移 500 透因 / role 非 head 500
    //  （isHead 外层已判——role 支实证不可达，留钉防演进破洞）
    const judgment = judgeDelegateRow(staff);
    if (!judgment.grant) {
      if (judgment.reason === "disabled") throw new TRPCError({ code: "UNAUTHORIZED", message: ADMIN_REQUIRED_MESSAGE }); // 停用委派账号确证拒绝（先于一切——c115 钉）
      // R7-c136-④：role 支在本块结构性不可达（isHead=isHeadRole 外闸与判决同谓词锁步）——若演进致分叉可达，
      //  携真实 reason 留痕（不造「isGrantableDelegateRow=false」假因误导 triage）；drift 支携原错（字段标签在错误消息里）
      delegateDrift(judgment.reason === "drift" ? "coerceDelegateRow" : "role-unreachable", judgment.reason === "drift" ? judgment.error : new Error(`judgeDelegateRow reason=${judgment.reason}——外闸 isHead 与判决分叉（演进破洞，结构性不可达被击穿）`));
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: INFRA_UNAVAILABLE_MESSAGE });
    }
    const { id: delegateId, username, displayName } = judgment; // 判决已过——取值直解构（判决产物即授予值——不再复跑 coercion）
    await assertNotRevoked(token, verdict); // R7-c80-④⑤：授前判（席位命中才查台账——吊销治理席=死）
    // R7-c114-⑥：授予留痕移到授前判【后】——判决未过时不留「放行」假痕（triage 不被假授予误导）
    warnThrottled(`adminGate.delegate-grant.${username}`, `[auth/adminGate] 委派授予 ${username}#${delegateId}（治理席放行——若 id 与历史不符=按名再继承在日志现形）`);
    return {
      id: delegateId,
      username, // R7-c47-⑦：闸后具名 const（不再 String() 重收窄——与原生支同口径，同函数两支政策不再相反）
      displayName: `${displayName}（委派管理员）`,
      role: "admin",
      delegated: true,
    } satisfies DelegatedAdminIdentity; // R7-c24-②：联合类型钉死——不再 as unknown as WbUser 全关类型检查
  }
  // M64 第三层回退：超终原生账号（st_admin_accounts，nt_ token）。
  // 缺本层曾致 nt_ 会话打开 admin.overview 即 401 → 前端全局清会话被踢回登录页（M65 事故修复）。
  // R7-c24-①：静态直引 ./nativeAdmin（下沉后环解——旧动态 import 手法退役）
  try {
    const native = await findNativeAdminByToken(token);
    // R7-c42-⑨：收窄值直接用——nativeAdmin 映射恒产 finite number+非空串，再 Number()/String()=重开防御性强转旧习（漂移被静默重收窄不回编译错）
    // R7-c61-③/R7-c62-⑥：disabled 域 {0,1} 钉已收进映射器（coerceDisabledFlag 单点——本臂不再手写域查）
    if (native && native.disabled !== 1 && isAdminWhitelistedRole(native.role)) { // R7-c51-④/R7-c82-⑩/R7-c83-⑦/R7-c115-⑨：角色白名单走共享谓词单点（isAdminWhitelistedRole——两颁证点+本支三处锁步；未来加角色不再漏本支）
      await assertNotRevoked(token, verdict); // R7-c80-④⑤：授前判（同委派支——席位命中才查台账）
      return {
        id: native.id,
        username: native.username,
        displayName: `${native.displayName}（超终）`,
        role: "admin",
        delegated: true, // requireHqAdmin 放行口径与委派相同：原生超终账号天然本厂治理席
        adminOrigin: "native",
      } satisfies DelegatedAdminIdentity; // R7-c24-②：联合类型钉死
    }
  } catch (e) {
    // R7-c40-⑤/R7-c41-⑥/R7-c80-⑥ bug medium：TRPCError（授前判的吊销 401/台账 500）原样上行——空绑定捕把 revoked 吞成 500=
    //  死错必清契约破洞（吊销的原生席被 500 误报，会话不清——探针臂实证）封死；仅 nativeAdmin 原始错（非 TRPCError）折 500 显因
    if (e instanceof TRPCError) throw e;
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: INFRA_UNAVAILABLE_MESSAGE });
  }
  // R7-c98-③ bug medium/R7-c128-⑧：委派支非缺表故障+原生支未中=委派席健康未实证——500 显因留会话（M65 活错不清）；
  //  不 401（401 清会话=委派席被瞬时故障误踢——与缺表降级分两义）；委派支健康时两支全灭才归 null（401 落点归 requireAdmin）。
  //  【与 cabinGate 契约有意分歧显式钉】：cabinGate 系 wb 单源闸（无行=可证缺席→401 清会话）；本闸含委派回退支——
  //  委派查询失败时「无命中」不可证（外来/死 token 与活委派席不可分辨）——取舍=保活委派席不被瞬时故障误踢，
  //  代价=外来 token 在 staff 表故障窗内收 500 而非 401（会话清不清依赖瞬时 infra——有意接受；cabinGate 头注同钉互引）
  if (delegateDown) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: INFRA_UNAVAILABLE_MESSAGE });
  return null; // 两支全灭=无命中（401 落点归 requireAdmin——本函数只授不夺）
}

/**
 * M48d 超级终端本厂闸门（彭总口径：超级终端只对 HQ 主体开放——公司名走 HQ_COMPANY_NAME_DEFAULT 单源，
 *  话术见 hqTerminalOnlyMessage；R7-c159-⑨ security low：源码注释不嵌生产字面值）。
 * env HQ_FACTORY_IDS：本厂 factoryId 逗号分隔（生产值由部署手册在上线前配置——仓内不留字面值）。
 * 语义：fail-closed——未配置时 wb_users 路径一律拒（委派名单仍可读救），绝不裸奔。
 * R7-c82-⑦：自 terminal.ts 迁 auth 层（authLock 等安全路由不再为一道闸拖入整个 terminal 模块图）；
 * terminal.ts 两段式再出口保持既有 import 路径不破。
 */
/** 纯十进制 id 名单解析单源（R7-c131-⑤）：splitEnvList+字符串域钉+剔除节流告警——hqFactoryIds/adminDelegateIds 同引
 *  （R7-c121-⑤ 域钉：Number.isInteger(1e13)===true 数值层拦不住科学计数法；R7-c129-⑦：剔除不再静默——键/文经 sink 压平限长） */
function envIdList(name: string, opts?: { configuredEmptyThrows?: boolean }): number[] { // R7-c142-⑤：错配显形政策折入单点（两处不再各抄）
  // R7-c132-⑦：两段式——解析纯化（filter 不持副作用），剔除项归队后统一告警（解析与观测解耦）；
  //  isSafeInteger 界：超长数字串 Number 失精（永不命中真 id）同剔告警
  const entries = splitEnvList(name);
  const ok: number[] = [];
  const dropped: string[] = [];
  for (const s of entries) {
    // R7-c133-⑩ bug medium：容忍前导零（运维表格导出 "06290209" 形态——剔除即静默缺员难诊断）；
    //  域钉保留：1e3/+1/-1/0/小数照旧拒（纯数字串+安全整数+正数三证）
    const n = /^\d+$/.test(s) ? Number(s) : NaN;
    if (Number.isSafeInteger(n) && n > 0) { ok.push(n); continue; }
    dropped.push(s);
  }
  // R7-c143-⑥：键不嵌条目值（值独立键——一串错值=一窗一条，不再逐条目开窗洪灌；键不带配置值=日志路由键干净）；
  //  消息带样例值（诊断不丢）；尾巴名感知（HQ_FACTORY_IDS 的全 401 措辞不再误导委派名单）
  if (dropped.length > 0) {
    // R7-c160-③：尾巴从「只特判 HQ_FACTORY_IDS」改「调用方 opt-in 旗派生」——configuredEmptyThrows 调用方
    //  全剔=错配显形抛 500（下行闸在），旧文案「静默缺员」对该通道误导 triage 面封死
    let tail: string; // R7-c161-②：拆序不嵌套三元（仓规——rawRows/revocation 同例）
    if (name === "HQ_FACTORY_IDS") {
      tail = "全剔=本厂闸全表不命中全 HQ 401";
    } else if (opts?.configuredEmptyThrows) {
      tail = "全剔=错配显形抛错上行（非静默缺员）";
    } else {
      tail = "全剔=该名单通道静默缺员";
    }
    warnThrottled(`adminGate.envIdList-drop.${name}`, `[auth/adminGate] ${name} 条目被剔 ${dropped.length} 枚（非纯十进制/超安全整数界；样例：${dropped.slice(0, 3).map((s) => s.slice(0, 16)).join("，")}）——若系误配名单静默缺员（${tail}）`);
  }
  // R7-c142-⑤：配置了却零有效=错配掩码抛（opt-in——HQ_FACTORY_IDS/ADMIN_HQ_DELEGATE_IDS 两钉同引锁步；
  //  掩码=内部措辞不外泄；ADMIN_DELEGATE_IDS 不传此件——空名单=通道关系设计语义不抛）
  if (opts?.configuredEmptyThrows && (process.env[name] ?? "").trim() !== "" && ok.length === 0) throw new Error(`[auth/adminGate] ${name} 已配置但全部条目非法（0 枚有效——错配显形）`); // R7-c157-⑥：解析器纯化=plain Error（不与传输层耦合——纯件进 display/lockRole 等非请求路径不再拖 TRPC 型）；掩码映射在调用边界
  return ok;
}

export function hqFactoryIds(): number[] {
  // R7-c121-⑤/R7-c129-⑦/R7-c131-⑤/R7-c140-⑤/R7-c141-⑤/R7-c142-⑤：域钉+剔除告警+错配掩码抛全走 envIdList 单点
  //  （配置了却零有效=抛——静默降级面封死；未配置（空串）=fail-closed 全拒既有语义不动）
  try {
    return envIdList("HQ_FACTORY_IDS", { configuredEmptyThrows: true });
  } catch {
    throw infraError500(); // R7-c157-⑥：错配抛在边界映射掩码（解析器纯化后）——内部措辞不外泄
  }
}

/** 委派 id 名单解析单源（R7-c131-⑤ security medium 收口）：不可变键通道——P-DELEGATE-IDBIND 落地件
 *  （删号重建同名不继承——新号 id 不同不命中；与 username 名单并集匹配=过渡态双轨，纯 id 配置即可完全摆脱可变键）；
 *  上线检查单：CD-1 nebula.env 增配 ADMIN_DELEGATE_IDS=逗号分隔 staff id（与 ADMIN_DELEGATE_USERNAMES 并存或替代） */
export function adminDelegateIds(): number[] {
  return envIdList("ADMIN_DELEGATE_IDS");
}

/** 委派行投影列单点（R7-c137-②）：闸侧查询（按 token）与 collectDelegateBindings（按双键）同引——
 *  列改名/摘除只改一处（「同谓词、不同行形状」分歧面封死——判决锁死而喂它的行形状不锁=漂移复活面） */
const DELEGATE_ROW_COLS = "id, username, displayName, role, disabled";
const DELEGATE_ROW_COLS_WITH_CREATED = `${DELEGATE_ROW_COLS}, createdAt` as const; // 报告支加 createdAt（绑定留痕用）

/** 委派绑定归集单源（R7-c136-② test low）：boot 委派报告渲染层与闸侧同谓词（isGrantableDelegateRow=judgeDelegateRow 投影）——
 *  行加载+分区+缺员归集一处（执行器注入=可单测；boot 只剩渲染）；调用方保证至少一名单非空（delegateKeyCond 自执行守卫兜） */
export async function collectDelegateBindings(
  db: { execute(q: ReturnType<typeof sql>): Promise<unknown> },
  usernames: readonly string[],
  ids: number[],
): Promise<{
  grants: Array<Record<string, unknown>>;
  nonGrants: Array<Record<string, unknown>>;
  missingNames: string[];
  missingIds: number[];
}> {
  const rows = rawRows(await db.execute(
    sql`SELECT ${sql.raw(DELEGATE_ROW_COLS_WITH_CREATED)} FROM st_staff_accounts WHERE ${delegateKeyCond(usernames, ids)}`, // R7-c137-②：投影列单点同引
  ));
  // R7-c128-①：单趟分区（谓词含 coercion+节流留痕有真工——双评=双工+互补性靠人肉；一趟推两桶=可证互补）
  const grants: Array<Record<string, unknown>> = [];
  const nonGrants: Array<Record<string, unknown>> = [];
  for (const r of rows) (isGrantableDelegateRow(r) ? grants : nonGrants).push(r);
  // R7-c157-⑦ bug low：型先判再归一——String(NULL) 产 "null" 字面量会假命中/假缺报（漂移行被报成「无行」误导 triage；
  //  与 normalizeCiText 收窄 string 同纪律——非串行不入名判（其 username 漂移由 nonGrants 支承载））
  const missingNames = usernames.filter((u) => !rows.some((r) => typeof r.username === "string" && normalizeCiText(r.username) === normalizeCiText(u)));
  const missingIds = ids.filter((d) => !rows.some((r) => Number(r.id) === d));
  return { grants, nonGrants, missingNames, missingIds };
}

/** 委派双键并集条件单源（R7-c131-⑤）：闸侧查询与 boot 委派报告同引——username 轨+id 轨 OR 语义一处（两臂各拼=漂移面封死；
 *  调用方保证至少一名单非空——全空支由调用方闸外拦截） */
function delegateKeyCond(usernames: readonly string[], ids: number[]): ReturnType<typeof sql> { // R7-c139-④：零外部消费实证摘出口（boot 经 collectDelegateBindings 间接消费——同纪律）
  // R7-c134-⑧ bug medium：空名单守卫自执行（双空会渲出 IN () 语法错——文档约定改结构断言，未来调用方/次序调整不再踩）
  if (usernames.length === 0 && ids.length === 0) throw new Error("[auth/adminGate] delegateKeyCond 需至少一名单非空（双空会渲出空谓词语法错——调用方闸外先拦）");
  const parts: Array<ReturnType<typeof sql>> = [];
  if (usernames.length > 0) parts.push(sql`username IN (${sql.join(usernames.map((u) => sql`${u}`), sql`, `)})`);
  if (ids.length > 0) parts.push(sql`id IN (${sql.join(ids.map((d) => sql`${d}`), sql`, `)})`);
  return sql`(${sql.join(parts, sql` OR `)})`;
}

/** HQ 席位谓词单源（OCR R79-2/R7-c155-⑮）：requireHqAdmin 闸门与 adminCaps 展示信号同判——规则演进只改此处，
 *  展示信号与真实闸不再靠人工锁步漂移。
 *  hq 形参契约显式钉：省略=惰性读 hqFactoryIds()（治理席支不触名单——错配抛不影响读救）；显式传 []=wb 支恒不中
 *  （requireHqAdmin 治理席先判内部用——外部调用方【绝不】传空数组当「默认」（空表≠省略——语义钉死防误读）） */
export function isHqPrincipal(user: unknown, hq?: number[]): boolean { // R83-1/R7-c142-③ bug medium：名单惰性读——默认形参期求值会在治理席分支前抛（HQ 错配误锁读救通道+adminCaps 展示端点被 500 面）；
  //  只在 wb 终支解析（治理席支先返不触名单）；调用方已读则显式传参复用（不再每请求双读 env）
  if (user === null || typeof user !== "object") return false; // R106-14 bug low：unknown 入参先守再解引——null/原始型不再裸 deref（fail-closed 方向）
  if (isDelegatedSeat(user)) { // R7-c56-⑥/R7-c124-④/R7-c140-⑥/R7-c141-⑧：委派标判定走共享谓词——【信任边界显式钉：委派席==HQ 主体】
    //  系有意耦合（治理席回退=超终读救通道——彭总口径）；配置面即攻击面：名单宽放/错配=超终域静默授予——名单变更须走变更评审，
    //  boot 委派绑定报告逐启动留痕兜底；
    //  R7-c141-⑧ bug high：双序列不混判——委派标覆盖两条 id 序列（staff 委派席/原生超终席同从 1 起——P-ID-SPACE 分带
    //  隔离是在 wbThreadUserId 输出层，本闸读的是原始 id）——原生席（adminOrigin==="native"）恒 HQ（本厂治理席=彭总 nt_
    //  在产面，剥离即 M65 锁死复刻面封死）；分离闸只作用于 staff 委派序
    if ((user as { adminOrigin?: string }).adminOrigin === "native") return true;
    //  R7-c140-⑥ security medium：分离演进 opt-in——ADMIN_HQ_DELEGATE_IDS 一经配置（不可变 id 白名单），staff 委派席 HQ 资格只由它授
    //  （与救援读救名单解耦——宽配委派名单不再顺带扩 HQ 信任域）；
    //  R7-c141-④：配置了却零有效=错配掩码抛（静默回落默认=fail-open 重开面封死——与 HQ_FACTORY_IDS 同形异向钉）；
    //  R7-c144-⑤ security medium 挂账登记（P-HQ-TRUST-SPLIT）：门禁再促「生产默认 fail-closed（未配置即不授委派 HQ）」——
    //  默认翻转会当场斩断彭总 COO/CMO 读救通道（应急窗自锁风险）——属 owner 级信任决策，本会话不擅自翻默认；
    //  提请彭总拍板：A=保持默认（委派即 HQ 救援）；B=生产 fail-closed（CD-1 增配名单后启用）。PR 评论已挂请决策；
    const rawHq = process.env.ADMIN_HQ_DELEGATE_IDS;
    if (rawHq !== undefined && rawHq.trim() !== "") {
      // R7-c142-⑤：错配掩码抛走 envIdList 单点（配置了却零有效=抛——静默回落默认=fail-open 重开面封死）
      let hqDelegates: number[];
      try {
        hqDelegates = envIdList("ADMIN_HQ_DELEGATE_IDS", { configuredEmptyThrows: true });
      } catch {
        throw infraError500(); // R7-c157-⑥：边界映射掩码（同 hqFactoryIds 口径）
      }
      return hqDelegates.includes(Number((user as { id?: number }).id));
    }
    // R7-c151-③ security medium：默认口径可观测——委派席按默认获 HQ 时节流留痕（名单过宽=信任域静默扩面显性化；
    //  生产默认翻转=owner 级决策在拍（P-HQ-TRUST-SPLIT——PR 评论已提请彭总拍板）——本钉不改变默认，只让现状可见）
    warnThrottled("adminGate.hq-delegate-default", "[auth/adminGate] 委派席按默认口径获 HQ 资格（ADMIN_HQ_DELEGATE_IDS 未配置——委派名单即 HQ 信任域；收窄=配置该名单）");
    return true;
  }
  return (hq ?? hqFactoryIds()).includes(Number((user as { factoryId?: number }).factoryId)); // R7-c142-③：惰性解析——只在本支读名单
}

/**
 * M48d 本厂闸增强守卫（超级终端专属）：先 requireAdmin（含委派回退），
 * 再对 wb_users 本厂路径加 HQ_FACTORY_IDS fail-closed。
 * - 委派账号（本厂 COO/CMO head）天然放行（读救通道）；
 * - HQ_FACTORY_IDS 未配置 → fail-closed 全拒 wb_users 路径，绝不裸奔；
 * - 非本厂 admin → 精确口径「超级终端仅对广东灵智枢生态科技有限公司开放」。
 * 通用企业 admin 路径（duty-chat/deptConsole/devices 等）仍走 requireAdmin，不受本闸影响。
 */
export async function requireHqAdmin(token: string, out?: { verdict?: RevocationVerdict }) {
  const user = await requireAdmin(token, out); // R7-c102-①：判决袋透传
  // R7-c142-④ bug medium：治理席先判（委派/原生支不依赖 HQ_FACTORY_IDS——HQ 错配抛不再误锁读救通道；错配窗=救援窗，正好撞面）；
  //  读救通道承诺（「委派账号天然放行」）先于名单解析
  if (isHqPrincipal(user, [])) return user; // 治理席判完即返（空名单入参=wb 支恒 false 不落此——治理席支在谓词内部先行）
  const hq = hqFactoryIds(); // R83-1/R7-c142-③④：单读后喂谓词（惰性——只在 wb 路径读名单；错配抛只影响 wb 面）
  if (isHqPrincipal(user, hq)) return user; // R82-1 谓词委派；R84-7：此后 delegated≠true 且不在名单——下方两支合并为单判决点
  if (hq.length === 0) {
    warnThrottled("adminGate.hq-env", "[auth/adminGate] HQ_FACTORY_IDS 未配置：超级终端 wb_users 路径关闭，仅委派账号可进"); // R7-c84-②：共享节流单点（HQ 闸每请求洪灌面封死——与委派误配同政策）
    throw new TRPCError({ code: "UNAUTHORIZED", message: ADMIN_REQUIRED_MESSAGE });
  }
  // R84-7：谓词已判非 HQ（delegated≠true 且不在名单），原 includes 复判恒真——收敛单判决点，不再双判漂移
  throw new TRPCError({ code: "UNAUTHORIZED", message: hqTerminalOnlyMessage() }); // R7-c83-⑧：话术单源（常量同模块出口——内联字面量漂移面封死）
}
