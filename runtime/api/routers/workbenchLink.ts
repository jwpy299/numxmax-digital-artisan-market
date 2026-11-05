import { z } from "zod";
import {
  createTRPCUntypedClient,
  httpLink,
  TRPCClientError,
} from "@trpc/client";
import superjson from "superjson";
import { createRouter, publicQuery } from "../middleware";
import { markDeprecated } from "./deprecation";

/**
 * 匠市 → NumX Max 智能工作台：两段式 SSO 桥接代理路由。
 *
 * 依据《NumX Max 智能工作台 API 文档（匠市对接版）》已核实事实实现：
 * - 工作台服务端为 tRPC（endpoint /api/trpc）+ superjson transformer；
 * - token 一律放在请求体字段（无 Authorization header），由业务层 sessionMe(token) 校验；
 * - ticket 形如 st_<48 hex>，一次性、TTL 300 秒，明文仅签发响应返回一次（库只存 sha256）；
 * - entryUrl 为相对路径，形如 /bridge?ticket=<urlencoded ticket>，前端整页跳转；
 * - 落地页白名单：/dept、/dashboard、/market、/showroom、/skillmall、/org，默认 /dept；
 * - 上架 / 招募 / 展厅均为「提交 pending + 人工确认」两段式，不承诺即时生效。
 *
 * 这里通过服务端到服务端的 tRPC client 转发，避免浏览器跨域，
 * 也避免手工拼接 superjson 序列化 / batch HTTP 请求（文档明确不建议）。
 *
 * 注册方式（由主代理在 api/router.ts 统一挂载）：
 *   import { workbenchLinkRouter } from "./routers/workbenchLink";
 *   // appRouter 内新增： workbenchLink: workbenchLinkRouter,
 */

/**
 * 工作台 tRPC API base。
 * 工作台服务端（agentic / nebulaLink / workbenchMarket / showroomPortal）
 * 已按官方 API 文档真实实现并挂载在本服务 /api/trpc 下（同部署承载），
 * 因此默认指向本服务自身；如需对接独立部署的工作台，
 * 通过环境变量 WORKBENCH_API_URL 覆盖为真实地址。
 */
const WORKBENCH_API_URL =
  process.env.WORKBENCH_API_URL ??
  `http://127.0.0.1:${process.env.PORT || 3000}/api/trpc`;

/** 工作台侧单次调用超时（毫秒）：占位地址不可达时快速失败，避免挂起请求 */
const WORKBENCH_CALL_TIMEOUT_MS = 8_000;

/** 服务端到服务端的工作台 tRPC client（无类型：工作台 AppRouter 不在本仓库内） */
const workbenchClient = createTRPCUntypedClient({
  links: [
    httpLink({
      url: WORKBENCH_API_URL,
      transformer: superjson,
    }),
  ],
});

/** 桥接调用失败的结构化错误：reachable 区分「网络不可达」与「工作台业务拒绝」 */
interface BridgeFailure {
  ok: false;
  reachable: boolean;
  message: string;
}

const UNREACHABLE_MESSAGE =
  "工作台服务未连通（地址未配置或网络不可达），SSO 已就绪待接入";

function toBridgeFailure(err: unknown): BridgeFailure {
  if (err instanceof TRPCClientError) {
    // data 存在说明工作台服务端返回了 tRPC 错误包（业务层拒绝，如 token 失效）；
    // data 不存在则是网络层失败（DNS/连接拒绝/超时）。
    const hasServerEnvelope =
      (err as unknown as { data?: unknown }).data !== undefined;
    return {
      ok: false,
      reachable: hasServerEnvelope,
      message: hasServerEnvelope ? err.message : UNREACHABLE_MESSAGE,
    };
  }
  return { ok: false, reachable: false, message: UNREACHABLE_MESSAGE };
}

/** 统一转发入口：带超时与安全错误包装 */
async function forward<T>(
  call: () => Promise<T>,
): Promise<{ ok: true; data: T } | BridgeFailure> {
  try {
    const data = await call();
    return { ok: true, data };
  } catch (err) {
    return toBridgeFailure(err);
  }
}

const callOpts = () => ({ signal: AbortSignal.timeout(WORKBENCH_CALL_TIMEOUT_MS) });

/** 文档已核实的落地页白名单 */
const TARGETS = [
  "/dept",
  "/dashboard",
  "/market",
  "/showroom",
  "/skillmall",
  "/org",
] as const;

/** bridgeStatus 输出（文档当前核实值） */
interface BridgeStatusPayload {
  source: string;
  supportedTargets: string[];
  ticketTtlSeconds: number;
  requiresLogin: boolean;
}

