const RESERVED_NAMES = new Set(['numx max', 'numx max·数智生态', 'nebula', 'nebula harness', '灵枢', '灵枢·星云', '国家超算互联网', 'scnet'])

export function normalizePublicDisplayName(value: string): string {
  const name = value.normalize('NFC').trim().replace(/\s+/g, ' ')
  if (name.length < 2 || name.length > 80 || !/[\p{L}\p{N}]/u.test(name)) throw new Error('公开展示名须为 2–80 个字符且包含文字或数字')
  if (/^[\p{P}\p{S}\s]+$/u.test(name)) throw new Error('公开展示名不能只有符号')
  if (/(?<!\d)1[3-9]\d{9}(?!\d)/.test(name) || /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(name) || /(?<!\d)\d{17}[\dXx](?!\d)/.test(name)) throw new Error('公开展示名不得包含手机号、邮箱或证件号码')
  if (/官方|官网/.test(name) || RESERVED_NAMES.has(name.toLowerCase())) throw new Error('公开展示名不得冒用平台或官方名称')
  return name
}

export function publicDisplayNameError(value: string): string | null {
  try { normalizePublicDisplayName(value); return null } catch (error) { return error instanceof Error ? error.message : '公开展示名不合法' }
}
