/**
 * 幂等同步迭代 14 账号体系扩展（wb_users / wb_factories additive 加列 + 演示账号）。
 * TiDB 下 drizzle-kit push 不可用，故用 mysql2 直连（参照 sync-industries.mts 模式）。
 * 用法：DATABASE_URL=$(grep '^DATABASE_URL=' .env | cut -d= -f2-) npx tsx db/sync-nb-auth.mts
 * 语法自检：DRY_RUN=1 npx tsx db/sync-nb-auth.mts（不连库，直接退出）
 *
 * - wb_users 加列：phone（唯一索引，存量 NULL）/ realName / idCardMasked / idCardHash /
 *   kind ENUM('person','enterprise') DEFAULT 'enterprise'
 * - wb_factories 加列：creditCode / industryGroup DEFAULT '工业制造'（存量防御回填）
 * - 幂等种子 2 个演示账号（演示口令为统一占位口令，仅内测演示用）：
 *   · 企业演示「星云智造示范工厂」phone 13900000001，工业制造，4 个示例部门（带人数/职能）
 *   · 个人演示「陈工匠」phone 13900000002，身份证 110101199003077758
 *     （GB11643 校验位验证：加权和 246，246 mod 11 = 4 → 映射 '10X98765432'[4] = '8'，
 *      与末位一致，为合法校验位测试号；库中只落 sha256 + 掩码，绝不存明文）
 */
if (process.env.DRY_RUN) {
  console.log("dry run ok");
  process.exit(0);
}

import { createHash, randomBytes, scryptSync } from "node:crypto";
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const conn = await mysql.createConnection(url);

