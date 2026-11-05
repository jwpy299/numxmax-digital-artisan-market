/**
 * 四层四锁·身份证据层（批七 R7-8 收口：品牌与证据构造从 guards.ts 拆出——guards 回纯判决层，本层是唯一
 *  特权身份产线；七-c 接线：requireAdmin 调本层 authenticateAdmin 取证——auth 层自读库（queries/connection 直引，revocation.ts 同例不成环；仍不伸手路由层，R7-14-③ 依赖反转不破），唯 DB 核验行可品牌化（R7-c10-②：API 形状即闸）。
 *
 * 边界诚实登记（R7-8+R7-9-① high 收口）：TS 类型只在编译期有意义，运行期任何对象都能喂进任何函数——
 *  本层的真实防线是【真身名册 MINTED（WeakSet 本体登记）】（R7-b-③/R7-b5-③ 头注对齐实现）：品牌键不可枚举+冻结+本体在册三层齐备——
 *  形状完整度（passwordHash 在场）只是绊线不是城墙（R7-17-③ 已诚实化）；委派治理席证据不在本骨架开放（R7-9-①）——
 *  引用面由 identitySurface.test.ts 哨兵看守（R7-13-③/R7-15-③：asResolvedAdminIdentity 与 __*ForTest 名，非钩模块 import 即红）；
 *  owner 口径钉准（R7-15-②）：requireAdmin 的 wb_users 支严格 role==="admin"——owner 存量行本就 401，四锁同闸不另开通道，
 *  头注旧称「owner 必须走品牌证据」不可达属误述，已改；owner 如需特权须先经 requireAdmin 收编再评。
 *  委派治理席证据不在本骨架开放（R7-9-①：原 DelegatedIdentity 五字段形（已撤）可被字面量直造——委派证据 mint 归七-c：
 *  届时本文件新增 asDelegatedIdentity 出厂函数（品牌键只能在本文件内附着），requireAdmin 的 DB 核验现场调它——
 *  而不是在 requireAdmin 里直接造（品牌键模块私有，外部造不出，唯一产线不破）。
 */
// R7-9-①：方言归一导入摘除——本层严格 role==="admin" 钉准 requireAdmin 同闸，不经归一（R7-9-③）
import { eq, and, or } from "drizzle-orm";
 // R7-c10-②：authenticateAdmin 自读库（R7-c71-⑥：LEGACY 启动探针撤除——import 期 DB 副作用+谓词与回填不齐的假警报面，检测点收敛回回填脚本迁移后校验）
import { wbUsers, type WbUser } from "@db/schema"; // 表元/行型引 schema 出口单源（R7-7-⑦）
import { getDb } from "../queries/connection"; // R7-c10-②：DB 直引（revocation.ts 同例——connection 只引 env/schema/relations，不成环）
import { isRevoked, tokenFingerprint, authTokenHash, authTokenPlaintextGuard } from "./revocation"; // R7-c14-②：产线先查吊销台账再产证；tokenFingerprint=判别结果指纹绑定；authTokenHash/authTokenPlaintextGuard=P3-6 落库哈希与明文腿守卫单点（import/no-duplicates——双语句同源合并）
import { logQueryErrorThrottled } from "../queries/rawRows"; // R7-c143-⑤：warnThrottled 随旗函数修剪失消费——摘除（幻影绑定不养） // R7-c15-④：原始 DB 错误不走裸 console.warn——共享脱敏链出口（SQL/绑定参数脱敏后节流留痕）
import { hasCauseChainMatch, isDupEntry } from "../queries/dupEntry"; // R7-c156-④：撞键判别同引（runGuardedDb dupPassthrough 用） // R7-c52-③/R7-c60-②：中性原语出口（isNoSuchTable 共享 walker——名随实，不与撞键语义耦合）
import { TRPCError } from "@trpc/server"; // R7-c19-①：吊销单点与 infra 500 出口（auth 接线层，guards/scopes 保持纯）
import { env } from "../lib/env"; // R7-c132-①：环境判别共享抽象（opt-in 白名单谓词同引——NODE_ENV 直读收口）
import { LEDGER_UNAVAILABLE_MESSAGE, ADMIN_REQUIRED_MESSAGE } from "@contracts/authLock"; // R7-c134-⑥/R7-c135-④+门禁 PR#9-r35-④：同模块 import 合一（仓规 import/no-duplicates）；先引后出（纯再出口不带本地绑定=消费面 TS2304 钉）
export { ADMIN_REQUIRED_MESSAGE }; // 再出口保持既有 import 路径不破
export { LEDGER_UNAVAILABLE_MESSAGE }; // 再出口——既有消费端（identity 路径）零改
import type { Role } from "./scopes";

const RESOLVED_IDENTITY: unique symbol = Symbol("wbResolvedIdentity");

// R7-c61-②/R7-c96-⑥/R7-c114-⑦ security medium：opt-in 旗启动即鸣——【显式调用】（reportRevocationOptionalFlag 由 boot 路径调——
//  非 import 期副作用；措辞对齐实况，不再写「模块载入」）；本旗仅限 pre-migration 环境显式声明——启动警报炸眼
/** 缺表降级 opt-in 白名单谓词单点（R7-c62-④/R7-c75-①/R7-c77-①/R7-c78-⑨）：仅显式非生产（development/test）生效——
 *  模块载入警报与 resolveRevocation 同引本点（两份字面量条件=静默分歧面封死；staging/未设/错拼/生产皆 fail-closed） */
function revocationTableOptionalEnabled(): boolean {
  return flagOptInEffective(FLAG_REVOCATION_TABLE_OPTIONAL); // 门禁 PR#9-r6-②⑤：谓词体归单点（不再逐旗复抄）
}

/** 安全 opt-in 旗读取+判定双单点（门禁 PR#9-r5-④/r6-②⑤——吊销台账/2FA 两旗同引）：
 *  flagOptInOn=trim 归一后的在场判（reporter 与谓词同一读取——空白垫值两判分歧面封死）；
 *  flagOptInEffective=在场且环境闸放行（仅显式非生产——环境集演进只改本点） */
