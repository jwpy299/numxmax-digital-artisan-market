const { parentPort, workerData } = require('node:worker_threads')
const { isSecureUrl, jsonStringByteLength, normalizeWithinBudget, readTrpcResponse, trpcUrl, upstreamErrorCode } = require('../../org-transport/index.cjs')

const manifest = workerData.manifest
const allowed = new Set(manifest.allowedProcedures)
const apiBase = new URL(workerData.apiBase).origin
const permissions = manifest.permissions
const network = new Set((permissions.network || []).map((origin) => new URL(origin).origin))
const manifestTimeout = Number(permissions.timeoutMs)
const hostTimeoutMs = Number(workerData.hostTimeoutMs || manifestTimeout)
const maxResponseBytes = Number(permissions.maxResponseBytes)
const maxPayloadBytes = Number(permissions.maxPayloadBytes)
if (!Number.isInteger(manifestTimeout) || manifestTimeout < 1 || !Number.isInteger(hostTimeoutMs) || hostTimeoutMs < 1 || !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || !Number.isInteger(maxPayloadBytes) || maxPayloadBytes < 1) {
  throw new Error('org_plugin_manifest_invalid')
}
// 生产默认给宿主留最多 1s、最少 10% 的终止余量；测试使用更短宿主超时时，由宿主先终止慢 worker。
const workerTimeoutMs = hostTimeoutMs < manifestTimeout
  ? manifestTimeout
  : Math.max(1, hostTimeoutMs - Math.min(1000, Math.max(1, Math.ceil(hostTimeoutMs * 0.1))))

function timeoutSignal(ms) {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined
}

function reply(id, ok, data, code) {
  parentPort.postMessage(ok
    ? { id, ok: true, data }
    : { id, ok: false, error: { code, message: code } })
}

parentPort.on('message', async (message) => {
  const id = message?.id
  if (typeof id !== 'string' || !id) return
  const { procedure, input } = message
  if (!allowed.has(procedure)) {
    reply(id, false, undefined, 'org_plugin_procedure_denied')
    return
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    reply(id, false, undefined, 'org_plugin_payload_invalid')
    return
  }
  try {
    // 宿主已规范化；worker 再做一次并校验体积，覆盖未来非 orgPluginHost 的直接驱动者。
    const normalizedInput = normalizeWithinBudget(input, maxPayloadBytes, 'org_plugin_payload_too_large')
    if (jsonStringByteLength(normalizedInput) > maxPayloadBytes) {
      reply(id, false, undefined, 'org_plugin_payload_too_large')
      return
    }
    const url = trpcUrl(apiBase, procedure)
    const parsedUrl = new URL(url)
    const secure = isSecureUrl(parsedUrl, permissions.allowInsecureLoopback === true)
    if (!network.has(parsedUrl.origin) || !secure) {
      reply(id, false, undefined, 'org_plugin_network_denied')
      return
    }
    let response, data
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // 登录 token 只放在既有 tRPC JSON 输入中；禁止重定向把它带到其他源。
        body: JSON.stringify({ json: normalizedInput }),
        signal: timeoutSignal(workerTimeoutMs),
        redirect: 'error',
      })
      data = await readTrpcResponse(response, maxResponseBytes)
    } catch (error) {
      reply(id, false, undefined, upstreamErrorCode(error, 'org_plugin_upstream_unreachable'))
      return
    }
    reply(id, true, data)
  } catch (error) {
    reply(id, false, undefined, upstreamErrorCode(error, 'org_plugin_runtime_error'))
  }
})
