/**
 * NumX Max 智能工作台 —— 业务层共享辅助（鉴权 / 凭据 / 评分）。
 *
 * 依据《NumX Max 智能工作台 API 文档（匠台对接版）》已核实事实：
 * - 所有 procedure 均为 publicQuery 声明，框架层无自动鉴权；
 *   需要登录态的接口在请求体携带 token 字段，由业务层 sessionMe(token) 校验。
 * - token 单点有效：nt_ 前缀，重新登录 / SSO 消费 ticket 后重颁并覆盖 wb_users.authToken。
 * - ticket（st_+48hex）与 publishKey（pk_+48hex）明文仅签发响应返回一次，库只存 sha256。
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { authTokenHash, authTokenPlaintextGuard } from "../auth/revocation"; // P3-6 落库哈希单点+明文腿守卫（去重合并）
import { logQueryErrorThrottled, rawRows } from "../queries/rawRows"; // 惰性迁移失败留痕+拆包单点（wb#70 钉）
import { and, eq, or, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "../queries/connection";
import { wbUsers, wbFactories, wbDeptHeads, type WbUser, type WbFactory } from "@db/schema";
import { normalizeRole, type WbRole } from "@contracts/dialect"; // R7-8-①/R7-17-⑥：同模块单条 import（value+type 合一）
import { SESSION_INVALID_MESSAGE, INFRA_UNAVAILABLE_MESSAGE } from "../auth/identity"; // R7-c40-①：会话失效话术单源（isWbAuthError 正则锚定——手抄即漂移）

/** 文档核实的落地页白名单 */
export const WB_TARGETS = [
  "/dept",
  "/dashboard",
  "/market",
  "/showroom",
  "/skillmall",
  "/org",
] as const;

export const WB_TICKET_TTL_SECONDS = 300;
export const WB_DEFAULT_SOURCE = "craftsman-market";

// ─── 凭据生成 / 哈希 ─────────────────────────────────────────────────────────
/** 生成一次性明文凭据：prefix + 48 hex（M16 iv_ 邀请码；M17 pd_ 配对码/dt_ 设备凭证；ps_ 配对信号；qs_ 管理台轮询密语） */
export function newCredential(prefix: "st_" | "pk_" | "nt_" | "iv_" | "pd_" | "ps_" | "dt_" | "qs_"): string {
  return `${prefix}${randomBytes(24).toString("hex")}`;
}

export function sha256(plain: string): string {
  return createHash("sha256").update(plain, "utf8").digest("hex");
}

// ─── 密码（scrypt + salt，node crypto，存储格式 salt:hash 均为 hex）──────────
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 32);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

// ─── sessionMe(token)：业务层显式鉴权（token 在请求体字段，非 header）────────
export interface WbSession {
  user: WbUser;
  factory: WbFactory;
}

/** wb_users token 双轨解析单点（P3-6 门禁 critical：写面指纹化后读面必须全走双轨——各站自查必漂移=有效会话 401 静默强退面；
 *  hash 先明文后（过渡窗存量），明文命中即惰性迁移（败不炸鉴权——扫尾脚本兜底）；驱动错掩 INFRA（原始 Drizzle 错误内嵌 SQL+明文 token——
 *  无 errorFormatter 逐字回客户端面封死，identity.ts authenticateAdmin 同口径）。
 *  消费面：全部 wb_users.authToken 业务读点同引本件；admin 系特殊谓词面（identity authenticateAdmin/adminGate 带委派条件）保留自轨但同走
 *  authTokenHash/authTokenPlaintextGuard 单点——「单点」指业务读面，不谎称全仓唯一实现 */
