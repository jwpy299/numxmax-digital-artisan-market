import { drizzle } from "drizzle-orm/mysql2";
import { createPool, type Pool, type PoolConnection, type Connection } from "mysql2/promise";
import { env } from "../lib/env";
import { redactConnTarget } from "../lib/redact"; // 脱敏链共享单点（R10 票①：池 error 报文不裸打）
import { POOL_PING_TIMEOUT_MS, POOL_PING_TIMEOUT_MAX_MS } from "./probeBudget"; // 池信号预算与其上界**单一来源**（portal#45 的 :132 / R5 的 :157-159）
import * as schema from "@db/schema";
import * as relations from "@db/relations";

const fullSchema = { ...schema, ...relations };

/** 池显式单例（portal#40 R3 票：健康探测要摸池——drizzle(url) 内部建池拿不到池柄；
 *  行为与 drizzle(url) 等价：驱动内部本就以同一 URL createPool，schema/mode 选项原样） */
let pool: Pool | undefined;
let instance: ReturnType<typeof createDb> | undefined;

function getPool(): Pool {
  if (!pool) {
    pool = createPool(env.databaseUrl);
    // 池 error 事件托管（R9 票⑤：进程级单例池的 idle/连接 error 不得成 unhandled 事件炸进程）。
    //  防御式访问（R10 票②：.pool 是驱动未公开形态——升级变脸降级为 warn 不炸）；报文走 redactConnTarget 脱敏（R10 票① security：驱动错误原文带 host:port）。
    const corePool = (pool as unknown as { pool?: { on?: (ev: string, cb: (e: unknown) => void) => void } }).pool;
        // 实证钉死（mysql2 ^3.14 源码：lib/promise/pool.js inheritEvents 只转发 acquire/connection/enqueue/release——
    //  error 不在列，promise Pool 的 self 面挂 error 是空挂！R26 票① high）：必须挂核心池 .pool.on；
    //  防御式访问（变脸降级 warn 不炸）；报文走脱敏单点。
    const sink = redactPoolErr; // 脱敏单点直绑（模块级函数引用已稳定）
    if (corePool?.on) corePool.on("error", sink);
    else console.warn("[pool] mysql2 promise Pool 未暴露核心池（驱动升级变脸？）——error 托管缺位，idle 连接错误将走 unhandled");
  }
  return pool;
}

function dbConfig() {
  return { mode: "planetscale" as const, schema: fullSchema };
}

/** 类型由工厂推断（pool/单连接重载分形——同一 mode/schema 单源，调用方不再复制配置或伪造事务型）。 */
function createDb() {
  return drizzle(getPool(), dbConfig());
}

/** 命名锁等必须保持同一物理连接的场景：Drizzle 收到 Connection 时 transaction 复用该 session，不再向池另取连接。 */
export function createDbFromConnection(conn: Connection) {
  // mysql2 独立连接自带 connection 属性；直接 drizzle(conn) 会被误判为配置对象并新建池。
  // 显式 client 保持命名锁同一物理连接，禁止默认配置创建新池。
  const db = drizzle({ ...dbConfig(), client: conn });
  // 驱动配置判定若再次漂移，必须在事务前 fail-loud，绝不允许命名锁与事务分到不同物理连接。
  if (db.$client !== conn) throw new Error("db_conn_not_reused"); // 稳定错误码入报文；内部诊断细节不回传客户端
  return db;
}

export function getDb() {
  if (!instance) instance = createDb();
  return instance;
}



/** error-like 字段读取（R22 票③：rawRows 面支持 {code,message} 裸对象形态——不赌 instanceof，结构化读） */
const readErrField = (e: unknown, k: string): unknown =>
  e !== null && typeof e === "object" ? (e as Record<string, unknown>)[k] : undefined;

/** 报文规范化单点（R18 票⑥：池 error 面与 onError 面同引，不双写） */
export const redactErrMsg = (e: unknown): string => { // 导出（R25 票③ portal：healthProbe 留痕面同引，message 提取不双写）
  if (e instanceof Error) return redactConnTarget(e.message);
  const m = readErrField(e, "message"); // error-like 裸对象读真 message（R22 票③：不止 "[object Object]"）
  return redactConnTarget(typeof m === "string" ? m : String(e));
};

