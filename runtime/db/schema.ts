import {
  mysqlTable,
  mysqlEnum,
  bigint,
  int,
  tinyint,
  varchar,
  text,
  boolean,
  double,
  json,
  timestamp,
  index,
  uniqueIndex,
  serial,
} from "drizzle-orm/mysql-core";

// ─── 老师傅（Agent 经验来源 / creator）───────────────────────────────────────
export const masters = mysqlTable("masters", {
  id: bigint("id", { mode: "number", unsigned: true })
      .autoincrement()
      .primaryKey(),
  name: varchar("name", { length: 64 }).notNull(),
  // 署名行，如 "陈国栋 · 32年数控经验"
  signature: varchar("signature", { length: 128 }).notNull(),
  specialty: varchar("specialty", { length: 128 }).notNull(), // 领域，如 "数控设备"
  yearsExperience: int("yearsExperience").notNull(),
  title: varchar("title", { length: 128 }), // 头衔，如 "某重工集团高级技师"
  reputation: int("reputation").notNull().default(80), // 声望 0-100
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// ─── 雇主企业 ────────────────────────────────────────────────────────────────
export const enterprises = mysqlTable("enterprises", {
  id: bigint("id", { mode: "number", unsigned: true })
      .autoincrement()
      .primaryKey(),
  name: varchar("name", { length: 128 }).notNull(),
  industry: varchar("industry", { length: 64 }).notNull(),
  contactName: varchar("contactName", { length: 64 }),
  contactTitle: varchar("contactTitle", { length: 64 }), // 联系人职务，如 "设备总监"
  tokenBalance: int("tokenBalance").notNull().default(0),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// ─── 数字工匠 Agent ─────────────────────────────────────────────────────────
export const agents = mysqlTable(
  "agents",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .autoincrement()
      .primaryKey(),
    slug: varchar("slug", { length: 64 }).notNull().unique(), // zhenheng / tingtao ...
    code: varchar("code", { length: 16 }).notNull().unique(), // ART-0007
    name: varchar("name", { length: 64 }).notNull(),
    avatar: varchar("avatar", { length: 255 }).notNull(), // /avatar-zhenheng.png
    // iter83 3D 数字人：参数化形象配置（seed/palette/ring）+ 购买前自我介绍文案
    avatarConfig: json("avatar_config").$type<{
      seed: string;
      palette: { primary: string; accent: string };
      ring?: boolean;
    } | null>(),
    introText: text("intro_text"),
    industry: varchar("industry", { length: 64 }).notNull(),
    industryGroup: varchar("industryGroup", { length: 32 }).notNull().default("工业制造"),
    capabilityTags: json("capabilityTags").$type<string[]>().notNull(),
    masterId: bigint("masterId", { mode: "number", unsigned: true })
      .notNull()
      .references(() => masters.id),
    status: mysqlEnum("status", ["pending", "active", "suspended", "rejected"])
      .notNull()
      .default("active"),
    delistRisk: boolean("delistRisk").notNull().default(false), // 连续低分下架风险
    monthlyPrice: int("monthlyPrice").notNull(), // 当前月薪 Token/月
    suggestedPrice: int("suggestedPrice").notNull(), // 平台建议价
    tasksCompleted: int("tasksCompleted").notNull().default(0),
    successRate: double("successRate").notNull().default(98), // 百分比 0-100
    avgRating: double("avgRating").notNull().default(5), // 0-5
    ratingCount: int("ratingCount").notNull().default(0),
    experienceMonths: int("experienceMonths").notNull().default(0),
    skillCount: int("skillCount").notNull().default(0), // 冗余技能数（展示用）
    memoryCount: int("memoryCount").notNull().default(0), // 工作记忆条目数（含历史基线）
    weeklyHires: int("weeklyHires").notNull().default(0), // 本周新增雇佣（榜单用）
    weeklyHireTrend: json("weeklyHireTrend").$type<number[]>().notNull(), // 近 7 天雇佣柱状
    recommended: boolean("recommended").notNull().default(false), // 匠市推荐
    certified: boolean("certified").notNull().default(true), // 平台认证
    listedAt: timestamp("listedAt").defaultNow().notNull(),
    // P2-4（W3）：数字员工审核留痕 —— 只进不出的 pending 状态补操作入口与留痕。
    // 三列 additive、全 NULL-able、不改既有列；按 devListings 既有约定（status+listedAt+人工审核）对齐。
    // ⚠️ C 级双签面：本处只出声明，落库走 db/sync-agent-review.mts（幂等 additive），Owner 签后才执行。
    reviewedAt: timestamp("reviewedAt"),
    reviewedBy: varchar("reviewedBy", { length: 64 }), // 审核人（admin id 或 username 留痕）
    rejectReason: varchar("rejectReason", { length: 255 }), // 驳回理由（agentReview.reject 必填）
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    statusIdx: index("agents_status_idx").on(table.status),
    industryIdx: index("agents_industry_idx").on(table.industry),
    // iter85：匠市列表 status+industry 组合过滤（由 db/sync-iter85.mts 落库）
    statusIndustryIdx: index("agents_status_industry_idx").on(
      table.status,
      table.industry,
    ),
  }),
);

// ─── 技能（每个 Agent 8-12 项）──────────────────────────────────────────────
export const skills = mysqlTable(
  "skills",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .autoincrement()
      .primaryKey(),
    agentId: bigint("agentId", { mode: "number", unsigned: true })
      .notNull()
      .references(() => agents.id),
    name: varchar("name", { length: 128 }).notNull(),
    type: mysqlEnum("type", ["V", "U"]).notNull(), // V=动作 U=判断逻辑
    complexity: int("complexity").notNull().default(3), // 1-5
    pricePerCall: int("pricePerCall").notNull().default(100), // 单次调用 Token
    callCount: int("callCount").notNull().default(0),
    successRate: double("successRate").notNull().default(98), // 百分比（种子口径，H1 起前端改展示 realSuccessRate）
    // Harness H1：执行器登记（tool/llm_doc/llm_analysis/llm_kb_qa/llm_ppt/llm_sheet/generic）；
    // 由 db/sync-h1.mts additive 加列并回填（同名继承 st_skills.executor_kind，无映射记 'generic'）
    executorKind: varchar("executorKind", { length: 32 }),
    description: varchar("description", { length: 255 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    agentIdx: index("skills_agent_idx").on(table.agentId),
  }),
);

// ─── 雇佣记录（智能合约）─────────────────────────────────────────────────────
export const agentHireRecords = mysqlTable(
  "agent_hire_records",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .autoincrement()
      .primaryKey(),
    agentId: bigint("agentId", { mode: "number", unsigned: true })
      .notNull()
      .references(() => agents.id),
    enterpriseId: bigint("enterpriseId", { mode: "number", unsigned: true })
      .notNull()
      .references(() => enterprises.id),
    periodMonths: int("periodMonths").notNull(), // 合约周期（月）
    monthlyPrice: int("monthlyPrice").notNull(), // 签约月薪 Token
    status: mysqlEnum("status", ["trial", "active", "expired", "cancelled"])
      .notNull()
      .default("active"),
    tasksCompleted: int("tasksCompleted").notNull().default(0),
    rating: double("rating"), // 雇主评价分（可空）
    review: text("review"), // 雇主评价文字（可空）
    startedAt: timestamp("startedAt").notNull(),
    endsAt: timestamp("endsAt").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    agentIdx: index("hire_agent_idx").on(table.agentId),
    enterpriseIdx: index("hire_enterprise_idx").on(table.enterpriseId),
  }),
);