/** 旗名字面量单源（门禁 PR#9-r25-⓪）：谓词与 reporter 同引——未来改名只触一处（双持=启停闸守错旗面封死） */
const FLAG_REVOCATION_TABLE_OPTIONAL = "REVOCATION_TABLE_OPTIONAL";
const FLAG_ADMIN_2FA_TABLE_OPTIONAL = "ADMIN_2FA_TABLE_OPTIONAL";

const flagOptInOn = (flagName: string): boolean => (process.env[flagName] ?? "").trim() === "1";
const flagOptInEffective = (flagName: string): boolean => flagOptInOn(flagName) && env.isExplicitNonProd; // R7-c132-①/R7-c160-④→PR#9-r14-④：环境集判定归 env.isExplicitNonProd 单点（本行不再自持字面量谱系）

/** 启动显形单点：旗在场但被环境闸压制=配置错配即抛（两半同走上面双单点——字面量分抄=静默分歧面封死） */
function reportOptionalFlag(flagName: string, scene: string): void {
  if (flagOptInOn(flagName) && !flagOptInEffective(flagName)) {
    throw new Error(`[SECURITY][auth/identity] ${flagName}=1 在场但本环境不生效（NODE_ENV 非显式 development/test——${scene}被闸压制而旗在场=配置错配，摘除本旗或修正 NODE_ENV 后再启）`);
  }
}

/** opt-in 旗错配断言（R7-c76-⑤/R7-c78-⑨/R7-c96-⑤⑥/R7-c128-⑦/R7-c129-⑤/R7-c143-⑤）：唯一调用点=boot 生产 serve 入口
 *  （import 期副作用清零后 dev/test 不触本函数——「生效中警报」支系双盲死支（生产恒不生效/非生产恒不调）已摘除；
 *  非生产谱系的错配可见性归运行期 fail-closed 500 留痕（resolveRevocation 带 env 现场入脱敏链））；
 *  旗在场=压制态错配 → 抛致命 Error（库层不持进程生死——exit 决断归 boot 启动块） */
export function reportRevocationOptionalFlag(): void {
  reportOptionalFlag(FLAG_REVOCATION_TABLE_OPTIONAL, "降级"); // 吊销台账旗（判定归 flagOptInEffective 单点——措辞形态不变）
}

/** 2FA 缺表豁免 opt-in 谓词单点（门禁 PR#9-r2-⑤ security medium——与吊销台账旗同政策族：
 *  仅显式非生产（development/test）生效——生产在场即被环境闸压制=fail-closed 保住） */
export function twoFaTableOptionalEnabled(): boolean {
  return flagOptInEffective(FLAG_ADMIN_2FA_TABLE_OPTIONAL); // 门禁 PR#9-r6-⑤：谓词体归单点（环境集演进不再两臂锁步手改）
}
/** 2FA opt-in 旗启动显形（门禁 PR#9-r2-⑤/r5-④）：走 reportOptionalFlag 单点（与吊销旗零复抄） */
export function reportTwoFaOptionalFlag(): void {
  reportOptionalFlag(FLAG_ADMIN_2FA_TABLE_OPTIONAL, "2FA 缺表豁免");
}

/** 真身名册（R7-b-③ security medium）：品牌键从「键存在」升级为「对象本体在册」——
 *  Proxy 可伪造 getOwnPropertyDescriptor 冒充任意自有键（含本 symbol 名，它连 symbol 都不必知道），
 *  唯有 WeakSet 本体名册攻不破：克隆/摊拷/Proxy 全不在册 */
const MINTED = new WeakSet<object>();

/** 已核验身份证据（品牌键为模块内 unique symbol，外部构造不出合法值——结构化伪造在编译期即炸） */
export interface ResolvedWbIdentity {
  readonly [RESOLVED_IDENTITY]: true;

  readonly factoryId: number | null; // 委派证据无厂号（null），boss 判在 lockRoleOfWbUser 委派支短路
  readonly delegated: boolean;
}

/** 武装窗（R7-c10-② security medium 收口）：导出 mint 只在武装窗内产证——运行期闸，不再只靠纪律+哨兵 lint。
 *  产线路径走 authenticateAdmin（DB 核验现场直调私有 mintAdminEvidence，不经过本闸）；
 *  测试经 identityTestHook 的 __withMintArmedForTest 窄口开窗（哨兵看守进口面）。
 *  窗为同步块：mint 纯同步、开窗到关窗不跨 await，并发无交错窗；finally 保关窗（异常不留门）；
 *  R7-c15-② 环境闸叠加：NODE_ENV!==test 拒开窗（运行期边界实体化——产线环境双件同引也铸不出证） */
let mintArmed = false;
export function withMintArmed<T>(fn: () => T): T {
  // R7-c15-② security low 收口：环境闸——非测试环境拒开窗（产线包即使同引开窗器+mint 双件也铸不出证：运行期边界实体化，哨兵/树摇退居二线；vitest 下 NODE_ENV=test 自动成立）
  if (process.env.NODE_ENV !== "test") throw new Error("[auth/identity] withMintArmed 仅限测试环境开窗");
  const prev = mintArmed; // R7-c12-②：可重入——嵌套开窗内层 finally 不关外层的窗（存旧值恢复，非无脑置 false）
  mintArmed = true;
  try { return fn(); } finally { mintArmed = prev; }
}

/** 品牌证据私有产线（七-a 骨架只开 wb_users 全行支）：唯 authenticateAdmin 的 DB 核验现场与武装窗内可产证——
 *  入参钉全行型（绊线口径：passwordHash 在场只挡随手伪造，真防线=品牌键运行期验+武装窗+调用处纪律）。
 *  口径钉准（R7-9-③）：严格 role === "admin"——与 requireAdmin 的 wb_users 分支同闸（owner 存量行在 requireAdmin 即 401，
 *  本构造器不多开 owner→admin/boss 通道；若未来 requireAdmin 收编 owner，此处同步再评）。
 *  形状闸出口看守（R7-13-③/R7-b2-⑥ 哨兵制）：TS 无法阻止同包 import——identitySurface.test.ts 进口面哨兵钉死
 *  （仅本文件与 identityTestHook.ts 可引 asResolvedAdminIdentity/withMintArmed，他模块 import 即测试红；同 withTimeoutSurface 仓规先例） */
