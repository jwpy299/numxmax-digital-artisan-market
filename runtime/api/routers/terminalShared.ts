/**
 * terminalShared —— terminal.ts 与 terminalMeetings.ts 共用的基础件（P1-3 拆域收口）。
 *
 * 背景（P1-3 根因）：terminal.ts 曾以 `export * from "./terminalMeetings"` 复用对侧导出，
 * 但 `export *` 只把对侧导出**转发给本模块的消费方**，不会把名字引入本模块作用域——
 * terminal.ts 自己的 185 条 TS2304 由此而来。
 * 而让两文件互相 import 又会造出真正的 ESM 双向环（terminalMeetings 依赖 terminal），
 * 求值期绑定可能为 undefined——故把「两侧都要用」的基础件抽到本第三个模块，依赖单向：
 *
 *   terminalShared.ts  ←  terminal.ts
 *                      ←  terminalMeetings.ts
 *
 * 行为零变化：以下函数/常量均自 terminal.ts 逐字搬迁，仅补齐各自所需的 import。
 */
import { sql } from "drizzle-orm"; // eq 摘（portal#86：直查面退役后零消费[TS6133 死引不养]）
import { TRPCError } from "@trpc/server";
import { getDb } from "../queries/connection";
import { isNoSuchTable, infraUnavailable500 } from "../auth/identity"; // 战区④票二配套：缺表判别+500 政策单源同引（stQuery 对齐 wb canonical——搬链=配套件一起搬）
// P1-3b（门禁 portal#31 轮3 票① 明确要求）：把 findAgentByCode / llmReplyOrDegraded / clip
//   连同 LlmReply / DEGRADED_PREFIX 上提到本模块，好让 staff.ts 改指这里、
//   从而**真正拆掉** terminal.ts → terminalMeetings.ts → staff.ts → terminal.ts 那条间接环。
import { resolveWbUserByToken } from "./wbSession"; // portal#86 必修：双轨解析单点同引（明文直读退役）
import { callModelChat, callSlotChat, type LlmMessage, type SlotId } from "./modelGateway";
import {
  agents,
  agentHireRecords,
  tokenTransactions,
} from "@db/schema"; // wbUsers 摘（portal#86：直查面退役→双轨单点后无消费[TS6133 死引不养]）

const ADMIN_REQUIRED = "需要管理员权限";
/** 会议管理类操作守卫提示（terminal.ts 与 terminalMeetings.ts 共用） */
export const HEAD_REQUIRED = "需部门负责人权限";
/** st_ 表缺失统一提示（terminal.ts 与 terminalMeetings.ts 共用） */
export const TERMINAL_TABLES_HINT =
  "灵智枢智能运营数据表未初始化，请先在服务器执行 db/sync-terminal.mts 后再操作";

/** rawRows 归中立足（战区④批 A-lite：本地副本退役——re-export canonical 单源[../queries/rawRows]，消费方零改；
 *  语义逐字等价[同 unwrapping 面——wb canonical 口径兼容注释在叶内]） */
import { rawRows } from "../queries/rawRows";
export { rawRows }; // import+export 双行=本地绑定+再出口两面齐（export...from 直通不给本地绑定的坑面封死）

/**
 * 管理员鉴权：token → wb_users.authToken 匹配 + role==='admin'。
 * 迭代 39（权限委派）：wb_users 未命中时，回退校验 st_staff_accounts——
 * 仅 ADMIN_DELEGATE_USERNAMES 指定的 COO/CMO 两个负责人账号可获得管理后台全量权限，
 * 返回合成 admin 身份（delegated:true，displayName 取自 staff 档案，全程留痕）。
 */
export const ADMIN_DELEGATE_USERNAMES = ["18024101277", "13620120709"] as const;

/**
 * M48d 超级终端本厂闸门（彭总口径：超级终端只对广东灵智枢生态科技有限公司开放）。
 * env HQ_FACTORY_IDS：本厂 factoryId 逗号分隔（生产值 6290209，由部署手册在上线前配置）。
 * 语义：fail-closed——未配置时 wb_users 路径一律拒（委派名单仍可读救），绝不裸奔。
 */