// ─── 7 天免费试用 ────────────────────────────────────────────────────────────
export interface TrialReport {
  suitabilityScore: number; // 适用度评分 0-100
  diagnosticAccuracy: number; // 诊断准确率 %
  avgResponseSec: number; // 平均响应秒
  tasksCompleted: number;
  confidenceGrade: string; // A / A- / B+ ...
  advice: string; // 雇佣建议
  summary: string;
  highlights: string[];
}

export const trials = mysqlTable(
  "trials",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .autoincrement()
      .primaryKey(),
    agentId: bigint("agentId", { mode: "number", unsigned: true })
      .notNull()
      .references(() => agents.id),
    enterpriseId: bigint("enterpriseId", { mode: "number", unsigned: true })
      .notNull()
      .references(() => enterprises.id),
    status: mysqlEnum("status", ["active", "completed", "expired"])
      .notNull()
      .default("active"),
    productionLine: varchar("productionLine", { length: 255 }), // 产线信息（申请时填写）
    skillCalls: int("skillCalls").notNull().default(0),
    tokensSpent: int("tokensSpent").notNull().default(0),
    report: json("report").$type<TrialReport>(), // 结束后生成
    startedAt: timestamp("startedAt").notNull(),
    endsAt: timestamp("endsAt").notNull(), // startedAt + 7 天
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    agentIdx: index("trials_agent_idx").on(table.agentId),
  }),
);

// ─── 任务执行 ────────────────────────────────────────────────────────────────
export interface TaskStep {
  order: number;
  kind: "intent" | "decompose" | "dispatch" | "execute" | "verify" | "report";
  title: string;
  detail: string;
  skillName?: string; // dispatch/execute 步骤对应技能
  tokens?: number; // 该步骤技能调用费
  durationMs: number;
  status: "done";
  logs?: string[]; // 执行日志流
}

export interface TaskReport {
  title: string;
  findings: string[]; // 关键发现
  suggestions: string[]; // 建议措施
  processSummary: string; // 执行过程摘要
  skillChain: string[]; // 技能链
  confidence: number; // 0-1
  confidenceGrade: string; // A / B ...
  durationMs: number;
  tokenCost: number;
}

export const tasks = mysqlTable(
  "tasks",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .autoincrement()
      .primaryKey(),
    agentId: bigint("agentId", { mode: "number", unsigned: true })
      .notNull()
      .references(() => agents.id),
    enterpriseId: bigint("enterpriseId", { mode: "number", unsigned: true })
      .notNull()
      .references(() => enterprises.id),
    hireRecordId: bigint("hireRecordId", { mode: "number", unsigned: true })
      .references(() => agentHireRecords.id),
    instruction: text("instruction").notNull(), // 雇主自然语言任务
    intentSummary: varchar("intentSummary", { length: 255 }).notNull(), // 意图解析结果
    targetDevice: varchar("targetDevice", { length: 64 }), // 目标设备，如 CNC-03
    status: mysqlEnum("status", ["completed", "failed"])
      .notNull()
      .default("completed"),
    steps: json("steps").$type<TaskStep[]>().notNull(),
    report: json("report").$type<TaskReport>().notNull(),
    confidence: double("confidence").notNull(), // 0-1
    tokenCost: int("tokenCost").notNull(), // 本次技能调用总费
    durationMs: int("durationMs").notNull(),
    memoryWritten: boolean("memoryWritten").notNull().default(false),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    agentIdx: index("tasks_agent_idx").on(table.agentId),
    enterpriseIdx: index("tasks_enterprise_idx").on(table.enterpriseId),
  }),
);

// ─── 工作记忆 ────────────────────────────────────────────────────────────────
export const agentMemories = mysqlTable(
  "agent_memories",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .autoincrement()
      .primaryKey(),
    agentId: bigint("agentId", { mode: "number", unsigned: true })
      .notNull()
      .references(() => agents.id),
    taskId: bigint("taskId", { mode: "number", unsigned: true }).references(
      () => tasks.id,
    ),
    category: varchar("category", { length: 32 }).notNull(), // 设备特征/工艺参数/雇主偏好/环境补偿
    summary: text("summary").notNull(), // 任务摘要 + 关键经验
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    agentIdx: index("memories_agent_idx").on(table.agentId),
  }),
);

// ─── 评价 ────────────────────────────────────────────────────────────────────
export const reviews = mysqlTable(
  "reviews",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .autoincrement()
      .primaryKey(),
    agentId: bigint("agentId", { mode: "number", unsigned: true })
      .notNull()
      .references(() => agents.id),
    enterpriseId: bigint("enterpriseId", { mode: "number", unsigned: true })
      .notNull()
      .references(() => enterprises.id),
    hireRecordId: bigint("hireRecordId", { mode: "number", unsigned: true }).references(
      () => agentHireRecords.id,
    ),
    taskId: bigint("taskId", { mode: "number", unsigned: true }).references(
      () => tasks.id,
    ),
    rating: int("rating").notNull(), // 1-5
    content: text("content").notNull(),
    employerTitle: varchar("employerTitle", { length: 64 }), // 评价人职务
    hireMonths: int("hireMonths"), // 已雇佣月数（展示 chip）
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    agentIdx: index("reviews_agent_idx").on(table.agentId),
    // iter85：详情评价列表 agentId 过滤 + createdAt 排序（由 db/sync-iter85.mts 落库）
    agentCreatedIdx: index("reviews_agent_created_idx").on(
      table.agentId,
      table.createdAt,
    ),
  }),
);

// ─── Token 流水 ──────────────────────────────────────────────────────────────
export const tokenTransactions = mysqlTable(
  "token_transactions",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .autoincrement()
      .primaryKey(),
    type: mysqlEnum("type", [
      "hire_commission", // 雇佣佣金（平台 15%）
      "skill_call", // 技能调用（平台 20%）
      "trial_skill_call", // 试用期技能调用（平台 20%）
      "trial_reward", // 试用激励/补贴
      "price_adjustment", // 调价差额
    ]).notNull(),
    amount: int("amount").notNull(), // 流水总额 Token
    platformFee: int("platformFee").notNull(), // 平台佣金
    masterShare: int("masterShare").notNull(), // 老师傅分成
    agentId: bigint("agentId", { mode: "number", unsigned: true })
      .notNull()
      .references(() => agents.id),
    enterpriseId: bigint("enterpriseId", { mode: "number", unsigned: true })
      .notNull()
      .references(() => enterprises.id),
    hireRecordId: bigint("hireRecordId", { mode: "number", unsigned: true }).references(
      () => agentHireRecords.id,
    ),
    taskId: bigint("taskId", { mode: "number", unsigned: true }).references(
      () => tasks.id,
    ),
    note: varchar("note", { length: 255 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    agentIdx: index("tx_agent_idx").on(table.agentId),
    typeIdx: index("tx_type_idx").on(table.type),
  }),
);

