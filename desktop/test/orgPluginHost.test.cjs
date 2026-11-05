const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const { create, normalizeJson, validatePluginResponse } = require('../src/orgPluginHost.cjs')
const { jsonStringByteLength, maxNodesForBytes } = require('../src/org-transport/index.cjs')
const productionManifest = require('../src/plugins/numx-org-runtime/manifest.json')
const superjson = require('superjson')

function manifestFor(apiBase) {
  return {
    ...productionManifest,
    permissions: {
      ...productionManifest.permissions,
      network: [apiBase],
      allowInsecureLoopback: true,
    },
  }
}

async function listen(source, options = {}) {
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url })
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const input = JSON.parse(raw || '{}').json || {}
      const respond = () => {
        if (input.mode === 'redirect') {
          res.writeHead(307, { location: options.redirectTo || '/api/trpc/harnessProxy.healthz' })
          res.end()
          return
        }
        if (input.mode === 'null') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ result: { data: { json: null } } }))
          return
        }
        if (input.mode === 'emptyMeta') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ result: { data: { json: { value: 1 }, meta: { values: {} } } } }))
          return
        }
        if (input.mode === 'rich') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            result: {
              data: superjson.serialize({
                when: new Date('2024-01-01T00:00:00.000Z'),
                big: 123n,
                map: new Map([['a', 1]]),
              }),
            },
          }))
          return
        }
        if (input.mode === 'http500') {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ message: 'upstream failed' }))
          return
        }
        if (input.mode === 'trpcError') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { json: { message: 'sensitive upstream detail' } } }))
          return
        }
        if (input.mode === 'big') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ result: { data: { json: { big: 'x'.repeat(productionManifest.permissions.maxResponseBytes + 1) } } } }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ result: { data: { json: {
          ok: true,
          marker: input.marker || '',
          tokenEcho: input.token || '',
          source,
        } } } }))
      }
      if (input.delayMs) setTimeout(respond, input.delayMs)
      else respond()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const apiBase = `http://127.0.0.1:${server.address().port}`
  return { server, apiBase, requests, close: () => new Promise((resolve) => server.close(resolve)) }
}

function inputWithBytes(target) {
  const input = { token: '' }
  const base = Buffer.byteLength(JSON.stringify(input))
  input.token = 'x'.repeat(target - base)
  assert.equal(Buffer.byteLength(JSON.stringify(input)), target)
  return input
}

function invoke(host, input = {}) {
  return host.invoke({ procedure: 'harnessProxy.healthz', input })
}