export function hqFactoryIds(): number[] {
  return (process.env.HQ_FACTORY_IDS ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

export async function requireAdmin(token: string) {
  const db = getDb();
  const user = await resolveWbUserByToken(db, token); // portal#86 必修：明文直读→双轨单点（指纹迁移行可读面封死）
  if (user && user.role === "admin") {
    try {
      const rows = rawRows(
        await db.execute(sql`SELECT disabled FROM wb_users WHERE id = ${user.id} LIMIT 1`),
      );
      if (rows[0] && Number(rows[0].disabled) === 1) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: ADMIN_REQUIRED });
      }
    } catch (err) {
      if (err instanceof TRPCError) throw err;
      // disabled 列尚未补齐：忽略，不阻断
    }
    return user;
  }
  // 委派回退：指定 COO/CMO staff token
  const staffRows = rawRows(
    await db.execute(
      sql`SELECT id, username, displayName, role, disabled FROM st_staff_accounts
          WHERE authToken = ${token} AND username IN (${sql.join(
            ADMIN_DELEGATE_USERNAMES.map((u) => sql`${u}`),
            sql`, `,
          )})
          LIMIT 1`,
    ),
  );
  const staff = staffRows[0];
  if (staff && Number(staff.disabled) !== 1 && String(staff.role) === "head") {
    return {
      id: Number(staff.id),
      username: String(staff.username),
      displayName: `${String(staff.displayName)}（委派管理员）`,
      role: "admin",
      delegated: true,
    } as unknown as NonNullable<typeof user>; // 双轨单点后 user 型含 undefined——委派/原生支返回窄化出 undefined（TS18048 面封死）
  }
  // M64 第三层：超终原生账号（st_admin_accounts，adminOrigin=native）。
  // 动态 import 防循环依赖（adminAuth 依赖 terminal 的 requireAdmin/rawRows）。
  try {
    const { findNativeAdminByToken } = await import("./adminAuth");
    const native = await findNativeAdminByToken(token);
    if (native && Number(native.disabled) !== 1) {
      return {
        id: Number(native.id),
        username: String(native.username),
        displayName: `${String(native.displayName)}（超终）`,
        role: "admin",
        delegated: true, // requireHqAdmin 放行口径与委派相同：原生超终账号天然本厂治理席
        adminOrigin: "native",
      } as unknown as NonNullable<typeof user>; // 双轨单点后 user 型含 undefined——委派/原生支返回窄化出 undefined（TS18048 面封死）
    }
  } catch (err) {
    if (err instanceof TRPCError) throw err;
    // st_admin_accounts 未建表时静默跳过（迁移前行为零变化）
  }
  throw new TRPCError({ code: "UNAUTHORIZED", message: ADMIN_REQUIRED });
}

/**
 * M48d 本厂闸增强守卫（超级终端专属）：先 requireAdmin（含委派回退），
 * 再对 wb_users 本厂路径加 HQ_FACTORY_IDS fail-closed。
 * - 委派账号（本厂 COO/CMO head）天然放行（读救通道）；
 * - HQ_FACTORY_IDS 未配置 → fail-closed 全拒 wb_users 路径，绝不裸奔；
 * - 非本厂 admin → 精确口径「超级终端仅对广东灵智枢生态科技有限公司开放」。
 * 通用企业 admin 路径（duty-chat/deptConsole/devices 等）仍走 requireAdmin，不受本闸影响。
 */
export async function requireHqAdmin(token: string) {
  const user = await requireAdmin(token);
  if ((user as unknown as { delegated?: boolean }).delegated === true) return user;
  const hq = hqFactoryIds();
  if (hq.length === 0) {
    console.warn("[terminal] HQ_FACTORY_IDS 未配置：超级终端 wb_users 路径关闭，仅委派账号可进");
    throw new TRPCError({ code: "UNAUTHORIZED", message: ADMIN_REQUIRED });
  }
  if (!hq.includes(Number((user as unknown as { factoryId?: number }).factoryId))) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "超级终端仅对广东灵智枢生态科技有限公司开放" });
  }
  return user;
}

