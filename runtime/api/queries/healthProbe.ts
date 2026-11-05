/**
 * healthProbe —— DB 自检单点（门禁打磨终版）：
 * /api/healthz（boot.ts 经 healthzMachine）消费 dbProbeTimedFlight；admin.systemHealth/terminal.cockpit/terminalMeetings 消费 dbProbeTimed 一次性面（吞错返 boolean 不假绿灯）。
 * （dbProbe 布尔面自 R15 票② 摘除——本仓无生产消费者；wb 仓同。）
 * 架构（portal#30 票①）：探测走【专用一次性连接】，永不占用应用共享池——挂死探测不再漏 pool slot；
 *  换槽方 destroy() 毁底层 socket，FD 不积。
 * 健康语义（portal#40 R3 同构）：ok = 专用连接真查询通过【且】共享池有界 acquire+ping 通过——
 *  池饿死/挂死时端点必须红（不假绿）；专用连接对了池也要对。
 * 结算保证三层：
 *  ① 语句执行挂死：MAX_EXECUTION_TIME(1500) 服务端 1.5s 杀查询（3024）；
 *  ② 连接建立挂死：connectTimeout(1000) 客户端兜底（票⑥：建连界与语句界不共常量；取值推导见常量注释——临界 2.5s 全罩 HTTP 3s 预算内）；
 *  ③ 已建连但应答挂死：调用方（healthzMachine.ts——R26 票⑥：常量和换槽逻辑已迁机器层，boot.ts 只做 JSON 装配）HEALTHZ_PROBE_MAX_AGE_MS 到期换槽＋destroy（代码级上界）。
 * 失败留痕：console.error 60s 手卷节流 + message 级脱敏链（连接目标 IPv4/IPv6 全形态/主机名不回显）；
 *  换槽取消不留痕（取消≠故障）。
 */
import { createConnection, type Connection } from "mysql2/promise";
import { getProbeConnectionUrl, poolAcquirePing, redactErrMsg } from "./connection"; // redactErrMsg：message 提取+脱敏单点（R25 票③）
import { POOL_PING_TIMEOUT_MS as PROBE_POOL_PING_TIMEOUT_MS } from "./probeBudget"; // 池信号预算**单一来源**（portal#45 的 :132）

/** 探测语句级上限 1.5s（独立探测界：withDbTimeout.DB_EXEC_HINT 是面板区界——语义不同非同义双写；本仓探测界常量自持。
 *  取值推导（R6 票⑥：临界全罩 HTTP 3s 预算内）：SELECT 1 正常毫秒级，1.5s 纯兜底；
 *  临界=max(建连 1s+查询 1.5s, 池信号 1.5s)=2.5s<3s——「慢而活」区间结构性消失） */
const PROBE_MAX_EXECUTION_TIME_MS = 1_500;
/** 探测建连级上限（默认 1s——本地回环建连毫秒级，纯兜底；env PROBE_CONNECT_TIMEOUT_MS 可调，R16 票①：
 *  DATABASE_URL 指向远端/托管库时 RTT+握手可破 1s（探测无池重试，误红会烦运维）——运维面接管；
 *  调大须守预算约束：connectTimeout+1500ms 语句界 < 3000ms HTTP 预算，否则「慢而活假 503」区间回归）。 */
const PROBE_CONNECT_TIMEOUT_MS = (() => {
  const raw = Number(process.env.PROBE_CONNECT_TIMEOUT_MS);
  if (!(Number.isInteger(raw) && raw > 0)) return 1_000;
  // clamp 1400ms（R21 票③：预算不变量 connect+1500ms 语句界 < 3000ms HTTP 预算是结构性——prose 不够，clamp 守住；
  //  运维调大需求（远端库 RTT）在 1400ms 内已覆盖）
  return Math.min(raw, 1_400);
})();
// 池信号有界上界 1.5s 的值**只在本文件内部使用**（别名导入，见上）—— 不再对外再导出：
// 门禁 portal#45 R4 的 :39 实测"全仓没有任何模块 import 它" ⇒ 再导出只是**多余导出面**
//（R3 那条说写法偏离纪律，我按纪律改了写法；R4 进一步指出这条导出本身没有消费者 —— 那就直接去掉）。
// 跨模块要用的常量已在 `./probeBudget` 上，那才是单一入口。

/** 探测临界路径（建连+语句串行，池信号并行）：healthzMachine 的 HTTP 预算判定用。
 *  ⚠️ 语义精确化（wb#49 ⑤）：原来是 `connect + statement`（把**并行腿**漏了），改成 `max(串行腿, 并行腿)`。
 *  **当前取值不变**（max(串行, 1500) = 串行），但它才是"临界路径"的定义 —— 将来池信号若调到超过串行腿，
 *  预算判定才会跟着动（旧式会一直报串行腿，把真实临界藏起来）。 */