function mintAdminEvidence(user: WbUser | null | undefined): ResolvedWbIdentity | null {
  if (user === null || typeof user !== "object") return null;
  if (user.role !== "admin") return null; // 严格钉准 requireAdmin 同闸（R7-9-③）
  if (typeof user.passwordHash !== "string" || user.passwordHash.length === 0) return null; // R7-9-①/R7-17-③：绊线口径（真防线=品牌键+调用处纪律）
  if (Number(user.disabled) === 1) return null; // R7-c2-⑨/R7-c3-⑦：数值归一（仓内同口径 admin.ts/terminal.ts/adminAuth.ts/staff.ts 均 Number(x)===1）——drizzle 映射 boolean 与 raw SQL TINYINT 数字 1 双形态都拦，true/1/"1" 三通吃；undefined（部分行）不误拦
  const fid = user.factoryId;
  if (typeof fid !== "number" || !Number.isFinite(fid)) return null; // R7-c6-⑧ bug medium：摘掉 <=0 多判——requireAdmin 从不查 factoryId（0=未挂靠平台账号合法在册），本层「同闸」口径对齐；HQ 成员资格由 lockRoleOfWbUser 名单判
  // R7-9-③/R7-b8-② 口径钉准：品牌键=编译期闸（类型面让外部构造不出合法 ResolvedWbIdentity），运行期闸=MINTED 名册——
  //  本键不再被运行期读；不可枚举防摊拷、冻结防改写、名册验本体（三层各司其职，注释与实现对齐）
  const ev = { factoryId: fid, delegated: false }; // R7-c6-⑧：同 fid // R7-c6-⑥：role 字段摘除（写-only 死面，delegated→boss 时恒报 admin 误导分支）——证据形状收窄到判决所需
  Object.defineProperty(ev, RESOLVED_IDENTITY, { value: true, enumerable: false });
  Object.freeze(ev);
  MINTED.add(ev); // R7-b-③：本体入册（判据真身）
  return ev as unknown as ResolvedWbIdentity; // unknown 中转（R7-10-④：品牌键运行期注入、类型面无键）
}

/** 导出 mint（测试钩窄口专用，R7-c10-②）：未开窗恒 null——任意模块 import 了也造不出证据（伪造字面量产证通道运行期拆除，
 *  不再只靠哨兵 lint；哨兵仍守进口面）。产线禁直调——七-c 接线走 authenticateAdmin（API 形状即闸） */
export function asResolvedAdminIdentity(user: WbUser | null | undefined): ResolvedWbIdentity | null {
  if (!mintArmed) return null;
  return mintAdminEvidence(user);
}

/** 全列登记（R7-c78-⑤/R7-c109-④/R7-c111-⑥ security low 收口）：wb_users 每列显式归类 strip/keep——
 *  satisfies 只证「列出的名合法」，新增敏感列会静默外泄；全列登记=加列不归类即编译红（显式 keep/strip 决策强制） */
const WB_FIELD_EXPOSURE = {
  passwordHash: "strip", authToken: "strip", idCardHash: "strip", realName: "strip", idCardMasked: "strip",
  id: "keep", username: "keep", displayName: "keep", role: "keep", factoryId: "keep", departmentId: "keep",
  phone: "strip", // R7-c141-⑥ security low：auth 结果行零消费端实证（admin.ts/adminAnalytics 的 .phone 系另投影/掩码行——与本行无关）——数据最小化（与 nativeAdmin phone 摘帽同纪律；消费端再现需联系展示→另开评审）
  kind: "keep", gender: "keep", city: "keep", voice_pref: "keep", invitedBy: "keep", activatedAt: "keep",
  disabled: "keep", createdAt: "keep",
} as const satisfies Record<keyof WbUser, "strip" | "keep">;
type WbStripKey = { [K in keyof WbUser]: (typeof WB_FIELD_EXPOSURE)[K] extends "strip" ? K : never }[keyof WbUser];
const WB_STRIPPED_FIELDS = (Object.keys(WB_FIELD_EXPOSURE) as (keyof WbUser)[]).filter((k) => WB_FIELD_EXPOSURE[k] === "strip") as readonly WbStripKey[]; // 剥离名单=登记表派生（单一事实源）

/** 出闸行（R7-c45-③/R7-c49-⑤/R7-c141-⑥ security 收口）：凭据列+PII 四件（含 phone）物理剥离——ok 支回行不带出 auth 层；
 *  phone 转 strip（auth 结果零消费端实证——数据最小化；消费端再现→另开评审） */
export type SafeWbUser = Omit<WbUser, WbStripKey>; // R7-c78-⑤/R7-c111-⑥：型名单=运行期名单同一源（全列登记表派生）

/** 生产认证结果判别联合（R7-c18-① high 收口）：401/403/500 语义分立——revoked=确已吊销（401 合理）/
 *  invalid=无此行或非 admin 行（401 合理）/rejected=admin 行形状闸不过（硬 401 不落回退支）/ledger_unavailable=台账查验 infra 失败（绝不 401——M65 清会话炸弹，调用方须 500 显因）；
 *  R7-c22-②：ok 支回传产线取行（row）——requireAdmin 探针即产线取行，平行验证路径合一（每请求 5 查降 2 查） */
export type AdminAuthResult =
  | { ok: true; evidence: ResolvedWbIdentity; row: SafeWbUser }
  | { ok: false; reason: "invalid"; rowFound: boolean } // R7-c74-⑥：invalid 拆子态——rowFound=false（wb 无此行=死会话/外来凭证）调用方 401 清会话；true（活行非 admin）→403 留页（M65 双面钉在分流端，不再一勺烩）
  | { ok: false; reason: "revoked" | "rejected" | "ledger_unavailable" }; // R7-c23-③：rejected=wb_users admin 行形状闸不过（停用/空 hash/厂号非法——硬 401 不落回退支，停用不给复活通道）


