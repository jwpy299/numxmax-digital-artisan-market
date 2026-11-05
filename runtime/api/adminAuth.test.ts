/**
 * M64 adminAuth（超终专属注册/登录通道）闸。
 * 假库：内存双表（st_admin_accounts / st_admin_applications）状态ful 模拟；
 * requireAdmin mock 放行（第三层回退自身的集成由 terminal 侧既有测试文化覆盖）。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { hashPassword } from "./routers/wbSession";
import { totpAt } from "./auth/totp"; // 七-d：测试同引产线纯件（KAT 已钉——不抄实现）
import { authTokenHash } from "./auth/revocation"; // P3-6 对齐：塞库 token 存指纹（实现面查 authTokenHash=mock 存明文永不中=「会话无效」面封死——测试欠债修）

type Row = Record<string, unknown>;
let accounts: Row[] = [];
let applications: Row[] = [];
let tfaRows: Row[] = []; // 七-d：2FA 面内存表
let nextApplId = 1;

/** 极简 SQL 路由：按 sql 文本关键词分发到内存表操作 */
vi.mock("./queries/connection", async () => {
  const { MySqlDialect } = await import("drizzle-orm/mysql-core");
  const dialect = new MySqlDialect();
  return {
    getDb: () => {
      const db = {
      execute: async (stmt: unknown) => {
        const q = dialect.sqlToQuery(stmt as never); // { sql, params } 真实文本+绑定
        const text = q.sql;
        const params = q.params as unknown[];
        if (text.includes("FROM st_admin_accounts")) {
          if (text.includes("authToken =")) {
            const tok = params[0];
            return [accounts.filter((a) => a.authToken === tok).slice(0, 1), []] as never; // R7-c24：元组形态（canonical rawRows 与 mock 双兼容）
          }
          if (text.includes("username = ? OR phone = ?")) {
            const idf = params[0];
            return [accounts.filter((a) => a.username === idf || a.phone === idf).slice(0, 1), []] as never; // R7-c24：元组形态（canonical rawRows 与 mock 双兼容）
          }
          if (text.includes("WHERE id =")) {
            const id = Number(params[0]);
            return [accounts.filter((a) => Number(a.id) === id).slice(0, 1), []] as never; // R7-c24：元组形态（canonical rawRows 与 mock 双兼容）
          }
          if (text.includes("WHERE username =")) {
            const un = params[0];
            return [accounts.filter((a) => a.username === un).slice(0, 1), []] as never; // R7-c24：元组形态（canonical rawRows 与 mock 双兼容）
          }
          return [accounts, []] as never; // R7-c24：元组形态（canonical rawRows 与 mock 双兼容）
        }
        if (text.includes("INSERT INTO st_admin_accounts")) {
          const [username, phone, passwordHash, displayName] = params as string[];
          accounts.push({ id: accounts.length + 1, username, phone, passwordHash, displayName, role: "admin", disabled: 0, authToken: null, createdAt: new Date(), lastLoginAt: null });
          return [[], []] as never; // R7-c24：元组形态（canonical rawRows 与 mock 双兼容）
        }
        if (text.includes("UPDATE st_admin_accounts")) {
          if (text.includes("lastLoginAt")) {
            const [tok, id] = [params[0], Number(params[1])];
            accounts = accounts.map((a) => Number(a.id) === id ? { ...a, authToken: tok, lastLoginAt: new Date() } : a);
          } else if (text.includes("passwordHash")) {
            const [hash, tok, id] = [params[0], params[1], Number(params[2])] as [string, string, number];
            accounts = accounts.map((a) => Number(a.id) === id ? { ...a, passwordHash: hash, authToken: tok } : a);
          } else if (text.includes("disabled = 1")) {
            const id = Number(params[0]);
            accounts = accounts.map((a) => Number(a.id) === id ? { ...a, disabled: 1, authToken: null } : a);
          } else if (text.includes("disabled = 0")) {
            const id = Number(params[0]);
            accounts = accounts.map((a) => Number(a.id) === id ? { ...a, disabled: 0 } : a);
          }
          return [[], []] as never; // R7-c24：元组形态（canonical rawRows 与 mock 双兼容）
        }
        if (text.includes("FROM st_admin_applications")) {
          if (text.includes("WHERE username =") && text.includes("phone =") && text.includes("ORDER BY")) {
            const [un, ph] = params as string[];
            return [applications.filter((a) => a.username === un && a.phone === ph).slice(-1), []] as never; // R7-c24：元组形态（canonical rawRows 与 mock 双兼容）
          }
          if (text.includes("status = 'pending'") && text.includes("username =")) {
            const un = params[0];
            return [applications.filter((a) => a.username === un && a.status === "pending").slice(0, 1), []] as never; // R7-c24：元组形态（canonical rawRows 与 mock 双兼容）
          }
          if (text.includes("WHERE id =")) {
            const id = Number(params[0]);
            return [applications.filter((a) => Number(a.id) === id).slice(0, 1), []] as never; // R7-c24：元组形态（canonical rawRows 与 mock 双兼容）
          }
          if (text.includes("WHERE status =")) {
            const st = params[0];
            return [applications.filter((a) => a.status === st), []] as never; // R7-c24：元组形态（canonical rawRows 与 mock 双兼容）
          }
          return [applications, []] as never; // R7-c24：元组形态（canonical rawRows 与 mock 双兼容）
        }
        if (text.includes("INSERT INTO st_admin_applications")) {
          const [username, phone, displayName, reason, inviteCode] = params as (string | null)[];
          applications.push({ id: nextApplId++, username, phone, displayName, reason, inviteCode, status: "pending", createdAt: new Date() });
          return [[], []] as never; // R7-c24：元组形态（canonical rawRows 与 mock 双兼容）
        }
        if (text.includes("UPDATE st_admin_2fa") && text.includes("SET enabled = 0")) { // 门禁 PR#9-r2-④/r14-⑥：软停支（删行退役——登记/确认史留痕）；键咬 SET 子句防误抢（自伤复盘钉）；验数钉（reset2fa 带 enabled=1 条件——返 affectedRows 真值）
          const accountId = Number(params[params.length - 1]);
          const row = tfaRows.find((r) => Number(r.account_id) === accountId && Number(r.enabled) === 1);
          if (row) Object.assign(row, { enabled: 0, last_step: null, fail_count: 0 });
          return [[{ affectedRows: row ? 1 : 0 }], []] as never;
        }
        if (text.includes("SELECT") && text.includes("FROM st_admin_2fa")) { // 七-d：2FA 读（login 闸/confirm/disable 共用）
          const id = Number(params[0]);
          return [tfaRows.filter((r) => Number(r.account_id) === id).slice(0, 1), []] as never;
        }
        if (text.includes("INSERT INTO st_admin_2fa")) { // enroll upsert：params=[accountId, secret, secret]
          const [accountId, secret] = params as [number, string, string];
          const i = tfaRows.findIndex((r) => Number(r.account_id) === Number(accountId));
          const row = { account_id: accountId, secret_b32: secret, enabled: 0, last_step: null, fail_count: 0, verified_at: null }; // PR#9-④/r17-⓪：失败计数列+verified_at（真待确认=NULL）
          if (i >= 0) tfaRows[i] = row; else tfaRows.push(row);
          return [[], []] as never;
        }
        if (text.includes("UPDATE st_admin_2fa") && text.includes("SET enabled = 1")) { // confirm 生效（门禁 PR#9-r5-⑥/r27-自伤复盘：键咬 SET 子句——consume 写句 WHERE 带 "enabled = 1"，裸词键误抢面再封）
          const [step, accountId] = params as [number, number];
          const row = tfaRows.find((r) => Number(r.account_id) === Number(accountId));
          const ok = row !== undefined && Number(row.enabled) === 0 && (row.verified_at === null || row.verified_at === undefined) && (row.last_step === null || row.last_step === undefined || Number(row.last_step) < Number(step)); // PR#9-r17-⓪：verified_at IS NULL 条件同模拟（软停行不复活）
          if (row && ok) Object.assign(row, { enabled: 1, last_step: step, fail_count: 0, verified_at: new Date() }); // PR#9-④/r17-⓪：成功清计数+verified_at 落戳
          return [[{ affectedRows: row && ok ? 1 : 0 }], []] as never;
        }
        if (text.includes("UPDATE st_admin_2fa") && text.includes("last_step =")) { // login 步长消费（回放闸条件原子性模拟）
          const [step, accountId] = params as [number, number, number];
          const row = tfaRows.find((r) => Number(r.account_id) === Number(accountId));
          const ok = row && (row.last_step === null || row.last_step === undefined || Number(row.last_step) < Number(step));
          if (row && ok) { row.last_step = step; row.fail_count = 0; } // PR#9-④：成功清计数
          return [[{ affectedRows: row && ok ? 1 : 0 }], []] as never; // R7-c131-④/R7-d：验数钉配套
        }
        if (text.includes("UPDATE st_admin_2fa") && text.includes("fail_count = IF")) { // 门禁 PR#9-r2-①：尝试原子认领（锁判+计数一体——params=[窗,窗,accountId,窗,MAX]；≥MAX 即锁返 0 行）
          const accountId = Number(params[2]);
          const row = tfaRows.find((r) => Number(r.account_id) === accountId);
          const locked = row !== undefined && Number(row.fail_count ?? 0) >= 5;
          if (row && !locked) row.fail_count = Number(row.fail_count ?? 0) + 1;
          return [[{ affectedRows: row && !locked ? 1 : 0 }], []] as never;
        }
        if (text.includes("UPDATE st_admin_applications")) {
          const status = text.includes("'rejected'") ? "rejected" : "approved";
          const id = Number(params[params.length - 1]);
          const pendingBefore = applications.filter((a) => Number(a.id) === id && a.status === "pending").length; // R7-c132-④：验数钉配套——pending 谓词命中数=affectedRows（并发终态不再恒 1）
          applications = applications.map((a) => Number(a.id) === id && a.status === "pending" ? { ...a, status, reviewedBy: "hq", reviewedAt: new Date() } : a);
          return [[{ affectedRows: pendingBefore }], []] as never; // R7-c24：元组形态（canonical rawRows 与 mock 双兼容）
        }
        if (text.includes("markerN")) return [[{ markerN: 1, totalN: 1, legacyN: 0 }], []] as never; // R7-c134-⑨：吊销探针行（fail-loud 解包钉配套）
        return [[], []] as never; // R7-c24：元组形态（canonical rawRows 与 mock 双兼容）
        },
      };
      // R7-c131-④：事务 mock——tx 共享同一 execute 路由（内存表无真回滚；路由保真即可——原子性语义由产线 drizzle 承担）
      return { execute: db.execute, transaction: async (fn: (tx: typeof db) => Promise<unknown>) => fn(db) };
    },
  };
});

