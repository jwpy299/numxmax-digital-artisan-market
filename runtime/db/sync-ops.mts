/**
 * 幂等同步迭代 27「套餐售卖 + 运营中心」所需的 7 张新表（CREATE TABLE IF NOT EXISTS）：
 * - pkg_packages        套餐目录（key 唯一，features JSON）
 * - pkg_orders          套餐订单（order_no 唯一；claim 只存 sha256 + 明文回查列 claim_code）
 * - pkg_entitlements    企业套餐权益（claim 后写入，工厂维度）
 * - ops_access_log      tRPC 访问日志（中间件 fire-and-forget 写入）
 * - ops_ip_blocklist    IP 封锁名单（中间件 60s 内存缓存）
 * - ops_vulns           漏洞/异常发现（dedup_key 唯一去重）
 * - cs_config           智能客服配置（单行 id=1）
 * 迭代 28 追加：st_meeting_config（圆桌席位配置）/ cs_sessions / cs_messages（客服访客会话），
 * 以及 st_kb_docs additive 加列 dept_key（information_schema 检查后 ALTER，幂等）。
 * 迭代 29 追加：ops_health_checks（服务器指标采集）/ ops_alerts（运维预警，dedup_key 去重）。
 * 迭代 30 追加：st_skills / st_agent_skills / st_skill_feedback / st_evo_proposals / st_evo_reports
 * （技能体系 + 自进化引擎，均 CREATE TABLE IF NOT EXISTS）。
 * 迭代 31 追加：st_skill_packs / st_pack_applications / st_pack_purchases / st_pack_mounts /
 * st_creator_income（技能商店 + 能力资产化 + 三方分账，均 CREATE TABLE IF NOT EXISTS）。
 * 迭代 35 追加：st_admin_audit（管理后台操作审计，CREATE TABLE IF NOT EXISTS）。
 * 迭代 34 追加（API-CONTRACT-v10 §2）：st_token_topups（Token 充值申请，人工确认入账，
 * status pending|confirmed|rejected，索引 ix_topup_factory，CREATE TABLE IF NOT EXISTS）。
 * 迭代 33 追加（API-CONTRACT-v9）：st_evo_proposals 企业级提案-审批层新列
 * （factory_id/skill_key/proposal_type/rationale/diff_preview/source/decision_note +
 * 索引 ix_prop_factory_status）——新库走 DDL 全量列，既有库走 ensureEvoProposalColumns
 * information_schema 检查后 additive ALTER（幂等，不 drop 不改既有列）。
 *
 * 全部为 additive 新表：不 drop、不改既有表结构。
 * 风格仿 db/sync-admin.mts：raw mysql2 直连、幂等、DRY_RUN 早退。
 *
 * 用法（手动）：set -a && . ./.env && set +a && npx tsx db/sync-ops.mts
 * 语法自检：DRY_RUN=1 npx tsx db/sync-ops.mts（不连库，直接退出）
 * 启动接入：api/boot.ts import { ensureOpsTables } 并 fire-and-forget 调用（失败静默）。
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DDLS: string[] = [
  `CREATE TABLE IF NOT EXISTS pkg_packages (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    \`key\` VARCHAR(32) NOT NULL UNIQUE,
    name VARCHAR(64) NOT NULL,
    price_yuan INT NOT NULL,
    period_label VARCHAR(32) NOT NULL,
    agents_count INT NOT NULL DEFAULT 0,
    scope_label VARCHAR(64) NOT NULL DEFAULT '',
    synergy_label VARCHAR(64) NOT NULL DEFAULT '',
    monetize_label VARCHAR(128) NOT NULL DEFAULT '',
    scale_label VARCHAR(64) NOT NULL DEFAULT '',
    poster_url VARCHAR(128) NOT NULL DEFAULT '',
    dept_code VARCHAR(32) NULL,
    package_tier VARCHAR(16) NULL,
    team_spec JSON NULL,
    features JSON NULL,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS pkg_orders (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    order_no VARCHAR(40) NOT NULL UNIQUE,
    package_id BIGINT UNSIGNED NOT NULL,
    buyer_name VARCHAR(64) NOT NULL,
    buyer_phone VARCHAR(20) NOT NULL,
    company_name VARCHAR(128) NOT NULL,
    amount_yuan INT NOT NULL,
    claim_hash CHAR(64) NOT NULL,
    claim_code VARCHAR(20) NOT NULL DEFAULT '',
    status ENUM('pending','paid','configured','cancelled') NOT NULL DEFAULT 'pending',
    factory_id BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    paid_at TIMESTAMP NULL,
    configured_at TIMESTAMP NULL,
    INDEX idx_pkg_orders_phone (buyer_phone),
    INDEX idx_pkg_orders_claim_hash (claim_hash)
  )`,
  `CREATE TABLE IF NOT EXISTS pkg_entitlements (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    factory_id BIGINT UNSIGNED NOT NULL,
    package_key VARCHAR(32) NOT NULL,
    agents_count INT NOT NULL DEFAULT 0,
    period_label VARCHAR(32) NOT NULL DEFAULT '',
    expires_at TIMESTAMP NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_pkg_ent_factory (factory_id)
  )`,
  `CREATE TABLE IF NOT EXISTS ops_access_log (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    ts TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ip VARCHAR(64) NOT NULL DEFAULT '',
    path VARCHAR(128) NOT NULL DEFAULT '',
    method VARCHAR(16) NOT NULL DEFAULT '',
    status INT NOT NULL DEFAULT 200,
    latency_ms INT NOT NULL DEFAULT 0,
    ua VARCHAR(200) NOT NULL DEFAULT '',
    INDEX idx_ops_access_ts (ts),
    INDEX idx_ops_access_ip (ip)
  )`,
  `CREATE TABLE IF NOT EXISTS ops_ip_blocklist (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    ip VARCHAR(64) NOT NULL UNIQUE,
    reason VARCHAR(255) NOT NULL DEFAULT '',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by VARCHAR(64) NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS ops_vulns (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    source VARCHAR(32) NOT NULL,
    severity VARCHAR(16) NOT NULL,
    title VARCHAR(255) NOT NULL,
    detail TEXT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'open',
    plan TEXT NULL,
    dedup_key VARCHAR(255) NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS cs_config (
    id INT NOT NULL PRIMARY KEY,
    welcome TEXT NULL,
    persona_prompt TEXT NULL,
    handoff_hint TEXT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`,
  // ─── 迭代 28：圆桌席位配置 + 客服访客会话 ─────────────────────────────────
  `CREATE TABLE IF NOT EXISTS st_meeting_config (
    dept_key VARCHAR(64) NOT NULL PRIMARY KEY,
    agent_name VARCHAR(64) NOT NULL,
    persona_hint TEXT NULL,
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    updated_by VARCHAR(64) NOT NULL DEFAULT '',
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS cs_sessions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    session_key VARCHAR(64) NOT NULL UNIQUE,
    ip VARCHAR(64) NOT NULL DEFAULT '',
    ua VARCHAR(255) NOT NULL DEFAULT '',
    first_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    msg_count INT NOT NULL DEFAULT 0
  )`,
  // ─── 迭代 29：服务器健康采集 + 预警 ────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS ops_health_checks (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    server VARCHAR(32) NOT NULL,
    metric VARCHAR(32) NOT NULL,
    value VARCHAR(128) NOT NULL DEFAULT '',
    status VARCHAR(16) NOT NULL DEFAULT 'ok',
    ts DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_srv_metric_ts (server, metric, ts)
  )`,
  `CREATE TABLE IF NOT EXISTS ops_alerts (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    server VARCHAR(32) NOT NULL,
    severity VARCHAR(16) NOT NULL,
    title VARCHAR(200) NOT NULL,
    detail TEXT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'open',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ack_at DATETIME NULL,
    resolved_at DATETIME NULL,
    dedup_key VARCHAR(128) NOT NULL,
    INDEX idx_status (status)
  )`,
  `CREATE TABLE IF NOT EXISTS cs_messages (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    session_key VARCHAR(64) NOT NULL,
    role ENUM('user','bot') NOT NULL,
    content TEXT NULL,
    intent VARCHAR(32) NULL,
    ts TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_cs_messages_session (session_key),
    INDEX idx_cs_messages_ts (ts)
  )`,
  // ─── 迭代 30：数字员工技能体系 + 自学习自进化引擎（st_ 前缀 5 表）─────────
  `CREATE TABLE IF NOT EXISTS st_skills (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    skill_key VARCHAR(64) NOT NULL UNIQUE,
    name VARCHAR(64) NOT NULL,
    layer ENUM('general','professional','industry') NOT NULL,
    category VARCHAR(32) NOT NULL DEFAULT '',
    description VARCHAR(255) NOT NULL DEFAULT '',
    trigger_hints JSON NULL,
    flow_steps JSON NULL,
    slot VARCHAR(16) NOT NULL DEFAULT 'chat',
    output_template TEXT NULL,
    quality_checklist JSON NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'active',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS st_agent_skills (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    agent_id BIGINT UNSIGNED NOT NULL,
    skill_key VARCHAR(64) NOT NULL,
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    proficiency INT NOT NULL DEFAULT 0,
    revisions INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_agent_skill (agent_id, skill_key)
  )`,
  `CREATE TABLE IF NOT EXISTS st_skill_feedback (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    agent_id BIGINT UNSIGNED NOT NULL,
    skill_key VARCHAR(64) NOT NULL,
    factory_id BIGINT UNSIGNED NULL,
    \`signal\` ENUM('useful','useless','rework') NOT NULL,
    note VARCHAR(255) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_fb_agent_skill (agent_id, skill_key),
    KEY idx_fb_created (created_at)
  )`,
  `CREATE TABLE IF NOT EXISTS st_evo_proposals (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    week VARCHAR(8) NOT NULL,
    target_type ENUM('skill','agent','knowledge','ops') NOT NULL,
    target_key VARCHAR(64) NOT NULL DEFAULT '',
    title VARCHAR(128) NOT NULL DEFAULT '',
    content TEXT NULL,
    evidence TEXT NULL,
    status ENUM('pending','approved','rejected','applied') NOT NULL DEFAULT 'pending',
    decided_by VARCHAR(64) NULL,
    decided_at DATETIME NULL,
    applied_at DATETIME NULL,
    factory_id BIGINT UNSIGNED NULL,
    skill_key VARCHAR(64) NOT NULL DEFAULT '',
    proposal_type ENUM('optimize','new_skill','retire') NOT NULL DEFAULT 'optimize',
    rationale TEXT NULL,
    diff_preview TEXT NULL,
    \`source\` ENUM('auto','llm') NOT NULL DEFAULT 'auto',
    decision_note VARCHAR(255) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_evo_status (status),
    KEY idx_evo_week (week),
    KEY ix_prop_factory_status (factory_id, status)
  )`,
  `CREATE TABLE IF NOT EXISTS st_evo_reports (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    week VARCHAR(8) NOT NULL UNIQUE,
    content TEXT NULL,
    stats JSON NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  // ─── 迭代 31：技能商店 + 能力资产化 + 三方分账（st_ 前缀 5 表）─────────────
  `CREATE TABLE IF NOT EXISTS st_skill_packs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    pack_key VARCHAR(64) NOT NULL UNIQUE,
    source_skill_key VARCHAR(64) NULL,
    title VARCHAR(64) NOT NULL,
    description VARCHAR(255) NOT NULL DEFAULT '',
    layer VARCHAR(16) NOT NULL DEFAULT 'general',
    track ENUM('A','B') NOT NULL DEFAULT 'A',
    creator_type ENUM('platform','factory','staff') NOT NULL DEFAULT 'platform',
    creator_id BIGINT UNSIGNED NULL,
    factory_id BIGINT UNSIGNED NULL,
    price_tokens INT NOT NULL DEFAULT 0,
    content_json JSON NULL,
    sanitize_report TEXT NULL,
    status ENUM('draft','pending_review','listed','rejected','delisted') NOT NULL DEFAULT 'draft',
    review_note VARCHAR(255) NULL,
    sales_count INT NOT NULL DEFAULT 0,
    listed_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_pack_status (status),
    KEY idx_pack_track (track)
  )`,
  `CREATE TABLE IF NOT EXISTS st_pack_applications (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    pack_key VARCHAR(64) NOT NULL,
    applicant_type ENUM('staff','factory') NOT NULL,
    applicant_id BIGINT UNSIGNED NOT NULL,
    factory_id BIGINT UNSIGNED NULL,
    track ENUM('A','B') NOT NULL DEFAULT 'B',
    confirm_by VARCHAR(64) NULL,
    confirm_at DATETIME NULL,
    confirm_status ENUM('pending','confirmed','rejected') NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_app_factory (factory_id),
    KEY idx_app_confirm (confirm_status)
  )`,
  `CREATE TABLE IF NOT EXISTS st_pack_purchases (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    pack_key VARCHAR(64) NOT NULL,
    buyer_factory_id BIGINT UNSIGNED NOT NULL,
    price_tokens INT NOT NULL,
    share_platform INT NOT NULL DEFAULT 0,
    share_factory INT NOT NULL DEFAULT 0,
    share_staff INT NOT NULL DEFAULT 0,
    status VARCHAR(16) NOT NULL DEFAULT 'paid',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_pur_factory (buyer_factory_id),
    KEY idx_pur_pack (pack_key)
  )`,
  `CREATE TABLE IF NOT EXISTS st_pack_mounts (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    purchase_id BIGINT UNSIGNED NOT NULL,
    pack_key VARCHAR(64) NOT NULL,
    buyer_factory_id BIGINT UNSIGNED NOT NULL,
    agent_id BIGINT UNSIGNED NOT NULL,
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_mount (pack_key, buyer_factory_id, agent_id)
  )`,
  `CREATE TABLE IF NOT EXISTS st_creator_income (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    purchase_id BIGINT UNSIGNED NOT NULL,
    owner_type ENUM('platform','factory','staff') NOT NULL,
    owner_id BIGINT UNSIGNED NULL,
    amount INT NOT NULL DEFAULT 0,
    period VARCHAR(8) NOT NULL,
    status ENUM('accrued','settled') NOT NULL DEFAULT 'accrued',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_income_owner (owner_type, owner_id)
  )`,
  // ─── 迭代 35：管理后台操作审计（API-CONTRACT-v6 批次A）─────────────────────
  `CREATE TABLE IF NOT EXISTS st_admin_audit (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    admin_user_id BIGINT UNSIGNED NOT NULL,
    admin_name VARCHAR(64) NOT NULL DEFAULT '',
    \`action\` VARCHAR(64) NOT NULL,
    target VARCHAR(191) NOT NULL DEFAULT '',
    detail_json TEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_audit_time (created_at),
    KEY ix_audit_admin (admin_user_id)
  )`,
  // ─── 迭代 35 批次B：客服工单闭环 + 推荐位运营（API-CONTRACT-v7）────────────
  `CREATE TABLE IF NOT EXISTS st_ops_tickets (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    source ENUM('feedback','silent','manual') NOT NULL DEFAULT 'manual',
    factory_id BIGINT UNSIGNED NULL,
    ref_id BIGINT UNSIGNED NULL,
    title VARCHAR(191) NOT NULL DEFAULT '',
    status ENUM('open','processing','done') NOT NULL DEFAULT 'open',
    assignee VARCHAR(64) NOT NULL DEFAULT '',
    note TEXT NULL,
    reply TEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    closed_at DATETIME NULL,
    KEY ix_tickets_status (status),
    KEY ix_tickets_factory (factory_id)
  )`,
  `CREATE TABLE IF NOT EXISTS st_ticket_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    ticket_id BIGINT UNSIGNED NOT NULL,
    actor VARCHAR(64) NOT NULL DEFAULT '',
    event VARCHAR(32) NOT NULL,
    detail TEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_events_ticket (ticket_id),
    KEY ix_events_time (created_at)
  )`,
  `CREATE TABLE IF NOT EXISTS st_recommend_slots (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    slot_key ENUM('portal_agents','portal_packs','shop_packs') NOT NULL,
    target_id VARCHAR(64) NOT NULL,
    weight INT NOT NULL DEFAULT 0,
    pinned TINYINT(1) NOT NULL DEFAULT 0,
    note VARCHAR(255) NOT NULL DEFAULT '',
    updated_by VARCHAR(64) NOT NULL DEFAULT '',
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_slot_target (slot_key, target_id)
  )`,
  // ─── 迭代 32：企业成长快报（API-CONTRACT-v8 §2，唯一键幂等惰性生成）────────
  `CREATE TABLE IF NOT EXISTS st_weekly_digest (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    factory_id BIGINT UNSIGNED NOT NULL,
    week_start DATE NOT NULL,
    highlights_json TEXT NULL,
    metrics_json TEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_factory_week (factory_id, week_start)
  )`,
  // ─── 迭代 34：Token 充值申请（API-CONTRACT-v10 §2，人工确认入账）───────────
  `CREATE TABLE IF NOT EXISTS st_token_topups (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    factory_id BIGINT UNSIGNED NOT NULL,
    amount INT NOT NULL,
    price_cny INT NOT NULL,
    status ENUM('pending','confirmed','rejected') NOT NULL DEFAULT 'pending',
    remark VARCHAR(255) NOT NULL DEFAULT '',
    proof TEXT NULL,
    confirmed_by VARCHAR(64) NULL,
    confirmed_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_topup_factory (factory_id)
  )`,
];

/** 迭代 28：st_kb_docs additive 加列 dept_key（information_schema 检查后 ALTER，幂等） */
async function ensureKbDeptKeyColumn(conn: { query: (q: string) => Promise<unknown> }): Promise<void> {
  const tables = (await conn.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'st_kb_docs'`,
  )) as unknown;
  const tableRows = Array.isArray(tables) && Array.isArray(tables[0]) ? (tables[0] as Array<unknown>) : (tables as Array<unknown>);
  if (!Array.isArray(tableRows) || tableRows.length === 0) return; // st_kb_docs 尚未创建：跳过
  const rows = (await conn.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'st_kb_docs' AND COLUMN_NAME = 'dept_key'`,
  )) as unknown;
  const cols = Array.isArray(rows) && Array.isArray(rows[0]) ? (rows[0] as Array<unknown>) : (rows as Array<unknown>);
  if (Array.isArray(cols) && cols.length > 0) return;
  await conn.query(`ALTER TABLE st_kb_docs ADD COLUMN dept_key VARCHAR(64) NULL`);
}