// ─── 招募单（企业发布 Agent 需求）───────────────────────────────────────────
export const recruitments = mysqlTable(
  "recruitments",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .autoincrement()
      .primaryKey(),
    enterpriseId: bigint("enterpriseId", { mode: "number", unsigned: true })
      .notNull()
      .references(() => enterprises.id),
    // 发布人（登录用户）；种子数据可为空
    createdByUserId: bigint("createdByUserId", {
      mode: "number",
      unsigned: true,
    }).references(() => users.id),
    title: varchar("title", { length: 128 }).notNull(),
    industry: varchar("industry", { length: 64 }).notNull(),
    capabilityTags: json("capabilityTags").$type<string[]>().notNull(),
    description: text("description").notNull(),
    budgetMonthly: int("budgetMonthly").notNull(), // 预算 Token/月
    periodMonths: int("periodMonths").notNull(), // 招募周期（月）
    urgent: boolean("urgent").notNull().default(false), // 急聘
    status: mysqlEnum("status", ["open", "filled", "closed"])
      .notNull()
      .default("open"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    enterpriseIdx: index("recruitments_enterprise_idx").on(table.enterpriseId),
    statusIdx: index("recruitments_status_idx").on(table.status),
    industryIdx: index("recruitments_industry_idx").on(table.industry),
  }),
);

// ─── 招募应征（Agent 应征企业招募单）─────────────────────────────────────────
export const recruitmentApplications = mysqlTable(
  "recruitment_applications",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .autoincrement()
      .primaryKey(),
    recruitmentId: bigint("recruitmentId", { mode: "number", unsigned: true })
      .notNull()
      .references(() => recruitments.id),
    agentId: bigint("agentId", { mode: "number", unsigned: true })
      .notNull()
      .references(() => agents.id),
    // 应征提交人（登录用户）；种子数据可为空
    applicantUserId: bigint("applicantUserId", {
      mode: "number",
      unsigned: true,
    }).references(() => users.id),
    message: text("message").notNull(), // 应征留言 / 方案说明
    status: mysqlEnum("status", ["pending", "accepted", "rejected"])
      .notNull()
      .default("pending"),
    decidedAt: timestamp("decidedAt"), // 企业决定时间（接受/拒绝时回填）
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    recruitmentIdx: index("applications_recruitment_idx").on(
      table.recruitmentId,
    ),
    agentIdx: index("applications_agent_idx").on(table.agentId),
    applicantIdx: index("applications_applicant_idx").on(table.applicantUserId),
    statusIdx: index("applications_status_idx").on(table.status),
  }),
);

// ─── 类型导出 ────────────────────────────────────────────────────────────────
export type Master = typeof masters.$inferSelect;
export type Enterprise = typeof enterprises.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type Skill = typeof skills.$inferSelect;
export type AgentHireRecord = typeof agentHireRecords.$inferSelect;
export type Trial = typeof trials.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type AgentMemory = typeof agentMemories.$inferSelect;
export type Review = typeof reviews.$inferSelect;
export type TokenTransaction = typeof tokenTransactions.$inferSelect;
export type Recruitment = typeof recruitments.$inferSelect;
export type RecruitmentApplication =
  typeof recruitmentApplications.$inferSelect;

export const users = mysqlTable("users", {
  id: serial("id").primaryKey(),
  unionId: varchar("unionId", { length: 255 }).notNull().unique(),
  name: varchar("name", { length: 255 }),
  email: varchar("email", { length: 320 }),
  avatar: text("avatar"),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
  lastSignInAt: timestamp("lastSignInAt").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// ═══════════════════════════════════════════════════════════════════════════
// 灵枢星云智能工作台（同部署承载，wb_ 前缀）
// 依据《灵枢星云智能工作台 API 文档（匠市对接版）》实现：
// - token 单点有效（nt_ 前缀，覆盖 wb_users.authToken）
// - ticket（st_+48hex）/ publishKey（pk_+48hex）明文一次性，库只存 sha256
// - 运行表均按 factoryId 作用域隔离；wb_users.departmentId 保留 raw 值
// ═══════════════════════════════════════════════════════════════════════════

// ─── 工作台用户 ──────────────────────────────────────────────────────────────
export const wbUsers = mysqlTable(
  "wb_users",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .autoincrement()
      .primaryKey(),
    username: varchar("username", { length: 64 }).notNull().unique(),
    passwordHash: varchar("passwordHash", { length: 255 }).notNull(), // scrypt: salt:hash(hex)
    displayName: varchar("displayName", { length: 64 }).notNull(),
    // M16：枚举纯加值（manager/staff），存量 admin/owner/member 语义由
    // normalizeRole（api/routers/wbSession.ts）读取侧归一：owner→admin、member→staff
    role: mysqlEnum("role", ["admin", "owner", "manager", "staff", "member"])
      .notNull()
      .default("member"),
    factoryId: bigint("factoryId", { mode: "number", unsigned: true }).notNull(),
    departmentId: varchar("departmentId", { length: 64 }), // 保留 raw 部门 ID
    authToken: varchar("authToken", { length: 80 }), // nt_ 前缀，单点有效
    // 迭代 14 additive：手机号登录 / 个人实名（身份证绝不存明文，仅 sha256 + 掩码）
    phone: varchar("phone", { length: 20 }), // 唯一索引；存量行允许 NULL
    realName: varchar("realName", { length: 64 }),
    idCardMasked: varchar("idCardMasked", { length: 32 }), // 前4+10*+后4
    idCardHash: varchar("idCardHash", { length: 64 }), // sha256(身份证号)
    kind: mysqlEnum("kind", ["person", "enterprise"])
      .notNull()
      .default("enterprise"),
    // v162 additive：性别（注册男女模块；NULL=未填）
    gender: varchar("gender", { length: 8 }),
    // v170 additive：城市归属（大屏点亮；NULL=待点亮）
    city: varchar("city", { length: 16 }),
    // v174 additive：音色偏好（VOICE_REGISTRY 键；NULL=默认）
    voice_pref: varchar("voice_pref", { length: 24 }),
    // M16 additive：邀请渠道审计（NULL=非邀请渠道）；activatedAt NULL=待激活/非邀请
    invitedBy: bigint("invitedBy", { mode: "number", unsigned: true }),
    activatedAt: timestamp("activatedAt"),
    // M16 补齐：列早已由 sync-admin.mts 落库（TINYINT(1)，MySQL 中 boolean 为其别名），
    // 此前一直 raw SQL 访问，现入 schema 消除特例（存量 raw SQL 读写不受影响）
    disabled: boolean("disabled").notNull().default(false),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    phoneIdx: uniqueIndex("wb_users_phone_uniq").on(table.phone),
    // iter85：每请求 token 鉴权点查（由 db/sync-iter85.mts 落库）
    authTokenIdx: index("wb_users_authToken_idx").on(table.authToken),
  }),
);

