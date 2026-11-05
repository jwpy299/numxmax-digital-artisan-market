/**
 * healthzMachine —— /api/healthz 深健康状态机（portal#40 R5 票④：状态机抽离可直测，boot.ts 薄装配；两仓同款）：
 *  单航班共享在飞＋TTL 结果缓存（DB 侧限流）＋超龄换槽 destroy（FD 不积）＋代际守卫缓存写＋deadline 预算内追随一次＋换槽先重读缓存。
 *  依赖注入探测工厂（生产=dbProbeTimedFlight；测试注入可控假 flight 毫秒级驱动时序），Hono 无关——boot.ts 只做 JSON 装配。
 *  健康语义：ok = 专用连接真查询通过【且】共享池有界 acquire+ping 通过（healthProbe 层保证）；本层只管调度与缓存。
 *  响应面 measured 字段（口径调和，R19 票⑤）：本端点自本 PR 出生——「免鉴权 nginx/ops 探针面」是设计意图
 *  （超终探针待切），当前线上无消费者；契约自本 PR 定型为 {ok, latencyMs:number, measured:boolean, ts}，
 *  此后变更即按已发布契约管理（measured 是实测性标，外部消费只读 status+ok 即可）。
 */
import { execSync } from "node:child_process";
import { redactErrMsg } from "./queries/connection"; // 留痕 message 提取+脱敏单点（R25 票③）
import { dbProbeTimedFlight, PROBE_CRITICAL_PATH_MS, type DbProbeResult, type DbProbeTimedFlight } from "./queries/healthProbe"; // 含 PROBE_CRITICAL_PATH_MS（预算断言）

/** 契约⑤统一 schema 面（全服务同键 {ok,service,version,…}——deploy-check 一次 curl 全机群[契约① sha 自证普及面]）：
 *  service——env HEALTHZ_SERVICE 优先（admin 实例=admin[unit env 面]），缺省回本仓名；
 *  version——boot 期 git rev-parse --short HEAD（systemd WorkingDirectory=仓目录面；同步一次性，请求路径不跑）；
 *  取不到="unknown"——healthz 永不因版本面炸（降级不崩溃[wb#49 同律]）。 */
const HEALTHZ_SERVICE = process.env.HEALTHZ_SERVICE ?? "portal";
const HEALTHZ_VERSION = (() => { try { return execSync("git rev-parse --short HEAD", { timeout: 3000 }).toString().trim(); } catch { return "unknown"; } })();

/** HTTP 层响应预算 3s（挂死期请求出路，不挂起堆积） */
const HEALTHZ_HTTP_TIMEOUT_MS = 3_000;
// 预算不变量（R26 票②：探测临界路径必须全罩 HTTP 预算内——不靠注释漂移）。
// ⚠️ **降级为告警位**（wb#49 ③）：原来是模块加载期 `throw` —— 常量一旦被改错，**import 即炸**，
//   整个 app 起不来（blast radius 远大于"healthz 自己报红"）。健康面自己的口径本就是"降级而非崩溃"，
//   故改成：记一条 `console.error` + 置降级位，由 `/api/healthz` 返回 **503**；
//   不变量本身仍由**测试**钉住（`healthzMachine.test.ts` / `healthzBudget.test.ts`），保住 R26「可见即拦截」的原意。
export const HEALTHZ_BUDGET_BROKEN = PROBE_CRITICAL_PATH_MS >= HEALTHZ_HTTP_TIMEOUT_MS;
if (HEALTHZ_BUDGET_BROKEN) {
  console.error(`healthz 预算破坏：探测临界 ${PROBE_CRITICAL_PATH_MS}ms >= HTTP 预算 ${HEALTHZ_HTTP_TIMEOUT_MS}ms——先调探测常量（已降级为 healthz 503，不阻塞启动）`);
}
/** 结果 TTL 1s：兼作 DB 侧限流阀（免鉴权端点靠它封顶放大面——任意并发下 DB 探测 ≤ 1 次/s） */
const HEALTHZ_RESULT_TTL_MS = 1_000;
/** 在飞槽代码级最大存活 10s：到期换槽＋毁旧探测 socket，不赌驱动会结算 */
const HEALTHZ_PROBE_MAX_AGE_MS = 10_000;
// ④（wb#49）原来这里有一行**模块级** `let factoryErrLastAt = 0` —— 已挪进 machine 实例（见下）。
//   理由：节流窗口是**调度状态**，模块级意味着"同进程内所有实例共享一个窗口"——测试注入两个 machine 时
//   会互相压制（一个实例的留痕把另一个实例的留痕吃掉），生产侧也只该按实例计。
//   wb 侧早已是实例级，这里是**对齐 wb 的终态**，不是新设计。

