const RESERVED_NAMES = new Set([
  'numx max', 'numx max·数智生态', 'numx max·数字匠市', '数字匠市',
  'nebula', 'nebula harness', '灵枢', '灵枢·星云', '国家超算互联网', 'scnet',
])
function reservedKey(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '')
}
const RESERVED_KEYS = new Set([...RESERVED_NAMES].map(reservedKey))

/** 前后端共用的公开展示名规范；错误由调用侧映射为 TRPCError 或 inline Error。 */
export function normalizePublicDisplayNameValue(value: unknown): string {
  if (typeof value !== 'string') throw new Error('公开展示名必须是字符串')
  const name = value.normalize('NFKC').replace(/\p{Default_Ignorable_Code_Point}/gu, '').trim().replace(/\s+/g, ' ')
  if (name.length < 2 || name.length > 80 || !/[\p{L}\p{N}]/u.test(name)) throw new Error('公开展示名须为 2–80 个字符且包含文字或数字')
  if (/^[\p{P}\p{S}\s]+$/u.test(name)) throw new Error('公开展示名不能只有符号')
  const compactDigits = name.replace(/[^\p{N}]/gu, '')
  const compactIdentity = name.replace(/[^\p{N}Xx]/gu, '')
  if (/1[3-9]\d{9}/.test(compactDigits) || /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(name) || /\d{17}[\dXx]/.test(compactIdentity)) throw new Error('公开展示名不得包含手机号、邮箱或证件号码')
  const reserved = reservedKey(name)
  const impersonatesReserved = [...RESERVED_KEYS].some((key) => key.length >= 2 && reserved.includes(key))
  if (/官方|官网/.test(name) || impersonatesReserved) throw new Error('公开展示名不得冒用平台或官方名称')
  return name
}