function sha256(plain: string): string {
  return createHash("sha256").update(plain, "utf8").digest("hex");
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

/** information_schema 检测后 ADD COLUMN（additive，幂等） */
async function ensureColumn(table: string, column: string, ddl: string) {
  const [cols] = await conn.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  if ((cols as unknown[]).length > 0) {
    console.log(`${table}.${column}: column exists, skip`);
  } else {
    await conn.query(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    console.log(`${table}.${column}: column added`);
  }
}

// ── 1. wb_users additive 加列 ────────────────────────────────────────────────
await ensureColumn("wb_users", "phone", "phone VARCHAR(20) NULL AFTER departmentId");
await ensureColumn("wb_users", "realName", "realName VARCHAR(64) NULL AFTER phone");
await ensureColumn("wb_users", "idCardMasked", "idCardMasked VARCHAR(32) NULL AFTER realName");
await ensureColumn("wb_users", "idCardHash", "idCardHash VARCHAR(64) NULL AFTER idCardMasked");
await ensureColumn(
  "wb_users",
  "kind",
  "kind ENUM('person','enterprise') NOT NULL DEFAULT 'enterprise' AFTER idCardHash",
);

// phone 唯一索引（幂等：STATISTICS 检测）
{
  const [idx] = await conn.query(
    `SELECT INDEX_NAME FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wb_users' AND INDEX_NAME = 'wb_users_phone_uniq'`,
  );
  if ((idx as unknown[]).length > 0) {
    console.log("wb_users.phone: unique index exists, skip");
  } else {
    await conn.query(`ALTER TABLE wb_users ADD UNIQUE KEY wb_users_phone_uniq (phone)`);
    console.log("wb_users.phone: unique index added");
  }
}

// ── 2. wb_factories additive 加列 + 存量防御回填 ─────────────────────────────
await ensureColumn("wb_factories", "creditCode", "creditCode VARCHAR(32) NULL AFTER industryText");
await ensureColumn(
  "wb_factories",
  "industryGroup",
  "industryGroup VARCHAR(32) NOT NULL DEFAULT '工业制造' AFTER industry",
);
{
  const [upd] = await conn.query(
    `UPDATE wb_factories SET industryGroup = '工业制造' WHERE industryGroup = '' OR industryGroup IS NULL`,
  );
  console.log(
    `wb_factories.industryGroup: backfill ok (affected=${(upd as { affectedRows: number }).affectedRows})`,
  );
}

// ── 3. 演示企业「星云智造示范工厂」（按 enterpriseName 幂等）─────────────────
let demoFactoryId: number;
{
  const [rows] = await conn.query(
    "SELECT id FROM wb_factories WHERE enterpriseName = ? LIMIT 1",
    ["星云智造示范工厂"],
  );
  const existing = (rows as { id: number }[])[0];
  if (existing) {
    demoFactoryId = existing.id;
    console.log(`wb_factories: 星云智造示范工厂 exists (id=${existing.id}), skip`);
  } else {
    const departments = [
      { id: "dept_1", name: "生产部", headcount: "120", duty: "产线排产与现场执行" },
      { id: "dept_2", name: "设备部", headcount: "18", duty: "设备点检、保养与故障诊断" },
      { id: "dept_3", name: "质检部", headcount: "24", duty: "来料 / 过程 / 出厂检验" },
      { id: "dept_4", name: "工艺技术部", headcount: "12", duty: "工艺参数维护与持续改进" },
    ];
    const [res] = await conn.query(
      `INSERT INTO wb_factories
       (enterpriseName, industry, industryGroup, industryText, headcount, departments, painPoints, profile)
       VALUES (?, '工业制造', '工业制造', ?, ?, CAST(? AS JSON), ?, CAST(? AS JSON))`,
      [
        "星云智造示范工厂",
        "精密零部件加工",
        "201-500 人",
        JSON.stringify(departments),
        "设备故障停机频繁、质检人力不足",
        JSON.stringify({ source: "sync-nb-auth", demo: true }),
      ],
    );
    demoFactoryId = (res as { insertId: number }).insertId;
    console.log(`wb_factories: seeded 星云智造示范工厂 (id=${demoFactoryId})`);
  }
}

// ── 4. 演示账号（按 phone/username 幂等；演示口令 Nebula123456，仅内测演示用）──
interface DemoUser {
  username: string;
  phone: string;
  password: string;
  displayName: string;
  realName: string | null;
  role: "owner" | "member";
  kind: "person" | "enterprise";
  factoryId: number;
  idCard: string | null; // 明文仅用于派生 sha256 + 掩码，绝不入库
}

const demoUsers: DemoUser[] = [
  {
    username: "13900000001",
    phone: "13900000001",
    password: process.env.NEBULA_DEMO_PASSWORD ?? 'demo-only',
    displayName: "星云智造管理员",
    realName: "星云智造管理员",
    role: "owner",
    kind: "enterprise",
    factoryId: demoFactoryId,
    idCard: null,
  },
  {
    username: "13900000002",
    phone: "13900000002",
    password: process.env.NEBULA_DEMO_PASSWORD ?? 'demo-only',
    displayName: "陈工匠",
    realName: "陈工匠",
    role: "member",
    kind: "person",
    factoryId: 0,
    // 合法校验位测试号（加权和 246 % 11 = 4 → '8'，见文件头注释）；只落 sha256 + 掩码
    idCard: "110101199003077758",
  },
];

for (const u of demoUsers) {
  const [dup] = await conn.query(
    "SELECT id FROM wb_users WHERE username = ? OR phone = ? LIMIT 1",
    [u.username, u.phone],
  );
  if ((dup as unknown[]).length > 0) {
    console.log(`wb_users: ${u.displayName}(${u.phone}) exists, skip`);
    continue;
  }
  await conn.query(
    `INSERT INTO wb_users
     (username, passwordHash, displayName, realName, role, kind, factoryId, departmentId,
      phone, idCardHash, idCardMasked)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    [
      u.username,
      hashPassword(u.password),
      u.displayName,
      u.realName,
      u.role,
      u.kind,
      u.factoryId,
      u.phone,
      u.idCard ? sha256(u.idCard) : null,
      u.idCard ? `${u.idCard.slice(0, 4)}${"*".repeat(10)}${u.idCard.slice(-4)}` : null,
    ],
  );
  console.log(`wb_users: seeded ${u.displayName}(${u.phone}, kind=${u.kind})`);
}

// ── 5. 汇总 ──────────────────────────────────────────────────────────────────
const checks: [string, string][] = [
  ["wb_users(kind=enterprise)", "SELECT COUNT(*) AS c FROM wb_users WHERE kind='enterprise'"],
  ["wb_users(kind=person)", "SELECT COUNT(*) AS c FROM wb_users WHERE kind='person'"],
  ["wb_factories(industryGroup=工业制造)", "SELECT COUNT(*) AS c FROM wb_factories WHERE industryGroup='工业制造'"],
];
for (const [label, q] of checks) {
  const [rows] = await conn.query(q);
  console.log(`${label}: ${(rows as { c: number }[])[0].c} row(s)`);
}

await conn.end();
console.log("sync-nb-auth done.");