test('org 插件：网络/过程/载荷权限真实执行，token 走 tRPC JSON 输入', async () => {
  const peer = await listen('A')
  const manifest = manifestFor(peer.apiBase)
  const host = create({ apiBase: peer.apiBase, manifest, timeoutMs: 1000 })
  try {
    assert.throws(() => create({ apiBase: 'https://example.com', manifest }), /org_plugin_network_denied/)
    assert.throws(() => create({ apiBase: 'http://example.com', manifest: {
      ...manifest,
      permissions: { ...manifest.permissions, network: ['http://example.com'] },
    } }), /org_plugin_network_denied/)
    await assert.rejects(host.invoke({ procedure: 'harnessProxy.notReal', input: {} }), /org_plugin_procedure_denied/)
    await assert.rejects(invoke(host, null), /org_plugin_payload_invalid/)
    await assert.rejects(invoke(host, { buffer: Buffer.alloc(1024) }), /org_plugin_payload_invalid/)
    assert.throws(() => normalizeJson({ map: new Map([['x', 1]]) }), /org_plugin_payload_invalid/)
    assert.equal(normalizeJson({ cursor: undefined, limit: 20 }).limit, 20)
    const shared = { value: 1 }
    assert.throws(() => normalizeJson({ left: shared, right: shared }), /org_plugin_payload_invalid/)
    assert.throws(() => validatePluginResponse({ id: '1', ok: true, data: { text: 'x'.repeat(100) } }, 10, 10), /org_plugin_response_too_large/)
    assert.throws(() => validatePluginResponse({ id: '1', ok: true, data: Array.from({ length: 15000 }, () => ({})) }, 20000, 1000), /org_plugin_response_too_large/, '节点帽溢出也必须报响应过大，而不是响应格式错误')
    const accepted = validatePluginResponse({ id: '1', ok: true, data: { text: 'x'.repeat(100) } }, 1, 200)
    assert.equal(accepted.ok, true, 'IPC 信封预算是独立正数，不是 NaN 或单限值')
    const manyTiny = { id: '1', ok: true, data: Array.from({ length: 100001 }, () => ({ id: 1 })) }
    assert.ok(Buffer.byteLength(JSON.stringify(manyTiny)) <= productionManifest.permissions.maxResponseBytes + productionManifest.permissions.maxIpcEnvelopeBytes)
    assert.equal(validatePluginResponse(manyTiny, productionManifest.permissions.maxResponseBytes, productionManifest.permissions.maxIpcEnvelopeBytes).data.length, 100001, '字节预算内的许多小对象不得被更低节点帽误杀')
    const wideEnvelope = { id: '1', ok: true, data: Array.from({ length: 15000 }, () => ({})) }
    assert.ok(Buffer.byteLength(JSON.stringify(wideEnvelope)) <= 120000)
    assert.equal(validatePluginResponse(wideEnvelope, 20000, 100000).data.length, 15000, '节点帽必须覆盖 body+envelope 的总预算')
    assert.throws(() => validatePluginResponse({ id: '1', ok: true, data: new Map() }, 10, 10), /org_plugin_payload_invalid/)
    assert.throws(() => validatePluginResponse({ id: '1', ok: true }, Number.NaN, 10), /org_plugin_manifest_invalid/)
    const proto = normalizeJson(JSON.parse('{"__proto__":{"polluted":true}}'))
    assert.ok(Object.hasOwn(proto, '__proto__'))
    assert.equal({}.polluted, undefined)
    class CustomArray extends Array {}
    assert.throws(() => normalizeJson(new CustomArray()), /org_plugin_payload_invalid/)
    assert.throws(() => normalizeJson(Number.NaN), /org_plugin_payload_invalid/)
    const sparse = [1]; sparse[2] = 3
    assert.throws(() => normalizeJson(sparse), /org_plugin_payload_invalid/)
    let deep = {}; for (let i = 0; i < 102; i += 1) deep = { nested: deep }
    assert.throws(() => normalizeJson(deep), /org_plugin_payload_invalid/)
    assert.throws(() => create({ apiBase: 'not-a-url', manifest }), /org_plugin_config_invalid/)

    const smallManifest = manifestFor(peer.apiBase)
    smallManifest.permissions.maxPayloadBytes = 1000
    const smallHost = create({ apiBase: peer.apiBase, manifest: smallManifest, timeoutMs: 1000 })
    try {
      await assert.rejects(invoke(smallHost, { rows: Array.from({ length: 10001 }, () => ({})) }), /org_plugin_payload_too_large/)
    } finally {
      await smallHost.close()
    }
    const max = productionManifest.permissions.maxPayloadBytes
    const manyRows = Array.from({ length: 12000 }, () => ({ id: 1 }))
    assert.ok(jsonStringByteLength(normalizeJson({ rows: manyRows }, { maxNodes: maxNodesForBytes(max) })) < max)
    const manyInput = await invoke(host, { rows: manyRows })
    assert.equal(manyInput.ok, true, '宿主与 worker 都不得用默认 10000 节点帽误杀合法输入')
    const under = await invoke(host, inputWithBytes(max - 1))
    assert.equal(under.ok, true)
    await assert.rejects(invoke(host, inputWithBytes(max + 1)), /org_plugin_payload_too_large/)

    const authed = await invoke(host, { token: 'test-session', marker: 'auth' })
    assert.equal(authed.data.tokenEcho, 'test-session')
    assert.equal(authed.data.source, 'A')
    const withUndefined = await invoke(host, { cursor: undefined, marker: 'undefined-ok' })
    assert.equal(withUndefined.ok, true)
    assert.equal(withUndefined.data.marker, 'undefined-ok')
  } finally {
    await host.close()
    await peer.close()
  }
})