// ─── 工作台企业（工厂画像）──────────────────────────────────────────────────
export const wbFactories = mysqlTable("wb_factories", {
  id: bigint("id", { mode: "number", unsigned: true })
    .autoincrement()
    .primaryKey(),
  enterpriseName: varchar("enterpriseName", { length: 128 }).notNull(),
  industry: varchar("industry", { length: 64 }).notNull(),
  industryText: varchar("industryText", { length: 128 }),
  headcount: varchar("headcount", { length: 32 }).notNull(),
  departments: json("departments")
    .$type<{ id: string; name: string; headcount?: string; duty?: string }[]>()
    .notNull(),
  painPoints: text("painPoints"),
  profile: json("profile").$type<Record<string, unknown>>(),
  // 迭代 14 additive：统一社会信用代码（选填）+ 行业大类（12 大类之一）
  creditCode: varchar("creditCode", { length: 32 }),
  // 迭代 90 additive：国家企业信用信息公示系统核验结果
  verifyStatus: varchar("verifyStatus", { length: 24 })
    .notNull()
    .default("unverified"),
  verifiedAt: timestamp("verifiedAt"),
  verifyPayload: json("verifyPayload").$type<Record<string, unknown>>(),
  industryGroup: varchar("industryGroup", { length: 32 })
    .notNull()
    .default("工业制造"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// ─── 部门负责人 ──────────────────────────────────────────────────────────────
export const wbDeptHeads = mysqlTable(
  "wb_dept_heads",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .autoincrement()
      .primaryKey(),
    factoryId: bigint("factoryId", { mode: "number", unsigned: true }).notNull(),
    deptId: varchar("deptId", { length: 64 }).notNull(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    routineLimit: int("routineLimit"),
  },
  (table) => ({
    factoryIdx: index("wb_dept_heads_factory_idx").on(table.factoryId),
  }),
);

// ─── 一次性组织邀请（iv_+48hex，明文仅 create 响应返回一次，库只存 sha256）───
// M16 组织账号权限：仅 admin 可发；role 限定 manager/staff（admin 不可被邀请产生）；
// consumedAt/revokedAt 一次性语义，expiresAt 默认 72h（24h~7d 可配）。
export const wbInvites = mysqlTable(
  "wb_invites",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .autoincrement()
      .primaryKey(),
    factoryId: bigint("factoryId", { mode: "number", unsigned: true }).notNull(), // 企业隔离
    codeHash: varchar("codeHash", { length: 64 }).notNull().unique(), // sha256(明文码)
    displayName: varchar("displayName", { length: 64 }).notNull(), // 受邀者姓名（落地页预填）
    deptId: varchar("deptId", { length: 64 }).notNull(), // 必须 ∈ factory.departments
    role: mysqlEnum("role", ["manager", "staff"]).notNull(),
    inviterId: bigint("inviterId", { mode: "number", unsigned: true }).notNull(), // 发起人（admin）
    expiresAt: timestamp("expiresAt").notNull(),
    consumedAt: timestamp("consumedAt"),
    revokedAt: timestamp("revokedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    factoryIdx: index("wb_invites_factory_idx").on(table.factoryId),
    expiresIdx: index("wb_invites_expires_idx").on(table.expiresAt),
  }),
);

// ─── M17 一次性设备配对码（pd_+48hex，TTL 300s，库只存 sha256，明文仅 open 响应一次）──
// 不配 factoryId：码在 claim 前不属于任何企业，归属由 claim 者决定（与 wb_invites 的关键差异）。
export const wbPairCodes = mysqlTable(
  "wb_pair_codes",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .autoincrement()
      .primaryKey(),
    codeHash: varchar("codeHash", { length: 64 }).notNull().unique(), // sha256(明文码)
    deviceName: varchar("deviceName", { length: 64 }).notNull(), // 设备自报名
    deviceType: mysqlEnum("deviceType", ["desktop", "tablet", "box", "other"]).notNull(),
    fingerprint: varchar("fingerprint", { length: 128 }).notNull(), // 设备指纹（防重复绑定）
    expiresAt: timestamp("expiresAt").notNull(),
    consumedAt: timestamp("consumedAt"),
    // F1 链接列：claim 事务内回写本码建出的设备 id；status 按此精确找设备（杜绝旧码领新设备）
    consumedDeviceId: varchar("consumedDeviceId", { length: 32 }),
    // M72 发现通道审计：NULL/'qr'=扫码（存量行零影响）；'ble'/'mdns'=信号源自动发现（ps_ 60s 短码）
    channel: varchar("channel", { length: 8 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    expiresIdx: index("wb_pair_codes_expires_idx").on(table.expiresAt),
  }),
);

// ─── M17 工作台终端台账（dt_ 设备凭证，库只存 sha256，tokenPulledAt 一次性自取）─────
// 与 M12 st_devices（闸口执行通道）语义不同：本表是跑工作台的终端绑定台账，互不动。
export const wbDevices = mysqlTable(
  "wb_devices",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .autoincrement()
      .primaryKey(),
    factoryId: bigint("factoryId", { mode: "number", unsigned: true }).notNull(), // 企业隔离
    name: varchar("name", { length: 64 }).notNull(),
    deviceType: mysqlEnum("deviceType", ["desktop", "tablet", "box", "other"]).notNull(),
    fingerprint: varchar("fingerprint", { length: 128 }).notNull(),
    tokenHash: varchar("tokenHash", { length: 64 }).notNull().unique(), // sha256(dt_)
    claimedBy: bigint("claimedBy", { mode: "number", unsigned: true }).notNull(), // 绑定人审计
    tokenPulledAt: timestamp("tokenPulledAt"), // NULL=凭证待设备自取（一次性语义）
    lastSeenAt: timestamp("lastSeenAt"), // NULL=绑定后从未心跳
    revokedAt: timestamp("revokedAt"), // 解绑即 token 失效
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    factoryIdx: index("wb_devices_factory_idx").on(table.factoryId),
    fingerprintIdx: index("wb_devices_fingerprint_idx").on(table.fingerprint),
  }),
);

// ─── 一次性跳转 ticket（st_+48hex，库只存 sha256，TTL 300s）─────────────────
export const wbTickets = mysqlTable(
  "wb_tickets",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .autoincrement()
      .primaryKey(),
    ticketHash: varchar("ticketHash", { length: 64 }).notNull().unique(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    factoryId: bigint("factoryId", { mode: "number", unsigned: true }).notNull(),
    target: varchar("target", { length: 32 }).notNull().default("/dept"),
    source: varchar("source", { length: 64 }).notNull().default("craftsman-market"),
    expiresAt: timestamp("expiresAt").notNull(),
    consumedAt: timestamp("consumedAt"),
  },
  (table) => ({
    userIdx: index("wb_tickets_user_idx").on(table.userId),
  }),
);

