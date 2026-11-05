import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { HttpBindings } from "@hono/node-server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./router";
import { createContext } from "./context";
import { clientIp } from "./lib/clientIp";
import { env } from "./lib/env";
import { resolveAgentSweepGate } from "./lib/agentSweepGate";
import { agentTestPreviewFlag, assertAgentEconomyBootMode, isAgentTestEconomy } from "./lib/agentEconomy";
import { assertAgentTestDatabaseConnection } from "./lib/agentEconomyBoot";
import { createOAuthCallbackHandler } from "./kimi/auth";
import { registerWechatCallback } from "./wechat/callback";
import { registerStreamEndpoints } from "./routers/streamBus";
import { handleAgentMarketLiveSse } from "./routers/agentMarketLiveSse";
import { handleWechatPayCallback } from "./routers/agentPluginPayments";
import { spiritChatHandler } from "./routers/spiritChat";
import { inviteQrHandler } from "./routers/qrImage";
import { isAdminDeploy } from "./lib/deployRole";
import { adminQrImageHandler } from "./routers/adminQrImage";
import { betaCheckHandler } from "./routers/betaGate";
import { smsYxtReportHandler, smsYxtMoHandler, ensureSmsTables } from "./routers/smsYxt";
import { Paths } from "@contracts/constants";
import { createHealthzMachine } from "./healthzMachine"; // P1-4：深健康状态机（调度/缓存/换槽收口于此，boot 薄装配）
import { ensureOpsTables } from "../db/sync-ops.mts";

// 测试经济必须先核验真实连接库名，再允许任何启动期写入或 HTTP 监听；只认 flag 不足以隔离生产。
const agentTestEconomyAtBoot = isAgentTestEconomy();
if (env.isProduction || agentTestEconomyAtBoot) {
  assertAgentEconomyBootMode();
  if (agentTestEconomyAtBoot) await assertAgentTestDatabaseConnection();
}

// 迭代 27：启动时幂等确保运营中心/套餐相关 7 张表存在（fire-and-forget，失败静默不阻断启动）
void ensureOpsTables().catch(() => {
  /* 表由 db/sync-ops.mts 手动补齐，启动绝不因建表失败而中断 */
});

const app = new Hono<{ Bindings: HttpBindings }>();

app.use(bodyLimit({ maxSize: 50 * 1024 * 1024 }));
app.use("*", async (c, next) => {
  // Electron file:// 的 Origin 固定为 null；只允许该来源，不把管理 API 放开给任意网站。
  c.header("Access-Control-Allow-Origin", "null");
  c.header("Access-Control-Allow-Credentials", "false");
  c.header("Vary", "Origin");
  c.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  c.header("Access-Control-Allow-Headers", "content-type,authorization");
  if (c.req.method === "OPTIONS") return c.status(204);
  await next();
});

app.get(Paths.oauthCallback, createOAuthCallbackHandler());


// P1-4：深健康端点（方案波 1——门禁打磨终版·两仓同款）：
//  状态机（单航班/TTL 限流/超龄换槽 destroy/代际守卫/deadline 追随）收口 ./healthzMachine.ts（可直测单点）；
//  探测面（专用一次性连接＋池信号不假绿＋三层结算封顶）收口 ./queries/healthProbe.ts；
//  本处只做 JSON 装配。免鉴权监控面（nginx/ops 探针要探）公开暴露系有意为之，可见信息仅 ok/latencyMs/measured/ts（measured=是否真实测标）。
const healthzMachine = createHealthzMachine();
app.get(Paths.healthz, async (c) => {
  const { body, status } = await healthzMachine.handle();
  return c.json(body, status);
});

