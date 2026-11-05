/**
 * 超终原生账号 token 查验（批七-c R7-c24-①）：从 routers/adminAuth 下沉 auth 层——
 *  adminGate 的 M64 第三层回退直引本模块（静态 import），分层契约复原（auth 层不伸手路由层，R7-14-③）；
 *  adminAuth.ts 再出口保持既有 import 路径不破。
 */
import { sql } from "drizzle-orm";
import { authTokenHash, authTokenPlaintextGuard } from "./revocation"; // P3-6 落库哈希单点+明文腿守卫（去重合并）
import { getDb } from "../queries/connection";
import { rawRows, logQueryErrorThrottled } from "../queries/rawRows"; // 单条 import 合并（R7-c25-②）
import { isNoSuchTable } from "./identity"; // 同层同引（缺表降级判别单源）

export type AdminAccountRow = {
  id: number; // R7-c39-③：mapper 恒产强转+finite 的 number——类型收窄让消费端不再防御性 Number()（不变式显式化）
  username: string;
  passwordHash: string;
  displayName: string;
  role: string;
  disabled: number;
  authToken?: never; // R7-c49-①：凭据列摘帽——零消费端实证，映射不再产 authToken（login 不写不读）
  // R7-c129-⑩：phone 同例摘帽（零消费端实证——adminAuth:379 系另查询不读本型；且唯一绕 coerceNonEmptyString 闸的串列=漂移静默 String 化面）
};

/** 有限数字字段闸单点（R7-c40-⑥/R7-c68-⑧）：在场性（null/undefined/""）+ finite 强转——委派支与原生映射同引（漂移不变式不双抄）；
 *  tag=调用方来源标签（委派支传 "[auth/adminGate]"——委派行漂移不再挂本模块前缀误 triage 到 st_admin_accounts） */
export function coerceFiniteId(v: unknown, label: string, min = -Infinity, tag = "[auth/nativeAdmin]"): number {
  if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) throw new Error(`${tag} ${label} 缺列/空白串——schema 漂移面`); // R7-c42-⑧：Number(" ")=0 静默面封死
  // R7-c129-⑪/R7-c131-⑦ bug low：字符串域钉——"0x1f"/"1e3"/" 12 " 型宽松解析不再静默归一（与 hqFactoryIds 字符串域钉同硬度；
  //  域外串→NaN 由下方 isFinite 闸接住 fail-closed）；嵌套三元展开（仓规）
  let n: unknown = v;
  if (typeof v === "string") {
    n = /^-?\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
  }
  // R7-c160-⑨ bug low：isFinite+isInteger 对 >2^53 双 true——Number 失精（9007199254740993→...992）照样放行=
  //  恰系本闸宣称拦的 schema/驱动漂移类却流入 id 合成/审计归属；isSafeInteger 一钉含 finite+integer+安全界
  if (typeof n !== "number" || !Number.isSafeInteger(n)) throw new Error(`${tag} ${label} 非安全整数/NaN（含 >2^53 失精——BIGINT UNSIGNED 漂移）——schema 漂移面`); // R7-c42-⑧：非整数（"1.5"）入 id/disabled 面封死
  if (n < min) throw new Error(`${tag} ${label} 越下界（<${min}）——id=0/负数入产线合成身份是 fail-open 面`); // R7-c56-③：id 下界钉（min 参数——disabled 的 0 合法不受影响）
  return n;
}

/** disabled 域闸单点（R7-c62-⑥）：域钉 {0,1}——域外漂移值（2/-1）fail-closed（静默当「未停用」=fail-open 面封死；
 *  adminGate 委派/原生两臂+login/setPassword 同引本点——域钉不再两臂各写各漂移） */
export function coerceDisabledFlag(v: unknown, label: string, tag = "[auth/nativeAdmin]"): 0 | 1 { // R7-c68-⑧：tag 透传字段闸（调用方来源标签单链）
  const n = coerceFiniteId(v, label, -Infinity, tag);
  if (n !== 0 && n !== 1) throw new Error(`${tag} ${label} 域外值（disabled 只认 0/1）——schema 漂移面`);
  return n as 0 | 1;
}
/** 超管角色判别谓词单源（R7-c81-② security medium）：authLock 防自锁闸+adminAuth.setDisabled 停用闸同引——
 *  utf8mb4_ci 列语义对齐（trim+小写——库存 "Super"/"SUPER"/带空白照样命中，闸不再静默空转）；两闸不再各抄字面量漂移 */
export function isSuperRole(v: unknown): boolean {
  return typeof v === "string" && v.trim().toLowerCase() === "super";
}

/** admin 角色判别谓词单源（R7-c83-⑦ bug medium）：与 isSuperRole 同口径归一——库存 "Admin"/"admin "
 *  在登录路径（isSuperRole 二分）照常进，原生支白名单不再把它们拒成无席（同谓词两臂刚性不一致面封死） */
function isAdminRole(v: unknown): boolean { // R7-c128-⑩：零外部消费实证摘出口（adminAuth 已改 isAdminWhitelistedRole——幻影出口不养；内部经 isAdminWhitelistedRole 可达）
  return typeof v === "string" && v.trim().toLowerCase() === "admin";
}

/** head 角色判别谓词单源（R7-c87-⑧ bug low）：委派支 head 闸同引——utf8mb4_ci 对齐（trim+小写——"Head"/"HEAD"/带空白不误伤读救通道） */
export function isHeadRole(v: unknown): boolean {
  return typeof v === "string" && v.trim().toLowerCase() === "head";
}

/** 颁证白名单谓词单点（R7-c111-⑤）：admin/super 复合——login/setPassword 两颁证点+原生支同引
 *  （双点手写复合=漂移面封死——「颁证即守白名单」不变式结构化） */