/** 500 话术透传白名单谓词（R7-c77-②/R7-c87-⑩）：模块私有——消费经 maskInfraMessage 单点（R7-c86-⑤ 起两传输同引掩码判决）；
 *  白名单演进只改本点（正/反条件双抄面封死） */
function isPassthroughInfraMessage(msg: string): boolean { // R7-c87-⑩：零外部消费摘出口（maskInfraMessage 内聚——幻影出口不养；注释口径同改）
  return msg === INFRA_UNAVAILABLE_MESSAGE || msg === LEDGER_UNAVAILABLE_MESSAGE;
}

/** 500 话术掩码单点（R7-c86-⑤）：白名单透传/非白名单裹 INFRA——staffTrack.sanitizeInfra（tRPC 路）与 streamBus（SSE/HTTP 路）
 *  同引本点（透传/裹换【判决】不再双抄——政策演进只改一处，两传输锁步） */
export function maskInfraMessage(msg: string): string {
  return isPassthroughInfraMessage(msg) ? msg : INFRA_UNAVAILABLE_MESSAGE;
}

/** log→mask→500 抛出口政策单点（R7-c125-① maintainability）：staff.ts/staffTrack.ts/adminAuth.ts 三处模块私有副本合流——
 *  任一副本漂移=raw 泄密面静默 reopen 面封死（政策=脱敏链留痕+INFRA_UNAVAILABLE_MESSAGE 掩码 500 上行，全锁本点）。
 *  分工声明：本点系【带留痕抛出器】；staffTrack.sanitizeInfra 系【无留痕构造器】（留痕由调用方在尝试前记一次——
 *  两政策有意不同，构造器的掩码判决已锁 maskInfraMessage 单点，不互拉齐） */
/** infra 500 构造器（无留痕——R7-c140-①）：调用方源处已留痕时用（防双记混 triage）；
 *  带留痕抛出器=infraUnavailable500（本构造器+logQueryErrorThrottled 合流——单点锁步） */
export function infraError500(): TRPCError {
  return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: INFRA_UNAVAILABLE_MESSAGE });
}

export function infraUnavailable500(tag: string, err: unknown): never {
  logQueryErrorThrottled(tag, err);
  throw infraError500();
}

/** 通用 infra 守卫（TRPCError 透传；其余错误脱敏 500；log:false 防双记）——与 identity 政策点同层，避免 lib→auth 反向依赖。 */
export async function guardInfra<T>(tag: string, fn: () => Promise<T>, opts?: { log?: boolean }): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof TRPCError) throw e;
    if (opts?.log === false) throw infraError500();
    infraUnavailable500(tag, e);
  }
}

/** 守卫执行单点（R7-c156-④ maintainability）：1146→412（missingMsg 调用方给）/dupPassthrough 撞键原链透传/
 *  余→infraUnavailable500 政策点——staff.ts runStaffDb 与 kb.ts runKbDb 两副本合流（同政策 5+ 处各抄=单侧演进漂移面封死；
 *  txInsertId 的事务形态自带同款分类在叶内，不在本点收编范围） */
export async function runGuardedDb<T>(run: () => Promise<T>, tag: string, missingMsg: string, opts?: { dupPassthrough?: boolean }): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (opts?.dupPassthrough && isDupEntry(err)) throw err; // 撞键域内信号（声明消费的调用点才收原链）
    if (isNoSuchTable(err)) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: missingMsg });
    }
    infraUnavailable500(tag, err);
  }
}

/** infra 掩码构造器单点（无留痕——R7-c125-③）：TRPCError 原样透传 / 500 消息掩码走 maskInfraMessage / raw→INFRA 500。
 *  分支政策（哪些输入变 500、哪些原样透传）只此一份——staffTrack 等传输层同引（双份实现=单侧改策漂移面封死）。
 *  留痕分工：raw 错由调用方在尝试前记一次（本构造器不记——双记混 triage 面）；带留痕抛出器走 infraUnavailable500 */
export function maskInfra500(err: unknown): TRPCError {
  if (!(err instanceof TRPCError)) return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: INFRA_UNAVAILABLE_MESSAGE });
  if (err.code === "INTERNAL_SERVER_ERROR") {
    return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: maskInfraMessage(err.message) });
  }
  return err;
}

/** AdminAuthResult 非 ok 非 invalid 分支→错误映射单点（R7-c78-④）：cabinGate/requireAdmin 同引——
 *  revoked/rejected→401、ledger_unavailable→500 显因的映射不再双抄（会话清理行为两闸锁步） */
export function throwForAdminAuthFailure(r: { ok: false; reason: "revoked" | "rejected" | "ledger_unavailable" }): never {
  if (r.reason === "ledger_unavailable") throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: LEDGER_UNAVAILABLE_MESSAGE });
  if (r.reason === "revoked") throw new TRPCError({ code: "UNAUTHORIZED", message: REVOKED_DENIED_MESSAGE });
  throw new TRPCError({ code: "UNAUTHORIZED", message: ADMIN_REQUIRED_MESSAGE }); // rejected（停用/坏行硬拒）
}

/** 吊销端点话术群（R7-c78-⑥ 单源）：authLock 同引——内联字面量漂移面封死（super 闸话术与 adminAuth.setDisabled 的 parity 谎言同收） */
export const SELF_REVOKE_DENIED_MESSAGE = "不得吊销自身当前会话";
export const SUPER_REVOKE_DENIED_MESSAGE = "超管账号不可吊销（防自锁）";
export const REVOKE_PLATFORM_ONLY_MESSAGE = "吊销权限仅限平台管理员";