// #24 星云手机精灵云端对话（免鉴权演示端点，自带限流）
app.post("/api/spirit-chat", spiritChatHandler);
// 工程团队实时进度（彭总令 2026-10-06：挂门户域名，独立页面——进度页专用口令鉴权，不用工作台登录）
// 彭总发话上桥（三人同席：页面直说，我俩都听见）
app.get("/api/invite-qr", inviteQrHandler);
if (isAdminDeploy()) {
  app.get(Paths.adminQrImage, adminQrImageHandler);
}
app.post("/api/beta-check", betaCheckHandler);
app.post("/api/sms-yxt/report", smsYxtReportHandler);
app.post("/api/sms-yxt/mo", smsYxtMoHandler);
// GET 活性面（P-YXT-BIND 实证）：推送地址 POST-only——浏览器/平台后台 GET 探测得 404=「地址打不开」误判面封死（GET 只回活性标，零业务面零数据）
app.get("/api/sms-yxt/report", (c) => c.json({ ok: true, endpoint: "sms-yxt/report", method: "POST" }));
app.get("/api/sms-yxt/mo", (c) => c.json({ ok: true, endpoint: "sms-yxt/mo", method: "POST" }));
// 短信三台账 DDL 启动预热（fire-and-forget——请求路径只剩 INSERT，与 ensureOpsTables 同面）
void ensureSmsTables().catch((e) => console.warn("[sms-yxt] ensureSmsTables failed:", (e as Error)?.message ?? e));
app.use("/api/trpc/*", async (c) => {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext: (opts) => createContext({ ...opts, clientIp: clientIp(c) }),
    // 配合 wb 前端 token 收口（query 也走 POST body，token 不进 URL）：
    // @trpc/server 默认 query 仅收 GET，需显式允许 methodOverride。
    allowMethodOverride: true,
    // v144 取证（真机 500 盲案）：trpc 错误落服务日志——只记 path+code+message，绝不记入参（token 红线）
    onError({ path, error }) {
      if (error.code === "UNAUTHORIZED" || error.code === "FORBIDDEN") return; // 常规鉴权拒绝不吵日志
      console.error(`[trpc] ${path} ${error.code}: ${String(error.message).slice(0, 300)}`);
    },
  });
});
// 微信公众号客服回调（公开接口，须在 /api/* 404 兜底之前注册）
registerWechatCallback(app);
// M8-c/M9-a：SSE 流式端点（duty-chat 流式追问 + 事件主动播报订阅）。
// EventSource 仅支持 GET，token 走 query 是全系统唯一例外；token 永不落日志。
registerStreamEndpoints(app);
app.get("/api/stream/agent-market-live", handleAgentMarketLiveSse);
app.post("/api/payments/wechat/callback", handleWechatPayCallback);
app.all("/api/*", (c) => c.json({ error: "Not Found" }, 404));

export default app;