/** 战区② 2.1（彭总部门级订阅包策略）：pkg_packages additive 加列 dept_code+team_spec
 * （information_schema 逐列检查后 ALTER，幂等；新库走上方完整 DDL 不会进入此分支——与 wb 侧同构） */
async function ensurePkgDeptColumns(conn: { query: (q: string) => Promise<unknown> }): Promise<void> {
  const unwrap = (r: unknown): Array<Record<string, unknown>> =>
    (Array.isArray(r) && Array.isArray(r[0]) ? r[0] : r) as Array<Record<string, unknown>>;
  const tables = unwrap(
    await conn.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pkg_packages'`,
    ),
  );
  if (tables.length === 0) return; // 表尚未创建：跳过（上方 DDL 会建）
  const colRows = unwrap(
    await conn.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pkg_packages'`,
    ),
  );
  const cols = new Set(colRows.map((r) => String(r.COLUMN_NAME)));
  if (!cols.has("dept_code")) {
    await conn.query(`ALTER TABLE pkg_packages ADD COLUMN dept_code VARCHAR(32) NULL AFTER poster_url`); // 部门键
  }
  if (!cols.has("team_spec")) {
    await conn.query(`ALTER TABLE pkg_packages ADD COLUMN team_spec JSON NULL AFTER dept_code`); // 团队规格
  }
  if (!cols.has("package_tier")) {
    await conn.query(`ALTER TABLE pkg_packages ADD COLUMN package_tier VARCHAR(16) NULL AFTER dept_code`); // 子包级（wb#81 同位同序——NumX portal#60 收口：库里有的列仓里也得有，新环境不复现）
  }
}