/** KB 面角色要求统一话术（R7-c77-⑥ 单源）：kbActor 活会话非 admin/非 staff 的 403 口径——活错不清（避开 isWbAuthError 正则） */
export const KB_ROLE_REQUIRED_MESSAGE = "无权访问知识库（需要管理员或部门成员权限）";

/** 吊销拒绝统一话术（R7-c19-① 单源）：确证吊销的 401 口径 */
export const REVOKED_DENIED_MESSAGE = "需要管理员权限";

/** 非 wb 身份高位偏移（R7-c65-⑦/R7-c68-⑤ P-ID-SPACE 收口——命名空间偏移方案，按源序列分带）：
 *  st_chat_threads/st_meetings 的 userId/createdBy 系 wb_users 空间（低段，BIGINT UNSIGNED——负数面不可用）；
 *  非 wb 身份按【源表序列】分带映射（R7-c68-⑤ security：st_staff_accounts 与 st_admin_accounts 是各自从 1 自增的独立序列——
 *  单带共享会同号同键=撞号面假收口，故每序列独占一带）：staff/委派席（st_staff_accounts 序列）→+1e12 带；
 *  原生超终席（st_admin_accounts 序列，adminOrigin==="native" 判别）→+2e12 带。三段永不相交=撞号面物理封死且在产行为零变化。
 *  既有存量（R7-c67-⑦ 显式处置）：切换前低段旧键历史行孤儿化（旧键查询 NOT_FOUND+静默重开复线程——不回迁不静默）；
 *  一次性回填随部署 db/sync-pid-space-legacy.mts（按源带回迁且无歧义才动：席位命中+wb 无同号+他席位无同号），
 *  残余口径/发布清单见 ops/P-ID-SPACE-LEGACY.md */
export const NON_WB_ID_OFFSET = 1_000_000_000_000; // st_staff_accounts 带（staff/委派席同一序列——远低于 BIGINT UNSIGNED 上限 1.8e19）
export const NON_WB_ADMIN_ID_OFFSET = 2_000_000_000_000; // st_admin_accounts 带（原生超终席——独立自增序列独占带，R7-c68-⑤：与 staff 带同号不再同键）

/** 委派/员工标记判别单点（R7-c50-③/R7-c65-⑦/R7-c84-⑥ 上收 identity 叶——消费端直引本文件；adminGate 再出口零消费实证已摘除，勿从旧路径引） */
export function isDelegatedSeat(x: unknown): boolean {
  return typeof x === "object" && x !== null && (x as { delegated?: unknown }).delegated === true;
}

/** 线程/会议归属 id 单点（R7-c65-⑦/R7-c68-⑤/R7-c84-⑤）：非 wb 身份按源序列分带映射（原生席须带 adminOrigin 判别——
 *  DelegatedAdminIdentity/MeetingActor 判别联合已编译期钉死：原生席构造漏标即红），wb 行原样——
 *  消费端读写 st_chat_threads.userId/st_meetings.createdBy 一律经本点（撞号面收口；
 *  R7-c111-③ 措辞诚实化：编译期钉在【构造端】判别联合——本点为运行期归一，松散结构签名系刻意（wb 行无标记落低段系契约）；
 *  「标记缺席」不可检——靠构造端钉；「标记在场但毁损」由下方守卫炸显因） */
export function wbThreadUserId(x: { id: number; delegated?: unknown; kind?: string; adminOrigin?: string }): number {
  if (x.adminOrigin === "native") return x.id + NON_WB_ADMIN_ID_OFFSET; // R7-c68-⑤：原生席独立带（先于 delegated 判——原生也带 delegated:true）
  // R7-c89-⑥ security medium：可检漂移断言——delegated 键在场但非布尔=标记被摊拷/弱类型化毁损（fail-closed 炸显因，
  //  不默落 wb 低段撞号面）；「标记缺席」系不可检情形——由 DelegatedAdminIdentity/MeetingActor 判别联合编译期钉（R7-c84-⑤）
  // R7-c98-⑦ bug low：adminOrigin 对称守卫——在场但非 "native"=标记被摊拷/弱类型化毁损（fail-closed 炸显因不默落 staff 带撞同号席）；
  //  与 delegated 守卫同纪律（两判别标记同硬度）
  if ("adminOrigin" in x && x.adminOrigin !== undefined && x.adminOrigin !== "native") {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: INFRA_UNAVAILABLE_MESSAGE }); // R7-c99-⑥：守卫改 TRPCError（裸 Error 冒泡=tRPC 格式化透栈/内文面封死——脱敏显因）
  }
  if ("delegated" in x && typeof x.delegated !== "boolean") {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: INFRA_UNAVAILABLE_MESSAGE }); // R7-c99-⑥：同上（标记漂移=服务端 bug——500 显因不泄内）
  }
  if (isDelegatedSeat(x) || x.kind === "staff") return x.id + NON_WB_ID_OFFSET;
  return x.id;
}


/** 通用 infra 不可用统一话术（R7-c26-⑨ 单源）：非台账类的服务 infra 失败 500 显因——话术对客户端行为有载（isWbAuthError 正则），手抄近似句=drift 面 */
export const INFRA_UNAVAILABLE_MESSAGE = "服务暂不可用，请稍后重试";
/** 通用客户端话术群（R7-c74-① 单源）：streamBus 4xx 固定话术等未认证面同引——内联字面量漂移面封死（「话术皆单源常量」契约兑现） */
export const REQUEST_INVALID_MESSAGE = "请求参数非法";
export const FORBIDDEN_GENERIC_MESSAGE = "无权限执行本操作";
export const NOT_FOUND_MESSAGE = "资源不存在";
export const CONFLICT_MESSAGE = "请求冲突";
export const PRECONDITION_MESSAGE = "前置条件未满足";
export const RATE_LIMIT_MESSAGE = "请求过于频繁";
/** 会话失效统一话术（R7-c40-① 单源）：wbSession.sessionMe 抛出 + streamBus 三处回包同引——isWbAuthError 正则（token 无效|未登录|已失效）锚定本话术，手抄即漂移即清会话行为漂移 */
export const SESSION_INVALID_MESSAGE = "token 无效或已过期";


