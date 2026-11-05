/**
 * agentic —— 工作台认证 / 企业 / 组织成员接口（工作台服务端，与文档对齐）。
 *
 * 全部 publicQuery 声明；需要登录态的接口在请求体携带 token，由 sessionMe(token) 校验。
 * token 单点有效：注册 / 登录 / 员工注册成功后均重颁 nt_ token 并覆盖 wb_users.authToken。
 */
import { z } from "zod";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { markDeprecated } from "./deprecation";
import { provisionFactoryConsoles } from "./deptConsole";
import { rawRows } from "./terminal";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import {
  agents,
  wbUsers,
  wbFactories,
  wbDeptHeads,
  wbListings,
  wbRoleAgents,
  type WbRoleAgent,
} from "@db/schema";
import {
  hashPassword,
  verifyPassword,
  normalizeRole,
  reissueToken,
  resolveWbUserByToken,
  sessionInfo,
  sessionMe,
  sha256,
} from "./wbSession";
import { maskIdCard, verifyIdCard } from "@/lib/idCard";
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
import { isDupEntry } from "../lib/dupEntry"; // 共享件直引（不经 ./sms 中转——循环断链面不再开）
import { isValidCreditCode, verifyEnterprise } from "./enterpriseVerify";
import { formCorpsForFactory } from "./corps";
import { initFactoryPlan } from "./billing";

const tokenInput = z.object({ token: z.string().trim().min(1) });

/** 双列查重小件（门禁票：「identifier 撞 username 或 phone 即占」单源——authRegister/enterprise 同引；msg 分面） */
async function assertFreeUserIdentity(
  db: Pick<ReturnType<typeof getDb>, "select">,
  v: string,
  msg: string,
): Promise<void> {
  const [hit] = await db
    .select({ id: wbUsers.id })
    .from(wbUsers)
    .where(or(eq(wbUsers.username, v), eq(wbUsers.phone, v)))
    .limit(1);
  if (hit) {
    throw new TRPCError({ code: "BAD_REQUEST", message: msg });
  }
}

/** 注册冲突文案单源（前置查重与 1062 捕获同引） */
const MSG_CONFLICT = "用户名或手机号已被占用";
/** enterprise 注册手机号撞单文案（预查与 1062 捕获同引——门禁 verbatim 票） */
const MSG_ENT_PHONE_DUP = "手机号已注册";
/** phone 撞单文案（恢复引导链——门禁票：半完成账号不卡死） */
const MSG_PHONE_BOUND = "该手机号已完成开户——请用手机号+验证码登录后继续";

const registerInput = z
  .object({
    username: z.string().trim().min(2).max(64),
    password: z.string().min(6).max(128),
    enterpriseName: z.string().trim().min(2).max(128),
    industry: z.string().trim().min(1).max(64),
    industryText: z.string().trim().max(128).optional(),
    headcount: z.union([
      z.string().trim().min(1).max(32),
      z.number().int().positive(),
    ]),
    departments: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
    painPoints: z.string().trim().max(2000).optional(),
    displayName: z.string().trim().max(64).optional(),
    // phone 可选绑（审核门禁票：随机密码开户无找回面——绑手机=验证码登录/找回链可及）；phoneSchema 单源同口径
    phone: phoneSchema.optional(),
    // phoneCode 验真（门禁 security 票：公开页不验归属=任意绑别人手机号劫持其验证码登录面封死）——phone 在场必填
    phoneCode: z
      .string()
      .trim()
      .regex(SMS_CODE_RE, "验证码为 6 位数字")
      .optional(), // 口径单源（smsVerify.SMS_CODE_RE——sms.ts 生成面/前端 wbSms 同）
  })
  .superRefine((v, ctx) => {
    // schema 级联动（门禁票：optional 裸挂=phone 无码可漏过契约层）——phone 在场则 phoneCode 必填
    if (v.phone && !v.phoneCode) {
      ctx.addIssue({
        code: "custom",
        path: ["phoneCode"],
        message: "绑定手机号须短信验证码验真",
      });
    }
    // 反向联动（门禁票）：phoneCode 在场而 phone 缺席=静默吞码无反馈——同拒
    if (!v.phone && v.phoneCode) {
      ctx.addIssue({
        code: "custom",
        path: ["phone"],
        message: "请先填写手机号",
      });
    }
  });

/** 企业画像输出形态 */
function profileOf(factory: typeof wbFactories.$inferSelect) {
  return {
    factoryId: factory.id,
    enterpriseName: factory.enterpriseName,
    industry: factory.industry,
    industryGroup: factory.industryGroup,
    industryText: factory.industryText,
    creditCode: factory.creditCode,
    headcount: factory.headcount,
    departments: factory.departments,
    painPoints: factory.painPoints,
    profile: factory.profile,
  };
}

/** 12 大行业大类（与 src/lib/industries.ts 的 INDUSTRY_GROUPS 对齐，服务端独立维护） */
const INDUSTRY_GROUP_KEYS = [
  "工业制造",
  "跨境电商",
  "设计创意",
  "财税服务",
  "医疗健康",
  "教育培训",
  "法律合规",
  "建筑工程",
  "农业科技",
  "文化传媒",
  "现代物流",
  "餐饮零售",
] as const;

/** SessionInfo + 迭代 14 扩展字段（kind/phone/industryGroup；个人账号 enterpriseName=null） */
export function sessionInfoEx(
  user: typeof wbUsers.$inferSelect,
  factory: typeof wbFactories.$inferSelect | undefined,
  token: string,
) {
  const base = factory
    ? sessionInfo(user, factory, token)
    : {
        token,
        username: user.username,
        displayName: user.displayName,
        enterpriseName: null,
        factoryId: user.factoryId,
        role: user.role,
        orgRole: normalizeRole(user.role),
      };
  return {
    ...base,
    kind: user.kind,
    phone: user.phone ?? null,
    industryGroup: factory?.industryGroup ?? null,
    departmentId: user.departmentId ?? null, // 前端据此决定登录后落点（member → /wb/dept）
  };
}

// ─── orgAutoSetup 确定性模板 ─────────────────────────────────────────────────
interface RoleTemplate {
  role: string;
  dept: string;
  /** 命中企业已有部门名的关键词（优先复用注册时填写的真实部门） */
  deptKeys: string[];
  skillKeys: string[];
  poolSlug: string;
}

/** 行业化角色模板集：按行业大类确定性选择角色/部门/技能词/匠市推荐池 */
interface IndustryRoleSet {
  match: string[];
  poolOrder: string[];
  roles: RoleTemplate[];
}