export type HealthzProbe = DbProbeResult; // 同形收口（R18 票④）
/** latencyMs 恒为数值（外部消费契约，portal R6 票①：免鉴权监控面不出 null——数值消费者不炸）；
 *  measured 标「是否真实测」：false=预算耗尽无实测（latencyMs 是 JS 等待如实值，非 DB 延迟）——
 *  语义消费读 measured，数值消费读 latencyMs，两面不互炸。（measured 系本次重构新增字段——端点尚未对外发布，无线上消费者。） */
export type HealthzBody = { ok: boolean; latencyMs: number; measured: boolean; ts: string; service: string; version: string };
/** `measured:false` 有**两种**来源，`latencyMs` 的读法随之不同（门禁 portal#45 的 :85 指出注释只覆盖了一种）：
 *  ① 预算耗尽/换槽未结算 ⇒ latencyMs = handler 视角的**如实 JS 等待**（不是 DB 延迟）；
 *  ② 预算降级位（`HEALTHZ_BUDGET_BROKEN`，常量关系被改坏）⇒ **一个请求都没发**，如实等待 ≈ 0，
 *     故取 `0` 并按 503 返回。消费方只应按 `measured` 决定要不要把 latencyMs 当延迟读。 */
export type HealthzVerdict = { body: HealthzBody; status: 200 | 503 };

export type HealthzFlight = DbProbeTimedFlight; // 同形收口（R20 票④：复用 healthProbe 飞行体形状，不再双写）
export type HealthzFlightFactory = () => HealthzFlight;

/** 时序参数（生产恒用默认；测试面注入小值毫秒级驱动换槽/超时/追随路径） */
export interface HealthzMachineOpts {
  httpTimeoutMs?: number;
  resultTtlMs?: number;
  probeMaxAgeMs?: number;
}

