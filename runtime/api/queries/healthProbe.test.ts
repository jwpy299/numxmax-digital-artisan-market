/**
 * healthProbe 直测（专用连接化后口径；R3 池信号面补齐）：
 * ① 建连+查询+池信号正常 → true，语句 hint 紧跟 SELECT（位置钉死），一次性连接结算即毁；
 * ② 建连即抛 → 吞错返 false（不假绿灯）；
 * ③ 查询挂死（永不结算）→ 换槽 destroy 毁底层 socket；
 * ③b 建连窗口期换槽 → 建连落地即毁、查询不发；
 * ④ 专用连接过但池信号红 → false（R3 票：池饿死不假绿）。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const queryMock = vi.fn();
const destroyMock = vi.fn();
const createConnectionMock = vi.fn();
const poolPingMock = vi.fn();

vi.mock("mysql2/promise", () => ({
  createConnection: (opts: unknown) => createConnectionMock(opts),
}));
vi.mock("./connection", () => ({
  getProbeConnectionUrl: () => "mysql://u:p@127.0.0.1:3306/d?connectTimeout=2000",
  poolAcquirePing: (...args: unknown[]) => poolPingMock(...args), // 全参转发（第三参 queryText 要可断言）
}));

import { dbProbeFlight, dbProbeTimed, __resetProbeOneShotForTest } from "./healthProbe"; // dbProbe 布尔面已摘除（R15 票②）

beforeEach(() => {
  __resetProbeOneShotForTest(); // 一次性面共享窗清零（用例间不串缓存）
  queryMock.mockReset();
  destroyMock.mockReset();
  createConnectionMock.mockReset();
  poolPingMock.mockReset();
  poolPingMock.mockResolvedValue(true); // 默认池健康
});

describe("dbProbe（专用一次性连接＋池信号面）", () => {
  it("① 全链健康 → true，hint 紧跟 SELECT，连接结算即毁，池信号同检", async () => {
    createConnectionMock.mockResolvedValue({ query: queryMock, destroy: destroyMock });
    queryMock.mockResolvedValue([[]]);
    expect(await dbProbeFlight().promise).toBe(true);
    expect(String(queryMock.mock.calls[0]?.[0])).toMatch(/SELECT\s+\/\*\+ MAX_EXECUTION_TIME\(1500\) \*\/\s+1/); // 位置钉死（critical：hint 必须紧跟 SELECT 之后）
    expect(createConnectionMock).toHaveBeenCalledTimes(1);
    expect(poolPingMock).toHaveBeenCalledTimes(1); // 池信号同检（R3 票：专用连接对了池也要对）
    expect(destroyMock).toHaveBeenCalledTimes(1); // 一次性连接：结算即毁
  });

  it("② 建连即抛 → 吞错返 false（不假绿灯）", async () => {
    createConnectionMock.mockRejectedValue(new Error("connection refused"));
    expect(await dbProbeFlight().promise).toBe(false);
  });

  it("③ 查询挂死 → 换槽 destroy 毁底层 socket（不占共享池的收尾保证）", async () => {
    createConnectionMock.mockResolvedValue({ query: queryMock, destroy: destroyMock });
    queryMock.mockReturnValue(new Promise(() => { /* 永不结算：模拟应答挂死 */ }));
    const flight = dbProbeFlight();
    await new Promise((r) => setTimeout(r, 0)); // 让建连微任务落地（conn 就位）
    flight.destroy(); // 换槽收尾
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  it("③b 建连窗口期换槽 → 建连落地即毁、查询不发（destroy 不静默无效）", async () => {
    let resolveConn: (v: unknown) => void = () => {};
    createConnectionMock.mockReturnValue(new Promise((r) => { resolveConn = r; }));
    const flight = dbProbeFlight();
    flight.destroy(); // 建连还在 pending（conn=null）——cancelled 标志置位
    resolveConn({ query: queryMock, destroy: destroyMock }); // 建连落地
    expect(await flight.promise).toBe(false);
    expect(queryMock).not.toHaveBeenCalled(); // 已换槽：查询不发
    expect(destroyMock).toHaveBeenCalledTimes(1); // 落地即毁
  });

  it("④ 专用连接过但池信号红 → false（R3 票：池饿死不假绿）", async () => {
    createConnectionMock.mockResolvedValue({ query: queryMock, destroy: destroyMock });
    queryMock.mockResolvedValue([[]]);
    poolPingMock.mockResolvedValue(false); // 池饿死
    expect(await dbProbeFlight().promise).toBe(false);
  });

  it("⑤ 一次性面超时兜底：池信号挂起 → 3s 后 ok:false（R15 票④；R16 票② 后一次性面=纯池信号，不开专用连接）", { timeout: 10_000 }, async () => {
    poolPingMock.mockReturnValue(new Promise(() => { /* 永不结算：池信号挂死 */ }));
    const r = await dbProbeTimed(); // 一次性面（在飞共享面在 beforeEach 清零）
    expect(r.ok).toBe(false);
    expect(r.latencyMs).toBe(3000); // 超时即跑满预算，latencyMs=预算值如实
    expect(createConnectionMock).not.toHaveBeenCalled(); // 一次性面不开专用连接（R16 票②）
  });

  it("⑥ 在飞共享：并发两调只跑一支池信号（扇出封止）", async () => {
    const [r1, r2] = await Promise.all([dbProbeTimed(), dbProbeTimed()]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(poolPingMock).toHaveBeenCalledTimes(1); // 并发同答，扇出=1
    expect(poolPingMock.mock.calls[0]?.[2]).toBe("select1"); // 池腿真查询模式（R17 票④＋R20 票②直钉：模块自有枚举常量）
    expect(createConnectionMock).not.toHaveBeenCalled(); // 一次性面不开专用连接
  });
});

