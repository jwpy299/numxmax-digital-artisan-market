import { createHash } from 'node:crypto'
import { verifyAgentPluginPackageAsync, type AgentPluginVerification } from './agentPluginManifest'

type Expected = { signerPublicKey?: string; signature?: string; artifactSha256?: string }
const CACHE_LIMIT = 100
const cache = new Map<string, AgentPluginVerification>()
const inFlight = new Map<string, Promise<AgentPluginVerification>>()
let verificationTail: Promise<void> = Promise.resolve()

function cacheKey(artifactSha256: string, expected: Expected): string {
  return JSON.stringify([artifactSha256, expected.signerPublicKey ?? '', expected.signature ?? ''])
}
function touch(key: string, value: AgentPluginVerification): AgentPluginVerification {
  cache.delete(key); cache.set(key, value)
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
  return value
}

/** 同步查缓存：grant/dispatch 命中后无需再 SELECT artifact_blob；信任锚与签名也是键的一部分。 */
export function getCachedAgentPluginVerification(artifactSha256: string, expected: Expected = {}): AgentPluginVerification | null {
  const key = cacheKey(artifactSha256, expected)
  const cached = cache.get(key)
  return cached ? touch(key, cached) : null
}

/** 单飞＋全局串行的异步验签：不阻塞事件循环，不让匿名并发各自制造子进程风暴。 */
export async function verifyAndCacheAgentPluginPackage(artifact: Buffer, expected: Expected): Promise<AgentPluginVerification> {
  const actualArtifactSha256 = createHash('sha256').update(artifact).digest('hex')
  if (expected.artifactSha256 !== undefined && expected.artifactSha256 !== actualArtifactSha256) throw new Error('agent_plugin_artifact_hash_mismatch')
  const artifactSha256 = actualArtifactSha256
  const key = cacheKey(artifactSha256, expected)
  const cached = getCachedAgentPluginVerification(artifactSha256, expected)
  if (cached) return cached
  const pending = inFlight.get(key)
  if (pending) return pending
  const work = verificationTail.then(async () => {
    const warm = getCachedAgentPluginVerification(artifactSha256, expected)
    if (warm) return warm
    const verification = await verifyAgentPluginPackageAsync(artifact, expected)
    return touch(key, verification)
  })
  verificationTail = work.then(() => undefined, () => undefined)
  inFlight.set(key, work)
  try { return await work } finally { inFlight.delete(key) }
}