export function createHealthzMachine(
  flightFactory: HealthzFlightFactory = () => dbProbeTimedFlight(),
  opts: HealthzMachineOpts = {},
) {
  const httpTimeoutMs = opts.httpTimeoutMs ?? HEALTHZ_HTTP_TIMEOUT_MS;
  const resultTtlMs = opts.resultTtlMs ?? HEALTHZ_RESULT_TTL_MS;
  const probeMaxAgeMs = opts.probeMaxAgeMs ?? HEALTHZ_PROBE_MAX_AGE_MS;

  let inflight: HealthzFlight | null = null;
  let inflightStartedAt = 0;
  /** 工厂炸留痕节流（60s 一窗——持续同步抛不刷屏）。**实例级**（wb#49 ④）：模块级会让同进程内多个 machine
   *  共用一个窗口（测试面互相压制、生产面按实例计的语义也错），故随实例走。 */
  let factoryErrLastAt = 0;
  /** 换槽代际计数：缓存写只认「所认航班仍是当代」——旧代迟到结果不得覆盖新代结论 */
  let generation = 0;
  let cache: { at: number; body: HealthzBody; gen: number } | null = null; // gen=写入代际（追随窗只采信当代真实测）

  /** HealthzBody 构造单点（R17 票②：settle 沉淀/超时分支/实测分支三处同引——字段不漂移） */
  function makeBody(ok: boolean, latencyMs: number, measured: boolean): HealthzBody {
    return { ok, latencyMs, measured, ts: new Date().toISOString(), service: HEALTHZ_SERVICE, version: HEALTHZ_VERSION };
  }

  /** 缓存读取单点（TTL 语义与 200/503 映射不双写）：
   *  handler 顶常规窗（resultTtlMs，DB 侧限流的实现点）；
   *  追随窗（portal R6 票① 放宽+portal R7 票① 收紧）：maxAge=httpTimeoutMs+resultTtlMs（≈预算+TTL，不放到整个换槽周期）且
   *  只采信当代（gen 戳）——「比本请求新的同代真实测」才上桌，陈旧绿面封死 */
  function readCache(maxAgeMs: number, onlyGen?: number): HealthzVerdict | null {
    if (!cache || Date.now() - cache.at >= maxAgeMs) return null;
    if (onlyGen !== undefined && cache.gen !== onlyGen) return null;
    return { body: cache.body, status: cache.body.ok ? 200 : 503 };
  }

  async function handle(): Promise<HealthzVerdict> {
    // ⓪ 预算降级位（wb#49 ③）：常量关系被改坏时**不许**静默给绿 —— 直接 503 且 `measured:false`
    //   （latencyMs 取 0：这一支根本没测）。放在 TTL 之前：降级是**配置事实**，不该被 1s 缓存窗遮住；也不占飞行槽。
    if (HEALTHZ_BUDGET_BROKEN) return { body: makeBody(false, 0, false), status: 503 };

    // ① TTL 命中即返：不碰 DB、不占槽（DB 侧限流的实现点）
    const hit = readCache(resultTtlMs);
    if (hit) return hit;

    // ② 换槽判据：无在飞，或在飞已超龄。超龄换槽＋毁旧探测 socket 是自愈路径
    const startedAt = Date.now();
    if (!inflight || startedAt - inflightStartedAt >= probeMaxAgeMs) {
      const superseded = inflight;
      // 探测工厂/毁 socket 同步抛守卫（R21 票②：抛则 handle reject→boot 无边界→500；健康端点只许 200/503）
      let flight: HealthzFlight;
      try {
        flight = flightFactory();
      } catch (e) {
        // 工厂同步炸=探测面不可用——如实 503 无实测（不写缓存，下一请求重试）；
        //  换代+清槽（R23 票①：被毁航班仍是当代在槽的话，其迟到 settle 的取消 artifact 会被 settle 沉淀写缓存
        //  （measured:true 的假实测红，TTL 内全 503）——换代+清槽让沉淀守卫拒写）；
        //  对称毁旧航班（换槽判据已成立——旧探测不放任，FD 不积语义不破）
        generation += 1;
        if (superseded !== null && inflight === superseded) inflight = null;
        try { superseded?.destroy(); } catch { /* best-effort */ }
        // 留痕：脱敏单点+手卷节流（R25 票③ 同构：不写缓存的分支若工厂持续同步抛会每请求一条——60s 一窗防洪）
        try {
          if (Date.now() - factoryErrLastAt > 60_000) {
            factoryErrLastAt = Date.now();
            console.error("[healthz] 探测工厂同步失败:", redactErrMsg(e));
          }
        } catch { /* 留痕不炸 handler */ }
        return { body: makeBody(false, Date.now() - startedAt, false), status: 503 };
      }
      inflightStartedAt = startedAt;
      generation += 1;
      const myGen = generation; // 本航班的代（settle 沉淀与释位的代际凭据）
      void flight.promise
        .then((res_) => {
          // 航班 settle 即沉淀缓存（R15 票① 根治追随窄窗：释槽先于缓存写会让追随者读不到新航班结果）——
          //  缓存语义=「最近一支当代航班的实测」；只在当代且仍在槽时沉淀（旧代/已换槽的结果不写）
          if (generation === myGen && inflight === flight) {
            cache = { at: Date.now(), body: makeBody(res_.ok, res_.latencyMs, true), gen: myGen };
          }
        })
        .finally(() => {
          // 同一性守卫：旧航班迟到的 finally 不得清掉已经换上来的新槽
          if (inflight === flight) inflight = null;
        })
        .catch(() => { /* 双保险：探测契约不抛 */ });
      inflight = flight;
      try { superseded?.destroy(); } catch { /* 毁不动不炸 handler（R21 票②：destroy 同步抛不破 503 语义） */ } // 换槽即毁旧探测底层 socket——挂死探测不占连接资源、FD 不积
    }
    // 取本地引用＋当代代际：await 期间槽可能被并发请求换掉，本请求先认自己拿到的那一航班
    const latched = inflight;
    let gen = generation;

    // deadline 制预算：所认航班被并发换槽时，剩余预算内追随一次新航班（不连环，总耗不突破预算）——
    //  旧航班被 destroy 的 reject/迟到不得把跟随它的请求打成 503 假阴
    const handlerStartedAt = Date.now(); // 显式起点（R9 票①：latencyMs 与 deadline 同源派生，不反解）
    const deadline = handlerStartedAt + httpTimeoutMs;
    const raceOnce = async (p: Promise<HealthzProbe>): Promise<HealthzProbe | null> => {
      const remain = deadline - Date.now();
      if (remain <= 0) return null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          p.catch(() => null), // 探测若 reject 不破 handler（无实测 ⇒ r=null ⇒ measured:false＋latencyMs 取如实 JS 等待）
          new Promise<null>((res) => { timer = setTimeout(() => res(null), remain); }),
        ]);
      } finally {
        if (timer) clearTimeout(timer); // 全路径清（resolve/reject 都不悬挂）
      }
    };
    let r = await raceOnce(latched.promise);
    let rMeasured = true; // 取消 artifact 诚实标（R11 票⑥）：换槽窗内的 ok:false 可能是 superseded.destroy() 打断所致（非真实测）
    if (gen !== generation) {
      // 所认航班被换槽：先重读缓存（新航班可能已结算落缓存、槽已释空——不看缓存直接判会 503 假阴；
      //  放宽窗=当代真实测年龄上界，见 readCache 注释）
      const fresh = readCache(httpTimeoutMs + resultTtlMs, generation); // 追随窗（≈预算+TTL＋只采信当代——代际戳守卫，陈旧绿面封死）
      if (fresh) return fresh;
      // latched 已被换槽：其 ok:false 实测性存疑（可能是 superseded.destroy() 的取消 artifact）——先降标
      //  （R14 票④：不嵌在 if(inflight) 里——新航班已结算释槽的窄窗里 inflight===null，降标不能跳票）
      if (r !== null && !r.ok) rMeasured = false;
      if (inflight) {
        // 追随成功才认新代（R9 票① 精修）；追随期再换槽不换代（R10 票①：代与航班同锁——
        //  await 期间又换槽则 followed 属「追随时那代」，g2 已非当代，守卫拒写缓存，响应照返真实测）；
        //  追随无果→保留 latched 实测与旧代 gen——缓存写守卫自然拒写，响应照常返（真伪看实测本身不看代）；
        //  已测健康不因换窗预算尽/新航班未结而报 503 假阴
        const followFlight = inflight;
        const g2 = generation; // 与所追随航班同代锁定
        const followed = await raceOnce(followFlight.promise);
        if (followed !== null) { r = followed; rMeasured = followed.ok || g2 === generation; if (g2 === generation) gen = g2; } // 追随期再换槽时 followed.ok:false 仍可能是取消 artifact（R12 票③：ok:true 必为实测，false 按当代性定标）
      }
    }

    // 实测分支 measured:true；预算耗尽分支 measured:false＋latencyMs=如实 JS 等待（不冒充 DB 延迟，语义由 measured 承载）
    // measured:false ⇒ latencyMs 恒为 handler 视角 JS 等待如实值（R17 票③：取消 artifact 路径不用 r.latencyMs——契约一致不误导）
    let body: HealthzBody; // R20 票③：嵌套三元平铺（仓 style 纪律）
    if (r === null) {
      body = makeBody(false, Date.now() - handlerStartedAt, false);
    } else {
      const latencyMs = rMeasured ? r.latencyMs : Date.now() - handlerStartedAt; // 取消 artifact 诚实降标
      body = makeBody(r.ok, latencyMs, rMeasured);
    }
    // 缓存写代际守卫：成败同缓存，但只在当代——DB 挂死期也只在 TTL 粒度上重探，不打穿
    if (gen === generation) cache = { at: Date.now(), body, gen }; // 代际戳随身（追随窗采信凭据）
    return { body, status: body.ok ? 200 : 503 };
  }

  return { handle }; // readCache 私有化（R6 票②：单入口 handle，缓存读不外露）
}