/** R9 票②：脱敏链纯函数直钉——IPv6 全形态/zone id/压缩形态全拦，时间值不误抹，截断在后不逃 regex */
import { redactConnTarget } from "../lib/redact"; // R10 票①：脱敏链已迁共享单点

describe("redactConnTarget 脱敏链", () => {
  it("IPv6 全形态全拦（含 zone id 与压缩）", () => {
    for (const a of ["::1", "fe80::1", "2001:db8::1", "::1:3306", "fe80::1%eth0",
                     "2001:0db8:85a3:0000:0000:8a2e:0370:7334", "2001:0:0:0:0:0:0:1", "[fe80::1%eth0]:3306"]) {
      expect(redactConnTarget(`connect ECONNREFUSED ${a}`)).toBe("connect ECONNREFUSED ***");
    }
  });
  it("zone id 不残留接口标识", () => {
    expect(redactConnTarget("x fe80::1%eth0 y")).not.toContain("eth0");
  });
  it("时间值与 word:word:word 不误抹", () => {
    expect(redactConnTarget("at 10:20:30 failed")).toContain("10:20:30");
    expect(redactConnTarget("word:word:word")).toContain("word:word:word");
  });
  it("IPv4/主机名/控制字符/截断顺序", () => {
    expect(redactConnTarget("refused 10.0.0.1:3306")).toBe("refused ***");
    expect(redactConnTarget("getaddrinfo ENOTFOUND db.internal")).toBe("getaddrinfo ENOTFOUND ***");
    expect(redactConnTarget("a\n\tb".length ? "a\u0007b" : "")).not.toContain("\u0007");
    expect(redactConnTarget("x".repeat(300))).toHaveLength(120);
  });
  it("R11 新增形态：裸主机名/下划线标签/C1 与 Unicode 分隔符", () => {
    expect(redactConnTarget("getaddrinfo ENOTFOUND dbserver")).toBe("getaddrinfo ENOTFOUND ***"); // 裸主机名（错误码锚定支）
    expect(redactConnTarget("connect ECONNREFUSED mysql-prod")).toBe("connect ECONNREFUSED ***");
    expect(redactConnTarget("x db_server.internal y")).toBe("x *** y"); // 下划线标签
    expect(redactConnTarget("a\u0085b")).not.toContain("\u0085"); // NEL
    expect(redactConnTarget("a\u2028b")).not.toContain("\u2028"); // U+2028
    expect(redactConnTarget("x".repeat(5000)).length).toBeLessThanOrEqual(120); // 超长输入链首有界
  });
  it("R13 新增形态：账号报文 host 抹除/方括号无冒号不误抹", () => {
    expect(redactConnTarget("Access denied for user 'root'@'localhost'")).toBe("Access denied for user 'root'@'***'");
    expect(redactConnTarget("[ERROR] something")).toBe("[ERROR] something"); // 方括号无冒号不误抹
  });
});
