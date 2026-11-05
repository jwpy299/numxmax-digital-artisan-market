/**
 * randomHex —— 安全随机 hex 串共享件（门禁票：WbOrg.deviceFingerprint 与 WbOnboarding 开户密码各写一份同式，漂移面）。
 * 安全面：crypto.getRandomValues（非 LCG——设备指纹/一次性密码等不可预测场景专用）。
 */
export function randomHex(bytes = 16): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}