// ─── 市场上架密钥（pk_+48hex，库只存 sha256）────────────────────────────────
export const wbPublishKeys = mysqlTable(
  "wb_publish_keys",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .autoincrement()
      .primaryKey(),
    keyHash: varchar("keyHash", { length: 64 }).notNull(),
    factoryId: bigint("factoryId", { mode: "number", unsigned: true }).notNull(),
    assetType: mysqlEnum("assetType", ["skill", "agent", "both"]).notNull(),
    expiresAt: timestamp("expiresAt").notNull(),
    revokedAt: timestamp("revokedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    factoryIdx: index("wb_publish_keys_factory_idx").on(table.factoryId),
    hashIdx: index("wb_publish_keys_hash_idx").on(table.keyHash),
  }),
);

// ─── 工作台市场上架（技能/智能体，两段式 pending → listed/rejected）─────────
export const wbListings = mysqlTable(
  "wb_listings",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .autoincrement()
      .primaryKey(),
    factoryId: bigint("factoryId", { mode: "number", unsigned: true }).notNull(),
    type: mysqlEnum("type", ["skill", "agent"]).notNull(),
    title: varchar("title", { length: 128 }).notNull(),
    category: varchar("category", { length: 64 }),
    capabilities: json("capabilities").$type<string[]>(),
    description: text("description").notNull(),
    delivery: varchar("delivery", { length: 128 }),
    employmentType: varchar("employmentType", { length: 64 }),
    pricingModel: varchar("pricingModel", { length: 64 }).notNull(),
    price: int("price").notNull(),
    accuracy: double("accuracy"),
    operator: varchar("operator", { length: 64 }),
    status: mysqlEnum("status", ["pending", "listed", "rejected"])
      .notNull()
      .default("pending"),
    hires: int("hires").notNull().default(0),
    decidedBy: bigint("decidedBy", { mode: "number", unsigned: true }),
    decidedAt: timestamp("decidedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    factoryIdx: index("wb_listings_factory_idx").on(table.factoryId),
    statusIdx: index("wb_listings_status_idx").on(table.status),
  }),
);

// ─── 招募合同（两段式 pending → active/rejected）────────────────────────────
export const wbContracts = mysqlTable(
  "wb_contracts",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .autoincrement()
      .primaryKey(),
    factoryId: bigint("factoryId", { mode: "number", unsigned: true }).notNull(), // 雇主企业
    listingId: bigint("listingId", { mode: "number", unsigned: true }).notNull(),
    roleScope: varchar("roleScope", { length: 128 }).notNull(),
    workMode: varchar("workMode", { length: 64 }).notNull(),
    trialDays: int("trialDays"),
    note: text("note"),
    status: mysqlEnum("status", ["pending", "active", "rejected"])
      .notNull()
      .default("pending"),
    decidedBy: bigint("decidedBy", { mode: "number", unsigned: true }),
    decidedAt: timestamp("decidedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    factoryIdx: index("wb_contracts_factory_idx").on(table.factoryId),
    listingIdx: index("wb_contracts_listing_idx").on(table.listingId),
  }),
);

// ─── 展厅发布状态（learning → pending_confirm → published/rejected）─────────
export const wbShowroom = mysqlTable("wb_showroom", {
  factoryId: bigint("factoryId", { mode: "number", unsigned: true }).primaryKey(),
  status: mysqlEnum("status", [
    "learning",
    "pending_confirm",
    "published",
    "rejected",
  ])
    .notNull()
    .default("learning"),
  score: int("score").notNull().default(0),
  metrics: json("metrics").$type<Record<string, number>>(),
  thresholds: json("thresholds").$type<Record<string, number>>(),
  requestedAt: timestamp("requestedAt"),
  decidedAt: timestamp("decidedAt"),
  productCount: int("productCount").notNull().default(0),
});

// ─── 展厅商品（确认发布时从 listed listings 真实拷贝生成）───────────────────
export const wbShowroomProducts = mysqlTable(
  "wb_showroom_products",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .autoincrement()
      .primaryKey(),
    factoryId: bigint("factoryId", { mode: "number", unsigned: true }).notNull(),
    title: varchar("title", { length: 128 }).notNull(),
    category: varchar("category", { length: 64 }),
    price: int("price").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    factoryIdx: index("wb_showroom_products_factory_idx").on(table.factoryId),
  }),
);

// ─── 组织角色专属 Agent（agentic.orgAutoSetup 幂等生成，同 factory 不重复插入）──
export const wbRoleAgents = mysqlTable(
  "wb_role_agents",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .autoincrement()
      .primaryKey(),
    factoryId: bigint("factoryId", { mode: "number", unsigned: true }).notNull(),
    role: varchar("role", { length: 64 }).notNull(), // 老板/车间主任/老师傅/质检员/操作工
    deptName: varchar("deptName", { length: 64 }).notNull(),
    agentId: bigint("agentId", { mode: "number", unsigned: true }), // 市场 agents.id 或 wb_listings.id
    agentName: varchar("agentName", { length: 128 }).notNull(),
    agentSource: mysqlEnum("agentSource", ["market", "listing"]).notNull(),
    assignedAt: timestamp("assignedAt").defaultNow().notNull(),
  },
  (table) => ({
    factoryIdx: index("wb_role_agents_factory_idx").on(table.factoryId),
  }),
);

// ─── 多部门共生事件链（symbiosis 路由，确定性生成 + 持久化）──────────────────
export interface WbSymbiosisStep {
  seq: number;
  fromRole: string;
  fromAgent: string;
  toRole: string;
  toAgent: string;
  message: string;
  status: string; // done / acknowledged / adjusted / reported
  durationMs: number;
}

export const wbSymbiosisEvents = mysqlTable(
  "wb_symbiosis_events",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .autoincrement()
      .primaryKey(),
    factoryId: bigint("factoryId", { mode: "number", unsigned: true }).notNull(),
    title: varchar("title", { length: 128 }).notNull(),
    chain: json("chain").$type<WbSymbiosisStep[]>().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    factoryIdx: index("wb_symbiosis_events_factory_idx").on(table.factoryId),
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
// 后端自进化能力（evolution 路由组，wb_evo_ 前缀）
// 提炼自 eliza IMemoryManager / facts 四段式反思、Farcaster 三合约语义、
// AgentKit 三层工具抽象，全部工业化改造（确定性向量/哈希链/配额治理）。
// ═══════════════════════════════════════════════════════════════════════════

// ─── 工业向量记忆库（五库一表，store 分区；对应 eliza messages/descriptions/
//     facts/lore/documents 五管理器）────────────────────────────────────────
export const wbEvoMemories = mysqlTable(
  "wb_evo_memories",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .autoincrement()
      .primaryKey(),
    agentId: bigint("agentId", { mode: "number", unsigned: true }).notNull(),
    factoryId: bigint("factoryId", { mode: "number", unsigned: true }).notNull(),
    store: mysqlEnum("store", ["events", "entities", "insights", "domain", "cases"])
      .notNull(),
    content: json("content")
      .$type<{ text: string; metadata?: Record<string, unknown> }>()
      .notNull(),
    embedding: json("embedding").$type<number[]>().notNull(), // 确定性 64 维哈希向量
    severity: int("severity").notNull().default(3), // 1-5（工业分级，召回加权）
    validUntil: timestamp("validUntil"), // 工况时效，null=长期有效
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    agentIdx: index("wb_evo_memories_agent_idx").on(table.agentId),
    factoryIdx: index("wb_evo_memories_factory_idx").on(table.factoryId),
    storeIdx: index("wb_evo_memories_store_idx").on(table.store),
  }),
);