/**
 * 迭代 33（API-CONTRACT-v9 §1）：st_evo_proposals 迭代 30 已建，
 * 此处为既有库 additive 补齐企业级提案-审批层新列 + ix_prop_factory_status 索引
 * （information_schema 逐列检查后 ALTER，幂等；新库走上方完整 DDL 不会进入此分支）。
 */
async function ensureEvoProposalColumns(conn: { query: (q: string) => Promise<unknown> }): Promise<void> {
  const unwrap = (r: unknown): Array<Record<string, unknown>> =>
    (Array.isArray(r) && Array.isArray(r[0]) ? r[0] : r) as Array<Record<string, unknown>>;
  const tables = unwrap(
    await conn.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'st_evo_proposals'`,
    ),
  );
  if (tables.length === 0) return; // 表尚未创建：跳过（上方 DDL 会建）
  const colRows = unwrap(
    await conn.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'st_evo_proposals'`,
    ),
  );
  const cols = new Set(colRows.map((r) => String(r.COLUMN_NAME)));
  const addCols: Array<[string, string]> = [
    ["factory_id", "ADD COLUMN factory_id BIGINT UNSIGNED NULL"],
    ["skill_key", "ADD COLUMN skill_key VARCHAR(64) NOT NULL DEFAULT ''"],
    ["proposal_type", "ADD COLUMN proposal_type ENUM('optimize','new_skill','retire') NOT NULL DEFAULT 'optimize'"],
    ["rationale", "ADD COLUMN rationale TEXT NULL"],
    ["diff_preview", "ADD COLUMN diff_preview TEXT NULL"],
    ["source", "ADD COLUMN `source` ENUM('auto','llm') NOT NULL DEFAULT 'auto'"],
    ["decision_note", "ADD COLUMN decision_note VARCHAR(255) NULL"],
  ];
  for (const [name, clause] of addCols) {
    if (!cols.has(name)) {
      await conn.query(`ALTER TABLE st_evo_proposals ${clause}`);
    }
  }
  const idxRows = unwrap(
    await conn.query(
      `SELECT INDEX_NAME FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'st_evo_proposals' AND INDEX_NAME = 'ix_prop_factory_status'`,
    ),
  );
  if (idxRows.length === 0) {
    await conn.query(`ALTER TABLE st_evo_proposals ADD INDEX ix_prop_factory_status (factory_id, status)`);
  }
}

