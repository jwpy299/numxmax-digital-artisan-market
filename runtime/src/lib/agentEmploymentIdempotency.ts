/** 只轮换本次成功动作显式消费的幂等键；失败或其他并发动作的键必须保留供原请求重试。 */
export function rotateSucceededActionKeys(keys: Record<string, string>, consumedScopes: readonly string[]): void {
  for (const scope of new Set(consumedScopes)) delete keys[scope]
}