/** 脱敏包装单点（R18 票②⑤：message 脱敏 + code/errno/sqlState/stack 保留 + cause 链【逐层脱敏】随身——
 *  rawRows 式递归读最深 cause message 的面：cause 逐层递归脱敏，穿透面封死；递归深度上限 4 层防病态链）。
 *  边界写实（R22 票②）：本件抹【连接目标】；不承接查询层 SQL/params——探测面查询是模块自有常量 SELECT 1，
 *  查询层报文脱敏归 rawRows.sanitizeQueryError 的 sink 纪律） */
export function wrapRedacted(err: unknown, depth = 0): Error {
  if (!(err instanceof Error) || depth >= 4) {
    const w = new Error(redactErrMsg(err));
    // 终止层同保留结构化字段（R21 票④＋R22 票③：裸对象形态也保码——readErrField 不赌 instanceof）
    for (const k of ["code", "errno", "sqlState"] as const) {
      const v = readErrField(err, k);
      if (typeof v === "string" || typeof v === "number") (w as unknown as Record<string, unknown>)[k] = v;
    }
    return w;
  }
  const w = new Error(redactErrMsg(err), err.cause !== undefined ? { cause: wrapRedacted(err.cause, depth + 1) } : undefined);
  if (typeof err.stack === "string") {
    // stack 重建（R20 票①+R21 票③+R24 票② security）：只保留栈帧行（/^\s+at\s/）——
    //  不假定 header=「name: message」行数（驱动自定义 stack/非 V8 运行时形态不等价），帧模式过滤不穿透。
    const frames = err.stack.split("\n").filter((l) => /^\s+at\s/.test(l));
    w.stack = `${w.name}: ${w.message}\n` + frames.join("\n");
  }
  for (const k of ["code", "errno", "sqlState"] as const) { // sqlState 同保留（非敏感分类字段；readErrField 兼容裸对象）
    const v = readErrField(err, k);
    if (typeof v === "string" || typeof v === "number") (w as unknown as Record<string, unknown>)[k] = v;
  }
  return w;
}

/** 池 error 事件出口（挂载处单引） */
function redactPoolErr(e: unknown): void {
  try { console.error("[pool] connection error:", wrapRedacted(e).message); } catch { /* 不炸 */ }
}

/** 池信号面状态（R9 五态自洽终版——四轮拉锯收敛）：
 *  ① 单飞 join：有未 settle flow 时撞窗探测 join 同答（不新开 acquire，正常并发不假红）；
 *  ② 逻辑闸 timeout 放闸：超时即 outstanding=false（恢复重试不赌驱动 settle）；
 *  ③ 超时记档（poolPingStuckLog）：timeout 即记档（不论 acquire/ping 阶段——ping 挂死也占面，R9 票④）；
 *     settle 即对称销账（stuckAt 凭据）；记档 60s 自然衰减（R9 票③：永不 settle 的记档不堵死恢复可见性——
 *     黑洞期新 waiter/连接消耗封顶 2 支/60s，物理面有界）；
 *  ④ 物理硬闸：未衰减记档 ≥2 拒新增（黑洞期累积真封死）；
 *  ⑤ 同一性守卫：老 flow 的 finally 不误清新槽。 */
let poolPingOutstanding = false;
let currentFlow: Promise<boolean> | null = null;
let currentFlowMode: "ping" | "select1" = "ping"; // 在飞探测模式（R23 票① 同构：join 只同级——select1 搭 ping 车=假绿）
let poolPingTicket: object | null = null; // 在飞槽凭据（同一性守卫）
const poolPingStuckLog: number[] = []; // 超时记档时刻（stuckAt 凭据兼作销账键）
const POOL_PING_MAX_STUCK = 2;
const POOL_PING_STUCK_DECAY_MS = 60_000;