const INDUSTRY_ROLE_SETS: IndustryRoleSet[] = [
  {
    match: ["跨境", "电商", "出海", "外贸"],
    poolOrder: ["duyang", "milan", "yifan", "tuoling", "xingdun", "chaoming"],
    roles: [
      {
        role: "老板",
        dept: "总经办",
        deptKeys: ["总经", "经营", "管理", "办公"],
        skillKeys: ["经营", "决策", "利润", "库存", "分析"],
        poolSlug: "duyang",
      },
      {
        role: "财务负责人",
        dept: "财务部",
        deptKeys: ["财务", "会计", "资金"],
        skillKeys: ["记账", "财税", "合规", "资金", "对账"],
        poolSlug: "siku",
      },
      {
        role: "供应链主管",
        dept: "供应链管理部",
        deptKeys: ["供应链", "采购", "物流", "仓储"],
        skillKeys: ["物流", "海外仓", "清关", "补货"],
        poolSlug: "tuoling",
      },
      {
        role: "销售运营",
        dept: "销售部",
        deptKeys: ["销售", "运营", "店铺", "客服"],
        skillKeys: ["选品", "Listing", "广告", "投放", "运营"],
        poolSlug: "milan",
      },
    ],
  },
  {
    match: ["财税", "财务", "会计", "税务", "代账"],
    poolOrder: [
      "siku",
      "mingzhang",
      "chouheng",
      "shenwei",
      "piaoshu",
      "huisuan",
    ],
    roles: [
      {
        role: "老板",
        dept: "总经办",
        deptKeys: ["总经", "经营", "管理", "办公"],
        skillKeys: ["经营", "决策", "财税", "资金", "分析"],
        poolSlug: "siku",
      },
      {
        role: "记账会计",
        dept: "记账核算部",
        deptKeys: ["记账", "核算", "账务", "会计"],
        skillKeys: ["记账", "凭证", "对账", "结转"],
        poolSlug: "mingzhang",
      },
      {
        role: "税务专员",
        dept: "税务合规部",
        deptKeys: ["税务", "合规", "筹划", "申报"],
        skillKeys: ["税务", "筹划", "申报", "合规"],
        poolSlug: "chouheng",
      },
      {
        role: "审计师",
        dept: "审计风控部",
        deptKeys: ["审计", "风控"],
        skillKeys: ["审计", "底稿", "风险", "扫描"],
        poolSlug: "shenwei",
      },
      {
        role: "客户经理",
        dept: "客户服务部",
        deptKeys: ["客户", "服务", "代账"],
        skillKeys: ["发票", "汇算", "客户", "答疑"],
        poolSlug: "piaoshu",
      },
    ],
  },
  {
    match: ["设计", "创意", "广告", "品牌", "传媒"],
    poolOrder: ["danqing", "liubai", "chisu", "sunmao", "qijing", "moyun"],
    roles: [
      {
        role: "老板",
        dept: "总经办",
        deptKeys: ["总经", "经营", "管理", "办公"],
        skillKeys: ["经营", "决策", "品牌", "分析"],
        poolSlug: "liubai",
      },
      {
        role: "创意总监",
        dept: "创意设计部",
        deptKeys: ["创意", "设计", "平面", "品牌"],
        skillKeys: ["海报", "品牌", "VI", "版式"],
        poolSlug: "danqing",
      },
      {
        role: "UI设计师",
        dept: "数字产品部",
        deptKeys: ["UI", "交互", "产品", "数字"],
        skillKeys: ["界面", "交互", "原型", "设计系统"],
        poolSlug: "chisu",
      },
      {
        role: "工业设计师",
        dept: "工业设计部",
        deptKeys: ["工业", "结构", "CMF"],
        skillKeys: ["外观", "CMF", "结构", "制造"],
        poolSlug: "sunmao",
      },
      {
        role: "客户经理",
        dept: "客户服务部",
        deptKeys: ["客户", "服务", "项目"],
        skillKeys: ["包装", "空间", "展示", "沟通"],
        poolSlug: "moyun",
      },
    ],
  },
];

function resolveIndustryRoleSet(text: string): IndustryRoleSet | null {
  for (const set of INDUSTRY_ROLE_SETS) {
    if (set.match.some((k) => text.includes(k))) return set;
  }
  return null;
}

/** 行业关键词 → 特色生产部门名（确定性映射，顺序即优先级） */
const INDUSTRY_DEPT_MAP: [string[], string][] = [
  [["汽车", "零部件"], "焊装车间"],
  [["电子", "SMT", "装配", "半导体"], "电子装配车间"],
  [["模具"], "模具车间"],
  [["压力容器", "锅炉", "钢结构"], "铆焊车间"],
  [["食品", "饮料", "灌装"], "灌装车间"],
  [["纺织", "印染"], "织造车间"],
  [["精密仪器", "仪器"], "精密装配车间"],
];

function resolveProductionDept(text: string): string {
  for (const [keys, dept] of INDUSTRY_DEPT_MAP) {
    if (keys.some((k) => text.includes(k))) return dept;
  }
  return "机加车间";
}

/** wb_role_agents 行 → 分步动画展示结构（保持插入顺序分组） */
function groupRoleAgents(rows: WbRoleAgent[]) {
  const order: string[] = [];
  const byDept = new Map<string, WbRoleAgent[]>();
  for (const r of rows) {
    if (!byDept.has(r.deptName)) {
      byDept.set(r.deptName, []);
      order.push(r.deptName);
    }
    byDept.get(r.deptName)!.push(r);
  }
  return order.map((name) => ({
    name,
    roles: byDept.get(name)!.map((r) => ({
      role: r.role,
      agentName: r.agentName,
      agentId: r.agentId,
      agentSource: r.agentSource,
    })),
  }));
}

// ─── 账号分发权限辅助（迭代 21：老板→负责人→员工）────────────────────────────
const HEAD_REGISTER_DENIED = "仅企业负责人可分发部门负责人账号";
const EMPLOYEE_REGISTER_DENIED = "仅企业负责人或本部门负责人可分发员工账号";
const CROSS_DEPT_DENIED = "仅可为本部门分发员工账号";

/** 部门负责人判定：wb_dept_heads 命中 且 本人 departmentId=deptId */
async function deptHeadOf(
  userId: number,
  factoryId: number,
  departmentId: string | null,
) {
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

/** 成员管理操作目标鉴权：admin/owner 可管本企业任何人；dept_head 只能管本部门 member */
async function assertMemberOperable(
  caller: typeof wbUsers.$inferSelect,
  target: typeof wbUsers.$inferSelect,
  deniedMessage: string,
  opts?: { allowSelf?: boolean },
) {
  if (caller.id === target.id) {
    if (opts?.allowSelf && (caller.role === "admin" || caller.role === "owner"))
      return;
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "不可对本人账号执行该操作",
    });
  }
  if (caller.role === "admin" || caller.role === "owner") return;
  // 负责人路径：不可操作 admin/owner；仅本部门 member
  if (target.role === "admin" || target.role === "owner") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "无权操作企业负责人账号",
    });
  }
  const isHead = await deptHeadOf(
    caller.id,
    caller.factoryId,
    caller.departmentId,
  );
  if (
    !isHead ||
    !caller.departmentId ||
    target.departmentId !== caller.departmentId ||
    target.role !== "member"
  ) {
    throw new TRPCError({ code: "FORBIDDEN", message: deniedMessage });
  }
}