export async function resolveWbUserByToken(db: ReturnType<typeof getDb>, token: string): Promise<WbUser | undefined> {
  const fp = authTokenHash(token);
  try {
    const [hit] = await db.select().from(wbUsers).where(eq(wbUsers.authToken, fp)).limit(1);
    if (hit) return hit;
    // qr 第三轨（扫码登录 wb token 面——2026-10-13 B 方案：与 authToken 双轨隔离，不顶 APP 登录态；
    //  命中条件=指纹中+会话 consumed（token 已取出）+wb_expires_at 未过）。
    //  qr 轨全容面：表未建/查询故障=留痕跳过（qr 是补充增强轨——它炸绝不拖死主登录链，测试网 mock 面实证钉）；
    //  真故障不静默=logQueryErrorThrottled 留痕（台账可查）。
    try {
      const qr = await db.execute(
        sql`SELECT u.* FROM st_qr_sessions q JOIN wb_users u ON u.id=q.user_id
            WHERE q.wb_token_hash=${fp} AND q.state='consumed' AND q.wb_expires_at>NOW() AND u.disabled=0 AND u.authToken IS NOT NULL LIMIT 1`, // 禁用即失效+吊销一致性（authToken NULL=登出/关闭/吊销=qr 同死；重颁=非空=多端面活——门禁 wb#72 security 钉）
      );
      const qrRows = rawRows(qr); // 单点收口（门禁 wb#70 钉：手工拆包面=非元组形态 mishandle 风险）
      // qr 轨行面：SELECT u.* 的列名与 wbUsers schema 键直对（rawRows 返 mysql2 原行列名——
      //  drizzle schema 的列名与属性名一致面=直对成立；列名漂移面挂账 P-QR-ROW-MAP，门禁 wb#72 钉）
      // qr 轨 raw 行归一（门禁 wb#72 钉：mysql2 原行 disabled=TINYINT 0/1 vs schema boolean——下游布尔判定面漂移封死）；
      //  列名与 schema 键直对（SELECT u.* 面——列名漂移面挂账 P-QR-ROW-MAP）
      if (qrRows[0]) {
        const row = qrRows[0] as Record<string, unknown>;
        return { ...row, disabled: Boolean(Number(row.disabled ?? 0)) } as unknown as WbUser;
      }
    } catch (qe) {
      logQueryErrorThrottled("[wbSession] qr 轨查询失败（跳过——主轨不破）", qe);
    }
    const [legacy] = await db.select().from(wbUsers).where(or(eq(wbUsers.authToken, fp), and(eq(wbUsers.authToken, token), authTokenPlaintextGuard()))).limit(1); // 第二查并查双形（并发迁移竞态：A 在本请求两腿间完成迁移时，单查明文腿=有效会话假 401 面封死——无论行处明文/已迁态同命中；pass-the-hash 仍封：输入为指纹时指纹支查的是 hash(指纹)≠库存指纹、明文胸被 guard 排除）
    if (legacy) {
      void db.update(wbUsers).set({ authToken: fp }).where(and(eq(wbUsers.id, legacy.id), eq(wbUsers.authToken, token)))
        .catch((e: unknown) => logQueryErrorThrottled("[wbSession] authToken 惰性迁移失败", e));
    }
    return legacy;
  } catch (e) {
    logQueryErrorThrottled("[wbSession] token 取行失败（infra/schema 漂移）", e);
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: INFRA_UNAVAILABLE_MESSAGE }); // 掩面（identity authenticateAdmin 同口径——原始错误内嵌 SQL+明文 token 不透客户端）
  }
}

export async function sessionMe(token: string): Promise<WbSession> {
  const db = getDb();
  const user = await resolveWbUserByToken(db, token); // 双轨单点同引（85+ 路由经本面——一处兜底全覆盖）
  if (!user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: SESSION_INVALID_MESSAGE });
  }
  const [factory] = await db
    .select()
    .from(wbFactories)
    .where(eq(wbFactories.id, user.factoryId))
    .limit(1);
  if (!factory) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: SESSION_INVALID_MESSAGE });
  }
  return { user, factory };
}

/** 重颁 nt_ token 并覆盖 wb_users.authToken（旧 token 立即失效，单点有效） */
export async function reissueToken(userId: number): Promise<string> {
  const db = getDb();
  const token = newCredential("nt_");
  await db.update(wbUsers).set({ authToken: authTokenHash(token) }).where(eq(wbUsers.id, userId)); // P3-6：落库只存指纹（明文不落库——返回面照发明文给客户端，bearer 语义不变）
  return token;
}

/** SessionInfo（文档 6.2 输出形态 + M16 orgRole 归一角色） */
export function sessionInfo(user: WbUser, factory: WbFactory, token: string) {
  return {
    token,
    username: user.username,
    displayName: user.displayName,
    enterpriseName: factory.enterpriseName,
    factoryId: factory.id,
    role: user.role,
    orgRole: normalizeRole(user.role),
  };
}

// ─── M16 组织角色三级归一（admin/manager/staff）与守卫 ───────────────────────
// 存量枚举 admin/owner/member 不批量 UPDATE：读取侧归一（owner→admin、member→staff，
// 未知/NULL 兜底 staff）；新写入一律用新值。manager 的判定以
// normalizeRole(user.role)==='manager' 与 wb_dept_heads 命中取并集（兼容存量）。
// R7-7-④/R7-8-①②/R7-c5-③/R7-c9-①：方言归一已沉 @contracts/dialect 零依赖中性叶——本处再出口仅 normalizeRole 一个值（WbRole 类型零消费不出，勿「补回」再养幻影 API）
export { normalizeRole }; // R7-c2-④/R7-c7-①：局部绑定直复用——WbRole 类型不再出口（全仓零消费，幻影 API 不养；前端类型引 @/lib/wbInvites 或 @contracts/dialect）