/** st_ 表查询统一兜底：表缺失时给出友好提示（战区④票二对齐 wb canonical：hint 可选件——非 terminal 族表（gate/kb 等引用面）
 *  调用方传本族脚本话术——412 指错脚本=运维空跑面封死；缺省=TERMINAL_TABLES_HINT 既有口径不动） */
export async function stQuery(statement: ReturnType<typeof sql>, hint = TERMINAL_TABLES_HINT): Promise<Array<Record<string, unknown>>> {
  try {
    return rawRows(await getDb().execute(statement));
  } catch (err) {
    // 对齐 wb canonical：缺表判别走 cause 链单源（顶层 message 正则在 drizzle 包装层永不中=死代码面封死）
    if (isNoSuchTable(err)) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: hint });
    }
    infraUnavailable500("[routers/terminalShared] st_ 查询失败（1146 以外——列漂移/连接断/schema 不符）", err); // 对齐 wb canonical：裸抛 raw=SQL+绑定参数逐字泄客户端面封死
  }
}

interface KpiSnapshot {
  userTotal: number;
  enterpriseUserTotal: number;
  factoryTotal: number;
  agentTotal: number;
  activeAgentTotal: number;
  hireOrderTotal: number;
  openRecruitmentTotal: number;
  tokenFlowTotal: number;
  tokenPlatformFeeTotal: number;
}

/** 测试残留排除标记单源（P0-4 门禁 R2 票②：TEST_ 口径三处硬编码收口——adminAi 沉默企业判定、
 *  admin overview、本文件 KPI 同引；sandbox 侧 db/sandbox-cleanup.mts 同惯例） */
export const TEST_RESIDUE_LIKE = "TEST\\_%";

/** P0-4 门禁 R3+R5 定稿口径：TEST_ 前缀精确拦测试残留（disabled 为业务停用语义，不进 KPI 排除面——
 *  R5 票③：disabled=0 谓词会误排未来真停用厂；TEST 两厂两号已被前缀精确拦住，ci collation 双写命中）；
 *  kindEq 枚举参数化（R5 票②：不开放 sql.raw 任意片段，导出面安全）；列缺失容忍（TEST_ 过滤不依赖 disabled 列） */
export async function scopedCountExcludingTests(
  table: "wb_users" | "wb_factories",
  nameCol: "username" | "enterpriseName",
  kindEq?: "enterprise" | "person",
): Promise<number> {
  // 表/列耦合守卫（门禁 R6 票④＋R7 票①：导出面不许编译期过、运行时炸）
  const NAME_COL: Record<"wb_users" | "wb_factories", "username" | "enterpriseName"> = { wb_users: "username", wb_factories: "enterpriseName" };
  if (nameCol !== NAME_COL[table]) throw new Error("nameCol 与 table 不配（wb_users→username、wb_factories→enterpriseName——门禁 R7 票①）");
  if (kindEq && table !== "wb_users") throw new Error("kindEq 仅适用于 wb_users（wb_factories 无 kind 列——门禁 R6 票④导出面守卫）");
  const db = getDb();
  const rows = rawRows(
    await db.execute(
      sql`SELECT count(*) AS c FROM ${sql.raw("`" + table + "`")} WHERE ${sql.raw("`" + nameCol + "`")} NOT LIKE ${TEST_RESIDUE_LIKE}${kindEq ? sql` AND ${sql.raw("`kind`")} = ${kindEq}` : sql``}`,
    ),
  );
  return Number(rows[0]?.c ?? 0);
}