export const agenticRouter = createRouter({
  /**
   * authRegister（mutation）：企业注册，注册者角色 admin。
   * 创建工厂 + admin 用户，重颁 token；
   * 输出 SessionInfo + { generatedBy, deptCount, bootstrapped }。
   */
  authRegister: publicQuery.input(registerInput).mutation(async ({ input }) => {
    const db = getDb();
    // v183 默认六部（彭总实锤：新企业空部门 → 邀请码无法生成）；
    // 与舱位制同图：管理/销售/采购/生产/财务/行政——注册即开箱可邀
    const DEFAULT_DEPARTMENTS = [
      "管理部",
      "销售部",
      "采购部",
      "生产部",
      "财务部",
      "行政部",
    ];
    const departments = (
      input.departments?.length ? input.departments : DEFAULT_DEPARTMENTS
    ).map((name, i) => ({
      id: `d${i + 1}`,
      name,
    }));
    // 验码两段式（计数事务外直提交，消费事务内尾部与 inserts 同进退）
    let smsCodeRowId: number | null = null;
    // 结构收窄替代非空断言（门禁票）：phone+phoneCode 同在场才验——superRefine 契约层已保证配对；
    // 收窄到局部常量（TS 不跨事务闭包边界收窄 input.phone——bindPhone 局部化携带）
    const bindCode = input.phoneCode ?? ""; // 局部常量收窄（TS 不从 bindPhone 推导 phoneCode 非空）
    const bindPhone = input.phone && bindCode ? input.phone : null;
    if (bindPhone) {
      smsCodeRowId = (
        await verifySmsCodeOnly(db, bindPhone, "register", bindCode)
      ).rowId;
    }
    // 密码 hash 事务外预计算（门禁票：scryptSync CPU 密集，进事务=占池连接数十毫秒——并发注册面阻塞）
    const passwordHash = hashPassword(input.password);
    // 注册体事务化（查重+双 insert 同进退——失败回滚不留半态）
    const { factoryId, userId } = await db.transaction(async (tx) => {
      await assertFreeUserIdentity(tx, input.username, MSG_CONFLICT);
      if (smsCodeRowId !== null && bindPhone !== null) {
        // 原子消费（事务内——注册失败码不耗；验真已在事务外完成；null 判替代非空断言）
        await consumeSmsCodeById(tx, smsCodeRowId);
        // phone UNI 约束前置查重只供友好文案（TOCTOU 真闸=UNI 约束+1062 捕获，见 insert catch）；
        // or(username) 同查：authLogin 按 username/phone 双列匹配 identifier，手机号被占作 username 也算冲突（门禁票）
        await assertFreeUserIdentity(tx, bindPhone, MSG_PHONE_BOUND); // phone 面同小件——恢复引导文案
      }
      const [{ id: factoryId }] = await tx
        .insert(wbFactories)
        .values({
          enterpriseName: input.enterpriseName,
          industry: input.industry,
          industryText: input.industryText ?? null,
          headcount: String(input.headcount),
          departments,
          painPoints: input.painPoints ?? null,
          profile: {
            source: "craftsman-market",
            registeredBy: input.username,
          },
        })
        .$returningId();
      // UNI 约束真闸（TOCTOU：前置查重只供友好文案，并发同号双过的最终防线=1062 捕获转可读——门禁票）
      const [{ id: userId }] = await tx
        .insert(wbUsers)
        .values({
          username: input.username,
          passwordHash,
          displayName: input.displayName?.trim() || input.username,
          phone: bindPhone,
          role: "admin",
          factoryId,
          departmentId: null,
        })
        .$returningId()
        .catch((e: unknown) => {
          // UNI 真闸（TOCTOU 最终防线）——isDupEntry 共享件（cause 链 5 层+errno+message，仓内权威版）
          if (isDupEntry(e)) {
            // 文案按面分（门禁票：bindPhone 在场时撞单多半在 phone——给恢复引导；纯 username 撞给通用）
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: bindPhone ? MSG_PHONE_BOUND : MSG_CONFLICT,
            });
          }
          throw e;
        });
      return { factoryId, userId };
    });
    // M53：注册即供给——按申报部门实时生成 DSH 部门工作台配置（失败不阻断注册；事务提交后再供给）
    void provisionFactoryConsoles(Number(factoryId), departments).catch(
      () => {},
    );
    const token = await reissueToken(userId);
    const [user] = await db
      .select()
      .from(wbUsers)
      .where(eq(wbUsers.id, userId))
      .limit(1);
    const [factory] = await db
      .select()
      .from(wbFactories)
      .where(eq(wbFactories.id, factoryId))
      .limit(1);
    return {
      ...sessionInfo(user, factory, token),
      generatedBy: "agentic.authRegister",
      deptCount: departments.length,
      bootstrapped: true,
    };
  }),

  /**
   * authLogin（mutation）：登录。重颁 token，旧 token 失效（单点有效）。
   * identifier（手机号或用户名，向后兼容旧的 username 字段）+ password，
   * 按 wb_users.phone 或 wb_users.username 匹配。
   * 输出 SessionInfo + { kind, phone, industryGroup }（个人账号 enterpriseName=null）。
   */
  authLogin: publicQuery
    .input(
      z.object({
        identifier: z.string().trim().min(1).max(64).optional(),
        username: z.string().trim().min(1).max(64).optional(), // 向后兼容旧调用方
        password: z.string().min(1).max(128),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const identifier = input.identifier ?? input.username;
      if (!identifier) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "请输入手机号或用户名",
        });
      }
      const [user] = await db
        .select()
        .from(wbUsers)
        .where(
          or(eq(wbUsers.username, identifier), eq(wbUsers.phone, identifier)),
        )
        .limit(1);
      if (!user || !verifyPassword(input.password, user.passwordHash)) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "手机号/用户名或密码错误",
        });
      }
      const [factory] = await db
        .select()
        .from(wbFactories)
        .where(eq(wbFactories.id, user.factoryId))
        .limit(1);
      const token = await reissueToken(user.id);
      return sessionInfoEx(user, factory, token);
    }),

  /**
   * authRegisterEnterprise（mutation）：企业注册（迭代 14，手机号即账号）。
   * 校验 phone 唯一；创建 wb_factories（industryGroup 行业大类 + 部门组织架构
   * 映射为 { id: dept_N, name, headcount, duty }）+ wb_users（username=phone、
   * role=owner、kind=enterprise）；重颁 token，输出 SessionInfo + kind。
   */
  authRegisterEnterprise: publicQuery
    .input(
      z.object({
        phone: phoneSchema,
        // 验证码验真（门禁 security high 票：公开注册口不验归属=预占劫持——zod 剥未知键，前端验真纯摆设面封死）
        code: z.string().trim().regex(SMS_CODE_RE, "验证码为 6 位数字"),
        // 邀测码闸（彭总令：封闭内测期注册必填——st_beta_invites 资格码面；字段名 betaCode 与 sms.ts 同口径）
        betaCode: z.string().trim().regex(BETA_CODE_RE, BETA_CODE_MSG),
        password: z.string().min(8, "密码至少 8 位").max(128),
        displayName: z.string().trim().min(1, "请填写联系人姓名").max(64),
        enterpriseName: z.string().trim().min(2).max(128),
        industryGroup: z.enum(INDUSTRY_GROUP_KEYS),
        industryText: z.string().trim().max(128).optional(),
        headcount: z.union([
          z.string().trim().min(1).max(32),
          z.number().int().positive(),
        ]),
        creditCode: z.string().trim().max(32).optional(),
        departments: z
          .array(
            z.object({
              name: z
                .string()
                .trim()
                .min(2, "部门名称 2-32 字")
                .max(32, "部门名称 2-32 字"),
              headcount: z.string().trim().max(32).optional(),
              duty: z.string().trim().max(128).optional(),
            }),
          )
          .min(1, "至少填写 1 个部门")
          .max(12, "部门最多 12 个"),
        painPoints: z.string().trim().max(2000).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      // 验码两段式同口径（计数直提交；消费在事务内尾部——与 inserts 同进退）
      const { rowId: smsRowId } = await verifySmsCodeOnly(
        db,
        input.phone,
        "register",
        input.code,
      );
      // 邀测码预检（资格码共享件 verifyBetaCode——彭总令封闭内测闸；kind 闸=enterprise 企业码专口[彭总链路钉]）
      const { betaInvId } = await verifyBetaCode(
        db,
        input.betaCode,
        input.phone,
        "enterprise",
      );
      await assertFreeUserIdentity(db, input.phone, MSG_ENT_PHONE_DUP);
      const departments = input.departments.map((d, i) => ({
        id: `dept_${i + 1}`,
        name: d.name,
        ...(d.headcount ? { headcount: d.headcount } : {}),
        ...(d.duty ? { duty: d.duty } : {}),
      }));
      // 迭代 90：填写了统一社会信用代码时，先本地校验再对标国家企业信用信息公示系统核验。
      // verified → 直接落库核验通过；mismatch / not_found → 拒绝注册；
      // pending_manual / 意外异常 → 放行注册并标记待人工核验，不阻断主链路。
      let verifyStatus: "verified" | "pending_manual" | "unverified" =
        "unverified";
      let verifiedAt: Date | null = null;
      let verifyPayload: Record<string, unknown> | null = null;
      if (input.creditCode) {
        try {
          if (!isValidCreditCode(input.creditCode)) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "统一社会信用代码格式不正确（需 18 位，校验位不符）",
            });
          }
          const vr = await verifyEnterprise(
            input.enterpriseName,
            input.creditCode,
          );
          if (vr.status === "verified") {
            verifyStatus = "verified";
            verifiedAt = new Date();
            verifyPayload = vr.payload ?? null;
          } else if (vr.status === "mismatch") {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                "企业名称与统一社会信用代码在国家企业信用信息公示系统中不匹配",
            });
          } else if (vr.status === "not_found") {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                "未在国家企业信用信息公示系统查询到该企业，请核对名称与信用代码",
            });
          } else {
            verifyStatus = "pending_manual";
            verifyPayload = vr.payload ?? null;
          }
        } catch (err) {
          if (err instanceof TRPCError) throw err;
          // 核验意外异常一律降级为人工核验，不阻断注册
          verifyStatus = "pending_manual";
          verifyPayload = {
            reason: "verify_unexpected_error",
            error:
              err instanceof Error
                ? err.message.slice(0, 200)
                : String(err).slice(0, 200),
          };
        }
      }
      // 密码 hash 事务外预计算（scryptSync 不占池连接）
      const passwordHash = hashPassword(input.password);
      // inserts 事务化（门禁票：factory/user 裸奔双写=半态面；消费在事务内尾部与 inserts 同进退——信用核验网络调用在事务外）
      const { factoryId, userId } = await db.transaction(async (tx) => {
        const [{ id: factoryId }] = await tx
          .insert(wbFactories)
          .values({
            enterpriseName: input.enterpriseName,
            industry: input.industryGroup,
            industryGroup: input.industryGroup,
            industryText: input.industryText ?? null,
            creditCode: input.creditCode ?? null,
            verifyStatus,
            verifiedAt,
            verifyPayload,
            headcount: String(input.headcount),
            departments,
            painPoints: input.painPoints ?? null,
            profile: {
              source: "craftsman-market",
              registeredBy: input.phone,
            },
          })
          .$returningId();
        // M53：注册即供给——按申报部门实时生成 DSH 部门工作台配置（失败不阻断注册）
        const [{ id: userId }] = await tx
          .insert(wbUsers)
          .values({
            username: input.phone,
            phone: input.phone,
            passwordHash,
            displayName: input.displayName,
            realName: input.displayName,
            role: "admin", // M16：新写入直用新三级语义（存量 owner 由 normalizeRole 归一）
            kind: "enterprise",
            factoryId,
            departmentId: null,
          })
          .$returningId()
          .catch((e: unknown) => {
            // 双列 UNI 真闸（与 authRegister 同件——isDupEntry 共享）
            if (isDupEntry(e)) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: MSG_ENT_PHONE_DUP,
              });
            }
            throw e;
          });
        // 原子消费在事务尾部（与双 insert 同进退——提交即码耗，回滚即码存；门禁票：事务外消费=账号建了码没耗的重放面）
        // 邀测码原子消费（共享件 consumeBetaCode——一次性）
        await consumeBetaCode(tx, betaInvId);
        await consumeSmsCodeById(tx, smsRowId);
        return { factoryId, userId };
      });
      // M53：注册即供给（挪出事务——fire-and-forget 用自家连接，占 tx 回调=嵌套连接雷；门禁票）
      void provisionFactoryConsoles(Number(factoryId), departments).catch(
        () => {},
      );
      const token = await reissueToken(userId);
      // iter91：注册成功即自动组建熊猫军团（forming/training，行业模板编制）；
      // 失败不阻断注册（st_corps 表未迁移等场景降级记日志）。
      try {
        await formCorpsForFactory({
          factoryId,
          industry: input.industryGroup,
          actor: `register:${input.phone}`,
        });
      } catch (err) {
        console.error(
          "[iter91] 自动组建军团失败（不阻断注册）:",
          err instanceof Error
            ? err.message.slice(0, 200)
            : String(err).slice(0, 200),
        );
      }
      // iter92：注册成功即开通默认套餐（basic，200 LLM/日，30 天）；
      // 失败不阻断注册（st_factory_plan 表未迁移等场景降级记日志）。
      try {
        await initFactoryPlan(factoryId);
      } catch (err) {
        console.error(
          "[iter92] 默认套餐开通失败（不阻断注册）:",
          err instanceof Error
            ? err.message.slice(0, 200)
            : String(err).slice(0, 200),
        );
      }
      const [user] = await db
        .select()
        .from(wbUsers)
        .where(eq(wbUsers.id, userId))
        .limit(1);
      const [factory] = await db
        .select()
        .from(wbFactories)
        .where(eq(wbFactories.id, factoryId))
        .limit(1);
      return sessionInfoEx(user, factory, token);
    }),

  /**
   * authRegisterPerson（mutation）：个人注册（迭代 14，实名核验）。
   * 身份证号做 18 位 + GB11643 加权校验位验证；库中绝不存明文——
   * idCardHash=sha256(idCard)、idCardMasked=前4+10*+后4；phone 与 idCardHash 均唯一。
   * 创建 wb_users（username=phone、kind=person、factoryId=0、role=member）；
   * 输出 SessionInfo（factoryId=0, enterpriseName=null）+ kind='person'。
   */
  authRegisterPerson: publicQuery
    .input(
      z.object({
        phone: phoneSchema,
        password: z.string().min(8, "密码至少 8 位").max(128),
        realName: z.string().trim().min(2, "请填写真实姓名").max(64),
        idCard: z.string().trim().length(18, "身份证号须为 18 位"),
        // 验证码验真（门禁 security 票：APP 个人注册口公开——不验=预占劫持）
        code: z.string().trim().regex(SMS_CODE_RE, "验证码为 6 位数字"),
        // 邀测码闸（彭总令：个人注册同要邀测码——st_beta_invites 资格码面）
        betaCode: z.string().trim().regex(BETA_CODE_RE, BETA_CODE_MSG),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      // 验码两段式同口径（计数直提交；本路由无事务面——验后先查重，消费挪建档前）
      const { rowId: personSmsRowId } = await verifySmsCodeOnly(
        db,
        input.phone,
        "register",
        input.code,
      );
      // 邀测码预检（资格码共享件——彭总令：个人注册同要；kind 闸=personal 个人码专口[彭总链路钉]）
      const { betaInvId } = await verifyBetaCode(
        db,
        input.betaCode,
        input.phone,
        "personal",
      );
      if (!verifyIdCard(input.idCard)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "身份证号校验失败，请核对后重试",
        });
      }
      const idCardHash = sha256(input.idCard);
      const [dupPhone] = await db
        .select({ id: wbUsers.id })
        .from(wbUsers)
        .where(
          or(eq(wbUsers.phone, input.phone), eq(wbUsers.username, input.phone)),
        )
        .limit(1);
      if (dupPhone) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: MSG_ENT_PHONE_DUP,
        });
      }
      // person 注册事务化（门禁票：insert+消费不同事务=消费失败号建码未耗半态面）——查重/建档/消费同进退
      // 密码 hash 事务外预计算（scryptSync 不占池连接——门禁 perf 票）
      const personPasswordHash = hashPassword(input.password);
      const userId = await db.transaction(async (tx) => {
        const [dupIdCard] = await tx
          .select({ id: wbUsers.id })
          .from(wbUsers)
          .where(eq(wbUsers.idCardHash, idCardHash))
          .limit(1);
        if (dupIdCard) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "身份证已注册" });
        }
        const [{ id: userId }] = await tx
          .insert(wbUsers)
          .values({
            username: input.phone,
            phone: input.phone,
            passwordHash: personPasswordHash,
            displayName: input.realName,
            realName: input.realName,
            idCardHash,
            idCardMasked: maskIdCard(input.idCard),
            role: "member",
            kind: "person",
            factoryId: 0,
            departmentId: null,
          })
          .$returningId()
          .catch((e: unknown) => {
            // phone/idCardHash 双 UNI 真闸（与兄弟口同件——isDupEntry 共享；门禁票）
            if (isDupEntry(e)) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: "手机号或身份证已注册",
              });
            }
            throw e;
          });
        // 原子消费挪建档成功后（门禁票：消费在 insert 前=insert 失败码耗号没建半态面）
        await consumeBetaCode(tx, betaInvId); // 邀测码消费（同事务——一次性）
        await consumeSmsCodeById(tx, personSmsRowId);
        return userId;
      });
      const token = await reissueToken(userId);
      const [user] = await db
        .select()
        .from(wbUsers)
        .where(eq(wbUsers.id, userId))
        .limit(1);
      return sessionInfoEx(user, undefined, token);
    }),

  /**
   * @deprecated 2026-08-13 彭总拍板下线（观察期 30 天）：占位桩，
   * 游离个人入企已被 wbInvites.accept 完整覆盖，勿再调用。
   */
  sessionUpgrade: publicQuery.input(tokenInput).mutation(async ({ input }) => {
    const db = getDb();
    const user = await resolveWbUserByToken(db, input.token); // portal#86 必修：明文直读→双轨单点（变体面——列裁投影照拿全行[键面够用]）
    if (!user) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "token 无效或已过期",
      });
    }
    return markDeprecated("agentic.sessionUpgrade", "wbInvites.accept", {
      needEnterprise: true as const,
    });
  }),

  /**
   * authMe（query）：{ token } → { user, profile } | null。
   * token 无效时返回 null（由业务层判定，不抛错）。
   * 个人账号（kind=person, factoryId=0，无企业画像）返回 profile=null，
   * 由前端展示引导空态（不视为 token 失效）。
   */
  authMe: publicQuery.input(tokenInput).query(async ({ input }) => {
    const db = getDb();
    const user = await resolveWbUserByToken(db, input.token); // portal#86 必修：明文直读→双轨单点（authMe 面——前端会话判定消费面）
    if (!user) return null;
    const [factory] = await db
      .select()
      .from(wbFactories)
      .where(eq(wbFactories.id, user.factoryId))
      .limit(1);
    if (!factory && user.kind !== "person") return null;
    return {
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        orgRole: normalizeRole(user.role), // M16：归一三级角色（owner→admin、member→staff）
        kind: user.kind,
        phone: user.phone ?? null,
        factoryId: user.factoryId,
        departmentId: user.departmentId,
      },
      profile: factory ? profileOf(factory) : null,
    };
  }),

  /** authLogout（mutation）：{ token } → { ok: true }，token 置空 */
  authLogout: publicQuery.input(tokenInput).mutation(async ({ input }) => {
    const db = getDb();
    const { user } = await sessionMe(input.token);
    await db
      .update(wbUsers)
      .set({ authToken: null })
      .where(eq(wbUsers.id, user.id));
    return { ok: true as const };
  }),

  /**
   * enterpriseDirectory（query）：企业目录（无输入）。
   * 输出 [{ factoryId, enterpriseName, industry, departments: [{ id, name }] }]
   */
  enterpriseDirectory: publicQuery.query(async () => {
    const db = getDb();
    const rows = await db
      .select()
      .from(wbFactories)
      .orderBy(desc(wbFactories.id));
    return rows.map((f) => ({
      factoryId: f.id,
      enterpriseName: f.enterpriseName,
      industry: f.industry,
      departments: f.departments,
    }));
  }),

  /**
   * enterpriseActiveProfile（query）：{ factoryId? } → 当前企业画像。
   * 未传 factoryId 时返回最近注册的企业画像。
   */
  enterpriseActiveProfile: publicQuery
    .input(z.object({ factoryId: z.number().int().positive().optional() }))
    .query(async ({ input }) => {
      const db = getDb();
      const rows = await db
        .select()
        .from(wbFactories)
        .where(
          input.factoryId ? eq(wbFactories.id, input.factoryId) : undefined,
        )
        .orderBy(desc(wbFactories.id))
        .limit(1);
      const factory = rows[0];
      if (!factory) return null;
      return profileOf(factory);
    }),

  /**
   * employeeRegister（mutation）：员工注册（迭代 21 起需要 token）。
   * 输入 { token, username, password, displayName, factoryId, deptId }；
   * 权限：本企业 admin/owner，或本企业该部门负责人（wb_dept_heads 命中且本人
   * departmentId=deptId）；负责人只能往自己部门加人；
   * 约束：deptId 必须是企业画像中的真实部门；输出 SessionInfo + { deptName }。
   */
  employeeRegister: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        username: z.string().trim().min(2).max(64),
        password: z.string().min(6).max(128),
        displayName: z.string().trim().min(1).max(64),
        factoryId: z.number().int().positive(),
        deptId: z.string().trim().min(1).max(64),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { user: caller } = await sessionMe(input.token);
      if (caller.factoryId !== input.factoryId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: EMPLOYEE_REGISTER_DENIED,
        });
      }
      // M16：admin 直通；manager（normalizeRole 或 dept_heads 命中）限本部门
      const callerRole = normalizeRole(caller.role);
      if (callerRole !== "admin") {
        const isManager =
          callerRole === "manager" ||
          (await deptHeadOf(caller.id, caller.factoryId, caller.departmentId));
        if (!isManager) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: EMPLOYEE_REGISTER_DENIED,
          });
        }
        if (input.deptId !== caller.departmentId) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: CROSS_DEPT_DENIED,
          });
        }
      }
      const [factory] = await db
        .select()
        .from(wbFactories)
        .where(eq(wbFactories.id, input.factoryId))
        .limit(1);
      if (!factory) {
        throw new TRPCError({ code: "NOT_FOUND", message: "企业不存在" });
      }
      const dept = factory.departments.find((d) => d.id === input.deptId);
      if (!dept) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "deptId 必须是企业画像中的真实部门",
        });
      }
      const [dup] = await db
        .select({ id: wbUsers.id })
        .from(wbUsers)
        .where(eq(wbUsers.username, input.username))
        .limit(1);
      if (dup) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "用户名已存在" });
      }
      const [{ id: userId }] = await db
        .insert(wbUsers)
        .values({
          username: input.username,
          passwordHash: hashPassword(input.password),
          displayName: input.displayName,
          role: "staff", // M16：新写入直用新三级语义（存量 member 由 normalizeRole 归一）
          factoryId: factory.id,
          departmentId: input.deptId, // 保留 raw 值
        })
        .$returningId();
      const token = await reissueToken(userId);
      const [user] = await db
        .select()
        .from(wbUsers)
        .where(eq(wbUsers.id, userId))
        .limit(1);
      return { ...sessionInfo(user, factory, token), deptName: dept.name };
    }),

  /**
   * headRegister（mutation）：部门负责人注册（迭代 21 起需要 token）。
   * 仅本企业 role=admin/owner 可调用（sessionMe 校验 factoryId 一致）；
   * 在 employeeRegister 基础上增加可选 routineLimit?，额外写入 wb_dept_heads。
   */
  headRegister: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        username: z.string().trim().min(2).max(64),
        password: z.string().min(6).max(128),
        displayName: z.string().trim().min(1).max(64),
        factoryId: z.number().int().positive(),
        deptId: z.string().trim().min(1).max(64),
        routineLimit: z.number().int().positive().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { user: caller } = await sessionMe(input.token);
      // M16：守卫升级 requireWbRole(['admin','manager']) 等价语义（manager 限本部门）；
      // normalizeRole 与 wb_dept_heads 命中取并集，兼容存量 member 负责人
      const callerRole = normalizeRole(caller.role);
      const isManager =
        callerRole === "manager" ||
        (callerRole === "staff" &&
          (await deptHeadOf(caller.id, caller.factoryId, caller.departmentId)));
      if (callerRole !== "admin" && !isManager) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: HEAD_REGISTER_DENIED,
        });
      }
      if (caller.factoryId !== input.factoryId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: HEAD_REGISTER_DENIED,
        });
      }
      if (callerRole !== "admin" && input.deptId !== caller.departmentId) {
        throw new TRPCError({ code: "FORBIDDEN", message: CROSS_DEPT_DENIED });
      }
      const [factory] = await db
        .select()
        .from(wbFactories)
        .where(eq(wbFactories.id, input.factoryId))
        .limit(1);
      if (!factory) {
        throw new TRPCError({ code: "NOT_FOUND", message: "企业不存在" });
      }
      const dept = factory.departments.find((d) => d.id === input.deptId);
      if (!dept) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "deptId 必须是企业画像中的真实部门",
        });
      }
      const [dup] = await db
        .select({ id: wbUsers.id })
        .from(wbUsers)
        .where(eq(wbUsers.username, input.username))
        .limit(1);
      if (dup) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "用户名已存在" });
      }
      const [{ id: userId }] = await db
        .insert(wbUsers)
        .values({
          username: input.username,
          passwordHash: hashPassword(input.password),
          displayName: input.displayName,
          role: "manager", // M16：新写入直用新三级语义，与 wb_dept_heads 双写
          factoryId: factory.id,
          departmentId: input.deptId,
        })
        .$returningId();
      // 额外写入 dept_heads
      await db.insert(wbDeptHeads).values({
        factoryId: factory.id,
        deptId: input.deptId,
        userId,
        routineLimit: input.routineLimit ?? null,
      });
      const token = await reissueToken(userId);
      const [user] = await db
        .select()
        .from(wbUsers)
        .where(eq(wbUsers.id, userId))
        .limit(1);
      return { ...sessionInfo(user, factory, token), deptName: dept.name };
    }),

  /**
   * orgMembers（query）：{ token, factoryId? } → [{ deptId, deptName, name, memberRole, username }]
   * M16 安全收紧：需有效 token 且仅返回本企业成员（此前按 factoryId 无 token 公开，泄露成员清单）；
   * factoryId 入参保留向后兼容，但与登录态企业不一致即拒绝。
   */
  orgMembers: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        factoryId: z.number().int().positive().optional(),
      }),
    )
    .query(async ({ input }) => {
      const db = getDb();
      const { user: caller, factory } = await sessionMe(input.token);
      if (input.factoryId != null && input.factoryId !== caller.factoryId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "仅可查看本企业成员",
        });
      }
      const members = await db
        .select()
        .from(wbUsers)
        .where(eq(wbUsers.factoryId, caller.factoryId));
      const heads = await db
        .select()
        .from(wbDeptHeads)
        .where(eq(wbDeptHeads.factoryId, caller.factoryId));
      const headSet = new Set(heads.map((h) => `${h.deptId}:${h.userId}`));
      const deptName = (id: string | null) =>
        factory.departments.find((d) => d.id === id)?.name ?? null;
      return members.map((u) => ({
        deptId: u.departmentId,
        deptName: deptName(u.departmentId),
        name: u.displayName,
        memberRole:
          u.departmentId && headSet.has(`${u.departmentId}:${u.id}`)
            ? "dept_head"
            : u.role,
        username: u.username,
      }));
    }),

  /**
   * orgMemberResetPassword（mutation）：重置成员密码并吊销其 authToken。
   * 权限：admin/owner 可重置本企业任何人；dept_head 只能重置本部门 member。
   */
  orgMemberResetPassword: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        userId: z.number().int().positive(),
        newPassword: z.string().min(6, "新密码至少 6 位").max(128),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { user: caller } = await sessionMe(input.token);
      const [target] = await db
        .select()
        .from(wbUsers)
        .where(
          and(
            eq(wbUsers.id, input.userId),
            eq(wbUsers.factoryId, caller.factoryId),
          ),
        )
        .limit(1);
      if (!target) {
        throw new TRPCError({ code: "NOT_FOUND", message: "成员不存在" });
      }
      await assertMemberOperable(caller, target, "仅可为本部门成员重置密码", {
        allowSelf: true,
      });
      await db
        .update(wbUsers)
        .set({ passwordHash: hashPassword(input.newPassword), authToken: null })
        .where(eq(wbUsers.id, target.id));
      return { ok: true as const, userId: target.id };
    }),

  /**
   * orgMemberSetDisabled（mutation）：停用/启用成员；停用即吊销 authToken。
   * 权限同重置密码；禁止停用自己；admin/owner 不可被 head 操作。
   */
  orgMemberSetDisabled: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        userId: z.number().int().positive(),
        disabled: z.boolean(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { user: caller } = await sessionMe(input.token);
      const [target] = await db
        .select()
        .from(wbUsers)
        .where(
          and(
            eq(wbUsers.id, input.userId),
            eq(wbUsers.factoryId, caller.factoryId),
          ),
        )
        .limit(1);
      if (!target) {
        throw new TRPCError({ code: "NOT_FOUND", message: "成员不存在" });
      }
      if (input.disabled && target.id === caller.id) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "不可停用自己的账号",
        });
      }
      await assertMemberOperable(caller, target, "仅可停用/启用本部门成员");
      // disabled 列为 additive raw 列（sync-admin.mts），用 raw SQL 写入
      await db.execute(
        input.disabled
          ? sql`UPDATE wb_users SET disabled = 1, authToken = NULL WHERE id = ${target.id}`
          : sql`UPDATE wb_users SET disabled = 0 WHERE id = ${target.id}`,
      );
      return { ok: true as const, userId: target.id, disabled: input.disabled };
    }),

  /**
   * orgMemberList（query）：成员列表（含角色/部门名/状态/创建时间）。
   * admin/owner 看全企业；dept_head 仅看本部门。
   */
  orgMemberList: publicQuery.input(tokenInput).query(async ({ input }) => {
    const db = getDb();
    const { user: caller, factory } = await sessionMe(input.token);
    // M16：归一三级角色；manager = normalizeRole 命中 或 dept_heads 命中（并集，兼容存量）
    const callerRole = normalizeRole(caller.role);
    const isAdmin = callerRole === "admin";
    const headDept =
      !isAdmin &&
      (callerRole === "manager" ||
        (await deptHeadOf(caller.id, caller.factoryId, caller.departmentId)))
        ? caller.departmentId
        : null;
    if (!isAdmin && !headDept) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "仅企业负责人或部门负责人可查看成员列表",
      });
    }
    const members = await db
      .select()
      .from(wbUsers)
      .where(
        headDept
          ? and(
              eq(wbUsers.factoryId, caller.factoryId),
              eq(wbUsers.departmentId, headDept),
            )
          : eq(wbUsers.factoryId, caller.factoryId),
      );
    const heads = await db
      .select()
      .from(wbDeptHeads)
      .where(eq(wbDeptHeads.factoryId, caller.factoryId));
    const headSet = new Set(heads.map((h) => `${h.deptId}:${h.userId}`));
    const deptName = (id: string | null) =>
      factory.departments.find((d) => d.id === id)?.name ?? null;
    // disabled 为 additive raw 列（sync-admin.mts）：列不存在则回退 false
    let disabledSet = new Set<number>();
    try {
      const rows = (await db.execute(
        sql`SELECT id, disabled FROM wb_users WHERE factoryId = ${caller.factoryId}`,
      )) as unknown;
      const list =
        Array.isArray(rows) && Array.isArray(rows[0])
          ? (rows[0] as Array<Record<string, unknown>>)
          : [];
      disabledSet = new Set(
        list.filter((r) => Number(r.disabled) === 1).map((r) => Number(r.id)),
      );
    } catch {
      // 列尚未补齐：忽略
    }
    return members
      .map((u) => ({
        userId: u.id,
        username: u.username,
        displayName: u.displayName,
        role:
          u.departmentId && headSet.has(`${u.departmentId}:${u.id}`)
            ? ("dept_head" as const)
            : u.role,
        deptId: u.departmentId,
        deptName: deptName(u.departmentId),
        disabled: disabledSet.has(u.id),
        createdAt: u.createdAt,
      }))
      .sort((a, b) => a.userId - b.userId);
  }),

  /**
   * orgAutoSetup（mutation，需要 token）—— 企业注册 AI 自动建组织。
   * 确定性"AI"解析：按行业关键词从内置模板生成部门与角色（老板/车间主任/老师傅/
   * 质检员/操作工，行业词命中时生产车间替换为特色部门名），每个角色配备一位专属 Agent：
   * 优先从全平台 wb_listings（type=agent 且 listed）按技能关键词匹配，不够则从主匠市
   * 推荐池（振衡/听涛/炽眸/衡准/策炉/巡线）确定性指派，写入 wb_role_agents。
   * 幂等：同 factory 重复调用返回既有结果，不重复插入。
   * 输出 { departments: [{ name, roles: [{ role, agentName, agentId, agentSource }] }], summary }
   */
  orgAutoSetup: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        industryHint: z.string().trim().max(64).optional(),
        orgDescription: z.string().trim().max(2000).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { factory } = await sessionMe(input.token);

      // ── 幂等：已有角色 Agent 编排 → 直接返回既有结果 ──────────────────────
      const existing = await db
        .select()
        .from(wbRoleAgents)
        .where(eq(wbRoleAgents.factoryId, factory.id));
      if (existing.length > 0) {
        // 2026-09-05 口径修（彭总令）：部门数一律读超终组织阵列（十舱），不数角色涉及的部门名
        const deptRows = rawRows(
          await db.execute(sql`SELECT COUNT(*) AS c FROM st_departments`),
        );
        const deptTotal =
          Number(
            (deptRows[0] as Record<string, unknown> | undefined)?.c ?? 0,
          ) || 0;
        return {
          departments: groupRoleAgents(existing),
          summary: `组织已生成：${deptTotal} 个部门 / ${existing.length} 个角色已配备专属数字工匠（重复调用返回既有结果）。`,
          generatedBy: "agentic.orgAutoSetup",
          reused: true,
        };
      }

      // ── 确定性解析：行业 → 行业化角色模板集（默认工业模板） ─────────────
      const industryText = [
        factory.industry,
        factory.industryText ?? "",
        input.industryHint ?? "",
        input.orgDescription ?? "",
      ].join(" ");
      const productionDept = resolveProductionDept(industryText);
      const industrySet = resolveIndustryRoleSet(industryText);

      const existingDepts = factory.departments.map((d) => d.name);
      const pickDept = (template: string, keys: string[]) =>
        existingDepts.find((n) => keys.some((k) => n.includes(k))) ?? template;

      const roles: RoleTemplate[] = industrySet
        ? industrySet.roles.map((r) => ({
            ...r,
            dept: pickDept(r.dept, r.deptKeys),
          }))
        : [
            {
              role: "老板",
              dept: pickDept("总经办", ["总经", "经营", "管理", "办公"]),
              deptKeys: ["总经", "经营", "管理", "办公"],
              skillKeys: ["经营", "决策", "排产", "计划", "分析"],
              poolSlug: "celu",
            },
            {
              role: "车间主任",
              dept: pickDept(productionDept, [
                "生产",
                "车间",
                "制造",
                "产线",
                "装配",
              ]),
              deptKeys: ["生产", "车间", "制造", "产线", "装配"],
              skillKeys: ["设备", "振动", "监控", "运维", "诊断"],
              poolSlug: "zhenheng",
            },
            {
              role: "老师傅",
              dept: pickDept("工艺技术部", ["工艺", "技术", "设备"]),
              deptKeys: ["工艺", "技术", "设备"],
              skillKeys: ["工艺", "热处理", "焊接", "数控"],
              poolSlug: "chimou",
            },
            {
              role: "质检员",
              dept: pickDept("质检部", ["质检", "质量", "品控", "检验"]),
              deptKeys: ["质检", "质量", "品控", "检验"],
              skillKeys: ["质检", "检测", "测量", "焊缝"],
              poolSlug: "hengzhun",
            },
            {
              role: "操作工",
              dept: pickDept(productionDept, [
                "生产",
                "车间",
                "制造",
                "产线",
                "装配",
              ]),
              deptKeys: ["生产", "车间", "制造", "产线", "装配"],
              skillKeys: ["巡检", "声学", "听音", "点检"],
              poolSlug: "tingtao",
            },
          ];

      // 企业尚无部门画像时，回写生成的部门（d1..d4，幂等前提：仅在为空时写入）
      if (factory.departments.length === 0) {
        const genNames = [...new Set(roles.map((r) => r.dept))];
        const departments = genNames.map((name, i) => ({
          id: `d${i + 1}`,
          name,
        }));
        await db
          .update(wbFactories)
          .set({ departments })
          .where(eq(wbFactories.id, factory.id));
      }

      // ── Agent 配备：先 listed 智能体上架（技能关键词评分），再推荐池兜底 ──
      const listedAgents = await db
        .select()
        .from(wbListings)
        .where(
          and(eq(wbListings.type, "agent"), eq(wbListings.status, "listed")),
        );
      const usedListingIds = new Set<number>();
      const usedSlugs = new Set<string>();

      const marketPool = await db.select().from(agents);
      const poolBySlug = new Map(marketPool.map((a) => [a.slug, a]));
      const POOL_ORDER = industrySet?.poolOrder ?? [
        "zhenheng",
        "tingtao",
        "chimou",
        "hengzhun",
        "celu",
        "xunxian",
      ];

      const rows: {
        factoryId: number;
        role: string;
        deptName: string;
        agentId: number | null;
        agentName: string;
        agentSource: "market" | "listing";
      }[] = [];

      for (const tpl of roles) {
        // 1) listed 上架匹配（评分 = 关键词命中数；平分取 id 小者，确定性）
        let best: { id: number; title: string; score: number } | null = null;
        for (const l of listedAgents) {
          if (usedListingIds.has(l.id)) continue;
          const hay = `${l.title} ${(l.capabilities ?? []).join(" ")} ${l.description}`;
          const score = tpl.skillKeys.filter((k) => hay.includes(k)).length;
          if (score > 0 && (!best || score > best.score)) {
            best = { id: l.id, title: l.title, score };
          }
        }
        if (best) {
          usedListingIds.add(best.id);
          rows.push({
            factoryId: factory.id,
            role: tpl.role,
            deptName: tpl.dept,
            agentId: best.id,
            agentName: best.title,
            agentSource: "listing",
          });
          continue;
        }
        // 2) 推荐池确定性指派：首选 slug 被占则按 POOL_ORDER 取未占用者
        let slug = tpl.poolSlug;
        if (usedSlugs.has(slug) || !poolBySlug.has(slug)) {
          slug =
            POOL_ORDER.find((s) => !usedSlugs.has(s) && poolBySlug.has(s)) ??
            tpl.poolSlug;
        }
        usedSlugs.add(slug);
        const agent = poolBySlug.get(slug);
        rows.push({
          factoryId: factory.id,
          role: tpl.role,
          deptName: tpl.dept,
          agentId: agent?.id ?? null,
          agentName: agent ? `${agent.name}（匠市推荐）` : "内置推荐数字工匠",
          agentSource: "market",
        });
      }

      for (const r of rows) {
        await db.insert(wbRoleAgents).values(r);
      }
      const inserted = await db
        .select()
        .from(wbRoleAgents)
        .where(eq(wbRoleAgents.factoryId, factory.id));

      return {
        departments: groupRoleAgents(inserted),
        summary: `AI 已为「${factory.enterpriseName}」生成 ${new Set(inserted.map((r) => r.deptName)).size} 个部门、${inserted.length} 个角色，并为每个角色配备专属数字工匠（已生效，可随时在组织页调整）。`,
        generatedBy: "agentic.orgAutoSetup",
        reused: false,
      };
    }),
});