/** 创建 7 张表（幂等）；DATABASE_URL 缺失或连接失败时抛错由调用方兜底 */
export async function ensureOpsTables(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.warn("sync-ops: DATABASE_URL 未配置，跳过建表");
    return;
  }
  const { default: mysql } = await import("mysql2/promise");
  const conn = await mysql.createConnection(url);
  try {
    for (const ddl of DDLS) {
      await conn.query(ddl);
    }
    await ensureKbDeptKeyColumn(conn);
    await ensurePkgDeptColumns(conn); // 战区② 2.1——pkg_packages 部门包列（dept_code+team_spec）
    await ensureEvoProposalColumns(conn);
    console.log(`sync-ops done (${DDLS.length} tables ensured + st_kb_docs.dept_key + st_evo_proposals v9 列)`);
  } finally {
    await conn.end();
  }
}

/** 仅当作为脚本直接执行时自动运行（被 boot.ts import / 打包进 boot.js 时不触发） */
const isDirectRun = (() => {
  try {
    const arg1 = process.argv[1] ?? "";
    // 打包进 dist/boot.js 后 import.meta.url 与 argv[1] 相同，必须额外按文件名判断
    if (!/sync-ops\.mts$/.test(arg1) && !/sync-ops/.test(arg1)) return false;
    return realpathSync(arg1) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  if (process.env.DRY_RUN) {
    console.log("dry run ok");
    process.exit(0);
  }
  ensureOpsTables()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("sync-ops failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
