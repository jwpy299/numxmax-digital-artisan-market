const fs = require('node:fs')
const path = require('node:path')
const { Worker } = require('node:worker_threads')
const { SHELL_API_BASE } = require('./apiAllowlist.cjs')
const { isSecureUrl, jsonStringByteLength, normalizeJson, normalizeWithinBudget } = require('./org-transport/index.cjs')

const manifestPath = path.join(__dirname, 'plugins', 'numx-org-runtime', 'manifest.json')
const defaultManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

function positiveInt(value) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) throw new Error('org_plugin_manifest_invalid')
  return number
}

function normalizedApiBase(value, manifest) {
  let url
  try {
    url = new URL(String(value))
    if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error('shape')
  } catch {
    throw new Error('org_plugin_config_invalid')
  }
  const network = Array.isArray(manifest.permissions?.network) ? manifest.permissions.network : []
  const allowed = network.some((origin) => {
    try { return new URL(origin).origin === url.origin } catch { return false }
  })
  const secure = isSecureUrl(url, manifest.permissions?.allowInsecureLoopback === true)
  if (!allowed || !secure) throw new Error('org_plugin_network_denied')
  return url.origin
}

function validatePluginResponse(result, maxResponseBytes, maxIpcEnvelopeBytes) {
  const bodyLimit = positiveInt(maxResponseBytes)
  const envelopeLimit = positiveInt(maxIpcEnvelopeBytes)
  const normalized = normalizeWithinBudget(result, bodyLimit + envelopeLimit, 'org_plugin_response_too_large')
  if (jsonStringByteLength(normalized) > bodyLimit + envelopeLimit) throw new Error('org_plugin_response_too_large')
  return normalized
}

function create(options = {}) {
  // 测试可注入一份显式声明 loopback 权限的 manifest；生产主进程只使用打包内 manifest。
  const manifest = options.manifest || defaultManifest
  const manifestTimeout = positiveInt(manifest.permissions?.timeoutMs)
  const maxPayloadBytes = positiveInt(manifest.permissions?.maxPayloadBytes)
  const maxResponseBytes = positiveInt(manifest.permissions?.maxResponseBytes)
  const maxIpcEnvelopeBytes = positiveInt(manifest.permissions?.maxIpcEnvelopeBytes)
  const maxConcurrentRequests = positiveInt(manifest.permissions?.maxConcurrentRequests)
  if (!Array.isArray(manifest.allowedProcedures) || !manifest.allowedProcedures.length || manifest.allowedProcedures.some((value) => typeof value !== 'string' || !value)) throw new Error('org_plugin_manifest_invalid')
  if (!/^[a-zA-Z0-9._-]+\.cjs$/.test(String(manifest.entry || ''))) throw new Error('org_plugin_manifest_invalid')
  const apiBase = normalizedApiBase(options.apiBase || SHELL_API_BASE.org, manifest)
  const configuredTimeout = options.timeoutMs === undefined ? manifestTimeout : positiveInt(options.timeoutMs)
  const timeoutMs = Math.min(configuredTimeout, manifestTimeout)
  const allowedProcedures = new Set(manifest.allowedProcedures)
  const state = { worker: null, pending: new Map(), sequence: 0, closed: false }

  function rejectForWorker(worker, code) {
    for (const [id, entry] of state.pending) {
      if (entry.worker !== worker) continue
      state.pending.delete(id)
      clearTimeout(entry.timer)
      entry.reject(new Error(code))
    }
  }

  function stopWorker(worker, code) {
    if (!worker) return
    if (state.worker === worker) state.worker = null
    rejectForWorker(worker, code)
    void worker.terminate().catch(() => {})
  }

  function startWorker() {
    if (state.worker) return state.worker
    const worker = new Worker(path.join(__dirname, 'plugins', 'numx-org-runtime', manifest.entry || 'index.cjs'), {
      workerData: { manifest, apiBase, hostTimeoutMs: timeoutMs },
    })
    state.worker = worker
    worker.unref()
    worker.on('message', (result) => {
      const id = result?.id
      if (typeof id !== 'string') return
      const entry = state.pending.get(id)
      if (!entry || entry.worker !== worker) return
      let validated
      try { validated = validatePluginResponse(result, maxResponseBytes, maxIpcEnvelopeBytes) } catch (error) {
        state.pending.delete(id)
        clearTimeout(entry.timer)
        const code = error?.message === 'org_plugin_response_too_large' ? 'org_plugin_response_too_large' : 'org_plugin_response_invalid'
        entry.reject(new Error(code))
        stopWorker(worker, 'org_plugin_worker_restart')
        return
      }
      state.pending.delete(id)
      clearTimeout(entry.timer)
      entry.resolve({ ok: validated.ok === true, data: validated.data, error: validated.error })
    })
    worker.once('error', () => { stopWorker(worker, 'org_plugin_worker_error') })
    worker.once('exit', () => {
      if (state.worker === worker) state.worker = null
      rejectForWorker(worker, 'org_plugin_worker_exit')
    })
    return worker
  }

  return {
    invoke({ procedure, input } = {}) {
      if (state.closed) return Promise.reject(new Error('org_plugin_closed'))
      if (typeof procedure !== 'string' || !allowedProcedures.has(procedure)) {
        return Promise.reject(new Error('org_plugin_procedure_denied'))
      }
      if (input === undefined) input = {}
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return Promise.reject(new Error('org_plugin_payload_invalid'))
      }
      let normalizedInput, payloadBytes
      try {
        normalizedInput = normalizeWithinBudget(input, maxPayloadBytes, 'org_plugin_payload_too_large')
        payloadBytes = jsonStringByteLength(normalizedInput)
      } catch (error) {
        if (error?.message === 'org_plugin_payload_too_large') return Promise.reject(error)
        return Promise.reject(new Error('org_plugin_payload_invalid'))
      }
      if (payloadBytes > maxPayloadBytes) {
        return Promise.reject(new Error('org_plugin_payload_too_large'))
      }
      if (state.pending.size >= maxConcurrentRequests) {
        return Promise.reject(new Error('org_plugin_rate_limited'))
      }

      let worker
      try { worker = startWorker() } catch { return Promise.reject(new Error('org_plugin_worker_start_failed')) }
      const id = String(++state.sequence)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const entry = state.pending.get(id)
          if (!entry || entry.worker !== worker) return
          state.pending.delete(id)
          entry.reject(new Error('org_plugin_timeout'))
          stopWorker(worker, 'org_plugin_worker_restart')
        }, timeoutMs)
        timer.unref()
        state.pending.set(id, { worker, resolve, reject, timer })
        try { worker.postMessage({ id, procedure, input: normalizedInput }) } catch {
          state.pending.delete(id)
          clearTimeout(timer)
          reject(new Error('org_plugin_worker_post_failed'))
          stopWorker(worker, 'org_plugin_worker_post_failed')
        }
      })
    },
    close() {
      if (state.closed) return Promise.resolve()
      state.closed = true
      const worker = state.worker
      state.worker = null
      if (worker) rejectForWorker(worker, 'org_plugin_closed')
      return worker ? worker.terminate().catch(() => {}) : Promise.resolve()
    },
  }
}

module.exports = { create, normalizeJson, validatePluginResponse }
