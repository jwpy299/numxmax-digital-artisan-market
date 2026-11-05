// iter85 迁移：应用层性能优化 —— 高频只读查询补索引（幂等）。
// 每个索引前先查 information_schema.STATISTICS，存在即跳过；st_* 表先判表存在（部分环境未 sync）。
// 只加确定性收益的索引；每个索引附理由注释。
// 运行：set -a && . ./.env && set +a && npx tsx db/sync-iter85.mts
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL missing");
const conn = await mysql.createConnection(url);

async function hasTable(table: string): Promise<boolean> {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS c FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = ?`,
    [table],
  );
  return Number((rows as { c: number }[])[0]?.c ?? 0) > 0;
}

async function hasIndex(table: string, indexName: string): Promise<boolean> {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS c FROM information_schema.STATISTICS
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
    [table, indexName],
  );
  return Number((rows as { c: number }[])[0]?.c ?? 0) > 0;
}

async function addIndex(
  table: string,
  indexName: string,
  ddl: string,
  reason: string,
): Promise<void> {
  if (!(await hasTable(table))) {
    console.log(`skip ${indexName}: table ${table} not present`);
    return;
  }
  if (await hasIndex(table, indexName)) {
    console.log(`skip ${indexName}: exists`);
    return;
  }
  await conn.query(ddl);
  console.log(`added ${indexName} — ${reason}`);
}

// 1) wb_users(authToken)：requireFactoryToken / requireAdmin 每个 wb、admin 请求都
//    WHERE authToken = ? 鉴权，此前无任何索引（仅 username/phone 唯一键），全表扫描。
await addIndex(
  "wb_users",
  "wb_users_authToken_idx",
  `ALTER TABLE wb_users ADD INDEX wb_users_authToken_idx (authToken)`,
  "wb/admin 每请求 token 鉴权按 authToken 点查，消除全表扫描",
);

// 2) agents(status, industry)：agents.list 匠市列表恒定条件 status='active'，
//    行业筛选为第二高频过滤；现有 agents_status_idx / agents_industry_idx 两个单列
//    索引只能择一使用，复合索引覆盖 状态+行业 组合过滤。
await addIndex(
  "agents",
  "agents_status_industry_idx",
  `ALTER TABLE agents ADD INDEX agents_status_industry_idx (status, industry)`,
  "匠市列表 status+industry 组合过滤，替代两单列索引的 index merge",
);

// 3) reviews(agentId, createdAt)：agents.detail 评价列表
//    WHERE agentId=? ORDER BY createdAt DESC LIMIT 50，现有 reviews_agent_idx 只覆盖
//    agentId，排序需 filesort；复合索引直接按序读取。
await addIndex(
  "reviews",
  "reviews_agent_created_idx",
  `ALTER TABLE reviews ADD INDEX reviews_agent_created_idx (agentId, createdAt)`,
  "Agent 详情评价列表按 agentId 过滤 + createdAt 排序，免 filesort",
);

// 4) st_chat_messages(threadId)：终端会话消息按 threadId 拉取（sync-terminal 建表时
//    已声明 idx_st_msgs_thread；此处兜底老库/缺失场景）。
await addIndex(
  "st_chat_messages",
  "idx_st_msgs_thread",
  `ALTER TABLE st_chat_messages ADD INDEX idx_st_msgs_thread (threadId)`,
  "终端聊天消息按 threadId 高频拉取",
);

// 5) st_staff_chat_messages(threadId)：数字员工会话消息按 threadId 拉取
//    （sync-staff 建表时已声明 idx_st_staff_msgs_thread；此处兜底）。
await addIndex(
  "st_staff_chat_messages",
  "idx_st_staff_msgs_thread",
  `ALTER TABLE st_staff_chat_messages ADD INDEX idx_st_staff_msgs_thread (threadId)`,
  "员工聊天消息按 threadId 高频拉取",
);

// 6) st_agent_artifacts(threadId)：产出物台账按 threadId 查证据回流
//    （sync-iter41 建表时已声明 idx_thread；此处兜底）。
await addIndex(
  "st_agent_artifacts",
  "idx_thread",
  `ALTER TABLE st_agent_artifacts ADD INDEX idx_thread (threadId)`,
  "技能产出物按 threadId 查询",
);

await conn.end();
console.log("sync-iter85 done");
