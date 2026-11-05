/**
 * 居民身份证号工具（GB 11643-1999 加权校验位，纯函数，前后端共用）。
 * - 校验位：前 17 位分别乘加权因子 [7,9,10,5,8,4,2,1,6,3,7,9,10,5,8,4,2]，
 *   求和对 11 取余，余数映射 '10X98765432' 得第 18 位。
 * - 铁律：身份证号绝不存明文（服务端仅落 sha256 + 掩码）、绝不进日志。
 */

const WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2] as const
const CHECK_CODES = '10X98765432'

/** 18 位身份证号校验（长度 + 字符集 + GB11643 校验位） */
export function verifyIdCard(id: string): boolean {
  if (!/^\d{17}[\dXx]$/.test(id)) return false
  let sum = 0
  for (let i = 0; i < 17; i++) {
    sum += Number(id[i]) * WEIGHTS[i]
  }
  return CHECK_CODES[sum % 11] === id[17].toUpperCase()
}

/** 掩码：前 4 位 + 10 个 * + 后 4 位（共 18 字符） */
export function maskIdCard(id: string): string {
  return `${id.slice(0, 4)}${'*'.repeat(10)}${id.slice(-4)}`
}
