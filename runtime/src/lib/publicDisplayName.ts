import { normalizePublicDisplayNameValue } from '@contracts/publicDisplayName'

export function normalizePublicDisplayName(value: string): string {
  return normalizePublicDisplayNameValue(value)
}

export function publicDisplayNameError(value: string): string | null {
  try { normalizePublicDisplayName(value); return null } catch (error) { return error instanceof Error ? error.message : '公开展示名不合法' }
}
