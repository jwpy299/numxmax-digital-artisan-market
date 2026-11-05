/**
 * 幂等同步迭代 18「灵智枢智能运营」（广东灵智枢生态科技有限公司）所需的新表：
 *   st_departments / st_agents / st_chat_threads / st_chat_messages /
 *   st_meetings / st_meeting_messages
 * 全部为 st_ 前缀新表（additive），不改 drizzle schema.ts，由 api/routers/terminal.ts 用 raw SQL 访问。
 *
 * 幂等种子：5 部门（总经理室/运营部/技术部/法务部/财务部）+ 5 驻部 Agent
 * （灵策COO / 灵眸CMO / 灵筑CTO / 灵衡法务官 / 灵算财务官），按 code 查重，重复执行不重复插入。
 *
 * 风格仿 db/sync-admin.mts：raw mysql2 直连、information_schema 检测、DRY_RUN 早退。
 * 用法：set -a && . ./.env && set +a && npx tsx db/sync-terminal.mts
 * 语法自检：DRY_RUN=1 npx tsx db/sync-terminal.mts（不连库，直接退出）
 */
if (process.env.DRY_RUN) {
  console.log("dry run ok");
  process.exit(0);
}

import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const conn = await mysql.createConnection(url);

/** information_schema 检测后 CREATE TABLE（幂等） */
async function ensureTable(name: string, ddl: string) {
  const [rows] = await conn.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [name],
  );
  if ((rows as unknown[]).length > 0) {
    console.log(`${name}: table exists, skip`);
  } else {
    await conn.query(ddl);
    console.log(`${name}: table created`);
  }
}