/** 统一库两系统 KPI 聚合（单条 SQL 失败不拖垮整体，缺失指标回落 0） */
export async function collectKpis(): Promise<KpiSnapshot> {
  const db = getDb();
  const safe = async <T>(p: Promise<T>, fallback: T): Promise<T> => {
    try {
      return await p;
    } catch {
      return fallback;
    }
  };
  const countOf = async (table: unknown) => {
    const rows = rawRows(await db.execute(sql`SELECT count(*) AS c FROM ${table}`));
    return Number(rows[0]?.c ?? 0);
  };
  const [userTotal, enterpriseUserTotal, factoryTotal, agentTotal, activeAgentTotal, hireOrderTotal, openRecruitmentTotal, tokenFlow] =
    await Promise.all([
      // P0-4 KPI exclude test residue (same scope as adminAi.ts silent-factory rule; B6 heal)
      safe(scopedCountExcludingTests('wb_users', 'username'), 0),
      safe(scopedCountExcludingTests('wb_users', 'username', 'enterprise'), 0),
      safe(scopedCountExcludingTests('wb_factories', 'enterpriseName'), 0),
      safe(countOf(agents), 0),
      safe(countOf(sql`agents WHERE status = 'active'`), 0),
      safe(countOf(agentHireRecords), 0),
      safe(countOf(sql`recruitments WHERE status = 'open'`), 0),
      safe(
        db
          .select({
            total: sql<number | string | null>`coalesce(sum(amount), 0)`,
            platformFee: sql<number | string | null>`coalesce(sum(platformFee), 0)`,
          })
          .from(tokenTransactions),
        [] as Array<{ total: number | string | null; platformFee: number | string | null }>,
      ),
    ]);
  return {
    userTotal,
    enterpriseUserTotal,
    factoryTotal,
    agentTotal,
    activeAgentTotal,
    hireOrderTotal,
    openRecruitmentTotal,
    tokenFlowTotal: Number(tokenFlow[0]?.total ?? 0),
    tokenPlatformFeeTotal: Number(tokenFlow[0]?.platformFee ?? 0),
  };
}

/**
 * 实时数据摘要（buildContextDigest）：驾驶舱 / 单聊 / 圆桌共用。
 * 约 300 字中文，聚合统一库两系统 KPI；任何单条 SQL 失败都不影响整体。
 */
export async function buildContextDigest(): Promise<string> {
  const k = await collectKpis();
  let meetingCount = 0;
  try {
    const rows = rawRows(await getDb().execute(sql`SELECT count(*) AS c FROM st_meetings`));
    meetingCount = Number(rows[0]?.c ?? 0);
  } catch {
    // st_meetings 表缺席容忍（digest 摘要降级为 0 场——R16 票③：空 catch 注释钉）
  }
  const kpi = [
    `统一库实时数据摘要：`,
    `工作台注册账号 ${k.userTotal}（其中企业账号 ${k.enterpriseUserTotal}），入驻企业（工作台）${k.factoryTotal} 家；`,
    `门户数字员工 ${k.agentTotal} 位（生效中 ${k.activeAgentTotal}），累计雇佣订单 ${k.hireOrderTotal} 单；`,
    `招聘中岗位 ${k.openRecruitmentTotal} 个；`,
    `Token 计量流水总额 ${k.tokenFlowTotal}，平台结算佣金累计 ${k.tokenPlatformFeeTotal}（结算口径）；`,
    `共生工作空间累计会议 ${meetingCount} 场。`,
  ].join("\n");
  return kpi.slice(0, 400);
}

// ─── st_ 表行类型 ────────────────────────────────────────────────────────────
interface DeptRow {
  id: number;
  code: string;
  name: string;
  duty: string;
  sort: number;
  agentCount?: number;
}

export interface AgentRow {
  id: number;
  deptCode: string;
  code: string;
  name: string;
  title: string;
  avatarEmoji: string;
  systemPrompt: string;
  status: string;
}

export async function listDepartments(): Promise<DeptRow[]> {
  const rows = await stQuery(
    sql`SELECT d.id, d.code, d.name, d.duty, d.sort,
          (SELECT count(*) FROM st_agents a WHERE a.deptCode = d.code AND a.status = 'active') AS agentCount
        FROM st_departments d ORDER BY d.sort ASC, d.id ASC`,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    code: String(r.code),
    name: String(r.name),
    duty: String(r.duty),
    sort: Number(r.sort),
    agentCount: Number(r.agentCount ?? 0),
  }));
}