/** 确证鉴权失败谓词（R7-c40-② 单源）：只认 TRPCError+UNAUTHORIZED——401/500 分流是 M65 清会话口径的载重支，四处方不再各抄 */
export function isAuthFailure(err: unknown): boolean {
  return err instanceof TRPCError && err.code === "UNAUTHORIZED";
}
/** 会议/枢总域权限话术单源（R7-c35-①）：terminalMeetings 同引（治理席/部门负责人双轨）——话术常量化防 grep 漂移 */
export const MEETING_ROLE_REQUIRED_MESSAGE = "会议/枢总仅 HQ 治理席或部门负责人可用";

/** MySQL 表未建错误判别（R7-c20-① 修正：errno 正本 1146——1149 是 ER_SYNTAX_ERROR，误判即 fail-open 降级）：
 *  判定器走 dupEntry.hasCauseChainMatch 共享 cause 链 walker（R7-c71-⑧：isDupErr 转发别名已摘）（仓级唯一来源——深度/包装演进单源，不手抄第三份链走）；
 *  吊销表未建=无吊销可存（recordRevocation 同表 INSERT 为前提） */
export function isNoSuchTable(e: unknown): boolean {
  return hasCauseChainMatch(e, { code: "ER_NO_SUCH_TABLE", errno: 1146 }); // R7-c52-③/R7-c60-②：中性原语正名（名随实——不与撞键语义耦合）
}

/** ER_BAD_FIELD_ERROR（1054 列漂移）判别（R7-c86-②/R7-c106-⑧）：code/errno 任一命中（hasCauseChainMatch 系 OR 判定——「双证」误读面封死；裸 errno 字面量=驱动/版本异形静默漏判面封死——仓规判别皆命名谓词） */
export function isBadFieldErr(e: unknown): boolean {
  return hasCauseChainMatch(e, { code: "ER_BAD_FIELD_ERROR", errno: 1054 });
}

/** ER_TABLEACCESS_DENIED_ERROR（1142 权限拒）判别（R7-c86-②/R7-c106-⑧）：同上——code/errno 任一命中 */
export function isTableAccessDenied(e: unknown): boolean {
  return hasCauseChainMatch(e, { code: "ER_TABLEACCESS_DENIED_ERROR", errno: 1142 });
}

const RESOLUTION_BRAND: unique symbol = Symbol("wbRevocationVerdict"); // R7-c21-③：判别结果品牌键——调用方不可伪造 "ok" 跳过查验（编译期闸+运行期验键；误用防线口径：同包头恶意代码无防线可言，同 ResolvedWbIdentity 头注）

/** 吊销判别三态（R7-c20-②） */
export type RevocationResolution = "ok" | "revoked" | "ledger_unavailable";

/** 吊销判别品牌结果（R7-c21-③/R7-c22-①）：唯 resolveRevocation 可产出——forgeable string 参数面封口（编译期 unique symbol 闸）；
 *  fp=token 指纹绑定：A 的判别结果喂给 B 即回退真查（跨 token 复用=fail-open 方向，钉死不留） */
export interface RevocationVerdict {
  readonly [RESOLUTION_BRAND]: true;
  readonly fp: string;
  readonly state: RevocationResolution;
}

/** 运行期验键（R7-c21-③）：伪造/摊拷的判别对象（品牌键不可枚举，字面量造不出）不采信——回退真查（fail-closed 方向：宁可二查不放行） */
function isVerdict(v: unknown): v is RevocationVerdict {
  return typeof v === "object" && v !== null && (v as Record<PropertyKey, unknown>)[RESOLUTION_BRAND] === true;
}

function mintVerdict(token: string, state: RevocationResolution): RevocationVerdict {
  const v = { fp: tokenFingerprint(token), state } as RevocationVerdict; // R7-10-④ unknown 中转同范（品牌键运行期注入、类型面无键）；fp 指纹绑定（R7-c22-①）
  Object.defineProperty(v, RESOLUTION_BRAND, { value: true, enumerable: false });
  return Object.freeze(v);
}

/** 吊销解析单点（R7-c20-②/R7-c21-③）：isRevoked + ER_NO_SUCH_TABLE 降级 + infra 判别——一份解析多处映射，安全敏感路径不双抄；
 *  返回品牌结果：requireAdmin 上提后分派前判决+admin 支产证复用同一份（每请求吊销查询恒一次——P-PERF 双查摘除） */
export async function resolveRevocation(token: string): Promise<RevocationVerdict> {
  try {
    return mintVerdict(token, (await isRevoked(token)) ? "revoked" : "ok");
  } catch (e) {
    if (isNoSuchTable(e)) {
      // R7-c53-③/R7-c54-① security medium：缺表降级改为显式 opt-in（REVOCATION_TABLE_OPTIONAL=1 才放行）——pre-migration 环境显式声明，
      //  旧「按未吊销降级」日志摘除（fail-closed 路径会谎报降级——triage 误导面封死；观测钉在下方两支各自）
      //  已迁移生产若表被删/改名/错路由（同样 1146）不再静默放行已吊销凭证，走 ledger_unavailable 显因 500；观测钉走节流链不洪灌：
      // R7-c62-④/R7-c75-①/R7-c77-①/R7-c78-⑨ security high 收口：opt-in 真白名单化——谓词单点同引（模块载入警报同条件）；
      //  NODE_ENV 未设/错拼/staging/生产一律 fail-closed（deny-list 下 staging/unset 被当非生产=降级放行已吊销凭证 fail-open 面封死）
      if (revocationTableOptionalEnabled()) {
        logQueryErrorThrottled("[SECURITY][auth/identity] st_token_revocations 不可达被按缺表降级（opt-in 旗在场）——已吊销凭证此刻可通行！若本环境本应已建表，立即核查库路由/迁移态", e);
        return mintVerdict(token, "ok");
      }
      logQueryErrorThrottled(`[auth/identity] 吊销台账缺表且 opt-in 未生效（REVOCATION_TABLE_OPTIONAL=${process.env[FLAG_REVOCATION_TABLE_OPTIONAL] ?? "未配"}, NODE_ENV=${process.env.NODE_ENV ?? "未设"}）——fail-closed 显因 500`, e); // 门禁 PR#9-r31-④：诊断 env 读归旗名常量（旗名一改全链编译期锁步） // R7-c69-④：措辞如实化——旗已配但被生产闸压制的路径不再谎报「未 opt-in」（triage 不跑偏）
      return mintVerdict(token, "ledger_unavailable");
    }
    // R7-c147-⑪：isRevoked 抛的 TRPCError 源处已带准确上下文留痕（标记缺席/探针漂移两支）——本层不重记
    //  （双记+误标 (infra)=triage 污染面封死——1146 良性道不再双通道同修类）；其余原始故障照记（脱敏链出口）
    if (!(e instanceof TRPCError)) logQueryErrorThrottled("[auth/identity] 吊销台账查验失败（infra）", e);
    return mintVerdict(token, "ledger_unavailable");
  }
}