/** 数据范围：admin 全企业；manager 本部门；staff 仅本人 */
export type WbDataScope = { scope: "factory" } | { scope: "dept"; deptId: string } | { scope: "self" };

export function dataScopeOf(
  user: { role: string | null | undefined; departmentId: string | null | undefined },
  headDeptIds: string[],
): WbDataScope {
  const role = normalizeRole(user.role);
  if (role === "admin") return { scope: "factory" };
  if (role === "manager") {
    const deptId =
      user.departmentId && (headDeptIds.length === 0 || headDeptIds.includes(user.departmentId))
        ? user.departmentId
        : headDeptIds[0];
    if (deptId) return { scope: "dept", deptId };
  }
  return { scope: "self" };
}

/** 部门负责人判定：wb_dept_heads 命中 且 本人 departmentId=deptId（与 agentic.ts 同口径） */
export async function isDeptHead(
  userId: number,
  factoryId: number,
  departmentId: string | null | undefined,
): Promise<boolean> {
  if (!departmentId) return false;
  const db = getDb();
  const [hit] = await db
    .select({ id: wbDeptHeads.id })
    .from(wbDeptHeads)
    .where(
      and(
        eq(wbDeptHeads.factoryId, factoryId),
        eq(wbDeptHeads.deptId, departmentId),
        eq(wbDeptHeads.userId, userId),
      ),
    )
    .limit(1);
  return !!hit;
}

/** 归一后的有效角色：normalizeRole 与 wb_dept_heads 命中取并集（兼容存量 member 负责人） */
export async function effectiveRoleOf(user: WbUser): Promise<WbRole> {
  const role = normalizeRole(user.role);
  if (role !== "staff") return role;
  return (await isDeptHead(user.id, user.factoryId, user.departmentId)) ? "manager" : "staff";
}

/**
 * 业务层角色守卫（与 requireEnterpriseAdmin 同层同风格；框架层无自动鉴权）。
 * token 无效抛 UNAUTHORIZED；角色不在 allow 内抛 FORBIDDEN(denied)。
 */
export async function requireWbRole(
  token: string,
  allow: WbRole[],
  denied: string,
): Promise<WbSession> {
  const session = await sessionMe(token);
  const role = await effectiveRoleOf(session.user);
  if (!allow.includes(role)) {
    throw new TRPCError({ code: "FORBIDDEN", message: denied });
  }
  return session;
}

/** 部门数据范围守卫：admin 直通；manager 需本部门（normalizeRole/deptHeadOf 并集）；staff 拒绝 */
export async function requireDeptScope(token: string, deptId: string): Promise<WbSession> {
  const session = await sessionMe(token);
  const role = await effectiveRoleOf(session.user);
  if (role === "admin") return session;
  if (role === "manager" && session.user.departmentId === deptId) return session;
  throw new TRPCError({ code: "FORBIDDEN", message: "仅可访问本部门数据" });
}

/** 决策基因链事件 ID（模拟，递增随机） */
export function newGeneEventId(): string {
  return `ge_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

// ─── 展厅学习评分（确定性规则）───────────────────────────────────────────────
/** 阈值：成员 ≥3 得 40 分；部门 ≥2 得 30 分；listed 上架 ≥1 得 30 分；ready=80 */
export const WB_THRESHOLDS = {
  memberCount: 3,
  departmentCount: 2,
  listedCount: 1,
  readyScore: 80,
} as const;

export interface WbLearningMetrics extends Record<string, number> {
  memberCount: number;
  departmentCount: number;
  listedCount: number;
}

export function scoreLearning(m: WbLearningMetrics) {
  let score = 0;
  const missing: string[] = [];
  if (m.memberCount >= WB_THRESHOLDS.memberCount) score += 40;
  else missing.push(`组织成员 ≥ ${WB_THRESHOLDS.memberCount}（当前 ${m.memberCount}）`);
  if (m.departmentCount >= WB_THRESHOLDS.departmentCount) score += 30;
  else missing.push(`真实部门 ≥ ${WB_THRESHOLDS.departmentCount}（当前 ${m.departmentCount}）`);
  if (m.listedCount >= WB_THRESHOLDS.listedCount) score += 30;
  else missing.push(`已上架（listed）技能/智能体 ≥ ${WB_THRESHOLDS.listedCount}（当前 ${m.listedCount}）`);
  return { score, ready: score >= WB_THRESHOLDS.readyScore, missing };
}