function stuckAliveCount(): number {
  const cutoff = Date.now() - POOL_PING_STUCK_DECAY_MS;
  while (poolPingStuckLog.length > 0 && poolPingStuckLog[0] < cutoff) poolPingStuckLog.shift();
  return poolPingStuckLog.length;
}

/** 销账单点（票⑦：try/catch 双分支不双写） */
function settleStuck(stuckAt: number): void {
  if (stuckAt <= 0) return;
  const idx = poolPingStuckLog.indexOf(stuckAt);
  if (idx >= 0) poolPingStuckLog.splice(idx, 1);
}

/** 连接收口单点（票⑦：成功才 release 回池；超时/失败/迟到一律 destroy 拔池——病连接不发给业务） */
function closeConn(conn: PoolConnection | null, releaseOk: boolean): void {
  try {
    if (conn === null) return;
    if (releaseOk) conn.release();
    else conn.destroy();
  } catch { /* best-effort */ }
}

/** 池有界信号（不假绿面）：池饿死/挂死时健康探测必须红。
 *  单飞 join／timeout 放闸／超时记档＋60s 衰减／物理硬闸／同一性守卫——五态语义见上方块注释；
 *  timeout 自毁引发的 reject 不误留痕（自伤≠故障）；失败/超时经 onError 留痕（黑洞期转红有日志）。 */