/** createWorkbenchTicket 输出（文档表 5-2） */
interface TicketPayload {
  ticket: string;
  entryUrl: string;
  target: string;
  expiresAt: string;
  factoryId: string;
  enterpriseName: string;
}

/** authLogin 输出 / authRegister 输出中的会话信息（SessionInfo） */
interface SessionPayload {
  token: string;
  username: string;
  displayName?: string;
  enterpriseName?: string;
  factoryId?: string;
  role?: string;
  [key: string]: unknown;
}

export const workbenchLinkRouter = createRouter({
  /**
   * 转发 nebulaLink.bridgeStatus 自检。
   * 工作台不可达时不抛错，返回 { reachable: false, message } 供前端降级展示。
   */
  bridgeStatus: publicQuery.query(async (): Promise<
    | ({ reachable: true } & BridgeStatusPayload)
    | { reachable: false; message: string }
  > => {
    const res = await forward(() =>
      workbenchClient.query("nebulaLink.bridgeStatus", undefined, callOpts()),
    );
    if (!res.ok) return { reachable: false, message: res.message };
    return { reachable: true, ...(res.data as BridgeStatusPayload) };
  }),

  /**
   * 转发 nebulaLink.createWorkbenchTicket：签发一次性跳转 ticket。
   *
   * 安全约束（文档第 10 节，对接方必须遵守）：
   * - ticket 明文只在签发响应出现一次，本路由仅原样透传给前端用于立即跳转；
   * - 不在此处写入数据库、不打印日志（严禁 console.log ticket 明文）；
   * - TTL 300 秒，过期由前端重新签发即可。
   */
  createWorkbenchTicket: publicQuery
    .input(
      z.object({
        token: z.string().trim().min(1),
        target: z.enum(TARGETS).optional(),
        source: z.string().trim().min(1).max(64).default("craftsman-market"),
      }),
    )
    .mutation(async ({ input }) => {
      const res = await forward(() =>
        workbenchClient.mutation(
          "nebulaLink.createWorkbenchTicket",
          { token: input.token, target: input.target, source: input.source },
          callOpts(),
        ),
      );
      if (!res.ok) return res;
      const data = res.data as TicketPayload;
      // 原样返回 ticket/entryUrl/expiresAt/factoryId/enterpriseName（ticket 明文不落库、不写日志）
      return {
        ok: true as const,
        ticket: data.ticket,
        entryUrl: data.entryUrl,
        target: data.target,
        expiresAt: data.expiresAt,
        factoryId: data.factoryId,
        enterpriseName: data.enterpriseName,
      };
    }),

  /** 转发 agentic.authRegister：企业注册（注册者角色 admin） */
  workbenchRegister: publicQuery
    .input(
      z.object({
        username: z.string().trim().min(2).max(64),
        password: z.string().min(6).max(128),
        enterpriseName: z.string().trim().min(2).max(128),
        industry: z.string().trim().min(1).max(64),
        headcount: z.union([z.string().trim().min(1).max(32), z.number().int().positive()]),
        industryText: z.string().trim().max(128).optional(),
        departments: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
        painPoints: z.string().trim().max(2000).optional(),
        displayName: z.string().trim().max(64).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const res = await forward(() =>
        workbenchClient.mutation("agentic.authRegister", input, callOpts()),
      );
      if (!res.ok) return res;
      return { ok: true as const, ...(res.data as SessionPayload) };
    }),

  /**
   * @deprecated 2026-08-13 彭总拍板下线（观察期 30 天）：用 agentic.authLogin 直连，勿走本转发。
   * 注意：登录会重颁 token，旧 token 失效（token 单点有效）。
   */
  workbenchLogin: publicQuery
    .input(
      z.object({
        username: z.string().trim().min(1).max(64),
        password: z.string().min(1).max(128),
      }),
    )
    .mutation(async ({ input }) => {
      const res = await forward(() =>
        workbenchClient.mutation("agentic.authLogin", input, callOpts()),
      );
      if (!res.ok) return res;
      return markDeprecated("workbenchLink.workbenchLogin", "agentic.authLogin", {
        ok: true as const,
        ...(res.data as SessionPayload),
      });
    }),

  /**
   * 转发 agentic.authMe：查询当前用户与企业画像。
   * token 放请求体字段；token 无效时工作台返回 null（由前端判定重新登录）。
   */
  workbenchMe: publicQuery
    .input(z.object({ token: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const res = await forward(() =>
        workbenchClient.query("agentic.authMe", { token: input.token }, callOpts()),
      );
      if (!res.ok) return res;
      return { ok: true as const, me: res.data as unknown };
    }),
});