export const PROBE_CRITICAL_PATH_MS = Math.max(
  PROBE_CONNECT_TIMEOUT_MS + PROBE_MAX_EXECUTION_TIME_MS,
  PROBE_POOL_PING_TIMEOUT_MS,
);
const PROBE_HINT_TEXT = `/*+ MAX_EXECUTION_TIME(${PROBE_MAX_EXECUTION_TIME_MS}) */`;

/** 分键节流（R5 票③：专用连接面与池信号面各自 60s 一窗——共用单键会让一面失败吞掉另一面 60s 的信息量） */
const probeErrLastAt = new Map<string, number>();

/** 失败留痕单点（分键 60s 节流；脱敏链走 redactConnTarget 单点）；
 *  全包 try（R13 票⑧ 同构：留痕是 fail-closed 边界——畸形错误对象的 message getter/toString 抛错不得顶掉「吞错返 false」契约） */
function logProbeError(prefix: string, e: unknown): void {
  try {
    const last = probeErrLastAt.get(prefix) ?? 0;
    if (Date.now() - last <= 60_000) return;
    probeErrLastAt.set(prefix, Date.now());
    console.error(prefix, redactErrMsg(e)); // message 提取+脱敏单点（R25 票③：redactErrMsg 同引——裸对象形态不丢 message）
  } catch { /* 留痕不炸探测契约 */ }
}

/** 探测飞行体：结果 promise + destroy 收尾柄（换槽毁 socket 的结构性保证） */
export interface DbProbeFlight {
  promise: Promise<boolean>;
  /** 换槽收尾（异常路径）：promise 永不结算也得毁底层 socket——best-effort，毁不动不炸调用方 */
  destroy: () => void;
}

/** 启航一支探测：专用一次性连接（不占共享池），结算即自毁（正常路径与换槽 destroy 幂等兼容） */
export function dbProbeFlight(): DbProbeFlight {
  let conn: Connection | null = null;
  let cancelled = false; // 换槽标志（票③）：建连窗口期 destroy 不得静默无效
  let tornDown = false; // destroy 幂等旗（wb R10 票④ 同构：换槽柄与 finally 双路径收口一处，不赌驱动 destroy 幂等）
  const teardown = (): void => { if (tornDown || conn === null) return; tornDown = true; try { conn.destroy(); } catch { /* best-effort */ } }; // conn 未就位不置旗（建连落地后 finally 仍须毁）
  // 池信号并行起跑（R4 同构＋R6 票⑥：三段常量建连 1s/查询 1.5s/池信号 1.5s 并行，临界=max(2.5s,1.5s)=2.5s 全罩 HTTP 3s 预算内；
  //  声明在 try 外（R9 票②：catch 路径也要 await 它，不孤儿）。池信号失败独立留痕）
  const poolPing = poolAcquirePing(PROBE_POOL_PING_TIMEOUT_MS, (e2) => logProbeError("[dbProbe] 池信号失败:", e2));
  const promise = (async (): Promise<boolean> => {
    try {
      conn = await createConnection(getProbeConnectionUrl(PROBE_CONNECT_TIMEOUT_MS));
      // 早退路径一律先 await poolPing（R9 票② 同构：池信号不孤儿——其池连接占用/记档/留痕副作用须随探测同结算；有界 1.5s 不破预算）
      if (cancelled) { await poolPing; return false; } // 建连落地前已被换槽：连接即毁（finally），查询不发
      await conn.query(`SELECT ${PROBE_HINT_TEXT} 1`); // hint 必须紧跟 SELECT 之后（票① critical）
      if (cancelled) { await poolPing; return false; } // 查询期间被换槽：池信号同收，不留痕
      const poolOk = await poolPing;
      return cancelled ? false : poolOk; // 终检（票⑤：ping 窗被换槽不得报成功——cancelled⇒false 契约显式化）
    } catch (e) {
      await poolPing; // 建连/查询抛路径同收池信号（不孤儿）
      if (cancelled) return false; // 换槽取消非真失败：不落误报留痕
      logProbeError("[dbProbe] DB 自检失败:", e);
      return false;
    } finally {
      teardown(); // 一次性连接：结算即毁（幂等旗单点——「吞错返 false」契约不破）
    }
  })();
  return {
    promise,
    destroy: () => { cancelled = true; teardown(); }, // 先置标志（建连窗 conn 未就位，标志兜底）再毁 socket（幂等单点）
  };
}