// R7-c44-⑦：mock 面迁移——adminAuth.ts 已直引 canonical rawRows（../queries/rawRows）+ adminGate requireAdmin；
//  再出口 terminal 不被本文件消费，mock 拦截点随之迁到 adminGate（单源闸——不再经 terminal 依赖图）
vi.mock("./auth/adminGate", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    requireAdmin: vi.fn(async () => ({ id: 1, username: "hq", role: "admin" })),
  };
});

import { adminAuthRouter } from "./routers/adminAuth";
import { findNativeAdminByToken } from "./routers/adminAuth";

const caller = adminAuthRouter.createCaller({} as never);

describe("M64 adminAuth 超终注册/登录通道", () => {
  beforeEach(() => {
    accounts = [];
    applications = [];
    tfaRows = []; // 七-d 同复位
    nextApplId = 1;
  });

  it("注册申请 → pending；重名账号占用预检", async () => {
    const r = await caller.registerApply({ username: "boss_peng", phone: "13800001111", displayName: "彭总", reason: "HQ 治理" });
    expect(r.status).toBe("pending");
    accounts.push({ id: 1, username: "taken_name", phone: null, passwordHash: "x:y", displayName: "x", role: "admin", disabled: 0 });
    await expect(
      caller.registerApply({ username: "taken_name", phone: "13800002222", displayName: "某人" }),
    ).rejects.toThrow("已被使用");
    // 同名在途申请重复提交被拒
    await expect(
      caller.registerApply({ username: "boss_peng", phone: "13800001111", displayName: "彭总" }),
    ).rejects.toThrow("待审申请");
  });

  it("手机号/账号格式闸", async () => {
    await expect(caller.registerApply({ username: "ab", phone: "13800001111", displayName: "x" })).rejects.toThrow();
    await expect(caller.registerApply({ username: "okname", phone: "23800001111", displayName: "x" })).rejects.toThrow();
    await expect(caller.registerApply({ username: "bad name!", phone: "13800001111", displayName: "x" })).rejects.toThrow();
  });

  it("myApplication 双因子查询：匹配返回状态，不匹配不泄露", async () => {
    await caller.registerApply({ username: "boss_peng", phone: "13800001111", displayName: "彭总" });
    const hit = await caller.myApplication({ username: "boss_peng", phone: "13800001111" });
    expect(hit.found).toBe(true);
    if (hit.found) expect(hit.status).toBe("pending");
    const miss = await caller.myApplication({ username: "boss_peng", phone: "13899990000" });
    expect(miss.found).toBe(false);
  });

  it("审批通过：建账号 + 一次性初始密码 + 申请转 approved", async () => {
    await caller.registerApply({ username: "boss_peng", phone: "13800001111", displayName: "彭总" });
    const r = await caller.review({ token: "t", applicationId: 1, decision: "approve" });
    expect(r.decision).toBe("approved");
    if (r.decision !== "approved") return;
    expect(r.initialPassword).toMatch(/^[A-Za-z0-9]{12}$/);
    expect(accounts.length).toBe(1);
    expect(accounts[0].username).toBe("boss_peng");
    expect(applications[0].status).toBe("approved");
    // 重复审结被拒
    await expect(caller.review({ token: "t", applicationId: 1, decision: "approve" })).rejects.toThrow("已审结");
  });

  it("审批驳回：落 note，不建账号", async () => {
    await caller.registerApply({ username: "stranger", phone: "13800003333", displayName: "路人", reason: "试试" });
    const r = await caller.review({ token: "t", applicationId: 1, decision: "reject", reviewNote: "非本厂人员" });
    expect(r.decision).toBe("rejected");
    expect(accounts.length).toBe(0);
    expect(applications[0].status).toBe("rejected");
  });

  it("登录全链：初始密码 → token → findNativeAdminByToken → 改密 → 旧密码失效", async () => {
    await caller.registerApply({ username: "boss_peng", phone: "13800001111", displayName: "彭总" });
    const rv = await caller.review({ token: "t", applicationId: 1, decision: "approve" });
    if (rv.decision !== "approved") throw new Error("unreachable");
    // 错误密码 401
    await expect(caller.login({ identifier: "boss_peng", password: "wrong-pass" })).rejects.toThrow("账号或密码错误");
    // 正确密码（手机号也可作 identifier）
    const byPhone = await caller.login({ identifier: "13800001111", password: rv.initialPassword });
    expect(byPhone.token).toMatch(/^nt_/);
    expect(byPhone.adminOrigin).toBe("native");
    // token 可被第三层回退识别
    const found = await findNativeAdminByToken(byPhone.token);
    expect(found?.username).toBe("boss_peng");
    // 自助改密：旧密码错误被拒
    await expect(caller.setPassword({ token: byPhone.token, oldPassword: "nope-nope", newPassword: "NewPass12345" })).rejects.toThrow("原密码错误");
    // 正确改密 → 新 token；旧密码登录失效
    const sp = await caller.setPassword({ token: byPhone.token, oldPassword: rv.initialPassword, newPassword: "NewPass12345" });
    expect(sp.token).toMatch(/^nt_/);
    await expect(caller.login({ identifier: "boss_peng", password: rv.initialPassword })).rejects.toThrow();
    const relogin = await caller.login({ identifier: "boss_peng", password: "NewPass12345" });
    expect(relogin.token).toMatch(/^nt_/);
  });

  it("停用：login 拒、findNative null-safe；super 不可停用", async () => {
    accounts.push({ id: 9, username: "super1", phone: null, passwordHash: hashPassword("SuperPass99"), displayName: "超管", role: "super", disabled: 0, authToken: null });
    accounts.push({ id: 10, username: "adm1", phone: null, passwordHash: hashPassword("AdminPass99"), displayName: "管理员", role: "admin", disabled: 0, authToken: null });
    await expect(caller.setDisabled({ token: "t", accountId: 9, disabled: true })).rejects.toThrow("超管账号不可停用");
    await caller.setDisabled({ token: "t", accountId: 10, disabled: true });
    await expect(caller.login({ identifier: "adm1", password: "AdminPass99" })).rejects.toThrow("已被停用");
    await caller.setDisabled({ token: "t", accountId: 10, disabled: false });
    const r = await caller.login({ identifier: "adm1", password: "AdminPass99" });
    expect(r.token).toMatch(/^nt_/);
  });

  it("applications 列表按状态过滤 + accounts 脱敏无 hash", async () => {
    await caller.registerApply({ username: "appl_jia", phone: "13800000001", displayName: "甲" });
    await caller.registerApply({ username: "appl_yi", phone: "13800000002", displayName: "乙" });
    const pend = await caller.applications({ token: "t", status: "pending" });
    expect(pend.items.length).toBe(2);
    await caller.review({ token: "t", applicationId: 1, decision: "approve" });
    const pend2 = await caller.applications({ token: "t", status: "pending" });
    expect(pend2.items.length).toBe(1);
    const accts = await caller.accounts({ token: "t" });
    expect(accts.items.length).toBe(1);
    expect(JSON.stringify(accts)).not.toContain("passwordHash");
  });
});