// ─── 数字员工链上身份卡（哈希链注册表：IdRegistry+KeyRegistry+Quota 三表语义
//     合一，每签发一次=一个区块，blockHash 链接 prevHash）─────────────────────
export const wbEvoIdentities = mysqlTable(
  "wb_evo_identities",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .autoincrement()
      .primaryKey(),
    did: varchar("did", { length: 128 }).notNull().unique(), // did:nebula:agent-<slug>
    agentId: bigint("agentId", { mode: "number", unsigned: true }).notNull(),
    factoryId: bigint("factoryId", { mode: "number", unsigned: true }).notNull(),
    keyState: mysqlEnum("keyState", ["NULL", "ADDED", "REMOVED"])
      .notNull()
      .default("ADDED"), // KeyRegistry KeyState 状态机
    quota: int("quota").notNull().default(1000), // StorageRegistry 去金融化 → 配额
    blockHash: varchar("blockHash", { length: 64 }).notNull(),
    prevHash: varchar("prevHash", { length: 64 }).notNull(),
    blockHeight: int("blockHeight").notNull(),
    card: json("card")
      .$type<{
        name: string;
        role: string;
        skillFingerprint: string;
        issuedBy: string;
        trustLevel: number;
      }>()
      .notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    agentIdx: index("wb_evo_identities_agent_idx").on(table.agentId),
    factoryIdx: index("wb_evo_identities_factory_idx").on(table.factoryId),
  }),
);

// ─── 自主循环计划（30 秒人工确认门 + 白名单豁免）─────────────────────────────
export interface WbEvoPlanStep {
  seq: number;
  action: string;
  target: string;
  rationale: string;
  durationMs: number;
  riskLevel: "low" | "medium" | "high";
}

export const wbEvoPlans = mysqlTable(
  "wb_evo_plans",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .autoincrement()
      .primaryKey(),
    planId: varchar("planId", { length: 64 }).notNull().unique(), // PLN-*
    factoryId: bigint("factoryId", { mode: "number", unsigned: true }).notNull(),
    agentId: bigint("agentId", { mode: "number", unsigned: true }).notNull(),
    goal: varchar("goal", { length: 512 }).notNull(),
    schedule: json("schedule").$type<WbEvoPlanStep[]>().notNull(),
    reasoning: json("reasoning")
      .$type<{ summary: string; appliedInsights: string[] }>()
      .notNull(),
    status: mysqlEnum("status", [
      "awaiting_confirm",
      "executing",
      "done",
      "expired_rejected",
      "rejected",
      "exempted_auto",
    ])
      .notNull()
      .default("awaiting_confirm"),
    confirmDeadline: timestamp("confirmDeadline"),
    trustLevel: int("trustLevel").notNull().default(0),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  },
  (table) => ({
    factoryIdx: index("wb_evo_plans_factory_idx").on(table.factoryId),
    agentIdx: index("wb_evo_plans_agent_idx").on(table.agentId),
  }),
);

// ─── 信任等级账本（每 agent 一行，连批计数驱动 L0→L3 升级）────────────────────
export const wbEvoTrust = mysqlTable("wb_evo_trust", {
  id: bigint("id", { mode: "number", unsigned: true })
    .autoincrement()
    .primaryKey(),
  agentId: bigint("agentId", { mode: "number", unsigned: true })
    .notNull()
    .unique(),
  level: int("level").notNull().default(0), // 0-3
  consecutiveApprovals: int("consecutiveApprovals").notNull().default(0),
  totalPlans: int("totalPlans").notNull().default(0),
  history: json("history")
    .$type<
      {
        at: string;
        event: string;
        level: number;
        consecutiveApprovals: number;
      }[]
    >()
    .notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
});

// ═══════════════════════════════════════════════════════════════════════════
// M21 数字职业档案（本人授权驱动，设计 §3）
// - 三表均带本人 userId 主键维度；additive 迁移见 db/sync-m21.mts
// - 红线：上家企业内部经营数据（任务明细/绩效评分）永不流动，只出结论性档案
// - 敏感信息（身份证/手机号）不在本组表内落库，输出侧一律脱敏（见 wbCareer 路由）
// ═══════════════════════════════════════════════════════════════════════════

// ─── 任职履历（入编/离职事件自动记录，pending=待本人确认）─────────────────────
export const wbCareerEntries = mysqlTable(
  "wb_career_entries",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .autoincrement()
      .primaryKey(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(), // 本人（档案主人）
    factoryId: bigint("factoryId", { mode: "number", unsigned: true }).notNull(), // 任职企业
    deptName: varchar("deptName", { length: 64 }), // 部门名快照（入编时画像值）
    role: varchar("role", { length: 32 }), // 企业内角色快照（staff/manager）
    startedAt: timestamp("startedAt").notNull(), // 入编时间
    endedAt: timestamp("endedAt"), // 离职时间（NULL=在职）
    status: mysqlEnum("status", ["pending", "confirmed", "departed"])
      .notNull()
      .default("pending"), // 待本人确认|已确认|已离职
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    userIdx: index("wb_career_entries_user_idx").on(table.userId),
    factoryIdx: index("wb_career_entries_factory_idx").on(table.factoryId),
  }),
);

// ─── 技能徽章（系统内培训/考核通过自动颁发，接 M18 入职考试）──────────────────
export const wbSkillBadges = mysqlTable(
  "wb_skill_badges",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .autoincrement()
      .primaryKey(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    skillKey: varchar("skillKey", { length: 64 }).notNull(), // 技能键（考核/培训来源）
    name: varchar("name", { length: 128 }).notNull(), // 徽章名（展示）
    factoryId: bigint("factoryId", { mode: "number", unsigned: true }).notNull(), // 颁发企业
    issuedAt: timestamp("issuedAt").notNull(), // 颁发时间
  },
  (table) => ({
    userIdx: index("wb_skill_badges_user_idx").on(table.userId),
  }),
);