/** 探测总兜底 3s（connect 1s + query 1.5s + 0.5s 余量；poolPing 并行不另计）——
 *  一次性面无换槽方（R4 票⑥）：三层全挂死时由本兜底 destroy 收 socket，「FD 不积」对一次性面同样成立 */
const PROBE_ONE_SHOT_TIMEOUT_MS = 3_000;
/** 一次性面并发扇出封止（R5 票⑥）：在飞共享——并发同答不占新连接；
 *  结算后【不缓存】（R15 票③：成功缓存 2s 会在故障伊始回放旧绿=假绿窗，健康面宁缺勿假） */
let oneShotInflight: Promise<DbProbeResult> | null = null;

/** 一次性共享探测（含 3s 总兜底）：在飞共享（并发同答不占新探测），结算即清不缓存。
 *  信号面=纯池信号（R16 票② performance：一次性面消费者 admin.systemHealth/cockpit/meetings 的语义是
 *  「应用 DB 查询路径通不通」=池健康——池信号自带单飞闸/超时放闸/病连接拔池，挂死不漏；
 *  专用连接面是 healthzMachine 换槽结构的专属需求，一次性面不再每次开两支连接）。 */
function dbProbeShared(): Promise<DbProbeResult> {
  if (oneShotInflight) return oneShotInflight;
  let timer: ReturnType<typeof setTimeout> | undefined;
  oneShotInflight = Promise.race([
    timed(poolAcquirePing(PROBE_POOL_PING_TIMEOUT_MS, (e) => logProbeError("[dbProbe] 池信号失败:", e), "select1")), // 池腿跑真 SELECT 1（R17 票④ 语义；R20 票②：模块自有枚举常量——注入面封死）
    // （R23 票⑥：此处尾 catch 摘除——poolAcquirePing 全路径 fulfill（硬闸 resolve false/race 全 boolean/onError 内包 try），不可达防御统一口径）
    new Promise<{ ok: boolean; latencyMs: number }>((res) => {
      // 超时分支 latencyMs=预算值（超时即跑满预算——如实语义；与 timed() 的成功路径基线不双写不漂移）
      timer = setTimeout(() => res({ ok: false, latencyMs: PROBE_ONE_SHOT_TIMEOUT_MS }), PROBE_ONE_SHOT_TIMEOUT_MS);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    oneShotInflight = null; // 结算即清（不缓存——故障/恢复即刻可见）
  });
  return oneShotInflight;
}

/** 测试钩（与 __resetDutyRefreshThrottleForTest（api/routers/snapshots.ts）同仓惯例）：一次性面共享窗状态清零——产线不得调用 */
export function __resetProbeOneShotForTest(): void {
  oneShotInflight = null; // 在飞共享面清零（结算缓存已退役——R15 票③）
  // ⚠️ **节流台账也要清**（wb#49 ⑥）：`probeErrLastAt` 是模块级、按分键记 60s 窗口。
  //   不清的话，前一个用例写过一笔留痕 ⇒ 后一个用例在 60s 窗内的同键留痕**被静默吞掉**，
  //   "本用例应有 N 条留痕"这类断言就会随用例顺序漂移（串状态 = 测试面假绿/假红）。
  probeErrLastAt.clear();
}

/** 计时微函数单点（R4 票④：两面计时同一处——一次性面走 dbProbeShared（含 3s 总兜底），flight 面不兜底（换槽方负责），语义各归其位不漂移） */
async function timed(p: Promise<boolean>): Promise<DbProbeResult> {
  const started = Date.now();
  const ok = await p;
  return { ok, latencyMs: Date.now() - started };
}

/** dbProbe 计时包装（R24 票② 收口单点）：一次性面——直接走 dbProbeShared，含 3s 总兜底 */
export function dbProbeTimed(): Promise<DbProbeResult> { // R23 票⑦：单点类型不双写
  return dbProbeShared();
}

/** 探测结果类型单点（R18 票④ 同构：healthzMachine.HealthzProbe 同形双写收口——机器层改引本型不漂移） */
export type DbProbeResult = { ok: boolean; latencyMs: number };

/** 计时飞行体（boot.ts /api/healthz 专用：换槽场景需要 destroy 柄） */
export interface DbProbeTimedFlight {
  promise: Promise<DbProbeResult>;
  destroy: () => void;
}

export function dbProbeTimedFlight(): DbProbeTimedFlight {
  const f = dbProbeFlight();
  return { promise: timed(f.promise), destroy: f.destroy }; // flight 面不兜底：兜底是换槽方的职责（boot.ts）
}
