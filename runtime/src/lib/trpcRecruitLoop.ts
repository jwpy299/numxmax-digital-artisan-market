import type { CreateTRPCReact } from "@trpc/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { trpc } from "@/providers/trpc";
import type { AppRouter } from "../../api/router";

/**
 * 招募-雇佣联动（applications）与审核管理台（review）的类型化 tRPC 客户端。
 * 两个路由已在 api/router.ts 注册，AppRouter 类型已包含对应命名空间，
 * 此处只是主 trpc 的别名（同一 Provider 上下文），不再做任何服务端类型构造。
 * 注意：浏览器 bundle 中禁止 value-import @trpc/server（会导致运行时崩溃）。
 */
export const trpcRecruitLoop =
  trpc as unknown as CreateTRPCReact<AppRouter, unknown>;

/** 路由输出类型推导（组件 props 用） */
export type RecruitLoopOutputs = inferRouterOutputs<AppRouter>;