// ── 1. 部门表 ────────────────────────────────────────────────────────────────
await ensureTable(
  "st_departments",
  `CREATE TABLE st_departments (
     id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     code VARCHAR(32) NOT NULL UNIQUE,
     name VARCHAR(64) NOT NULL,
     duty VARCHAR(512) NOT NULL,
     sort INT NOT NULL DEFAULT 0,
     createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
);

// ── 2. 驻部 Agent 表 ─────────────────────────────────────────────────────────
await ensureTable(
  "st_agents",
  `CREATE TABLE st_agents (
     id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     deptCode VARCHAR(32) NOT NULL,
     code VARCHAR(32) NOT NULL UNIQUE,
     name VARCHAR(64) NOT NULL,
     title VARCHAR(64) NOT NULL,
     avatarEmoji VARCHAR(16) NOT NULL DEFAULT '🤖',
     systemPrompt TEXT NOT NULL,
     status VARCHAR(16) NOT NULL DEFAULT 'active',
     createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
     INDEX idx_st_agents_dept (deptCode)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
);

// ── 3. 单聊线程表 ────────────────────────────────────────────────────────────
await ensureTable(
  "st_chat_threads",
  `CREATE TABLE st_chat_threads (
     id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     agentCode VARCHAR(32) NOT NULL,
     userId BIGINT UNSIGNED NOT NULL,
     title VARCHAR(128) NOT NULL,
     createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     INDEX idx_st_threads_user (userId, agentCode)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
);

// ── 4. 单聊消息表 ────────────────────────────────────────────────────────────
await ensureTable(
  "st_chat_messages",
  `CREATE TABLE st_chat_messages (
     id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     threadId BIGINT UNSIGNED NOT NULL,
     role VARCHAR(16) NOT NULL,
     content TEXT NOT NULL,
     provider VARCHAR(32) NULL,
     degraded TINYINT(1) NOT NULL DEFAULT 0,
     createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
     INDEX idx_st_msgs_thread (threadId)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
);

// ── 5. 协同会议表 ────────────────────────────────────────────────────────────
await ensureTable(
  "st_meetings",
  `CREATE TABLE st_meetings (
     id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     topic VARCHAR(255) NOT NULL,
     status VARCHAR(16) NOT NULL DEFAULT 'open',
     createdBy BIGINT UNSIGNED NOT NULL,
     summary TEXT NULL,
     createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     INDEX idx_st_meetings_status (status)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
);

// ── 6. 会议消息表 ────────────────────────────────────────────────────────────
await ensureTable(
  "st_meeting_messages",
  `CREATE TABLE st_meeting_messages (
     id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     meetingId BIGINT UNSIGNED NOT NULL,
     participantType VARCHAR(16) NOT NULL,
     participantKey VARCHAR(64) NOT NULL,
     displayName VARCHAR(64) NOT NULL,
     content TEXT NOT NULL,
     provider VARCHAR(32) NULL,
     degraded TINYINT(1) NOT NULL DEFAULT 0,
     round INT NOT NULL DEFAULT 0,
     createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
     INDEX idx_st_mmsgs_meeting (meetingId)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
);

// ── 种子数据 ─────────────────────────────────────────────────────────────────
const DEPARTMENTS: { code: string; name: string; duty: string; sort: number }[] = [
  {
    code: "gm",
    name: "总经理室",
    duty: "统筹公司整体战略与经营节奏，审批跨部门协同事项，基于两系统实时数据做经营决策。",
    sort: 1,
  },
  {
    code: "ops",
    name: "运营部",
    duty: "负责门户与工作台的用户增长、企业入驻与日常运营，监控转化与留存，策划市场活动。",
    sort: 2,
  },
  {
    code: "tech",
    name: "技术部",
    duty: "负责两系统的研发、架构与稳定性保障，维护统一数据库与大模型接入网关。",
    sort: 3,
  },
  {
    code: "legal",
    name: "法务部",
    duty: "负责合同合规、数据合规与内容审核规范，为两系统业务动作提供法律风险评估。",
    sort: 4,
  },
  {
    code: "finance",
    name: "财务部",
    duty: "负责 Token 计量结算、佣金核算与预算管控，输出经营财务分析与成本预警。",
    sort: 5,
  },
];

const AGENTS: {
  deptCode: string;
  code: string;
  name: string;
  title: string;
  avatarEmoji: string;
  duty: string;
}[] = [
  {
    deptCode: "ops",
    code: "lingsCe",
    name: "灵策",
    title: "COO 运营官",
    avatarEmoji: "🧭",
    duty: "制定两系统运营策略，跟踪用户增长、企业入驻、雇佣订单转化，提出运营动作与节奏建议。",
  },
  {
    deptCode: "ops",
    code: "lingsMou",
    name: "灵眸",
    title: "CMO 市场官",
    avatarEmoji: "👁️",
    duty: "洞察市场与行业趋势，关注品牌传播、渠道投放与招聘/上架供需两侧的市场反馈。",
  },
  {
    deptCode: "tech",
    code: "lingsZhu",
    name: "灵筑",
    title: "CTO 技术官",
    avatarEmoji: "🛠️",
    duty: "关注两系统稳定性、性能与架构演进，识别技术风险，给出工程侧的改进建议与排期思路。",
  },
  {
    deptCode: "legal",
    code: "lingsHeng",
    name: "灵衡",
    title: "首席法务官",
    avatarEmoji: "⚖️",
    duty: "评估业务动作的合规风险，关注合同、数据与内容规范，给出稳妥的法律合规建议。",
  },
  {
    deptCode: "finance",
    code: "lingsSuan",
    name: "灵算",
    title: "首席财务官",
    avatarEmoji: "🧮",
    duty: "跟踪 Token 计量流水与平台结算佣金，分析成本结构与预算执行，给出财务侧的稳健建议。",
  },
];

const PROMPT_SUFFIX =
  "你的建议基于星云数字匠市门户与灵枢·星云智能工作台两套系统的实时数据（由系统注入数据摘要），回答务必务实、分点、给出可执行动作；使用中文，不使用金融/炒作/投机类表述，Token 一律按「结算/兑换/计量」口径表述。";

for (const d of DEPARTMENTS) {
  const [rows] = await conn.query(`SELECT id FROM st_departments WHERE code = ? LIMIT 1`, [d.code]);
  if ((rows as unknown[]).length > 0) {
    console.log(`st_departments ${d.code}: exists, skip`);
  } else {
    await conn.query(
      `INSERT INTO st_departments (code, name, duty, sort) VALUES (?, ?, ?, ?)`,
      [d.code, d.name, d.duty, d.sort],
    );
    console.log(`st_departments ${d.code}: seeded`);
  }
}

for (const a of AGENTS) {
  const [rows] = await conn.query(`SELECT id FROM st_agents WHERE code = ? LIMIT 1`, [a.code]);
  if ((rows as unknown[]).length > 0) {
    console.log(`st_agents ${a.code}: exists, skip`);
  } else {
    const systemPrompt = `你是广东灵智枢生态科技有限公司的驻部智能体「${a.name}」，职位是${a.title}，服务于${
      DEPARTMENTS.find((d) => d.code === a.deptCode)?.name ?? "公司"
    }。职责：${a.duty}${PROMPT_SUFFIX}`;
    await conn.query(
      `INSERT INTO st_agents (deptCode, code, name, title, avatarEmoji, systemPrompt, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`,
      [a.deptCode, a.code, a.name, a.title, a.avatarEmoji, systemPrompt],
    );
    console.log(`st_agents ${a.code}: seeded (${a.name} ${a.title})`);
  }
}

await conn.end();
console.log("sync-terminal done");