const hostname = process.env.BIND_HOST || "127.0.0.1";
const rawPort = process.env.PORT || "3000";
const port = Number(rawPort);
const testPreview = !env.isProduction && process.env.NODE_ENV !== "test" && isAgentTestEconomy() && agentTestPreviewFlag();
if ((env.isProduction || testPreview) && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error(`PORT_INVALID:${JSON.stringify(rawPort.slice(0, 32))}`);
const explicitGateInstanceId = process.env.GATE_INSTANCE_ID?.trim();
const gateInstanceId = explicitGateInstanceId || `${hostname}:${port}`;

async function startHttpServer() {
  const { serve } = await import("@hono/node-server");
  const { serveStaticFiles } = await import("./lib/vite");
  serveStaticFiles(app);
  serve({ fetch: app.fetch, port, hostname }, () => {
    console.log(`${env.isProduction ? "Server" : "Isolated test preview"} running on http://${hostname}:${port}/`);
  });
}

if (env.isProduction) {
  await startHttpServer();

  // iter82 安全收敛：应用端口默认仅绑回环（对外一律经 nginx 反代），
  // 如需直连调试可在 .env 设 BIND_HOST=0.0.0.0 显式放开（新增变量，不改既有值）。
  // 2026-09-06 训练场互联（彭总令：四机相连 + 蒸馏跟虚拟日节律）：
  // 设 WG_BIND_HOST/WG_PORT（如 10.66.0.1:3202）即在 WireGuard 命线上再开一扇内网门，
  // 默认不开，生产公网面无变化。
  const wgHost = process.env.WG_BIND_HOST;
  const wgPort = parseInt(process.env.WG_PORT || "0");
  if (wgHost && wgPort > 0) {
    const { serve } = await import("@hono/node-server");
    serve({ fetch: app.fetch, port: wgPort, hostname: wgHost }, () => {
      console.log(`WG sidecar running on http://${wgHost}:${wgPort}/ (命线内网)`);
    });
  }

  // M68：模型网关保活心跳接线（曾长期是死代码——现网实证：闲置后首字 10.5s 冷启动）。
  // 每 240s 对已配置通道发 1-token 暖调用，连接/模型常驻热；LLM_KEEPALIVE_MS 可覆盖，=0 关闭。
  {
    const { startKeepAlive } = await import("./routers/modelGateway");
    const kaMs = Number(process.env.LLM_KEEPALIVE_MS ?? "240000");
    if (Number.isFinite(kaMs) && kaMs > 0) {
      startKeepAlive(Math.floor(kaMs));
      console.log(`[llm] gateway keepalive registered (${Math.floor(kaMs)}ms)`);
    }
  }

  // 迭代63 每周自动进化：仅 s1 由 .env EVO_WEEKLY_AUTO=1 开启；每小时 tick，
  // 周一 08 点整触发 weeklyAutoRun（同周幂等：审计标记 evo.weeklyAuto）。
  if (process.env.EVO_WEEKLY_AUTO === "1") {
    const { weeklyAutoRun } = await import("./routers/evo");
    setInterval(() => {
      const d = new Date();
      if (d.getDay() === 1 && d.getHours() === 8) {
        weeklyAutoRun("scheduler").catch((e) => console.error("[evo] weekly auto run failed:", e));
      }
    }, 3_600_000);
    console.log("[evo] weekly scheduler registered (EVO_WEEKLY_AUTO=1)");
  }

  // 2026-09-05 五师经验蒸馏（彭总令：固定每天早上 05:10 蒸）——
  // 环境变量 DISTILL_WEEKLY=1 开启；同日幂等（留痕查重）；失败静默不阻断。
  if (process.env.DISTILL_WEEKLY === "1") {
    const { distillRunOnce, distillRanToday } = await import("./routers/evolveDistill");
    setInterval(() => {
      const d = new Date();
      if (d.getHours() === 5 && d.getMinutes() === 10) {
        distillRanToday().then((ran) => {
          if (!ran) distillRunOnce("scheduler").catch(() => {});
        }).catch(() => {});
      }
    }, 60_000);
    console.log("[distill] daily scheduler registered (05:10, DISTILL_WEEKLY=1)");
  }

  // 2026-09-07 后训练（彭总令）：每夜 03:40 养料评效+优胜劣汰
  if (process.env.DISTILL_WEEKLY === "1") {
    const { postTrainScan } = await import("./routers/evolvePost");
    setInterval(() => {
      const d = new Date();
      if (d.getHours() === 3 && d.getMinutes() === 40) postTrainScan().catch(() => {});
    }, 60_000);
    console.log("[posttrain] nightly scan registered (03:40)");
  }

  // M23b 主动服务触发器：每 10 分钟一轮（设备离线/邀请临期，dedupeKey 查重——主动≠骚扰）。
  // 跟随上方 [evo] weekly scheduler 注册模式：仅生产 + 环境变量可关（WB_PROACTIVE_SWEEP=0）
  // + 失败静默不阻断服务；表未建时首轮报错仅落日志，待 db/sync-m23.mts 执行后自愈。
  if (process.env.WB_PROACTIVE_SWEEP !== "0") {
    const { runProactiveSweep } = await import("./routers/proactiveJobs");
    const sweep = () =>
      runProactiveSweep().catch((e) => console.error("[wb] proactive sweep failed:", e));
    void sweep();
    setInterval(() => {
      void sweep();
    }, 10 * 60 * 1000);
    console.log("[wb] proactive scheduler registered (10min, WB_PROACTIVE_SWEEP!=0)");
  }


  // iter81 闸门一：s3 龙虾执行队列 worker（仅 .env ENABLE_CLAW_WORKER=1 端启动，认领 exec_host='s3' 队列单）
  if (process.env.ENABLE_CLAW_WORKER === "1") {
    const { startClawWorker } = await import("./routers/claw");
    startClawWorker();
  }

  // iter100 M3：中枢实例心跳（无状态多实例——状态全在 MySQL，实例只是躯壳；
  // GATE_INSTANCE_ID 标识实例，GATE_HEARTBEAT=0 可关闭；表未建/抖动静默不阻断启动）
  if (process.env.GATE_HEARTBEAT !== "0") {
    const instanceId = gateInstanceId;
    const beat = async () => {
      try {
        const { getDb } = await import("./queries/connection");
        const { sql } = await import("drizzle-orm");
        await getDb().execute(
          sql`INSERT INTO st_gate_instances (instance_id, host, port, last_heartbeat)
              VALUES (${instanceId}, ${hostname}, ${port}, NOW())
              ON DUPLICATE KEY UPDATE last_heartbeat = NOW(), status = 'alive'`,
        );
      } catch {
        /* 心跳失败不阻断服务 */
      }
    };
    void beat();
    setInterval(() => {
      void beat();
    }, 15000);
    console.log(`[gate] instance heartbeat registered (${instanceId})`);
  }
}

if (testPreview) await startHttpServer();

// 个人 Agent 隔离训练：仅 AGENT_TRAINING_SWEEP=1 显式启用；先完成 additive DDL，再允许自动结算。
// 与 env.isProduction 解耦：隔离 staging/dev 显式开启沙箱时也能推进七日生命周期。
const sweepGate = resolveAgentSweepGate({
  sweepFlag: process.env.AGENT_TRAINING_SWEEP,
  nodeEnv: process.env.NODE_ENV,
  explicitGateInstanceId,
  sweepInstance: process.env.AGENT_TRAINING_SWEEP_INSTANCE,
  isProduction: env.isProduction,
  allowNonProd: process.env.AGENT_TRAINING_SWEEP_ALLOW_NON_PROD,
});
// 资金结算 sweep 不使用 HOST:PORT 作为多实例身份；身份缺失或不匹配都 fail-closed。
if (sweepGate.configurationInvalid) {
  console.error("[agent-training] sweep disabled: flag must be 1/true/yes, and NODE_ENV=test forbids automatic sweep");
} else if (sweepGate.requested && !sweepGate.environmentAllowed) {
  console.error("[agent-training] non-production sweep requires explicit AGENT_TRAINING_SWEEP_ALLOW_NON_PROD=1");
} else if (sweepGate.requested && !sweepGate.hasExplicitGateInstanceId) {
  console.error("[agent-training] sweep disabled: explicit GATE_INSTANCE_ID is required");
} else if (sweepGate.requested && !sweepGate.hasSweepInstance) {
  console.error("[agent-training] sweep disabled: explicit AGENT_TRAINING_SWEEP_INSTANCE is required");
} else if (sweepGate.requested && !sweepGate.instanceMatches) {
  console.warn(`[agent-training] sweep disabled by instance mismatch: configured=${sweepGate.sweepInstance}, actual=${sweepGate.explicitGateInstanceId}`);
}
if (sweepGate.shouldStart) {
  const { startAgentTrainingScheduler } = await import("./routers/agentEmploymentScheduler");
  startAgentTrainingScheduler();
  console.log("[agent-training] scheduler registered (60s sweep; ticks fail closed until additive DDL schema probes are ready)");
}