export async function listActiveAgents(): Promise<AgentRow[]> {
  const rows = await stQuery(
    sql`SELECT id, deptCode, code, name, title, avatarEmoji, systemPrompt, status
        FROM st_agents WHERE status = 'active' ORDER BY id ASC`,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    deptCode: String(r.deptCode),
    code: String(r.code),
    name: String(r.name),
    title: String(r.title),
    avatarEmoji: String(r.avatarEmoji ?? "🤖"),
    systemPrompt: String(r.systemPrompt ?? ""),
    status: String(r.status),
  }));
}

// ─── P1-3b：为拆掉 terminal.ts → terminalMeetings.ts → staff.ts → terminal.ts 间接环而上提的件 ───
//   门禁 portal#31 轮3 票①（maintainability/medium）明确要求：把这三件 + 两型上提到本模块，
//   并把 staff.ts:24-32 的 import 从 ./terminal 改指 ./terminalShared。
//   完成后 staff.ts 对 ./terminal 的边即为 0 ⇒ 那条三段环**真正消失**（此前只是「不炸」，不是「无环」）。

const DEGRADED_PREFIX = "大模型暂不可用，以下为规则生成的参考回复";

export async function findAgentByCode(code: string): Promise<AgentRow | null> {
  const rows = await stQuery(
    sql`SELECT id, deptCode, code, name, title, avatarEmoji, systemPrompt, status
        FROM st_agents WHERE code = ${code} LIMIT 1`,
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    id: Number(r.id),
    deptCode: String(r.deptCode),
    code: String(r.code),
    name: String(r.name),
    title: String(r.title),
    avatarEmoji: String(r.avatarEmoji ?? "🤖"),
    systemPrompt: String(r.systemPrompt ?? ""),
    status: String(r.status),
  };
}

export interface LlmReply {
  content: string;
  provider: string | null;
  model: string | null;
  degraded: boolean;
}

/**
 * 统一 LLM 调用 + 静默降级：失败时返回确定性模板（degraded:true），
 * 错误原因绝不回传前端。
 * slot 传能力槽位（brain/orggen/chat/flash/creative）时优先走海禛云统一网关
 * 对应模型，网关未配置或失败自动回退官方四模型故障转移链。
 */
export async function llmReplyOrDegraded(
  messages: LlmMessage[],
  degradedText: string,
  maxTokens = 600,
  timeoutMs = 45_000,
  slot?: SlotId,
  modelOverride?: string, // M79：部门适配首选模型（deptConsole.allowed_models 首项）
): Promise<LlmReply> {
  try {
    if (slot) {
      const viaGateway = await callSlotChat(slot, { messages, maxTokens, timeoutMs, modelOverride });
      if (viaGateway.ok && viaGateway.content) {
        return {
          content: viaGateway.content,
          provider: viaGateway.providerLabel ?? null,
          model: viaGateway.model ?? null,
          degraded: false,
        };
      }
    }
    const res = await callModelChat({ messages, maxTokens, timeoutMs });
    if (res.ok && res.content) {
      return {
        content: res.content,
        provider: res.providerLabel ?? res.provider ?? null,
        model: res.model ?? null,
        degraded: false,
      };
    }
  } catch {
    // 静默降级
  }
  return { content: `${DEGRADED_PREFIX}。\n${degradedText}`, provider: null, model: null, degraded: true };
}

/** 文本截断（上下文控制） */
export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 脱敏留痕共享出口（门户仓薄面——主线①搬链配套：betaApply 失败留痕用；不透 SQL+绑定参数=凭证纪律）。
 *  名实钉（portal#56 复审票：名带 Throttled 但没节流=宣称≠实现误导面——改名 logQueryError 名实相符；
 *  门户仓业务量面小不做节流[wb 侧深层节流件不搬——明态注释钉]） */
export function logQueryError(tag: string, e: unknown): void {
  const name = e instanceof Error ? e.name : typeof e;
  console.error(`${tag}（脱敏——明细不透客户端；errName=${name}）`); // 只透错误名不透内容（SQL/绑定/phone 不落日颜面封死）
}