/** 判别结果采纳单点（R7-c23-①）：品牌键（isVerdict）+ 指纹绑定（fp===token 指纹）双验——伪造/跨 token 一律拒采
 *  （回退真查，fail-closed）；安全敏感判定不双抄（assertNotRevoked/authenticateAdmin 同引本点） */
function pickVerdict(token: string, v?: RevocationVerdict): RevocationVerdict | undefined {
  return v !== undefined && isVerdict(v) && v.fp === tokenFingerprint(token) ? v : undefined;
}

/** 判别采纳单点（R7-c48-⑤）：采纳或回退真查一处——assertNotRevoked/authenticateAdmin 同引（采纳/回退策略演进不双抄） */
async function adoptVerdict(token: string, verdict?: RevocationVerdict): Promise<RevocationVerdict> {
  return pickVerdict(token, verdict) ?? await resolveRevocation(token);
}

/** 吊销判决统一出口（R7-c21-①/R7-c22-① security high 收口）：requireAdmin 系三支分派（wb_users/委派 staff/超终原生 st_admin_accounts）前调用——
 *  旧闸只挂 wb_users admin 支，revoked 凭证经回退支拿全量权限=缺口；infra 失败回退支不再静默放过；
 *  verdict 双验经 pickVerdict 单点（A 结果喂 B/伪造对象一律回退真查——fail-closed 方向） */
export async function assertNotRevoked(token: string, verdict?: RevocationVerdict): Promise<void> {
  const v = await adoptVerdict(token, verdict); // R7-c48-⑤：单点
  if (v.state === "revoked") throw new TRPCError({ code: "UNAUTHORIZED", message: REVOKED_DENIED_MESSAGE });
  if (v.state === "ledger_unavailable") throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: LEDGER_UNAVAILABLE_MESSAGE });
}

/** disabled 域判单源（R7-c128-⑨/R7-c129-④⑨/R7-c153-⑥）：0=活 / 1=死 / 域外=死（fail-closed——raw SQL 直写 TINYINT 可达域外值，
 *  漂移行绝不静默当活会话）；authenticateAdmin 产证前判与 staffTrack 探活同引——双轨存活口径锁步不漂移。
 *  ⚠️ R7-c153-⑥ bug low 实况钉：wb_users 主径经 drizzle boolean() 映射——驱动层域外值（2/-1）在 ORM 处预坍缩为 false
 *  （mapFromDriverValue：value===1 才真）——本谓词的域外闸对【ORM 映射径】结构性不可达（漂移在 ORM 层已 fail-open 成活）；
 *  本谓词真实守护面=raw SQL 径（staff/staffTrack 的 st_staff_accounts 读——mysql2 原始数字可达）；wb 域外残余面挂账
 *  P-WB-DISABLED-RAW（演进向：auth 取行改 raw SQL 读原始值，或 schema 换 int()）——ops 层纪律：wb_users 绝不 raw SQL 直写 */
export function isDisabledOrDriftDead(v: unknown): boolean {
  if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return true; // R7-c131-⑧/R7-c133-⑪ bug low：缺值/空值（含纯空白串）=漂移→死（Number(null/""/" ")===0 会把未知行误判活会话=fail-open 偏差封死——与 coerceFiniteId 空白闸同口径；布尔 0/1 行为不变）
  const n = Number(v);
  // R7-c153-③：布尔冗余化简——整数域上 (n≠0∧n≠1)∨n===1 ⟺ n≠0（冗余项遮蔽真规则=未来改错面封死）
  return !Number.isInteger(n) || n !== 0;
}

/** 特权身份唯一产线入口（R7-c10-②）：auth 层自读库——唯 DB 核验行可品牌化（API 形状即闸，纪律+哨兵退居二线）。
 *  七-c 接线处：requireAdmin 调本函数取证（不再自行 select 后喂行）。同闸口径：严格 role==="admin"（owner 存量行 401 不另开通道，R7-15-②）。
 *  R7-c14-②/R7-c18-①：产证前先查吊销台账（isRevoked）——三态判别出口（见 AdminAuthResult）；台账 infra 失败绝不折叠成 401（未迁库环境全场管理端被踢登录页=M65 事故复刻）。
 *  R7-c19-②/R7-c53-③/R7-c54-①：ER_NO_SUCH_TABLE 降级须显式 opt-in（REVOCATION_TABLE_OPTIONAL=1）——表未建=无吊销可存时放行；
 *  已迁移环境未配旗则 fail-closed 显因 500（表被删/错路由不再静默放行已吊销凭证） */