export function isAdminWhitelistedRole(v: unknown): boolean {
  return isAdminRole(v) || isSuperRole(v);
}

/** 非空串字段闸单点（R7-c72-③）：username/displayName 等「非空 string」契约——委派支（adminGate）与原生映射同引
 *  （双抄漂移面封死——契约演进如 trim/加列只改本点；tag=调用方来源标签，委派漂移不挂本模块前缀误 triage） */
export function coerceNonEmptyString(v: unknown, label: string, tag = "[auth/nativeAdmin]"): string {
  if (typeof v !== "string" || v.trim() === "") throw new Error(`${tag} ${label} 非空串闸不过（实际 ${typeof v}）——schema 漂移面`); // R7-c75-③：纯白串同拒（与 coerceFiniteId 的 trim 口径对齐——空白名织入委派身份/审计名面封死；返回值不 trim——原文语义不动）
  return v;
}

/** 行→类型化映射（R7-c26-①）：列名漂移/缺列在此炸显因——不再 as unknown as 全关检查
 *  （Number(undefined)=NaN 静默入产线合成身份的旧面封死；fail-closed：缺必要列即抛，由 adminGate 收 500） */
export function toAdminAccountRow(r: Record<string, unknown>): AdminAccountRow { // R7-c27-②：导出——st_admin_accounts 全读取路径复用（adminAuth.login 旧 as unknown as 谎 shape 面封死）
  const idNum = coerceFiniteId(r.id, "id", 1); // R7-c40-⑥/R7-c41-⑧/R7-c56-③/R7-c58-①：共享闸单点（在场性+finite+id 下界 min=1——空串/NaN/0/负数静默面全封；与委派支 delegateNum(id,1) 同下界，两臂不再分叉）
  const disabledNum = coerceDisabledFlag(r.disabled, "disabled"); // R7-c30-⑥/R7-c31-①/R7-c62-⑥：域钉 {0,1} 在本点（域外漂移值 fail-closed——login/setPassword/adminGate 两臂全走本映射）

  // R7-c36-③/R7-c38-⑤/R7-c43-⑦/R7-c72-③：空串/非串同闸走共享单点（非串值被 String() 静默织入审计名面封死；
  //  四列联合判断拆为逐列闸——契约单源化，委派支同引不再双抄）
  const username = coerceNonEmptyString(r.username, "username");
  const passwordHash = coerceNonEmptyString(r.passwordHash, "passwordHash");
  const role = coerceNonEmptyString(r.role, "role"); // R7-c37-①：role 在闸内（漂移误诊面封死）
  const displayName = coerceNonEmptyString(r.displayName, "displayName");
  return {
    id: idNum,
    username, // R7-c72-③：闸后具名 const（shared 闸返回值即收窄串——element-access 窄化随闸函数化失效，直用闸产物）
    passwordHash,
    displayName, // R7-c47-⑥：String() 重收窄摘除（与 role 同口径）
    role, // R7-c38-③/R7-c43-⑥：防御性强转旧习不回流
    disabled: disabledNum,

  };
}

/** 按 token 查超终原生账号（requireAdmin 第三层回退用；表缺失返回 null 不炸） */
export async function findNativeAdminByToken(token: string): Promise<AdminAccountRow | null> {
  let rows: Array<Record<string, unknown>>;
  const tokenFp = authTokenHash(token);
  try {
    rows = rawRows(
      await getDb().execute(
        sql`SELECT id, username, passwordHash, displayName, role, disabled
            FROM st_admin_accounts WHERE authToken = ${tokenFp} LIMIT 1`, // R7-c51-③：凭据列出投影；P3-6 先 hash
      ),
    );
    if (rows.length === 0) {
      // 双轨兜底（过渡窗存量明文）；明文命中即惰性迁移（扫尾脚本兜底）
      rows = rawRows(
        await getDb().execute(
          sql`SELECT id, username, passwordHash, displayName, role, disabled
              FROM st_admin_accounts WHERE (authToken = ${tokenFp} OR (authToken = ${token} AND ${authTokenPlaintextGuard()})) LIMIT 1`, // 并查双形（并发迁移竞态=有效会话假 401 面封死）；明文腿限非指纹形态（pass-the-hash 面同封）
        ),
      );
      if (rows.length > 0) {
        const legacyId = Number(rows[0].id);
        void getDb().execute(sql`UPDATE st_admin_accounts SET authToken = ${tokenFp} WHERE id = ${legacyId} AND authToken = ${token}`)
          .catch((e) => logQueryErrorThrottled("[auth/nativeAdmin] authToken 惰性迁移失败", e)); // 迁移败不炸鉴权（下次再迁）
      }
    }
  } catch (e) {
    // R7-c24-⑪/R7-c41-⑦：只容「表未建」降级；真 infra 失败留痕上行；行映射漂移错不在本 try（标签分离——
    //  triage 不再把 schema 漂移当 infra 找连接问题）
    if (isNoSuchTable(e)) return null;
    logQueryErrorThrottled("[auth/nativeAdmin] st_admin_accounts 查验失败（infra）", e);
    throw e;
  }
  if (!rows[0]) return null;
  try {
    return toAdminAccountRow(rows[0]); // 漂移显因上行
  } catch (e) {
    // R7-c42-⑦：映射漂移在本单点留痕——调用方（adminGate/adminAuth）以空捕折叠为 500，此处不留痕即失联
    logQueryErrorThrottled("[auth/nativeAdmin] st_admin_accounts 行映射失败（schema 漂移）", e);
    throw e;
  }
}