test('org 插件：并发按请求 ID 配对，宿主/后端隔离且上游边界不伪装成功', async () => {
  const a = await listen('A')
  const b = await listen('B')
  const hostA = create({ apiBase: a.apiBase, manifest: manifestFor(a.apiBase), timeoutMs: 1000 })
  const hostB = create({ apiBase: b.apiBase, manifest: manifestFor(b.apiBase), timeoutMs: 1000 })
  try {
    const [slow, fast] = await Promise.all([
      invoke(hostA, { marker: 'slow', delayMs: 80 }),
      invoke(hostA, { marker: 'fast' }),
    ])
    assert.equal(slow.data.marker, 'slow')
    assert.equal(fast.data.marker, 'fast')
    assert.equal(slow.data.source, 'A')
    assert.equal(fast.data.source, 'A')

    const [fromA, fromB] = await Promise.all([
      invoke(hostA, { marker: 'host-A' }),
      invoke(hostB, { marker: 'host-B' }),
    ])
    assert.equal(fromA.data.source, 'A')
    assert.equal(fromB.data.source, 'B')

    const httpError = await invoke(hostA, { mode: 'http500' })
    assert.equal(httpError.ok, false)
    assert.equal(httpError.error.code, 'org_plugin_upstream_http_500')
    const trpcError = await invoke(hostA, { mode: 'trpcError' })
    assert.equal(trpcError.ok, false)
    assert.equal(trpcError.error.code, 'org_plugin_upstream_error')
    assert.equal(trpcError.error.message, 'org_plugin_upstream_error')
    const tooLarge = await invoke(hostA, { mode: 'big' })
    assert.equal(tooLarge.ok, false)
    assert.equal(tooLarge.error.code, 'org_plugin_response_too_large')
    const nullResult = await invoke(hostA, { mode: 'null' })
    assert.equal(nullResult.ok, true)
    assert.equal(nullResult.data, null)
    const emptyMeta = await invoke(hostA, { mode: 'emptyMeta' })
    assert.equal(emptyMeta.ok, true, '空 values 属于业务元数据，不得误判为需要 revive 的类型信封')
    assert.equal(emptyMeta.data.value, 1)
    const richResult = await invoke(hostA, { mode: 'rich' })
    assert.equal(richResult.ok, true, 'Date/BigInt/Map/Set 的既有 JSON 表示可以保真透传')
    assert.equal(typeof richResult.data.when, 'string')
    assert.equal(typeof richResult.data.big, 'string')
    assert.equal(Array.isArray(richResult.data.map), true)
  } finally {
    await Promise.all([hostA.close(), hostB.close()])
    await Promise.all([a.close(), b.close()])
  }
})

test('org 插件：重定向不透 token，manifest 与并发上限 fail-closed', async () => {
  const target = await listen('TARGET')
  const origin = await listen('ORIGIN', { redirectTo: `${target.apiBase}/api/trpc/harnessProxy.healthz` })
  const manifest = manifestFor(origin.apiBase)
  manifest.permissions.maxConcurrentRequests = 2
  const host = create({ apiBase: origin.apiBase, manifest, timeoutMs: 1000 })
  try {
    const redirected = await invoke(host, { mode: 'redirect', token: 'test-session' })
    assert.equal(redirected.ok, false)
    assert.equal(redirected.error.code, 'org_plugin_redirect_denied')
    assert.equal(target.requests.length, 0, '重定向目标不得收到含 token 的 POST')

    const pending = await Promise.allSettled([
      invoke(host, { marker: 'one', delayMs: 150 }),
      invoke(host, { marker: 'two', delayMs: 150 }),
      invoke(host, { marker: 'three', delayMs: 150 }),
    ])
    assert.equal(pending.filter((item) => item.status === 'rejected' && /org_plugin_rate_limited/.test(item.reason.message)).length, 1)
    assert.throws(() => create({ apiBase: origin.apiBase, manifest: {
      ...manifest,
      permissions: { ...manifest.permissions, timeoutMs: Number.NaN },
    } }), /org_plugin_manifest_invalid/)

    const ipv6Manifest = manifestFor('http://[::1]:65535')
    const ipv6Host = create({ apiBase: 'http://[::1]:65535', manifest: ipv6Manifest })
    await ipv6Host.close()
  } finally {
    await host.close()
    await Promise.all([origin.close(), target.close()])
  }
})

