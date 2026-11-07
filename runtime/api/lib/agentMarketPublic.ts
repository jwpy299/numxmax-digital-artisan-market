import { TRPCError } from '@trpc/server'
import { normalizePublicDisplayNameValue } from '@contracts/publicDisplayName'

export function normalizePublicDisplayName(value: unknown): string {
  try { return normalizePublicDisplayNameValue(value) } catch (error) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: error instanceof Error ? error.message : '公开展示名不合法' })
  }
}