// ─── 档案授权记录（本人 C 级动作：分项授权，revokedAt 置位即撤回，幂等）────────
// scope 细粒度：career 履历 / badges 徽章 / achievements 成就 / proof 证明。
// 默认全不授权；同一 userId+targetFactoryId+scope 有效授权至多一行（应用层幂等保证）。
export const wbCareerShares = mysqlTable(
  "wb_career_shares",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .autoincrement()
      .primaryKey(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(), // 授权人（本人）
    targetFactoryId: bigint("targetFactoryId", { mode: "number", unsigned: true }).notNull(), // 被授权企业
    scope: mysqlEnum("scope", ["career", "badges", "achievements", "proof"]).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    revokedAt: timestamp("revokedAt"), // NULL=有效；置位=已撤回（立即不可见）
  },
  (table) => ({
    userTargetIdx: index("wb_career_shares_user_target_idx").on(
      table.userId,
      table.targetFactoryId,
    ),
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
// M22a 通用设备资产台账（App 扫码升级：生产设备/办公设备扫码登记与识别）
// - codeValue 是扫码原始值（qr/ean13/code128/manual），DB 层 utf8mb4_bin 大小写敏感，
//   应用层再按 === 精确复核（见 wbAssets 路由注释）；非凭证、可展示
// - factoryId+codeValue 非唯一联合索引：幂等由应用层保证（active 同码返回已有），
//   retired 行保留审计，同码退役后允许重新登记
// ═══════════════════════════════════════════════════════════════════════════
export const wbAssets = mysqlTable(
  "wb_assets",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .autoincrement()
      .primaryKey(),
    factoryId: bigint("factoryId", { mode: "number", unsigned: true }).notNull(), // 企业隔离
    assetNo: varchar("assetNo", { length: 64 }).notNull(), // 企业内资产编号（缺省自动生成 AS-{factoryId}-{6位随机大写字数}）
    name: varchar("name", { length: 128 }).notNull(), // 资产名称
    category: mysqlEnum("category", [
      "production", // 生产设备
      "hvac", // 空调
      "lighting", // 照明
      "printer", // 打印机
      "office", // 其他办公设备
      "other",
    ]).notNull(),
    codeType: mysqlEnum("codeType", ["qr", "ean13", "code128", "manual", "other"]).notNull(),
    codeValue: varchar("codeValue", { length: 256 }).notNull(), // 扫码原始值（大小写敏感）
    location: varchar("location", { length: 128 }), // 安装/摆放位置（可空）
    status: mysqlEnum("status", ["active", "retired"]).notNull().default("active"),
    boundBy: bigint("boundBy", { mode: "number", unsigned: true }).notNull(), // 登记人审计
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
    retiredAt: timestamp("retiredAt"), // NULL=在册；置位=已退役
  },
  (table) => ({
    factoryIdx: index("wb_assets_factory_idx").on(table.factoryId),
    factoryCodeIdx: index("wb_assets_factory_code_idx").on(table.factoryId, table.codeValue),
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
// M23a 数字人记忆（wb_memories）+ M23b 主动服务消息（wb_proactive_msgs）
// - wb_memories：灵枢/星云的长期记忆。scope=user 属本人私有（仅本人可 forget），
//   scope=factory 属全厂共享（系统事件写入，M23b 触发器可写 fact 类）；
//   importance 1-5（显式口令强制 4，LLM 提炼自定）；deletedAt 软删（forget 保留审计），
//   超容量 LRU 淘汰为物理删除（见 wbMemory 路由注释）。
// - wb_proactive_msgs：主动服务消息。userId NULL=全员广播；dedupeKey 查重
//   （同 key 存在即跳过——主动≠骚扰，24h 不重复烦）；readAt NULL=未读。
// ═══════════════════════════════════════════════════════════════════════════
export const wbMemories = mysqlTable(
  "wb_memories",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .autoincrement()
      .primaryKey(),
    factoryId: bigint("factoryId", { mode: "number", unsigned: true }).notNull(), // 企业隔离
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(), // 记忆归属人（scope=user 语义）
    persona: mysqlEnum("persona", ["lingshu", "xingyun", "xingxing"]).notNull(), // 记忆所属人格（灵枢|星云|小星）
    scope: mysqlEnum("scope", ["user", "factory"]).notNull(), // 本人私有|全厂共享
    kind: mysqlEnum("kind", ["preference", "fact", "note"]).notNull(), // 偏好|事实|便签
    content: varchar("content", { length: 300 }).notNull(), // 单条≤300字（写入即截断+stripSecrets）
    importance: tinyint("importance").notNull().default(3), // 1-5，显式口令=4，LLM 提炼 1-5
    uses: int("uses").notNull().default(0), // 被召回次数（召回即 +1）
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    lastUsedAt: timestamp("lastUsedAt"), // 最近召回时间（NULL=从未召回）
    deletedAt: timestamp("deletedAt"), // NULL=有效；置位=已遗忘（软删）
  },
  (table) => ({
    userFactoryIdx: index("wb_memories_user_factory_idx").on(table.userId, table.factoryId),
  }),
);

export const wbProactiveMsgs = mysqlTable(
  "wb_proactive_msgs",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .autoincrement()
      .primaryKey(),
    factoryId: bigint("factoryId", { mode: "number", unsigned: true }).notNull(), // 企业隔离
    userId: bigint("userId", { mode: "number", unsigned: true }), // NULL=全员广播
    kind: varchar("kind", { length: 32 }).notNull(), // 消息类（device_offline/invite_expire/...）
    content: varchar("content", { length: 500 }).notNull(),
    priority: mysqlEnum("priority", ["card", "speak"]).notNull(), // 卡片静默|语音播报
    dedupeKey: varchar("dedupeKey", { length: 128 }).notNull(), // 查重键（同 key 跳过）
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    readAt: timestamp("readAt"), // NULL=未读
  },
  (table) => ({
    factoryReadIdx: index("wb_proactive_factory_read_idx").on(table.factoryId, table.readAt),
    dedupeIdx: index("wb_proactive_dedupe_idx").on(table.dedupeKey),
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
// M25 短信验证码（wb_sms_codes）——彭总指令「手机短信注册通道」
// - 明文验证码仅经短信通道发出，库中只存 sha256（codeHash），绝不落库/日志/回显；
// - consumedAt 一次性消费（原子 UPDATE 置位防重放）；attempts 错验计数（≥5 作废）；
// - 无唯一约束：同号可有多条历史码（旧码过期作废），一次性语义由 consumedAt 保证。
// ═══════════════════════════════════════════════════════════════════════════
export const wbSmsCodes = mysqlTable(
  "wb_sms_codes",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .autoincrement()
      .primaryKey(),
    phone: varchar("phone", { length: 20 }).notNull(),
    codeHash: varchar("codeHash", { length: 64 }).notNull(), // sha256(明文验证码)
    purpose: mysqlEnum("purpose", ["register", "login", "beta_apply"]).notNull(),
    expiresAt: timestamp("expiresAt").notNull(), // 签发后 5 分钟
    consumedAt: timestamp("consumedAt"), // NULL=未消费；置位=已用/作废
    attempts: tinyint("attempts").notNull().default(0), // 错验次数（≥5 作废）
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    phonePurposeIdx: index("wb_sms_codes_phone_purpose_idx").on(
      table.phone,
      table.purpose,
      table.createdAt,
    ),
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
// M26 v1.4.0 呼叫信令（wb_calls）——成员 1v1 音视频通话 + 灵枢来电
// - 波1 全自研信令（invite/accept/reject/hangup + wbProactive 来电推送），
//   波2 接 TRTC 真媒体流（roomId=`call_{id}`，UserSig 服务端签发见 wbCalls 路由）；
// - callerId=0 表示数字人来电（灵枢/星云）；calleeId=NULL 表示全员广播来电；
// - status 状态机：ringing→active→ended；ringing 45s 未接→missed（惰性清扫）；
//   ringing→rejected（被叫拒接）；
// - 隐私红线：只落通话元数据（谁/何时/时长/类型），**不录音不录像**；
// - meta JSON：灵枢来电上下文 {persona, content, kind}（接听后口播详情用）。
// ═══════════════════════════════════════════════════════════════════════════
export const wbCalls = mysqlTable(
  "wb_calls",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .autoincrement()
      .primaryKey(),
    factoryId: bigint("factoryId", { mode: "number", unsigned: true }).notNull(), // 企业隔离
    callerId: bigint("callerId", { mode: "number", unsigned: true }).notNull(), // 主叫（0=数字人灵枢/星云来电）
    calleeId: bigint("calleeId", { mode: "number", unsigned: true }), // 被叫（NULL=全员广播，灵枢来电）
    media: mysqlEnum("media", ["audio", "video"]).notNull(), // 语音|视频
    roomId: varchar("roomId", { length: 64 }).notNull(), // TRTC 房间号 call_{id}
    status: mysqlEnum("status", ["ringing", "active", "ended", "missed", "rejected"])
      .notNull()
      .default("ringing"),
    startedAt: timestamp("startedAt").defaultNow().notNull(), // 呼叫发起（振铃开始）
    answeredAt: timestamp("answeredAt"), // NULL=未接听
    endedAt: timestamp("endedAt"), // NULL=进行中/振铃中
    durationSec: int("durationSec").notNull().default(0), // 通话时长秒（answeredAt 起算，hangup 落库）
    meta: json("meta").$type<{ persona?: string; content?: string; kind?: string }>(), // 灵枢来电上下文
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    calleeStatusIdx: index("wb_calls_callee_status_idx").on(table.calleeId, table.status),
    factoryCreatedIdx: index("wb_calls_factory_created_idx").on(table.factoryId, table.createdAt),
  }),
);

// ─── 工作台类型导出 ──────────────────────────────────────────────────────────
export type WbUser = typeof wbUsers.$inferSelect;
export type WbFactory = typeof wbFactories.$inferSelect;
export type WbDeptHead = typeof wbDeptHeads.$inferSelect;
export type WbInvite = typeof wbInvites.$inferSelect;
export type WbPairCode = typeof wbPairCodes.$inferSelect;
export type WbDevice = typeof wbDevices.$inferSelect;
export type WbTicket = typeof wbTickets.$inferSelect;
export type WbPublishKey = typeof wbPublishKeys.$inferSelect;
export type WbListing = typeof wbListings.$inferSelect;
export type WbContract = typeof wbContracts.$inferSelect;
export type WbShowroom = typeof wbShowroom.$inferSelect;
export type WbShowroomProduct = typeof wbShowroomProducts.$inferSelect;
export type WbRoleAgent = typeof wbRoleAgents.$inferSelect;
export type WbSymbiosisEvent = typeof wbSymbiosisEvents.$inferSelect;
export type WbEvoMemory = typeof wbEvoMemories.$inferSelect;
export type WbEvoIdentity = typeof wbEvoIdentities.$inferSelect;
export type WbEvoPlan = typeof wbEvoPlans.$inferSelect;
export type WbEvoTrust = typeof wbEvoTrust.$inferSelect;
export type WbCareerEntry = typeof wbCareerEntries.$inferSelect;
export type WbSkillBadge = typeof wbSkillBadges.$inferSelect;
export type WbCareerShare = typeof wbCareerShares.$inferSelect;
export type WbAsset = typeof wbAssets.$inferSelect;
export type WbMemory = typeof wbMemories.$inferSelect;
export type WbProactiveMsg = typeof wbProactiveMsgs.$inferSelect;
export type WbSmsCode = typeof wbSmsCodes.$inferSelect;
export type WbCall = typeof wbCalls.$inferSelect;

// ═══════════════════════════════════════════════════════════════════════════
// 开发者生态（dev_ 前缀）：独立开发者注册 / 作品上架（两段式审核）/ 收益结算
// - 与 wb_users 平行的独立账号体系；token 仅在请求体传递，单账号有效
// - 密码哈希沿用 wb 用户相同的 scrypt（salt:hash hex）方案
// ═══════════════════════════════════════════════════════════════════════════

// ─── 开发者账号 ──────────────────────────────────────────────────────────────
export const devAccounts = mysqlTable("dev_accounts", {
  id: bigint("id", { mode: "number", unsigned: true })
    .autoincrement()
    .primaryKey(),
  username: varchar("username", { length: 64 }).notNull().unique(),
  passwordHash: varchar("passwordHash", { length: 256 }).notNull(), // scrypt: salt:hash(hex)
  displayName: varchar("displayName", { length: 64 }).notNull(),
  contact: varchar("contact", { length: 128 }),
  status: mysqlEnum("status", ["active", "suspended"])
    .notNull()
    .default("active"),
  authToken: varchar("authToken", { length: 64 }), // 48 hex，登录时重颁覆盖
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// ─── 开发者上架作品（Agent / Skill，pending_review → listed/rejected）────────
export const devListings = mysqlTable(
  "dev_listings",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .autoincrement()
      .primaryKey(),
    devId: bigint("devId", { mode: "number", unsigned: true })
      .notNull()
      .references(() => devAccounts.id),
    kind: mysqlEnum("kind", ["agent", "skill"]).notNull(),
    name: varchar("name", { length: 64 }).notNull(),
    summary: varchar("summary", { length: 256 }),
    category: varchar("category", { length: 32 }),
    priceToken: int("priceToken").notNull().default(0), // 计量价 Token
    icon: varchar("icon", { length: 256 }),
    status: mysqlEnum("status", [
      "pending_review",
      "listed",
      "rejected",
      "delisted",
    ])
      .notNull()
      .default("pending_review"),
    usageCount: int("usageCount").notNull().default(0),
    revenueToken: int("revenueToken").notNull().default(0), // 累计计量收益 Token
    ratingSum: int("ratingSum").notNull().default(0),
    ratingCount: int("ratingCount").notNull().default(0),
    weeklyUsageTrend: json("weeklyUsageTrend").$type<number[]>(), // 近 7 天调用量
    listedAt: timestamp("listedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    devIdx: index("dev_listings_dev_idx").on(table.devId),
    statusIdx: index("dev_listings_status_idx").on(table.status),
  }),
);

// ─── 开发者收益流水（按调用计量 / 雇佣结算）──────────────────────────────────
export const devEarnings = mysqlTable(
  "dev_earnings",
  {
    id: bigint("id", { mode: "number", unsigned: true })
      .autoincrement()
      .primaryKey(),
    devId: bigint("devId", { mode: "number", unsigned: true })
      .notNull()
      .references(() => devAccounts.id),
    listingId: bigint("listingId", { mode: "number", unsigned: true }).references(
      () => devListings.id,
    ),
    amountToken: int("amountToken").notNull(),
    source: mysqlEnum("source", ["usage", "hire"]).notNull(),
    note: varchar("note", { length: 128 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    devIdx: index("dev_earnings_dev_idx").on(table.devId),
    listingIdx: index("dev_earnings_listing_idx").on(table.listingId),
  }),
);

// ─── 开发者生态类型导出 ──────────────────────────────────────────────────────
export type DevAccount = typeof devAccounts.$inferSelect;
export type DevListing = typeof devListings.$inferSelect;
export type DevEarning = typeof devEarnings.$inferSelect;