test('org 插件：worker 自身上游超时返回明确错误且后续可调用', async () => {
  const peer = await listen('A')
  const manifest = manifestFor(peer.apiBase)
  manifest.permissions.timeoutMs = 1000
  const host = create({ apiBase: peer.apiBase, manifest, timeoutMs: 1000 })
  try {
    const timedOut = await invoke(host, { delayMs: 2000 })
    assert.equal(timedOut.ok, false)
    assert.equal(timedOut.error.code, 'org_plugin_upstream_timeout')
    const recovered = await invoke(host, { marker: 'after-worker-timeout' })
    assert.equal(recovered.ok, true)
    assert.equal(recovered.data.marker, 'after-worker-timeout')
  } finally {
    await host.close()
    await peer.close()
  }
})


test('org 插件：worker 网络不可达返回统一上游错误码', async () => {
  const peer = await listen('UNREACHABLE')
  let host
  try {
    host = create({ apiBase: peer.apiBase, manifest: manifestFor(peer.apiBase), timeoutMs: 1000 })
    await peer.close()
    const result = await invoke(host, { marker: 'connection-refused' })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'org_plugin_upstream_unreachable')
  } finally {
    if (host) await host.close()
    else await peer.close()
  }
})

test('org 主进程桥：仅 org 加载行为件并在托盘退出时关闭宿主', () => {
  const main = fs.readFileSync(require.resolve('../src/main.cjs'), 'utf8')
  assert.ok(main.includes('shellKey === "org" ? require("./orgPluginHost.cjs").create() : null'))
  assert.ok(main.includes('require("./orgRuntimeIpc.cjs")'))
  assert.ok(main.includes('void orgRuntimeHost?.close(); app.exit(0);'))
})

test('org 插件：超时终止后可重建恢复，close 会拒绝在途请求', async () => {
  const peer = await listen('A')
  const host = create({ apiBase: peer.apiBase, manifest: manifestFor(peer.apiBase), timeoutMs: 300 })
  try {
    const warm = await invoke(host, { marker: 'warm' })
    assert.equal(warm.data.marker, 'warm')
    const timedOut = await Promise.allSettled([
      invoke(host, { marker: 'slow-a', delayMs: 1000 }),
      invoke(host, { marker: 'slow-b', delayMs: 2000 }),
    ])
    const codes = timedOut.map((item) => item.status === 'rejected' ? item.reason.message : 'unexpected_success').sort()
    assert.deepEqual(codes, ['org_plugin_timeout', 'org_plugin_worker_restart'].sort(), '超时不把同 worker 的其他请求也谎报为自身超时')
    const recovered = await invoke(host, { marker: 'after-timeout' })
    assert.equal(recovered.ok, true)
    assert.equal(recovered.data.marker, 'after-timeout')

    const pending = invoke(host, { marker: 'pending-close', delayMs: 1000 })
    const rejection = assert.rejects(pending, /org_plugin_closed/)
    await host.close()
    await rejection
    await assert.rejects(invoke(host, {}), /org_plugin_closed/)
  } finally {
    await host.close()
    await peer.close()
  }
})