export async function authenticateAdmin(token: string, verdict?: RevocationVerdict): Promise<AdminAuthResult> {
  // R7-c14-② security medium 收口：产线先查吊销台账再产证——吊销 token 不得铸证（账本不再惰性）；
  // R7-c20-②/R7-c21-③/R7-c22-①：verdict 传入即复用（双验：品牌键+指纹绑定——A 结果喂 B/伪造一律回退真查，fail-closed）
  const rev = (await adoptVerdict(token, verdict)).state; // R7-c23-①/R7-c48-⑤：采纳单点
  if (rev === "revoked") return { ok: false, reason: "revoked" };
  if (rev === "ledger_unavailable") return { ok: false, reason: "ledger_unavailable" };
  const db = getDb();
  let user: WbUser | undefined;
  const tokenFp = authTokenHash(token); // P3-6 双轨读面：先 hash（新颁全走指纹）；miss 再查明文（过渡窗存量）——明文命中即惰性迁移
  try {
    [user] = await db.select().from(wbUsers).where(eq(wbUsers.authToken, tokenFp)).limit(1);
    if (!user) {
      [user] = await db.select().from(wbUsers).where(or(eq(wbUsers.authToken, tokenFp), and(eq(wbUsers.authToken, token), authTokenPlaintextGuard()))).limit(1); // 并查双形（并发迁移竞态=有效会话假 401 面封死；明文腿限非指纹形态——pass-the-hash 面同封）
      if (user) {
        const legacyId = user.id;
        void db.update(wbUsers).set({ authToken: tokenFp }).where(and(eq(wbUsers.id, legacyId), eq(wbUsers.authToken, token)))
          .catch((e: unknown) => logQueryErrorThrottled("[auth/identity] authToken 惰性迁移失败", e)); // 迁移败不炸登录（下次登录再迁——扫尾脚本兜底）
      }
    }
  } catch (e) {
    // R7-c30-⑧ security medium：wb_users 取行包裹——本路径最后一条裸查询面封死；原始 Drizzle 错误内嵌 SQL+明文 authToken，
    //  tRPC 默认 errorFormatter 会透给调用方——脱敏留痕+INFRA 500 显因（同委派/原生支口径）
    logQueryErrorThrottled("[auth/identity] wb_users 取行失败（infra/schema 漂移）", e);
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: INFRA_UNAVAILABLE_MESSAGE });
  }
  if (!user) return { ok: false, reason: "invalid", rowFound: false }; // R7-c74-⑥：无此行=死会话子态（401 语义）
  // R7-c128-⑨/R7-c129-④ security medium：disabled 域判 fail-closed【先于产证】——0 活/1 死/域外死（raw SQL 直写 TINYINT 可达域外值；
  //  漂移行不分角色恒 rejected——admin 行漂移不再经 mint 的 Number()===1 窄判漏放成活 admin（c129 实证：置 !ev 支内=admin 漂移行不可达）；
  //  staffTrack 探活同谓词锁步——双轨存活口径单源）
  if (isDisabledOrDriftDead(user.disabled)) return { ok: false, reason: "rejected" }; // R7-c98-⑧：停用行不分角色恒 rejected（死会话——cabinGate「死→401 清会话」契约闭环）
  const ev = mintAdminEvidence(user); // 私有产线直调（同模块即 DB 核验现场，不经武装闸）
  // R7-c23-③：「无此 token」与「admin 行被闸拒」分立——admin 行形状闸不过（空 hash/厂号非法）=rejected 硬 401 不落回退支
  //  （旧支内即拒语义钉回；disabled 维已在上游域判恒截）；role!=="admin" 行仍 invalid 走回退（同旧口径）
  if (!ev) {
    // R7-c74-⑥：拆序不嵌套三元（仓规）——admin 行形状闸不过=rejected（硬 401 不落回退支，无 rowFound 键——判别联合型钉）；
    //  活行非 admin=invalid+rowFound:true（403 留页语义）
    if (user.role === "admin") return { ok: false, reason: "rejected" };
    return { ok: false, reason: "invalid", rowFound: true };
  }
  // R7-c45-③/R7-c78-⑤ security：凭据列物理剥离走字段单源循环（rest 解构的名单手抄面封死—— Omit 型与运行期同引 WB_STRIPPED_FIELDS）；
  //  as 收窄在此合法：剥离循环刚执行完（证据现场），非谎 shape
  const safeRow: Partial<WbUser> = { ...user };
  for (const f of WB_STRIPPED_FIELDS) delete safeRow[f];
  return { ok: true, evidence: ev, row: safeRow as SafeWbUser };
}

/** 特权角色唯一产线（品牌证据）：boss=HQ 名单内、admin=名单外；委派治理席证据七-c 在 DB 核验现场内联 mint（本骨架不开），
 *  届时 delegated=true 证据进本函数按 boss 判（同 requireHqAdmin/isHqPrincipal 口径） */
export function lockRoleOfWbUser(user: ResolvedWbIdentity | null | undefined, hqFactoryIds: readonly number[]): Role {
  if (user === null || typeof user !== "object") return "guest";
  // R7-9-③ high 收口：运行期验品牌——RESOLVED_IDENTITY 为模块级 unique symbol 且不可枚举，
  //  字面量直造/摊拷翻转（{...ev, delegated:true}）都过不了本闸（品牌不只是编译期装饰）
  // R7-b-④→R7-b-⑤：验真身名册（MINTED WeakSet 本体登记）——[[Get]]/Object.hasOwn 都可被 Proxy 伪造（getOwnPropertyDescriptor 陷阱任意答）,
  //  本体名册攻不破；上方品牌写入块同步：不可枚举防摊拷+冻结防改写（三层齐备，注释与实现对齐——R7-b4-① 清账）
  if (!MINTED.has(user)) return "guest";
  // R7-b7-①：roleOfEvidence 退役（无品牌谓词出口是可绕真身闸的替代特权路径）——委派语义内联回本函数：
  if (user.delegated) return "boss"; // R7-5-④：委派治理席全权（同 requireHqAdmin 口径）——R7-c8-③ 挂账：本支当前不可达系七-c 前向支（asDelegatedIdentity 出厂后可达且接 HQ 语义不变），勿摘；届时接线测试钉
  return user.factoryId !== null && hqFactoryIds.includes(user.factoryId) ? "boss" : "admin";
}