export function poolAcquirePing(
  timeoutMs: number,
  onErrorRaw?: (e: unknown) => void,
  /** 探测模式（R20 票②：任意 SQL 面收口为模块自有枚举——"select1"=池上跑模块自有常量 SELECT 1（验查询路径）；
   *  调用方无法传入运行期串，注入面结构封死。join 者同答 owner 的模式——探测语义同级，不另计。） */
  mode?: "ping" | "select1",
): Promise<boolean> {
  // onError 前置脱敏（R17 票②：单源脱敏不变性结构化——本模块拥有池面，调用方拿到手的必是已脱敏 error，未来消费方裸打也不泄）
  const onError = (e: unknown): void => {
    try { onErrorRaw?.(wrapRedacted(e)); } catch { /* 留痕回调不炸探测（内部全包——调用点不再套冗余 try） */ }
  };
  if (stuckAliveCount() >= POOL_PING_MAX_STUCK) {
    onError(new Error("pool ping rejected: stuck probes saturated"));
    return Promise.resolve(false); // 物理硬闸（未衰减超时记档淤积=池已堵，不添新）
  }
  // 入参守卫（wb#49 ①）：`NaN` ⇒ `deadline = Date.now() + NaN = NaN` ⇒ `now > deadline` **恒 false**
  // ⇒ **超时永不触发**（健康面最坏情况挂住）；`0`/负数 ⇒ 立即超时。两者都是"越界入参静默改变语义"。
  // 处置：**回落到有界默认值**（探测面不该因一个坏入参变假红），并经 `onError` 留痕。
  // ⚠️ **上界也要夹**（门禁 portal R4 同族，wb#53 R4 的 :158 先指出）：`1e12` 这种"巨大但有穷"的值会原样
  // 通过，而 Node 的 `setTimeout` 对 > 2^31-1ms 的延迟**回绕成 1ms** ⇒ 立刻超时（与"NaN 永不超时"正相反）。
  // 上界与兜底值**同放 `./probeBudget`**（门禁 portal#45 R5 的 :157-159：函数内联的魔法数与"单一来源"自相矛盾；
  // 且 120s 是个没根据的数，已按"探测语义上远超 HTTP 预算、又远离 2^31-1 溢出区"的理由定为 60s）。
  // ⚠️ **兜底路径也要夹**（门禁 wb#53 R6 的 :163-164，同构面）：既然这个常量叫"**绝对**上界"，就不能只在
  //    "有限且为正"那条路上生效 —— 若谁把 `POOL_PING_TIMEOUT_MS` 调到上界之上，兜底反而会**突破自己声明的上界**。
  let budgetMs = POOL_PING_TIMEOUT_MS;
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) budgetMs = Math.min(timeoutMs, POOL_PING_TIMEOUT_MAX_MS);
  if (budgetMs !== timeoutMs) {
    onError(new Error(`pool ping 入参非法或越界：timeoutMs=${String(timeoutMs)}，已归一到 ${budgetMs}ms（上界 ${POOL_PING_TIMEOUT_MAX_MS}ms / 兜底 ${POOL_PING_TIMEOUT_MS}ms）`));
  }
  const probeMode = mode ?? "ping";
  const deadline = Date.now() + budgetMs; // 总预算钉死（R25 票①：跨模式递归不重置预算——join 等待+自开补验共享同一 deadline）
  if (poolPingOutstanding && currentFlow) {
    // join 在飞同答（撞窗不假红；join 者自有超时——只放等待，不动共享连接的 destroy 权）
    const joinWait = (): Promise<boolean> => {
      let joinTimer: ReturnType<typeof setTimeout> | undefined;
      return Promise.race([
        currentFlow!,
        new Promise<boolean>((res) => {
          joinTimer = setTimeout(() => {
            onError(new Error(`pool ping join timeout ${budgetMs}ms`)); // join 超时同留痕（R22 票⑦：契约不跳票；下游分键节流兜底）
            res(false);
          }, budgetMs);
        }),
      ]).finally(() => { if (joinTimer !== undefined) clearTimeout(joinTimer); });
    };
    if (currentFlowMode === probeMode) return joinWait(); // 同级 join 同答
    // 跨模式不搭车（R23 票①：select1 是查询路径保证，搭 ping 车=假绿）——等 owner 落地（自有超时有界）后闸已开，自开一支
    return joinWait().then((ownerOk) => {
      if (!ownerOk) return false; // owner 红/超时——本探测同红（不另开放大）
      const remain = deadline - Date.now();
      if (remain <= 0) return false; // 预算耗尽不再补验（总耗不破 timeoutMs）
      return poolAcquirePing(remain, onErrorRaw, probeMode); // 传**归一化后的 probeMode**（wb#49 ②：原来传裸 mode —— 当前行为等价但默认值一改就分叉）
    });
    // （R17 票③：join 尾 catch 不可达——flow 全路径 fulfill；两面统一摘除）
  }
  const ticket = {}; // 槽内同一性凭据（先声明再上闸——同步 settle 竞态下 finally 可对号）
  poolPingOutstanding = true;
  currentFlowMode = probeMode; // 模式随身（join 同级判定凭据）
  poolPingTicket = ticket;
  let conn: PoolConnection | null = null;
  let timedOut = false; // 超时已触发：迟到连接只 destroy 不 ping；ping 迟到的绿也不发（票⑧）
  let pingOk = false; // ping 成败分流凭据：成功才许 release 回池
  let stuckAt = 0; // 超时记档时刻凭据（0=未记档；settle 对称销账）
  let tornDown = false; // destroy 幂等旗（R10 票③：timeout 与 finally 双路径收口一处，不赌驱动幂等）
  const teardown = (): void => { if (tornDown || conn === null) return; tornDown = true; closeConn(conn, false); }; // conn 未就位不置旗（R11 critical：提前置旗会让 finally 漏毁迟到连接——病连接回池）
  const flow = (async (): Promise<boolean> => {
    try {
      conn = await getPool().getConnection();
      if (timedOut) return false; // 迟到连接由 finally 的 destroy 拔池（探测已判死）
      // select1 模式跑模块自有常量真查询（portal R17 票④：一次性面语义=「应用查询路径通不通」——ping 绿不代表 SELECT 通；
      //  healthzMachine 面保持轻量 ping——专用连接腿已验查询路径）
      if (probeMode === "select1") await conn.query("SELECT 1"); // 用**归一化后**的 probeMode 分派（wb#49 ②：原来这里仍按裸 mode —— 归一化只做了递归那一半）
      else await conn.ping();
      if (timedOut) return false; // ping/query 落地前已超时（票⑧）：迟到的绿不发给 joiner——同窗探测结论不打架
      pingOk = true;
      return true;
    } catch (e) {
      if (!timedOut) { onError(e); }
      return false;
    } finally {
      settleStuck(stuckAt); // 对称销账（单点）
      if (poolPingTicket === ticket) { poolPingOutstanding = false; currentFlow = null; poolPingTicket = null; } // 同一性守卫（本槽才许清）
      if (pingOk && !timedOut) closeConn(conn, true); else teardown(); // 成功 release；其余走幂等 teardown（不双 destroy）
    }
  })();
  currentFlow = flow;
  // （R22 票⑥：R11 票③ 的「同步 settle 竞态」前提经再审系误判——async IIFE 的 catch/finally 恒在微任务执行，
  //   必晚于本同步段，守卫恒 false；摘除登记，poolPingTicket 同一性守卫保留在 finally 作换槽面）
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    flow,
    new Promise<boolean>((res) => {
      timer = setTimeout(() => {
        timedOut = true;
        stuckAt = Date.now(); poolPingStuckLog.push(stuckAt); // 超时即记档（不论阶段——ping 挂死同占面）
        poolPingOutstanding = false; // 逻辑闸放闸：下一支探测可进来重试（恢复可见性不赌驱动 settle）
        // currentFlow 不清：在飞 flow 终将 settle（或挂死由记档衰减兜底），join 面仍有效
        teardown(); // 已拿到的连接：半死拔池（幂等旗单点——不赌驱动 destroy 幂等，R10 票③）
        onError(new Error(`pool acquire/ping timeout ${budgetMs}ms`));
        res(false);
      }, budgetMs);
    }),
  ]).finally(() => { if (timer !== undefined) clearTimeout(timer); })
  // （R11 票④：R10 加的 race 尾部 catch 经审不可达——flow 全路径 fulfill（try/catch 全覆盖+finally 全守卫），摘除登记；
  //   「同步炸」面已由 ticket 守卫与 getPool try 段结构性承载）
}