describe("七-d 2FA（enroll→confirm→login 闸→回放拒→disable）", () => {
  it("my2fa 状态读（批七-e）：未启用 false → enroll+confirm 后 true（自助面读径钉）", async () => {
    seedAdmin();
    expect((await caller.my2fa({ token: "nt_2fa" })).enabled).toBe(false);
    const enr = await caller.enroll2fa({ token: "nt_2fa", password: "pw-123456" });
    await caller.confirm2fa({ token: "nt_2fa", password: "pw-123456", code: curCode(enr.secret) });
    expect((await caller.my2fa({ token: "nt_2fa" })).enabled).toBe(true);
  });

  beforeEach(() => { accounts = []; tfaRows = []; }); // 本套件状态自立——2FA 行不跨测试渗漏（节流钉留 enabled 行不再毒邻——套件无序耦合面封死）
  const seedAdmin = () => {
    accounts.push({ id: 9, username: "boss2", phone: "13900000000", passwordHash: hashPassword("pw-123456"), displayName: "二", role: "admin", disabled: 0, authToken: authTokenHash("nt_2fa"), createdAt: new Date(), lastLoginAt: null });
  };
  const curCode = (secret: string) => totpAt(secret, Math.floor(Date.now() / 1000 / 30));

  it("登记→确认→登录须码→同窗回放拒→停用须码→停用后免码", async () => {
    seedAdmin();
    const enr = await caller.enroll2fa({ token: "nt_2fa", password: "pw-123456" });
    expect(enr.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(enr.otpauthUrl).toContain("otpauth://totp/NebulaHQ:boss2");
    // 未确认前登录免码（enabled=0）——注意：login 重颁 nt_（旧 token 即吊销），后续操作链须用新证
    const lg0 = await caller.login({ identifier: "boss2", password: "pw-123456" });
    expect(lg0.username).toBe("boss2");
    // 错码确认拒
    await expect(caller.confirm2fa({ token: lg0.token, password: "pw-123456", code: "000000" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.confirm2fa({ token: lg0.token, password: "pw-123456", code: curCode(enr.secret) })).resolves.toEqual({ ok: true });
    // 生效后无码 → PRECONDITION 明示弹码窗
    await expect(caller.login({ identifier: "boss2", password: "pw-123456" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    // 正确码过（注意：confirm 已消费当前步长——login 同窗重放同码=回放拒；等下一窗或用 verifyTotp 窗语义：login 用同码同窗会被回放闸拦）
    const nextCode = totpAt(enr.secret, Math.floor(Date.now() / 1000 / 30) + 1); // 下一窗码（+1 窗容忍命中）
    const lg = await caller.login({ identifier: "boss2", password: "pw-123456", totpCode: nextCode });
    expect(lg.token).toMatch(/^nt_/);
    // 同窗重放同码 → 拒（回放闸）
    await expect(caller.login({ identifier: "boss2", password: "pw-123456", totpCode: nextCode })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    // 停用须码——回放闸语义：同窗（含 ±1 容忍窗）码已消费，须等下一真实窗口；测试以系统时间推进 31s 模拟（vi.setSystemTime 控 Date.now）
    const realNow = Date.now();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(realNow + 61_000); // 须越两窗：login 经 +1 容忍已消费下一窗码——+1 窗=已消费窗（回放闸正确语义，沙箱复现钉）；+2 窗才是未消费新窗
      const offCode = totpAt(enr.secret, Math.floor(Date.now() / 1000 / 30));
      await expect(caller.disable2fa({ token: lg.token, password: "pw-123456", code: offCode })).resolves.toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
    }
    // 停用后免码登录
    await expect(caller.login({ identifier: "boss2", password: "pw-123456" })).resolves.toMatchObject({ username: "boss2" });
  });

  it("setPassword 对已启用 2FA 账号须过动态码（门禁 PR#9-r4-①——盗 token+旧密码换密锁主面钉死）", async () => {
    seedAdmin();
    const enr = await caller.enroll2fa({ token: "nt_2fa", password: "pw-123456" });
    await caller.confirm2fa({ token: "nt_2fa", password: "pw-123456", code: curCode(enr.secret) });
    // 无码 → PRECONDITION 明示弹码窗
    await expect(caller.setPassword({ token: "nt_2fa", oldPassword: "pw-123456", newPassword: "pw-65432100" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    // 恒错码（排除偶中=钉不自伤）→ LOGIN_FAIL（计数已在认领）
    const win = new Set([-1, 0, 1].map((d) => totpAt(enr.secret, Math.floor(Date.now() / 1000 / 30) + d)));
    let wrong = "000000";
    for (let i = 0; win.has(wrong); i++) wrong = String(i + 1).padStart(6, "0");
    await expect(caller.setPassword({ token: "nt_2fa", oldPassword: "pw-123456", newPassword: "pw-65432100", totpCode: wrong })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    // 正码 → 过（+1 容忍窗码——confirm 已消费当前窗）；改密重签=旧证即死，后续操作链用新证
    const nx = totpAt(enr.secret, Math.floor(Date.now() / 1000 / 30) + 1);
    const sp = await caller.setPassword({ token: "nt_2fa", oldPassword: "pw-123456", newPassword: "pw-65432100", totpCode: nx });
    expect(sp.token).toMatch(/^nt_/);
    // 同窗重放同码改密 → 拒（回放闸——新证+新密码仍在同窗，码已消费即拦）
    await expect(caller.setPassword({ token: sp.token, oldPassword: "pw-65432100", newPassword: "pw-12345600", totpCode: nx })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("软停行不可被 confirm 复活（门禁 PR#9-r17-⓪——旧密钥须随 enroll 轮换，不复活）", async () => {
    seedAdmin();
    const enr = await caller.enroll2fa({ token: "nt_2fa", password: "pw-123456" });
    await caller.confirm2fa({ token: "nt_2fa", password: "pw-123456", code: curCode(enr.secret) });
    const realNow = Date.now();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(realNow + 61_000); // 越两窗（+1 容忍消费语义钉）
      const code = totpAt(enr.secret, Math.floor(Date.now() / 1000 / 30));
      await caller.disable2fa({ token: "nt_2fa", password: "pw-123456", code }); // 软停（verified_at 留痕）
    } finally {
      vi.useRealTimers();
    }
    // 停用后用旧密钥码 confirm → CONFLICT（复活闸）——须重新 enroll 颁新钥
    await expect(caller.confirm2fa({ token: "nt_2fa", password: "pw-123456", code: curCode(enr.secret) })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("reset2fa 应急通道：super 可重置他人/非 super 拒/重置后免码登录（门禁 PR#9-r14-⑥——丢验证器不再永久锁死）", async () => {
    seedAdmin();
    accounts.push({ id: 1, username: "hqsuper", phone: null, passwordHash: hashPassword("pw-hq-999"), displayName: "彭总", role: "super", disabled: 0, authToken: authTokenHash("nt_super"), createdAt: new Date(), lastLoginAt: null });
    // 非 super 拒
    await expect(caller.reset2fa({ token: "nt_2fa", password: "pw-123456", accountId: 9 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // super 重置前：boss2 先启用 2FA
    const enr = await caller.enroll2fa({ token: "nt_2fa", password: "pw-123456" });
    await caller.confirm2fa({ token: "nt_2fa", password: "pw-123456", code: curCode(enr.secret) });
    await expect(caller.login({ identifier: "boss2", password: "pw-123456" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" }); // 生效中须码
    await expect(caller.reset2fa({ token: "nt_super", password: "pw-hq-999", accountId: 9 })).resolves.toEqual({ ok: true });
    await expect(caller.login({ identifier: "boss2", password: "pw-123456" })).resolves.toMatchObject({ username: "boss2" }); // 重置后免码
    await expect(caller.reset2fa({ token: "nt_super", password: "pw-hq-999", accountId: 9 })).rejects.toMatchObject({ code: "CONFLICT" }); // 已非生效态=显形不静默
  });

  it("BAD_REQUEST wire 形态钉（门禁 PR#9-r37-①）：超长 identifier 的 zod 败=message 为 JSON 阵列+首条 message 中文可读——客户端分流件依赖的跨层形态锁死", async () => {
    try {
      await caller.login({ identifier: "x".repeat(65), password: "y" });
      expect.unreachable();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      const issues = JSON.parse(msg) as Array<{ path?: unknown[]; message?: unknown }>; // JSON 阵列形态钉
      expect(Array.isArray(issues)).toBe(true);
      expect(typeof issues[0]?.message).toBe("string");
      expect(/[\u4e00-\u9fff]/.test(String(issues[0]?.message))).toBe(true); // 中文可读（中文钉的供给侧）
    }
  });

  it("reset2fa 对己启用 2FA 的 super 须过本人动态码（门禁 PR#9-r21-④——高权端点同口径钉）", async () => {
    seedAdmin();
    accounts.push({ id: 1, username: "hqsuper", phone: null, passwordHash: hashPassword("pw-hq-999"), displayName: "彭总", role: "super", disabled: 0, authToken: authTokenHash("nt_super"), createdAt: new Date(), lastLoginAt: null });
    const enrB = await caller.enroll2fa({ token: "nt_2fa", password: "pw-123456" }); // 目标账号先启用
    await caller.confirm2fa({ token: "nt_2fa", password: "pw-123456", code: curCode(enrB.secret) });
    const enrS = await caller.enroll2fa({ token: "nt_super", password: "pw-hq-999" }); // super 自己也启用
    await caller.confirm2fa({ token: "nt_super", password: "pw-hq-999", code: curCode(enrS.secret) });
    await expect(caller.reset2fa({ token: "nt_super", password: "pw-hq-999", accountId: 9 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" }); // 无码弹窗
    const nx = totpAt(enrS.secret, Math.floor(Date.now() / 1000 / 30) + 1); // +1 窗码（confirm 已消费当前窗）
    await expect(caller.reset2fa({ token: "nt_super", password: "pw-hq-999", accountId: 9, totpCode: nx })).resolves.toEqual({ ok: true });
  });

  it("enroll/confirm 密码复验：错密码即拒（门禁 PR#9-r9-⑦——泄露 token 不够绑密钥面钉死）", async () => {
    seedAdmin();
    await expect(caller.enroll2fa({ token: "nt_2fa", password: "pw-wrong-000" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const enr = await caller.enroll2fa({ token: "nt_2fa", password: "pw-123456" });
    await expect(caller.confirm2fa({ token: "nt_2fa", password: "pw-wrong-000", code: curCode(enr.secret) })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.confirm2fa({ token: "nt_2fa", password: "pw-123456", code: curCode(enr.secret) })).resolves.toEqual({ ok: true });
  });

  it("失败节流：连错 5 次→第 6 次 429 锁定；锁窗内正确码同拒（门禁 PR#9-④ 暴破面钉）", async () => {
    seedAdmin();
    const enr = await caller.enroll2fa({ token: "nt_2fa", password: "pw-123456" });
    await caller.confirm2fa({ token: "nt_2fa", password: "pw-123456", code: curCode(enr.secret) });
    // 恒错码生成：枚举候选直到不落 ±1 窗（排除偶中=钉不自伤）
    const win = new Set([-1, 0, 1].map((d) => totpAt(enr.secret, Math.floor(Date.now() / 1000 / 30) + d)));
    let wrong = "000000";
    for (let i = 0; win.has(wrong); i++) wrong = String(i + 1).padStart(6, "0");
    for (let i = 0; i < 5; i++) {
      await expect(caller.login({ identifier: "boss2", password: "pw-123456", totpCode: wrong })).rejects.toMatchObject({ code: "UNAUTHORIZED" }); // 前 5 败=LOGIN_FAIL 不泄码态
    }
    await expect(caller.login({ identifier: "boss2", password: "pw-123456", totpCode: wrong })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" }); // 第 6 次=锁
    // 锁窗内【新窗】正确码同拒（锁定优先于校验——门禁 PR#9-r27-③ 后：同窗码=已消费窗码走回放拒 401 语义，
    //  锁 visibility 钉须用下一窗码才真触锁闸）
    const freshCode = totpAt(enr.secret, Math.floor(Date.now() / 1000 / 30) + 1);
    await expect(caller.login({ identifier: "boss2", password: "pw-123456", totpCode: freshCode })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });

  it("已生效重登记 → CONFLICT（先停用再登记）；无登记停用 → CONFLICT", async () => {
    seedAdmin();
    const enr = await caller.enroll2fa({ token: "nt_2fa", password: "pw-123456" });
    await caller.confirm2fa({ token: "nt_2fa", password: "pw-123456", code: curCode(enr.secret) });
    await expect(caller.enroll2fa({ token: "nt_2fa", password: "pw-123456" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(caller.disable2fa({ token: "nt_2fa", password: "pw-123456", code: "000000" })).rejects.toMatchObject({ code: "UNAUTHORIZED" }); // 错码停用拒
  });
});
