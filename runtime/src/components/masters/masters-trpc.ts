import type { inferRouterOutputs } from '@trpc/server'
import { trpc } from '@/providers/trpc'
import type { mastersRouter } from '../../../api/routers/masters'

/**
 * masters 路由（api/routers/masters.ts）由主代理在 api/router.ts 统一注册。
 * 注册前 AppRouter 类型尚不含 masters 命名空间；tRPC 客户端代理在运行时是动态的，
 * 因此这里做一次显式类型收窄 —— 注册后即获得真实数据，无需改动本文件。
 */
type RouterOutputs = inferRouterOutputs<typeof mastersRouter>

export type MasterListData = RouterOutputs['list']
export type MasterListItem = MasterListData['items'][number]
export type MasterDashboard = RouterOutputs['dashboard']
export type MasterAgentItem = MasterDashboard['agents'][number]
export type MasterReviewItem = MasterDashboard['reviews'][number]

export interface QueryState<T> {
  data: T | undefined
  isLoading: boolean
  isError: boolean
  error: { message: string } | null
  refetch: () => void
}

export const mastersTrpc = trpc as unknown as {
  masters: {
    list: {
      useQuery: (input?: undefined, opts?: { retry?: number }) => QueryState<MasterListData>
    }
    dashboard: {
      useQuery: (
        input: { masterId: number },
        opts?: { enabled?: boolean; retry?: number },
      ) => QueryState<MasterDashboard>
    }
  }
}
