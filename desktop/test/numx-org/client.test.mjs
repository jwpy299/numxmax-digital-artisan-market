import { test, beforeEach } from 'node:test';
import { spawnSync } from 'node:child_process';
import superjson from 'superjson';
import assert from 'node:assert/strict';
import { createClient, acquireRequestSlot, transport as resolvedTransport, assertActiveRequestsIdleForTest } from '../../src/plugins/numx-org/lib/client.js';
import { assertTransportShape } from '../../src/plugins/numx-org/lib/transport-loader.js';
import host from '../../src/orgPluginHost.cjs';
import { limits } from '../../src/plugins/numx-org/lib/contract.js';
import { API, okResponse } from './fixtures.mjs';

beforeEach(() => assertActiveRequestsIdleForTest());

test('客户端：tRPC 请求带 token、禁止重定向、保留 null', async () => {
  const calls = [];
  const client = createClient({
    apiBase: API,
    token: 'test-token',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return okResponse();
    },
  });
  const result = await client.postTrpc('entCabin.map', { dept: 'finance', token: 'injected-token-must-not-win' });
  assert.equal(result, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${API}/api/trpc/entCabin.map`);
  assert.equal(calls[0].init.redirect, 'error');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.json.token, 'test-token');
  assert.equal(body.json.dept, 'finance');
  await client.postTrpc('harnessProxy.delegate', { dept: 'finance' }, true);
  assert.equal(calls[1].url, `${API}/api/trpc/harnessProxy.delegate`);
  await assert.rejects(client.postTrpc('harnessProxy.delegate', {}, false), /org_plugin_read_denied/);
  await assert.rejects(client.postTrpc('entCabin.map', {}, true), /org_plugin_write_denied/);
  await assert.rejects(client.postTrpc('dshGovernance.propose', {}), /org_plugin_read_denied/);
  await assert.rejects(client.postTrpc('sms.sendCode', {}), /org_plugin_read_denied/);
  const anonymous = createClient({ apiBase: API, allowAnonymous: true, fetchImpl: async (url, init) => { calls.push({ url, init }); return okResponse(); } });
  await anonymous.postTrpc('sms.sendCode', { phone: '13800000000' });
  await assert.rejects(anonymous.postTrpc('entCabin.map', {}), /org_plugin_read_denied/);
  await assert.rejects(anonymous.postTrpc('harnessProxy.delegate', {}, true), /org_plugin_write_denied/);
  assert.equal(calls.length, 3, '只有独立匿名白名单可发公开请求，匿名写过程不得发出网络请求');
});

test('客户端：网络/传输异常归一稳定错误码', async () => {
  const redirect = new Error('fetch failed');
  redirect.cause = { code: 'ERR_REDIRECT' };
  const redirectClient = createClient({ apiBase: API, token: 'test-token', fetchImpl: async () => { throw redirect; } });
  await assert.rejects(redirectClient.postTrpc('entCabin.map'), /org_plugin_redirect_denied/);

  const timeout = new Error('aborted');
  timeout.name = 'TimeoutError';
  const timeoutClient = createClient({ apiBase: API, token: 'test-token', fetchImpl: async () => { throw timeout; } });
  await assert.rejects(timeoutClient.postTrpc('entCabin.map'), /org_plugin_upstream_timeout/);

  const unreachableClient = createClient({ apiBase: API, token: 'test-token', fetchImpl: async () => { throw new Error('socket closed'); } });
  await assert.rejects(unreachableClient.postTrpc('entCabin.map'), /org_plugin_upstream_unreachable/);
  const httpClient = createClient({ apiBase: API, token: 'test-token', fetchImpl: async () => new Response('{}', { status: 500 }) });
  await assert.rejects(httpClient.postTrpc('entCabin.map'), /org_plugin_upstream_http_500/);
  const bodyErrorClient = createClient({ apiBase: API, token: 'test-token', fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'bad' } }), { status: 200 }) });
  await assert.rejects(bodyErrorClient.postTrpc('entCabin.map'), /org_plugin_upstream_error/);
  const invalidClient = createClient({ apiBase: API, token: 'test-token', fetchImpl: async () => new Response('not-json', { status: 200 }) });
  await assert.rejects(invalidClient.postTrpc('entCabin.map'), /org_plugin_upstream_invalid_response/);
  const missingDataClient = createClient({ apiBase: API, token: 'test-token', fetchImpl: async () => new Response(JSON.stringify({ result: {} }), { status: 200 }) });
  await assert.rejects(missingDataClient.postTrpc('entCabin.map'), /org_plugin_upstream_invalid_response/);
  const timeoutCauseClient = createClient({ apiBase: API, token: 'test-token', fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { name: 'TimeoutError' } }); } });
  await assert.rejects(timeoutCauseClient.postTrpc('entCabin.map'), /org_plugin_upstream_timeout/);
  assert.throws(() => createClient({ apiBase: 'not-a-url', token: 'test-token' }), /org_plugin_network_denied/);
  assert.throws(() => createClient(), /org_plugin_network_denied/);
  assert.throws(() => createClient({ apiBase: API, token: 'x'.repeat(limits().tokenChars + 1) }), /org_plugin_token_too_long/);
});

test('客户端：纯 JSON 输入、声明长度上限与共享规范化实现', async () => {
  let fetchCalls = 0;
  const client = createClient({ apiBase: API, token: 'test-token', fetchImpl: async () => { fetchCalls += 1; return okResponse(); } });
  const cyclic = {};
  cyclic.self = cyclic;
  await assert.rejects(client.postTrpc('entCabin.map', cyclic), /org_plugin_payload_invalid/);
  await assert.rejects(client.postTrpc('entCabin.map', { bad: new Map() }), /org_plugin_payload_invalid/);
  await assert.rejects(client.postTrpc('entCabin.map', { bad: { toJSON() { return {}; } } }), /org_plugin_payload_invalid/);
  const accessor = Object.defineProperty({}, 'bad', { enumerable: true, get() { throw new Error('getter_must_not_run'); } });
  await assert.rejects(client.postTrpc('entCabin.map', accessor), /org_plugin_payload_invalid/);
  const accessorToJSON = Object.defineProperty({}, 'toJSON', { enumerable: true, get() { throw new Error('tojson_getter_must_not_run'); } });
  await assert.rejects(client.postTrpc('entCabin.map', accessorToJSON), /org_plugin_payload_invalid/);
  assert.equal(fetchCalls, 0);

  const oversized = createClient({
    apiBase: API,
    token: 'test-token',
    fetchImpl: async () => new Response('{}', { status: 200, headers: { 'content-length': String(limits().maxResponseBytes + 1) } }),
  });
  await assert.rejects(oversized.postTrpc('entCabin.map'), /org_plugin_response_too_large/);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(limits().maxResponseBytes + 1));
      controller.close();
    },
  });
  const streamingClient = createClient({ apiBase: API, token: 'test-token', fetchImpl: async () => new Response(stream, { status: 200 }) });
  await assert.rejects(streamingClient.postTrpc('entCabin.map'), /org_plugin_response_too_large/);
  await assert.rejects(client.postTrpc('entCabin.map', { blob: 'x'.repeat(limits().maxPayloadBytes) }), /org_plugin_payload_too_large/);
  const scalarIds = Array.from({ length: 12000 }, () => ({}));
  await client.postTrpc('entCabin.map', { ids: scalarIds });
  assert.equal(fetchCalls, 1, '容器列表不得被旧固定节点帽误杀');
  const rowBytes = JSON.stringify({ id: 1 }).length + 1;
  const envelopeBytes = Buffer.byteLength(JSON.stringify({ rows: [], token: 'test-token' }));
  const maxRows = Math.floor((limits().maxPayloadBytes - envelopeBytes) / rowBytes);
  await client.postTrpc('entCabin.map', { rows: Array.from({ length: maxRows - 16 }, () => ({ id: 1 })) });
  assert.equal(fetchCalls, 2, '超过旧节点帽但仍在字节预算内的输入必须允许');
  await assert.rejects(client.postTrpc('entCabin.map', { rows: Array.from({ length: maxRows + 16 }, () => ({ id: 1 })) }), /org_plugin_payload_too_large/);
  assert.equal(fetchCalls, 2, '超出字节预算的请求不得发出网络请求');
  assert.equal(host.normalizeJson, resolvedTransport.normalizeJson, '宿主与插件必须解析到同一个传输实现，而不是仅比较同源文件字节');
  assert.equal(typeof resolvedTransport.maxNodesForBytes, 'function', '传输加载器必须校验客户端实际调用的 maxNodesForBytes');
  const brokenTransport = { ...resolvedTransport };
  delete brokenTransport.maxNodesForBytes;
  assert.throws(() => assertTransportShape(brokenTransport), /org_plugin_transport_invalid:maxNodesForBytes/);
  assert.throws(() => resolvedTransport.normalizeJson([{}, {}], { maxNodes: 2 }), /org_plugin_nodes_exceeded/);
  assert.equal(resolvedTransport.upstreamErrorCode(new Error('org_plugin_nodes_exceeded')), 'org_plugin_payload_too_large');
  assert.throws(() => host.normalizeJson({ bad: new Map() }), /org_plugin_payload_invalid/);
  assert.throws(() => resolvedTransport.normalizeJson({ bad: new Map() }), /org_plugin_payload_invalid/);
});

test('客户端：跨客户端共享进程级并发上限，成功/失败后均释放名额', async () => {
  const resolvers = [];
  const client = createClient({
    apiBase: API,
    token: 'test-token',
    fetchImpl: () => new Promise((resolve) => resolvers.push(resolve)),
  });
  const otherModule = await import(new URL('../../src/plugins/numx-org/lib/client.js?instance=other', import.meta.url));
  const otherClient = otherModule.createClient({ apiBase: API, token: 'other-token', fetchImpl: async () => okResponse() });
  const pending = Array.from({ length: limits().maxConcurrentRequests }, () => client.postTrpc('entCabin.map').catch((error) => error));
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(resolvers.length, limits().maxConcurrentRequests);
    assert.throws(() => assertActiveRequestsIdleForTest(), /org_plugin_requests_active/, '测试复位不得把在途请求清零');
    await assert.rejects(otherClient.postTrpc('entCabin.map'), /org_plugin_rate_limited/);
  } finally {
    for (const resolve of resolvers) resolve(okResponse());
    let cleanupTimer;
    try {
      await Promise.race([
        Promise.allSettled(pending),
        new Promise((_, reject) => { cleanupTimer = setTimeout(() => reject(new Error('limiter_cleanup_timeout')), 2000); }),
      ]);
    } finally {
      clearTimeout(cleanupTimer);
    }
  }

  const failingClient = createClient({ apiBase: API, token: 'failure-token', fetchImpl: async () => { throw new Error('socket closed'); } });
  await assert.rejects(failingClient.postTrpc('entCabin.map'), /org_plugin_upstream_unreachable/);
  const recovered = await Promise.all(Array.from({ length: limits().maxConcurrentRequests }, () => otherClient.postTrpc('entCabin.map')));
  assert.deepEqual(recovered, Array.from({ length: limits().maxConcurrentRequests }, () => null), '失败后必须允许整批请求进入');
  resolvers.length = 0;
  const finalRequest = client.postTrpc('entCabin.map');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolvers.length, 1);
  resolvers[0](okResponse());
  await finalRequest;
});

test('客户端：等待队列有界、名额移交不重复自增且释放幂等', async () => {
  const initial = await Promise.all(Array.from({ length: limits().maxConcurrentRequests }, () => acquireRequestSlot({ queueIfBusy: true })));
  const queued = Array.from({ length: limits().maxQueuedRequests }, () => acquireRequestSlot({ queueIfBusy: true }));
  const acquired = [];
  try {
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(acquireRequestSlot({ queueIfBusy: true }), /org_plugin_rate_limited/);
    for (let index = 0; index < queued.length; index += 1) {
      const previous = index < initial.length ? initial[index] : acquired[index - initial.length];
      previous.release();
      acquired.push(await queued[index]);
    }
    for (const slot of acquired) { slot.release(); slot.release(); }
    assertActiveRequestsIdleForTest();
  } finally {
    for (const slot of acquired) slot.release();
    for (let index = 0; index < queued.length; index += 1) {
      try { (await queued[index]).release(); } catch { /* 已取消/已超时的等待者无需再释放 */ }
    }
    for (const slot of acquired) slot.release();
  }
});

test('客户端：调用方取消沿合并信号中断 fetch，且与上游超时不同码', async () => {
  const controller = new AbortController();
  const client = createClient({
    apiBase: API,
    token: 'test-token',
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('abort_not_forwarded')), 2000);
      init.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(init.signal.reason);
      }, { once: true });
    }),
  });
  const pending = client.postTrpc('entCabin.map', {}, false, controller.signal);
  controller.abort();
  await assert.rejects(pending, /org_plugin_cancelled/);
  const timeoutClient = createClient({
    apiBase: API,
    token: 'test-token',
    fetchImpl: async () => { const error = new Error('upstream timeout'); error.name = 'TimeoutError'; throw error; },
  });
  await assert.rejects(timeoutClient.postTrpc('entCabin.map'), /org_plugin_upstream_timeout/);
});

test('传输边界：maxBytes、过程名和 superjson 信封都显式校验', async () => {
  let cancelled = false;
  const errorResponse = { ok: false, status: 500, body: { cancel: async () => { cancelled = true; } }, headers: new Headers() };
  await assert.rejects(resolvedTransport.readTrpcResponse(errorResponse, 1024), /org_plugin_upstream_http_500/);
  assert.equal(cancelled, true, '非 2xx 先取消流，不缓冲完整错误页');
  await assert.rejects(resolvedTransport.readBoundedText(new Response('{}'), undefined), /org_plugin_manifest_invalid/);
  await assert.rejects(resolvedTransport.readBoundedText(new Response('{}'), -1), /org_plugin_manifest_invalid/);
  assert.throws(() => resolvedTransport.trpcUrl(API, 'bad procedure'), /org_plugin_procedure_denied/);
  const payload = { result: { data: { json: 'payload', other: 1 } } };
  const client = createClient({ apiBase: API, token: 'test-token', fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200 }) });
  assert.deepEqual(await client.postTrpc('entCabin.map'), { json: 'payload', other: 1 });
  const businessClient = createClient({ apiBase: API, token: 'test-token', fetchImpl: async () => new Response(JSON.stringify({ result: { data: { json: { json: 'business' } } } }), { status: 200 }) });
  assert.deepEqual(await businessClient.postTrpc('entCabin.map'), { json: 'business' }, '单键业务 JSON 不得被二次解包');
  const shared = { value: 1 };
  const rich = { createdAt: new Date('2024-01-01T00:00:00.000Z'), big: 123n, map: new Map([['a', 1]]), set: new Set([1, 2]), left: shared, right: shared };
  const richClient = createClient({ apiBase: API, token: 'test-token', fetchImpl: async () => new Response(JSON.stringify({ result: { data: superjson.serialize(rich) } }), { status: 200 }) });
  const revived = await richClient.postTrpc('entCabin.map');
  assert.equal(revived.createdAt instanceof Date, true);
  assert.equal(typeof revived.big, 'bigint');
  assert.equal(revived.map instanceof Map, true);
  assert.equal(revived.set instanceof Set, true);
  assert.equal(revived.left === revived.right, true, 'revive 必须保留合法的共享引用');
  const rootDate = await resolvedTransport.readTrpcResponse(new Response(JSON.stringify({ result: { data: superjson.serialize(new Date('2024-01-01T00:00:00.000Z')) } }), { status: 200 }), 1024, { revive: true });
  assert.equal(rootDate instanceof Date, true, '根路径空字符串也属于合法 superjson 元数据');
  for (const meta of [
    { values: { createdAt: 'Date' } },
    { values: { createdAt: ['__proto__'] } },
    { v: 2 },
  ]) {
    await assert.rejects(resolvedTransport.readTrpcResponse(new Response(JSON.stringify({ result: { data: { json: {}, meta } } }), { status: 200 }), 1024, { revive: true }), /org_plugin_upstream_invalid_response/);
  }
  const plainRich = await resolvedTransport.readTrpcResponse(new Response(JSON.stringify({ result: { data: superjson.serialize(rich) } }), { status: 200 }), 1024);
  const plainDecimal = await resolvedTransport.readTrpcResponse(new Response(JSON.stringify({ result: { data: { json: { amount: '1.23' }, meta: { values: { amount: ['Decimal'] } } } } }), { status: 200 }), 1024);
  assert.equal(plainDecimal.amount, '1.23', 'Decimal 的 JSON 数值字符串可以保真透传');
  assert.equal(plainRich.createdAt, '2024-01-01T00:00:00.000Z');
  assert.equal(plainRich.big, '123');
  assert.equal(Array.isArray(plainRich.map), true);
  await assert.rejects(resolvedTransport.readTrpcResponse(new Response(JSON.stringify({ result: { data: { json: {}, meta: { values: { when: ['RegExp'] } } } } }), { status: 200 }), 1024), /org_plugin_upstream_invalid_response/, '不兼容的类型元数据不得静默降级');
  for (const meta of [{}, { values: {} }]) {
    const business = await resolvedTransport.readTrpcResponse(new Response(JSON.stringify({ result: { data: { json: 'business', meta } } }), { status: 200 }), 1024);
    assert.equal(business, 'business', '空 meta/values 是合法 tRPC 信封，应返回 json 内容');
  }
  const nonEnvelope = await resolvedTransport.readTrpcResponse(new Response(JSON.stringify({ result: { data: { json: 'business', meta: [] } } }), { status: 200 }), 1024);
  assert.deepEqual(nonEnvelope, { json: 'business', meta: [] });
  assert.equal(resolvedTransport.trpcUrl(API, 'entCabin.map', '/proxy/trpc/'), `${API}/proxy/trpc/entCabin.map`);
  assert.throws(() => resolvedTransport.trpcUrl(API, 'entCabin.map', 'https://example.invalid/'), /org_plugin_procedure_denied/);
  assert.throws(() => resolvedTransport.trpcUrl(API, 'entCabin.map', '/%2e%2e/'), /org_plugin_procedure_denied/);
  assert.throws(() => resolvedTransport.trpcUrl(API, 'entCabin.map', '/%2e%2e%2fsecret/'), /org_plugin_procedure_denied/);
});

test('客户端：全局对象不可扩展时并发守门返回稳定错误', () => {
  const clientUrl = new URL('../../src/plugins/numx-org/lib/client.js', import.meta.url).href;
  const source = `
    Object.preventExtensions(globalThis);
    const { createClient } = await import(${JSON.stringify(clientUrl)});
    const client = createClient({ apiBase: ${JSON.stringify(API)}, token: 'locked-global', fetchImpl: async () => { throw new Error('fetch_must_not_run'); } });
    try {
      await client.postTrpc('entCabin.map');
      throw new Error('expected_rejection');
    } catch (error) {
      if (error?.message !== 'org_plugin_concurrency_unavailable') throw error;
    }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module'], { input: source, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