let stripWarnedOnce = false; // 剥除留痕一次性闸

/** 测试钩（同仓 __resetDutyRefreshThrottleForTest 惯例）：池信号面状态清零——产线不得调用 */
export function __resetPoolPingForTest(): void {
  poolPingOutstanding = false;
  currentFlow = null;
  poolPingStuckLog.length = 0;
  poolPingTicket = null; // 同一性凭据同清（R13 票⑦：不清则上案迟到 flow 可对号串台）
  currentFlowMode = "ping"; // 在飞模式同清（R26 票③：与槽状态一致，杜绝跨用例残留）
  stripWarnedOnce = false; // 同键剥除留痕闸一并清（票⑥：一次性 warn 不跨用例串）
}

export function getProbeConnectionUrl(connectTimeoutMs: number): string {
  // 入参守卫（R22 票⑤：与 maxExecutionTimeHintText 同纪律——NaN/0/负/浮点会让 URL 静默畸形）
  if (!Number.isInteger(connectTimeoutMs) || connectTimeoutMs <= 0) {
    throw new RangeError(`getProbeConnectionUrl: connectTimeoutMs 必须为正整数（收到 ${String(connectTimeoutMs)}）`);
  }
  // 追加法（R4 票②：new URL().toString() 再序列化会丢空密码冒号/重编码 query——原串零加工，与池完全同串）。
  //  同键剥除（R6 票③ clamp 语义）：原串已带 connectTimeout 时【剥除原值换探测值】——
  //  探测建连界是独立语义（运维大值会压过探测界把探测推出 HTTP 预算、假 503）；池的 connectTimeout 不受影响（池走原串）。
  //  #fragment 段不得吞参数（追加在 fragment 前）；原串以 ? 或 & 结尾时不再补分隔符；分隔符逻辑平铺不嵌套三元（仓 style 纪律）。
  const url = env.databaseUrl;
  const hashIdx = url.indexOf("#");
  const rawBase = hashIdx === -1 ? url : url.slice(0, hashIdx);
  const fragment = hashIdx === -1 ? "" : url.slice(hashIdx);
  // 剥同键（循环剥：连续同键一次正则漏剥第二键；剥到无变化为止）。
  //  作用域限定 query 段（R13 票⑤：& 是 URL password 的合法未编码字符——全串剥会把密码里的 &connectTimeout= 误删、
  //  探测用坏密码连库而池用原串=健康库报红；凭据段永不改写）
  const queryStart = rawBase.indexOf("?");
  const prefix = queryStart === -1 ? rawBase : rawBase.slice(0, queryStart);
  let query = queryStart === -1 ? "" : rawBase.slice(queryStart);
  const hadConnectTimeout = query !== "" && /[?&]connectTimeout=/.test(query); // 剥除前捕获（R14 票①：剥后检测恒假=死分支，运维感知丢失）
  if (query) {
    for (;;) {
      const next = query.replace(/([?&])connectTimeout=[^&#]*(&)?/, (_m, p1: string, p2: string | undefined) => (p2 ? p1 : ""));
      if (next === query) break;
      query = next;
    }
  }
  const base = prefix + query;
  if (hadConnectTimeout && !stripWarnedOnce) { // 剥前捕获态驱动（query 段作用域——密码段子串不误报，R13 票⑤）
    stripWarnedOnce = true; // 留痕一次性（探测每支都调本函数——不刷屏）
    console.warn("[getProbeConnectionUrl] DATABASE_URL 已带 connectTimeout，探测面按独立建连界剥除换值（池面不受影响）");
  }
  let sep: string;
  if (!base.includes("?")) sep = "?";
  else if (base.endsWith("?") || base.endsWith("&")) sep = "";
  else sep = "&";
  return `${base}${sep}connectTimeout=${connectTimeoutMs}${fragment}`;
}

/** 语句限时共享件：超时 destroy 断连，避免语句卡死把请求与并发槽位钉死；destroy 失败不抢在 reject 前抛。 */
export async function qTimed(conn: Connection, sqlText: string, params: unknown[], ms: number): Promise<[unknown, unknown]> {
  // 当前 mysql2 实测：独立连接顶层 release=function、底层 release=undefined；池连接底层 release=function 且 core._pool 存在。
  // 因此顶层 release() 绝不能恢复为判池条件；独立 PromiseConnection 也有 release()，误拒会让命名锁在首条 SQL 前必失败。
  // 结构判定：必须有底层 connection 与 query/destroy；顶层或底层 _pool 任一存在均为池连接，缺结构也 fail-closed。
  // 独立 PromiseConnection 也可有 release()；constructor.name 在构建期可变，二者都不再作为判池依据。
  // 本函数超时会 destroy，故只许独立连接，禁止池连接 destroy/release 双收口。
  const shape = conn as Connection & { connection?: { _pool?: unknown }; _pool?: unknown };
  const core = shape.connection;
  const missingShape = !core || typeof conn.query !== "function" || typeof conn.destroy !== "function";
  const coreRelease = typeof (core as { release?: unknown } | undefined)?.release === "function";
  if (shape._pool || core?._pool || coreRelease) throw new Error("qTimed 仅接受独立连接——禁止池连接 destroy/release 双收口");
  if (missingShape) throw new Error("qTimed 仅接受独立连接——连接结构缺失（需底层 connection 与 query/destroy）");
  if (!Number.isInteger(ms) || ms <= 0 || ms > 2_147_483_647) throw new RangeError(`qTimed: ms 必须为 1..2^31-1 的整数（收到 ${String(ms)}）`); // setTimeout 对非有限/越界值回绕成 ~1ms=健康连接被瞬时 destroy 面封死（poolAcquirePing 同律 fail-loud，门禁钉）
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      conn.query(sqlText, params) as Promise<[unknown, unknown]>,
      new Promise<never>((_, rej) => { timer = setTimeout(() => { try { conn.destroy(); } catch { /* destroy 抛不得——流已 teardown 时强毁会抢在 rej 前抛=uncaught+承诺永不结算=请求挂死钉闸槽（healthProbe.ts:51/connection.ts:127 同包壳） */ } rej(new Error("stmt_timed_out")); }, ms); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
