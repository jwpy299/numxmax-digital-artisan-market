import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import superjson from 'superjson';
import vm from 'node:vm';
import { registerOrgUi, __test } from '../../src/plugins/numx-org/lib/ui-routes.js';
import { limits } from '../../src/plugins/numx-org/lib/contract.js';
import { loginWithToken, disposeSessions } from '../../src/plugins/numx-org/lib/session.js';
import { assertActiveRequestsIdleForTest } from '../../src/plugins/numx-org/lib/client.js';
import { API, okResponse } from './fixtures.mjs';

function makeContext(options = {}) {
  const routes = new Map();
  const injections = [];
  const calls = [];
  const disposals = [];
  const registrationOrder = [];
  const activity = { active: 0, maxActive: 0 };
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/agentic.authLogin')) {
      return new Response(JSON.stringify({ result: { data: { json: { token: 'nt_real', user: { id: 42 } } } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (String(url).endsWith('/orgPlugin.installTicket')) {
      const payload = { result: { data: { json: { ok: true, ticketId: 'ticket-1', ticket: 'st_probe', expiresInSeconds: 120, pack: { id: 'dept-finance', version: '0.1.0', sha256: 'a'.repeat(64), channel: 'development' } } } } };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (String(url).endsWith('/orgPlugin.installConfirm')) {
      const payload = { result: { data: { json: { ok: true, installId: 77, status: 'active' } } } };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (String(url).endsWith('/orgPlugin.workspaces')) {
      const payload = { result: { data: { json: { currentDeptId: 'd1', packChannels: ['development'], cabins: [{ cabinCode: 'finance', cabinName: '财务舱', role: 'manager', activation: 'eligible', employeeInstallRequired: false, pack: { id: 'dept-finance', version: '0.1.0', channel: 'development' }, capabilities: ['plugin.install'] }] } } } };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (String(url).endsWith('/entCabin.map')) {
      if (options.richMap) return new Response(JSON.stringify({ result: { data: superjson.serialize({ createdAt: new Date('2024-01-01T00:00:00.000Z'), big: 123n, map: new Map([['a', 1]]), set: new Set([1, 2]) }) } }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (options.slowMap) {
        activity.active += 1;
        activity.maxActive = Math.max(activity.maxActive, activity.active);
        await new Promise((resolve) => setTimeout(resolve, 30));
        activity.active -= 1;
      }
      return new Response(JSON.stringify({ result: { data: { json: { cabins: [{ code: 'finance' }] } } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (String(url).includes('/api/invite-qr')) {
      return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), { status: 200, headers: { 'content-type': 'image/png' } });
    }
    if (String(url).includes('bad.svg')) {
      return new Response('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', { status: 200, headers: { 'content-type': 'image/svg+xml' } });
    }
    if (String(url).includes('/api/org-artifact')) {
      if (options.streamError) return new Response(new ReadableStream({ pull(controller) { controller.error(new Error('probe_stream_read')); } }), { status: 200, headers: { 'content-type': 'application/pdf' } });
      return new Response(Buffer.from('%PDF-1.7'), { status: 200, headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="a.pdf"' } });
    }
    return okResponse();
  };
  const ctx = {
    connection: {
      fetch: {
        register(route) {
          assert.ok(route.path.startsWith('/api/'));
          assert.ok(!routes.has(route.path), `duplicate route ${route.path}`);
          if (options.failAt === routes.size + 1) throw new Error('probe_register_failure');
          routes.set(route.path, route);
          registrationOrder.push(route.path);
          return async () => { disposals.push(route.path); routes.delete(route.path); };
        },
      },
    },
    on(event, listener) {
      assert.equal(event, 'webserver/index-inject');
      injections.push(listener);
      registrationOrder.push(event);
      return () => { disposals.push(event); injections.splice(injections.indexOf(listener), 1); };
    },
    credentials: {
      readRecord: async () => undefined,
      deleteRecord: async () => {},
      modifyRecord: async () => {},
    },
  };
  if (options.authenticated !== false) loginWithToken('host-token', 'dsh-org-ui', {}, ctx);
  const dispatch = async (path, init = {}) => {
    const request = new Request(`http://numx.local${path}`, init);
    const route = routes.get(new URL(request.url).pathname);
    if (!route || !route.methods.includes(request.method)) return new Response('not found', { status: 404 });
    return route.fetch(request);
  };
  const registerUi = async () => {
    const dispose = await registerOrgUi(ctx, { fetchImpl });
    return async () => { await dispose(); disposeSessions(ctx); };
  };
  return { ctx, routes, injections, calls, disposals, registrationOrder, dispatch, registerUi, activity };
}

function postJson(value) {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) };
}

test('DSH UI：原三屏与第四编排屏经 Connection 精确路由提供，各屏独立状态', async () => {
  const { routes, injections, dispatch, registerUi } = makeContext();
  const dispose = await registerUi();
  try {
    const script = await dispatch('/api/numx-org/ui.js');
    assert.equal(script.status, 200);
    const scriptBody = await script.text();
    assert.match(scriptBody, /data-org-view/);
    assert.match(scriptBody, /event\.origin !== window\.location\.origin/);

    const index = await dispatch('/api/numx-org/org/index.html');
    const indexBody = await index.text();
    assert.match(indexBody, /ag-login|组织智能运行时|组织运行时/);
    assert.match(indexBody, /navigateOrgView\('station', query\)/);
    assert.doesNotMatch(indexBody, /\.\.\/logo-mark\.png/);
    const cabin = await dispatch('/api/numx-org/org/cabin.html');
    const cabinBody = await cabin.text();
    assert.doesNotMatch(cabinBody, /https?:\/\/[^"'`\s]+\/api\/invite-qr/);
    assert.match(cabinBody, /canManageCabin|BINARY_API_BASE/);
    assert.match(cabinBody, /id="workspace-strip"/);
    assert.match(cabinBody, /loadWorkspaceDirectory\(\)/);
    assert.match(cabinBody, /\$\{BINARY_API_BASE\}\/invite-qr/);
    assert.match(cabinBody, /\$\{BINARY_API_BASE\}\/org-artifact/);
    assert.doesNotMatch(cabinBody, /\$\{BINARY_API_BASE\}\/api\/(invite-qr|org-artifact)/);
    const boot = await dispatch('/api/numx-org/org/org-boot.js');
    assert.equal(boot.status, 200);
    const bootBody = await boot.text();
    assert.match(bootBody, /function parseOrgTimestamp/);
    assert.match(bootBody, /async function apiRaw|AUTH_QUERY_TOKEN/);
    assert.match(bootBody, /function setBadgeFor|function pollNotices/);
    assert.match(bootBody, /function navigateOrgView/);
    assert.match(bootBody, /location\.assign\(`\$\{targetPage\}\?\$\{query\}`\)/);
    const parseTimestamp = new Function('location', 'window', 'document', 'localStorage', 'history', `${bootBody}; return parseOrgTimestamp;`)(
      { search: '', protocol: 'https:', pathname: '/org/index.html', href: 'https://numx.local/org/index.html' },
      {}, { addEventListener() {} }, { getItem() { return null; } }, { replaceState() {} },
    );
    assert.equal(parseTimestamp('2026-10-30 07:41:00'), Date.parse('2026-10-30T07:41:00Z'));
    assert.equal(parseTimestamp('2026-10-30 07:41:00Z'), Date.parse('2026-10-30T07:41:00Z'));
    assert.equal(parseTimestamp('2026-10-30T07:41:00+08:00'), Date.parse('2026-10-30T07:41:00+08:00'));
    assert.equal(parseTimestamp('not-a-date'), null);
    assert.match(bootBody, /const\s+BINARY_API_BASE\s*=\s*DSH_UI_PATH\s*\?\s*`\$\{API_BASE\}\/api\/numx-org`\s*:\s*`\$\{API_BASE\}\/api`/, `必须钉住 DSH 与普通宿主两种二进制前缀: ${bootBody.match(/const\s+BINARY_API_BASE[^;]*;/)?.[0] || 'missing'}`);
    assert.doesNotMatch(bootBody, /file:.*https:\/\/wb\./);
    const station = await dispatch('/api/numx-org/org/station.html');
    assert.equal(station.status, 200);
    const runtime = await dispatch('/api/numx-org/org/runtime.html');
    const runtimeBody = await runtime.text();
    assert.match(runtimeBody, /多 Agent 自然语言编排/);
    assert.match(runtimeBody, /agentRuntime.createPlan/);
    const stationBody = await station.text();
    assert.match(stationBody, /submitReview\(index\)|recoverExpiredSession/);
    assert.match(stationBody, /openTasks|stationKey/);
    const head = await dispatch('/api/numx-org/org/index.html', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');

    assert.equal(injections.length, 1);
    const rows = [];
    injections[0](rows);
    const html = rows.find((row) => row.kind === 'html')?.html || '';
    assert.match(html, /numx-org-runtime/);
    assert.equal((html.match(/data-org-frame=/g) || []).length, 4);
    assert.match(html, /data-org-frame="runtime"/);
    assert.ok(rows.some((row) => row.kind === 'script-src' && row.src === '/api/numx-org/ui.js'));
  } finally {
    await dispose();
  }
  assert.equal(routes.size, 0);
  assert.equal(injections.length, 0);
});

test('DSH UI：登录不替换宿主 token，组织读取复用真实宿主会话且信封只解一层', async () => {
  const { calls, dispatch, registerUi } = makeContext();
  const dispose = await registerUi();
  try {
    const login = await dispatch('/api/trpc/agentic.authLogin', postJson({ json: { identifier: 'u', password: 'p' } }));
    assert.equal(login.status, 200);
    assert.equal((await login.json()).result.data.json.token, 'nt_real');
    assert.equal(calls.at(-1).url, `${API}/api/trpc/agentic.authLogin`);
    assert.deepEqual(JSON.parse(calls.at(-1).init.body).json, { identifier: 'u', password: 'p' });

    const mapped = await dispatch('/api/trpc/entCabin.map', postJson({ json: {} }));
    assert.deepEqual((await mapped.json()).result.data.json.cabins, [{ code: 'finance' }]);
    assert.deepEqual(JSON.parse(calls.at(-1).init.body).json, { token: 'host-token' });
  } finally {
    await dispose();
  }
});

test('DSH UI：仅显式公开过程允许匿名，注册与口令链完整直传 WB', async () => {
  const { calls, dispatch, registerUi } = makeContext();
  const dispose = await registerUi();
  try {
    for (const [procedure, input] of [
      ['agentic.authRegister', { username: 'u', password: 'p', betaCode: 'iv_invalid' }],
      ['betaDaily.today', { token: 'must-not-forward' }],
      ['sms.sendCode', { phone: '13800000000', purpose: 'register' }],
      ['betaDaily.redeem', { codeText: 'probe', phone: '13800000000', smsCode: '000000' }],
    ]) {
      const response = await dispatch(`/api/trpc/${procedure}`, postJson({ json: input }));
      assert.equal(response.status, 200, procedure);
      assert.deepEqual(JSON.parse(calls.at(-1).init.body).json, procedure === 'betaDaily.today' ? {} : input);
      assert.equal(calls.at(-1).url, `${API}/api/trpc/${procedure}`);
    }
  } finally {
    await dispose();
  }
});

test('DSH UI：私有过程无真实会话返回 401，跨域与非 JSON 请求在上游前拒绝', async () => {
  const { calls, dispatch, registerUi } = makeContext({ authenticated: false });
  const dispose = await registerUi();
  try {
    const required = await dispatch('/api/trpc/entCabin.map', postJson({ json: {} }));
    assert.equal(required.status, 401);
    assert.match(await required.text(), /org_plugin_session_required/);
    const crossOrigin = await dispatch('/api/trpc/agentic.authLogin', {
      ...postJson({ json: { identifier: 'u', password: 'p' } }),
      headers: { 'content-type': 'application/json', origin: 'https://evil.invalid', 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(crossOrigin.status, 403);
    const plain = await dispatch('/api/trpc/agentic.authLogin', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"json":{}}' });
    assert.equal(plain.status, 415);
    assert.equal(calls.length, 0);
    assert.equal(__test.errorStatus(new Error('org_plugin_rate_limited')), 429);
  } finally {
    await dispose();
  }
});

test('DSH UI：未知过程、路径穿越、错误 JSON 与流式超限全部 fail-closed', async () => {
  const { calls, routes, dispatch, registerUi } = makeContext();
  const dispose = await registerUi();
  try {
    const denied = await dispatch('/api/trpc/not.allowed', postJson({ json: {} }));
    assert.equal(denied.status, 404);
    assert.equal(routes.has('/api/trpc/not.allowed'), false);
    assert.throws(() => __test.safeOrgFile(__test.DEFAULT_ORG_ROOT, '../etc/passwd'), /org_ui_path_invalid/);
    assert.throws(() => __test.safeOrgFile(__test.DEFAULT_ORG_ROOT, '/etc/passwd'), /org_ui_path_denied/);
    assert.throws(() => __test.procedureFromRequest(new Request('http://numx.local/api/trpc/%2e%2e%2fetc')), /org_plugin_procedure_denied/);
    assert.equal(__test.publicError(new Error('raw-secret')).code, 'org_plugin_upstream_error');
    assert.equal(__test.errorStatus(new Error('org_plugin_upstream_http_400')), 400);

    const malformed = await dispatch('/api/trpc/entCabin.map', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
    assert.equal(malformed.status, 400);
    assert.match(await malformed.text(), /org_plugin_payload_invalid/);

    const stream = new ReadableStream({ start(controller) { controller.enqueue(Buffer.alloc(limits().maxPayloadBytes + 1, 120)); controller.close(); } });
    const oversized = await dispatch('/api/trpc/entCabin.map', { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half' });
    assert.equal(oversized.status, 413);
    assert.match(await oversized.text(), /org_plugin_payload_too_large/);
    for (const json of [null, [], 'scalar']) {
      const invalid = await dispatch('/api/trpc/entCabin.map', postJson({ json }));
      assert.equal(invalid.status, 400);
      assert.match(await invalid.text(), /org_plugin_payload_invalid/);
    }
    assert.equal(calls.length, 0);
    assert.equal(__test.publicError(new Error('org_plugin_upstream_http_500')).message, '组织服务暂时不可用');
  } finally {
    await dispose();
  }
});

test('DSH UI：三屏并发突发有界排队，实际上游不超过并发上限', async () => {
  const { activity, calls, dispatch, registerUi } = makeContext({ slowMap: true });
  const dispose = await registerUi();
  try {
    const burst = Math.min(12, limits().maxConcurrentRequests + limits().maxQueuedRequests);
    const responses = await Promise.all(Array.from({ length: burst }, () => dispatch('/api/trpc/entCabin.map', postJson({ json: {} }))));
    assert.equal(responses.every((response) => response.status === 200), true);
    assert.equal(calls.length, burst);
    assert.ok(activity.maxActive > 0 && activity.maxActive <= limits().maxConcurrentRequests, `maxActive=${activity.maxActive}`);
  } finally {
    await dispose();
  }
});

test('DSH UI：二维码公开代理与取件 Bearer 代理均限制参数和响应类型', async () => {
  const { calls, dispatch, registerUi } = makeContext();
  const dispose = await registerUi();
  try {
    const qr = await dispatch('/api/numx-org/invite-qr?code=iv_probe', { headers: { authorization: 'Bearer caller-token' } });
    assert.equal(qr.status, 200);
    assert.equal(qr.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await qr.arrayBuffer()), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const qrCall = calls.at(-1);
    assert.equal(qrCall.url, `${API}/api/invite-qr?code=iv_probe`);
    assert.equal(qrCall.init.headers.authorization, undefined);
    assert.equal(qrCall.url.includes('token='), false);

    const artifact = await dispatch('/api/numx-org/org-artifact?station=sc&name=a.pdf', { headers: { authorization: 'Bearer caller-token' } });
    assert.equal(artifact.status, 200);
    assert.equal(artifact.headers.get('content-type'), 'application/pdf');
    assert.equal(artifact.headers.get('content-disposition'), 'attachment; filename="a.pdf"');
    assert.equal(artifact.headers.get('x-content-type-options'), 'nosniff');
    assert.match(artifact.headers.get('content-security-policy'), /sandbox/);
    assert.equal(calls.at(-1).init.headers.authorization, 'Bearer caller-token');
    const active = await dispatch('/api/numx-org/org-artifact?station=sc&name=bad.svg', { headers: { authorization: 'Bearer caller-token' } });
    assert.equal(active.status, 502);
    assert.equal(await artifact.text(), '%PDF-1.7');
    const badName = await dispatch('/api/numx-org/org-artifact?station=sc&name=..%2Fsecret', { headers: { authorization: 'Bearer caller-token' } });
    assert.equal(badName.status, 400);
    assert.equal((await dispatch('/api/numx-org/org-artifact?station=sc&name=..', { headers: { authorization: 'Bearer caller-token' } })).status, 400);
    assert.equal((await dispatch('/api/numx-org/org-artifact?station=sc&name=bad%01.pdf', { headers: { authorization: 'Bearer caller-token' } })).status, 400);
    assert.equal((await dispatch('/api/invite-qr?code=iv_probe')).status, 404, '旧全局二维码路由不得占用宿主命名空间');
    assert.equal((await dispatch('/api/org-artifact?station=sc&name=a.pdf')).status, 404, '旧全局取件路由不得占用宿主命名空间');
    assert.equal(calls.length, 3);
    assertActiveRequestsIdleForTest();
  } finally {
    await dispose();
  }
});

test('DSH UI：注册失败按逆序清理，不留半套路由', async () => {
  const { ctx, routes, injections, disposals, registrationOrder, registerUi } = makeContext({ failAt: 3 });
  await assert.rejects(registerUi(), /probe_register_failure/);
  assert.equal(routes.size, 0);
  assert.equal(injections.length, 0);
  assert.deepEqual(disposals, registrationOrder.slice(0, 2).reverse());
  disposeSessions(ctx);
});

test('DSH UI：二进制流读取失败必须归还名额，后续请求不被永久卡死', async () => {
  const { dispatch, registerUi } = makeContext({ streamError: true });
  const dispose = await registerUi();
  try {
    const response = await dispatch('/api/numx-org/org-artifact?station=sc&name=a.pdf', { headers: { authorization: 'Bearer caller-token' } });
    assert.equal(response.status, 200);
    await assert.rejects(response.text(), /probe_stream_read/);
    assertActiveRequestsIdleForTest();
    const privateRead = await dispatch('/api/trpc/entCabin.map', postJson({ json: {} }));
    assert.equal(privateRead.status, 200);
  } finally {
    await dispose();
  }
});

test('DSH UI：富类型上游按 JSON 线格式返回，不向浏览器复活 BigInt/Map/Set', async () => {
  const { dispatch, registerUi } = makeContext({ richMap: true });
  const dispose = await registerUi();
  try {
    const response = await dispatch('/api/trpc/entCabin.map', postJson({ json: {} }));
    assert.equal(response.status, 200);
    const text = await response.text();
    const body = JSON.parse(text);
    assert.equal(body.result.data.json.createdAt, '2024-01-01T00:00:00.000Z');
    assert.equal(body.result.data.json.big, '123', 'BigInt 在线格式中以字符串保真，不能复活为运行时 BigInt');
    assert.deepEqual(body.result.data.json.map, [['a', 1]]);
    assert.deepEqual(body.result.data.json.set, [1, 2]);
  } finally {
    await dispose();
  }
});

test('DSH UI：慢消费者不读取也按超时归还名额', async () => {
  let released = 0;
  const upstream = new ReadableStream({ pull() { return new Promise(() => {}); } });
  const bounded = __test.boundedUpstreamStream(upstream, 1024, () => { released += 1; }, 15);
  await assert.rejects(bounded.getReader().read(), /org_plugin_upstream_timeout/);
  assert.equal(released, 1);
});

test('DSH UI：匿名激活写过程在任何上游调用前拒绝', async () => {
  const { calls, dispatch, registerUi } = makeContext({ authenticated: false });
  const dispose = await registerUi();
  try {
    const response = await dispatch('/api/trpc/orgPlugin.installTicket', postJson({ json: { cabinCode: 'finance', packId: 'dept-finance' } }));
    assert.equal(response.status, 401);
    assert.equal(calls.length, 0);
  } finally {
    await dispose();
  }
});

test('DSH UI：激活票据与确认按真实写过程转发，含开发渠道', async () => {
  const { calls, dispatch, registerUi } = makeContext();
  const dispose = await registerUi();
  try {
    const ticketResponse = await dispatch('/api/trpc/orgPlugin.installTicket', postJson({ json: { cabinCode: 'finance', packId: 'dept-finance', packVersion: '0.1.0' } }));
    assert.equal(ticketResponse.status, 200);
    const ticketBody = JSON.parse(await ticketResponse.text());
    assert.equal(ticketBody.result.data.json.ticketId, 'ticket-1');
    assert.equal(ticketBody.result.data.json.pack.channel, 'development');
    const confirmResponse = await dispatch('/api/trpc/orgPlugin.installConfirm', postJson({ json: { ticketId: ticketBody.result.data.json.ticketId, ticket: ticketBody.result.data.json.ticket } }));
    assert.equal(confirmResponse.status, 200);
    const confirmBody = JSON.parse(await confirmResponse.text());
    assert.equal(confirmBody.result.data.json.ok, true);
    assert.equal(confirmBody.result.data.json.installId, 77);
    assert.equal(calls[0].url, `${API}/api/trpc/orgPlugin.installTicket`);
    assert.equal(JSON.parse(calls[0].init.body).json.cabinCode, 'finance');
    assert.equal(JSON.parse(calls[0].init.body).json.packId, 'dept-finance');
    assert.equal(JSON.parse(calls[0].init.body).json.packVersion, '0.1.0');
    assert.equal(calls[1].url, `${API}/api/trpc/orgPlugin.installConfirm`);
    assert.equal(JSON.parse(calls[1].init.body).json.ticketId, 'ticket-1');
    assert.equal(JSON.parse(calls[1].init.body).json.ticket, 'st_probe');
  } finally {
    await dispose();
  }
});

test('DSH UI：工作区目录匿名 401，登录后只读返回真实角色结构', async () => {
  const { ctx, calls, dispatch, registerUi } = makeContext({ authenticated: false });
  const dispose = await registerUi();
  try {
    const anonymous = await dispatch('/api/trpc/orgPlugin.workspaces', postJson({ json: {} }));
    assert.equal(anonymous.status, 401);
    assert.equal(calls.length, 0, '匿名工作区请求必须在任何 WB 调用前拒绝');
    loginWithToken('caller-token', 'dsh-org-ui', {}, ctx);
    const response = await dispatch('/api/trpc/orgPlugin.workspaces', postJson({ json: { token: 'caller-token' } }));
    assert.equal(response.status, 200);
    assert.equal(calls.at(-1).url, `${API}/api/trpc/orgPlugin.workspaces`);
    const body = JSON.parse(await response.text());
    assert.equal(body.result.data.json.cabins[0].role, 'manager');
    assert.equal(body.result.data.json.cabins[0].employeeInstallRequired, false);
    assertActiveRequestsIdleForTest();
  } finally {
    await dispose();
  }
});

test('DSH UI：重复释放路由与注入不抛错', async () => {
  const { routes, injections, registerUi } = makeContext();
  const dispose = await registerUi();
  await dispose();
  await dispose();
  assert.equal(routes.size, 0);
  assert.equal(injections.length, 0);
});

test('认证面错误：桥接、网络与权限错误均可读且不泄露原始包装', () => {
  const orgBoot = readFileSync(new URL('../../src/plugins/numx-org/ui/org/org-boot.js', import.meta.url), 'utf8');
  const start = orgBoot.indexOf('const ORG_PUBLIC_ERROR_MESSAGES =');
  const end = orgBoot.indexOf('function recoverExpiredSession(error)', start);
  assert.ok(start >= 0 && end > start, 'orgPublicErrorText 提取标记缺失或顺序异常');
  const context = vm.createContext({});
  vm.runInContext(orgBoot.slice(start, end), context);
  assert.equal(typeof context.orgPublicErrorText, 'function');
  const wrapped = new Error("Error invoking remote method 'org-runtime:invoke': Error: org_plugin_upstream_http_412");
  assert.equal(context.orgPublicErrorText(wrapped), '请求来源校验未通过，请稍后重试或联系运维');
  assert.equal(context.orgPublicErrorText(new Error(`${wrapped.message}, retry requested`)), '请求来源校验未通过，请稍后重试或联系运维');
  assert.equal(context.orgPublicErrorText(new Error('org_plugin_upstream_http_401')), '账号、密码或会话校验失败，请重新登录');
  assert.equal(context.orgPublicErrorText(new Error('org_plugin_rate_limited')), '操作过于频繁，请稍后重试');
  assert.equal(context.orgPublicErrorText(new Error('org_plugin_write_denied')), '当前账号无权执行此操作');
  assert.equal(context.orgPublicErrorText({ name: 'TimeoutError', message: 'signal timed out.' }), '组织服务响应超时，请稍后重试');
  assert.equal(context.orgPublicErrorText(new Error('Failed to fetch')), '组织服务暂时无法连接，请检查网络后重试');
  assert.equal(context.orgPublicErrorText(new Error('该手机号今日已兑过专属邀测码')), '该手机号今日已兑过专属邀测码');

  const index = readFileSync(new URL('../../src/plugins/numx-org/ui/org/index.html', import.meta.url), 'utf8');
  assert.ok(index.includes("agErr('ag-err', orgPublicErrorText(e));"));
  assert.ok(index.includes("agErr('ag-r-err', orgPublicErrorText(e));"));
  const sendStart = index.indexOf('async function agDailySend');
  const redeemStart = index.indexOf('async function agDailyRedeem');
  const authEnd = index.indexOf("document.getElementById('ag-daily-toggle').onclick", redeemStart);
  assert.ok(sendStart > 0 && redeemStart > sendStart && authEnd > redeemStart, '认证面代码段未定位到');
  assert.ok(index.slice(sendStart, redeemStart).includes('err.textContent = orgPublicErrorText(e)'));
  assert.ok(index.slice(redeemStart, authEnd).includes('err.textContent = orgPublicErrorText(e)'));
  const authFace = index.slice(index.indexOf('async function agLogin'), authEnd);
  assert.doesNotMatch(authFace, /String\(\s*e\??\.message/, '认证面不得直接展示原始错误信息');
});


function makeWorkspaceRuntime({ wbApi, apiRaw, alerts = [] } = {}) {
  const orgBoot = readFileSync(new URL('../../src/plugins/numx-org/ui/org/org-boot.js', import.meta.url), 'utf8');
  const errorStart = orgBoot.indexOf('const ORG_PUBLIC_ERROR_MESSAGES =');
  const errorEnd = orgBoot.indexOf('function recoverExpiredSession(error)', errorStart);
  const workspaceStart = orgBoot.indexOf('let WORKSPACE_DIRECTORY;');
  const workspaceEnd = orgBoot.indexOf('// 三屏共享', workspaceStart);
  const escStart = orgBoot.indexOf('function escH(value)');
  const escEnd = orgBoot.indexOf('\n', escStart);
  assert.ok(errorStart >= 0 && errorEnd > errorStart && workspaceStart >= 0 && workspaceEnd > workspaceStart && escStart >= 0 && escEnd > escStart);
  const strip = { innerHTML: '' };
  const style = { id: '', textContent: '' };
  const document = {
    head: { appendChild() {} },
    createElement: () => ({ ...style }),
    getElementById: (id) => id === 'workspace-strip' ? strip : null,
  };
  const listeners = new Map();
  const window = {
    confirm: () => true,
    location: { origin: 'https://numx.local' },
    parent: null,
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type, listener) => { if (listeners.get(type) === listener) listeners.delete(type); },
  };
  const location = { origin: 'https://numx.local', pathname: '/org/index.html', assign() {} };
  const source = `
    let TOKEN = 'token-a';
    ${orgBoot.slice(escStart, escEnd)}
    ${orgBoot.slice(errorStart, errorEnd)}
    ${orgBoot.slice(workspaceStart, workspaceEnd)}
    return {
      workspaceActivationLabel, workspaceCardEnterable, workspaceCanActivate, activateWorkspacePlugin,
      loadWorkspaceDirectory, renderWorkspaceStrip, openWorkspaceCabin, workspaceIsCurrent, resetWorkspaceDirectory, failWorkspaceDirectory,
      window, location, listeners,
      setScope: (scope) => { curView = scope.curView; curDept = scope.curDept; DEPT = scope.DEPT; DEPT_STATUS = scope.DEPT_STATUS; },
      setToken: (value) => { TOKEN = value; },
      getDirectory: () => WORKSPACE_DIRECTORY,
      getTicket: () => workspaceActivationTicket,
    };
  `;
  const workspaceApi = async (...args) => {
    const result = await (wbApi || (async () => ({ cabins: [] })))(...args);
    return result && Array.isArray(result.cabins) && result.packChannels === undefined ? { ...result, packChannels: ['development'] } : result;
  };
  return new Function('window', 'document', 'location', 'listeners', 'curView', 'curDept', 'DEPT', 'DEPT_STATUS', 'wbApi', 'apiRaw', 'alert', source)(
    window, document, location, listeners, undefined, undefined, undefined, undefined,
    workspaceApi,
    apiRaw || (async () => { throw new Error('unexpected_api'); }),
    (message) => alerts.push(message),
  );
}

test('工作区状态枚举与激活谓词使用真实 pack，admin 不被激活状态困住', async () => {
  const runtime = makeWorkspaceRuntime();
  await runtime.loadWorkspaceDirectory();
  const base = { cabinCode: 'finance', role: 'manager', current: false, installed: true, employeeInstallRequired: false, capabilities: ['plugin.install'], pack: { id: 'dept-finance', version: '0.1.0', channel: 'development' } };
  const labels = {
    active: '本舱已激活', stale: '安装包版本待核对', registry_unavailable: '已安装，登记信息未读回', eligible: '本舱可激活', not_required: '组织视图',
    subscription_required: '负责人待订阅', department_mapping_required: '部门映射待补',
    package_mapping_required: '订阅包映射待补', pack_unavailable: '当前部门包未开放安装',
  };
  for (const [activation, label] of Object.entries(labels)) {
    const row = { ...base, activation };
    assert.ok(runtime.workspaceActivationLabel(row).startsWith(label), activation);
    const enterable = runtime.workspaceCardEnterable(row);
    assert.equal(enterable, true, activation);
  }
  assert.equal(runtime.workspaceCardEnterable({ ...base, role: 'admin', activation: 'pack_unavailable' }), true);
  assert.equal(runtime.workspaceActivationLabel({ ...base, activation: 'active', employeeInstallRequired: true }), '本舱已激活 · 本机需安装');
  assert.equal(runtime.workspaceActivationLabel({ ...base, activation: 'eligible', employeeInstallRequired: true }), '本舱可激活 · 本机需安装');
  assert.equal(runtime.workspaceCanActivate({ ...base, activation: 'eligible', employeeInstallRequired: true }), true, '本机安装提示不得阻断 WB 已授权激活');
  assert.equal(runtime.workspaceCanActivate({ ...base, activation: 'eligible', pack: null }), false);
  assert.equal(runtime.workspaceCanActivate({ ...base, activation: 'eligible', pack: { ...base.pack, channel: 'production' } }), false);
  assert.equal(runtime.workspaceCanActivate({ ...base, activation: 'eligible' }), true);
});

test('激活确认失败重试复用同一票据，成功后读回 active', async () => {
  const eligible = { cabinCode: 'finance', cabinName: '财务舱', role: 'manager', activation: 'eligible', employeeInstallRequired: false, capabilities: ['plugin.install'], pack: { id: 'dept-finance', version: '0.1.0', channel: 'development' } };
  let directory = { cabins: [eligible] };
  let ticketCalls = 0;
  let confirmCalls = 0;
  let failConfirm = true;
  const alerts = [];
  const confirmInputs = [];
  const runtime = makeWorkspaceRuntime({
    wbApi: async () => directory,
    apiRaw: async (path, input) => {
      if (path === 'orgPlugin.installTicket') {
        ticketCalls += 1;
        return { ok: true, ticketId: 'ticket-1', ticket: 'st_once', expiresInSeconds: 120, pack: { id: 'dept-finance', version: '0.1.0', channel: 'development', sha256: 'a'.repeat(64) } };
      }
      if (path === 'orgPlugin.installConfirm') {
        confirmCalls += 1;
        confirmInputs.push(input);
        if (failConfirm) { failConfirm = false; throw new Error('network_down'); }
        return { ok: true, installId: 77, status: 'active' };
      }
      throw new Error('unexpected_api');
    },
    alerts,
  });
  await runtime.loadWorkspaceDirectory();
  await runtime.activateWorkspacePlugin('finance');
  assert.equal(ticketCalls, 1);
  assert.equal(confirmCalls, 1);
  assert.ok(runtime.getTicket());
  directory = { cabins: [{ ...eligible, activation: 'active', capabilities: [] }] };
  await runtime.activateWorkspacePlugin('finance');
  assert.equal(ticketCalls, 1, '重试不得再次签票');
  assert.equal(confirmCalls, 2);
  assert.deepEqual(confirmInputs, [
    { ticketId: 'ticket-1', ticket: 'st_once' },
    { ticketId: 'ticket-1', ticket: 'st_once' },
  ]);
  assert.equal(runtime.getTicket(), null);
  assert.ok(alerts.at(-1).includes('已激活'));
});

test('工作区目录按代次与 token 丢弃旧账号慢响应', async () => {
  const pending = [];
  const runtime = makeWorkspaceRuntime({ wbApi: () => new Promise((resolve) => pending.push(resolve)) });
  const oldLoad = runtime.loadWorkspaceDirectory();
  runtime.setToken('token-b');
  const newLoad = runtime.loadWorkspaceDirectory();
  pending[1]({ cabins: [{ cabinCode: 'finance', cabinName: '财务舱', role: 'manager' }] });
  await newLoad;
  pending[0]({ cabins: [{ cabinCode: 'sales', cabinName: '销售舱', role: 'admin' }] });
  await oldLoad;
  assert.equal(runtime.getDirectory().cabins[0].cabinCode, 'finance');
  assert.equal(runtime.getDirectory().cabins[0].role, 'manager');
});


test('页面级降级不会让在飞工作区目录永久失效', async () => {
  const pending = [];
  const runtime = makeWorkspaceRuntime({ wbApi: () => new Promise((resolve) => pending.push(resolve)) });
  const loading = runtime.loadWorkspaceDirectory();
  runtime.failWorkspaceDirectory(new Error('health_down'));
  assert.equal(runtime.getDirectory(), null);
  pending[0]({ cabins: [{ cabinCode: 'finance', cabinName: '财务舱', role: 'manager' }] });
  await loading;
  assert.equal(runtime.getDirectory().cabins[0].cabinCode, 'finance');
});

test('缺少渠道元数据按响应异常处理，不冒充包未开放', async () => {
  const runtime = makeWorkspaceRuntime({ wbApi: async () => ({ packChannels: null, cabins: [] }) });
  await runtime.loadWorkspaceDirectory();
  assert.equal(runtime.getDirectory(), null);
  assert.ok(runtime.renderWorkspaceStrip().includes('工作区目录未读回'));
});


test('目录成功自行重绘，cabinName 回退舱码且空渠道只关闭激活', async () => {
  const runtime = makeWorkspaceRuntime({ wbApi: async () => ({ packChannels: [], cabins: [{ cabinCode: 'finance', role: 'manager', activation: 'eligible', capabilities: ['plugin.install'], pack: { id: 'dept-finance', version: '0.1.0', channel: 'development' } }] }) });
  await runtime.loadWorkspaceDirectory();
  assert.equal(runtime.getDirectory().cabins[0].cabinName, 'finance');
  const html = runtime.renderWorkspaceStrip();
  assert.ok(html.includes('当前部门包未开放安装'));
  assert.ok(!html.includes('工作区目录未读回'));
  assert.equal(runtime.workspaceCanActivate(runtime.getDirectory().cabins[0]), false);
});


test('Desktop 过期或已消费票据不会卡死后续激活', async () => {
  const eligible = { cabinCode: 'finance', cabinName: '财务舱', role: 'manager', activation: 'eligible', employeeInstallRequired: false, capabilities: ['plugin.install'], pack: { id: 'dept-finance', version: '0.1.0', channel: 'development' } };
  const ticket = (id) => ({ ok: true, ticketId: id, ticket: `st_${id}`, expiresInSeconds: 120, pack: { id: 'dept-finance', version: '0.1.0', channel: 'development', sha256: 'a'.repeat(64) } });
  let directory = { cabins: [eligible] };
  let ticketCalls = 0;
  let confirmCalls = 0;
  const runtime = makeWorkspaceRuntime({
    wbApi: async () => directory,
    apiRaw: async (path) => {
      if (path === 'orgPlugin.installTicket') { ticketCalls += 1; return ticket(`ticket-${ticketCalls}`); }
      if (path === 'orgPlugin.installConfirm') {
        confirmCalls += 1;
        if (confirmCalls === 1) throw { code: 'org_plugin_ticket_expired', message: '票据已过期' };
        return { ok: true, installId: 77, status: 'active' };
      }
      throw new Error('unexpected_api');
    },
  });
  await runtime.loadWorkspaceDirectory();
  await runtime.activateWorkspacePlugin('finance');
  directory = { cabins: [{ ...eligible, activation: 'active', capabilities: [] }] };
  await runtime.activateWorkspacePlugin('finance');
  assert.equal(ticketCalls, 2, '过期后必须重新签票');
  assert.equal(confirmCalls, 2);

  directory = { cabins: [eligible] };
  ticketCalls = 0;
  confirmCalls = 0;
  const consumedRuntime = makeWorkspaceRuntime({
    wbApi: async () => directory,
    apiRaw: async (path) => {
      if (path === 'orgPlugin.installTicket') { ticketCalls += 1; return ticket(`consumed-${ticketCalls}`); }
      if (path === 'orgPlugin.installConfirm') { confirmCalls += 1; throw new Error('org_plugin_ticket_consumed'); }
      throw new Error('unexpected_api');
    },
  });
  await consumedRuntime.loadWorkspaceDirectory();
  await consumedRuntime.activateWorkspacePlugin('finance');
  await consumedRuntime.activateWorkspacePlugin('finance');
  assert.equal(ticketCalls, 2, 'consumed 非 active 后必须允许新票核对');
  assert.equal(confirmCalls, 2);
});


test('岗位屏切舱的 ACK 与空 origin 兜底都保持 station 视图', () => {
  const runtime = makeWorkspaceRuntime();
  runtime.location.pathname = '/api/numx-org/org/station.html';
  let assigned = '';
  runtime.location.origin = 'null';
  runtime.window.location.origin = 'null';
  runtime.location.assign = (value) => { assigned = value; };
  runtime.openWorkspaceCabin('produce');
  assert.equal(assigned, 'station.html?dept=produce');

  assigned = '';
  runtime.location.origin = 'https://numx.local';
  runtime.window.location.origin = 'https://numx.local';
  let posted;
  const parent = {
    postMessage(message) {
      posted = message;
      runtime.listeners.get('message')({ origin: 'https://numx.local', source: parent, data: { type: 'numx-org:navigated', view: 'station' } });
    },
  };
  runtime.window.parent = parent;
  runtime.openWorkspaceCabin('quality');
  assert.equal(posted.view, 'station');
  assert.equal(assigned, '');
  runtime.location.pathname = '/api/numx-org/org/cabin.html';
  runtime.location.origin = 'null';
  runtime.window.location.origin = 'null';
  runtime.window.parent = runtime.window;
  runtime.openWorkspaceCabin('sales');
  assert.equal(assigned, 'cabin.html?dept=sales');
});

test('工作区畸形舱行在渲染前失败为明确未读回', async () => {
  const runtime = makeWorkspaceRuntime({ wbApi: async () => ({ cabins: [null] }) });
  await runtime.loadWorkspaceDirectory();
  assert.equal(runtime.getDirectory(), null);
  assert.ok(runtime.renderWorkspaceStrip().includes('工作区目录未读回'));
});


test('工作区远程舱名与能力文本在 innerHTML 前完整转义', async () => {
  const runtime = makeWorkspaceRuntime({ wbApi: async () => ({ cabins: [{ cabinCode: 'finance', cabinName: '<img src=x onerror=1>', role: 'manager', activation: 'not_required', capabilities: ['" onmouseover="1'] }] }) });
  await runtime.loadWorkspaceDirectory();
  const html = runtime.renderWorkspaceStrip();
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /onmouseover="1"/);
  assert.match(html, /&quot; onmouseover=&quot;1/);
});


test('激活在飞时双击与导航均不产生第二次签票', async () => {
  const eligible = { cabinCode: 'finance', cabinName: '财务舱', role: 'manager', activation: 'eligible', employeeInstallRequired: false, capabilities: ['plugin.install'], pack: { id: 'dept-finance', version: '0.1.0', channel: 'development' } };
  let directory = { cabins: [eligible] };
  let resolveTicket;
  let ticketCalls = 0;
  const runtime = makeWorkspaceRuntime({
    wbApi: async () => directory,
    apiRaw: async (path) => {
      if (path === 'orgPlugin.installTicket') {
        ticketCalls += 1;
        return new Promise((resolve) => { resolveTicket = () => resolve({ ok: true, ticketId: 'ticket-1', ticket: 'st_once', expiresInSeconds: 120, pack: { id: 'dept-finance', version: '0.1.0', channel: 'development', sha256: 'a'.repeat(64) } }); });
      }
      if (path === 'orgPlugin.installConfirm') return { ok: true, installId: 77, status: 'active' };
      throw new Error('unexpected_api');
    },
  });
  await runtime.loadWorkspaceDirectory();
  const first = runtime.activateWorkspacePlugin('finance');
  await new Promise((resolve) => setImmediate(resolve));
  await runtime.activateWorkspacePlugin('finance');
  runtime.location.origin = 'null';
  runtime.window.location.origin = 'null';
  runtime.openWorkspaceCabin('produce');
  await runtime.activateWorkspacePlugin('finance');
  assert.equal(ticketCalls, 1);
  assert.equal(runtime.workspaceActivationLabel(eligible), '正在激活…');
  directory = { cabins: [{ ...eligible, activation: 'active', capabilities: [] }] };
  resolveTicket();
  await first;
  assert.equal(ticketCalls, 1);
});


test('工作区 current 标记按页面视图与映射状态解析', () => {
  const runtime = makeWorkspaceRuntime();
  const row = { cabinCode: 'finance', current: true };
  runtime.setScope({ curView: 'dash' });
  assert.equal(runtime.workspaceIsCurrent(row), false);
  runtime.setScope({ curView: 'cabin', curDept: 'finance' });
  assert.equal(runtime.workspaceIsCurrent(row), true);
  runtime.setScope({ DEPT_STATUS: 'forbidden', DEPT: '' });
  assert.equal(runtime.workspaceIsCurrent(row), false);
  runtime.setScope({ DEPT_STATUS: 'ready', DEPT: 'finance' });
  assert.equal(runtime.workspaceIsCurrent(row), true);
});


test('cabin 在飞写操作切舱会回滚选择，完成后才重置通知并切舱', () => {
  const cabinHtml = readFileSync(new URL('../../src/plugins/numx-org/ui/org/cabin.html', import.meta.url), 'utf8');
  const start = cabinHtml.indexOf('function switchCabinWorkspace(code)');
  const end = cabinHtml.indexOf('async function bootCabin()', start);
  assert.ok(start >= 0 && end > start);
  const cabinOptions = [{ value: 'finance', textContent: '财务舱' }, { value: 'produce', textContent: '生产舱' }];
  const selector = { value: 'finance', options: cabinOptions, add(option) { cabinOptions.push(option); }, get selectedOptions() { return cabinOptions.filter((option) => option.value === this.value); } };
  const badge = { style: { display: '' }, textContent: '2' };
  const msgs = { innerHTML: 'old' };
  const draft = { value: 'A 舱草稿' };
  const panels = Object.fromEntries(['#cabin-sub', '#crew-count', '#inbox-count', '#rev-count', '#siglog', '#krow', '#alist', '#nbox'].map((id) => [id, { innerHTML: '旧舱数据', textContent: '旧舱数据' }]));
  const calls = { poll: 0, boot: 0, sync: 0, badge: 0, paint: 0, clearIdem: 0, navigate: 0, navigateArgs: [], alerts: [] };
  const context = {
    DEPT: 'finance', DISPATCHING: true, DECIDING: new Set(), WORKSPACE_DIRECTORY: undefined,
    NOTICE_DEPT: 'finance', NOTICE_EPOCH: 0, DEPT_STATUS: 'ready', CABIN_NAME: '财务舱', NOTICE_IDS: [1],
    LIVE: { mode: 'live' }, SCOPED_ERROR: 'old',
    document: { createElement: () => ({ value: '', textContent: '' }) },
    $: (id) => id === '#toWho' ? selector : id === '#nbadge' ? badge : id === '#msgs2' ? msgs : id === '#inp2' ? draft : panels[id] ?? null,
    clearIdemKey: () => { calls.clearIdem += 1; },
    pollNotices: () => { calls.poll += 1; },
    invalidateNoticePoll: () => { context.NOTICE_EPOCH += 1; },
    paintWorkspaceStrip: () => { calls.paint += 1; },
    bootCabin: () => { calls.boot += 1; },
    navigateOrgView: (view, query) => { calls.navigate += 1; calls.navigateArgs.push([view, query]); },
    syncDispatchAccess: () => { calls.sync += 1; },
    setBadge: () => { calls.badge += 1; },
    renderCrew: () => {},
    renderInbox: () => {},
    renderRevs: () => {},
    refreshCounts: () => {},
    alert: (message) => calls.alerts.push(message),
  };
  const switchSource = cabinHtml.slice(start, end);
  vm.runInContext(`${switchSource}; switchCabinWorkspace('produce');`, vm.createContext(context));
  assert.equal(selector.value, 'finance', '在飞时必须回滚 select，禁止误派到其他舱');
  assert.equal(calls.boot, 0);
  context.DISPATCHING = false;
  context.DECIDING = new Set(['review-1']);
  vm.runInContext(`${switchSource}; switchCabinWorkspace('produce');`, vm.createContext(context));
  assert.equal(context.DEPT, 'produce');
  assert.equal(context.NOTICE_DEPT, 'produce');
  assert.equal(context.NOTICE_EPOCH, 1);
  assert.equal(context.LIVE.mode, 'loading');
  assert.equal(context.SCOPED_ERROR, '');
  assert.equal(msgs.innerHTML, '');
  assert.equal(draft.value, '', '切舱不得把 A 舱草稿误发到 B 舱');
  assert.equal(calls.clearIdem, 1);
  assert.match(panels['#cabin-sub'].textContent, /正在切换并读取真实数据/);
  for (const id of ['#siglog', '#krow', '#alist']) assert.match(panels[id].innerHTML, /部门舱切换中/);
  assert.doesNotMatch(panels['#nbox'].innerHTML, /旧舱数据/);
  assert.equal(panels['#crew-count'].textContent, '— 数字员工');
  assert.equal(calls.poll, 1);
  assert.equal(calls.boot, 1);
  assert.equal(calls.badge, 1);
  assert.equal(calls.paint, 1, '切舱立即清除旧工作区快照，不等待两个网络往返');
  assert.equal(calls.sync, 2);
  context.DEPT = 'produce';
  context.DEPT_STATUS = 'unavailable';
  vm.runInContext(`${switchSource}; switchCabinWorkspace('produce');`, vm.createContext(context));
  assert.equal(calls.boot, 2, '当前舱未 ready 时同舱卡必须允许重试 boot');
  context.DEPT = 'finance';
  vm.runInContext(`${switchSource}; switchCabinWorkspace('not-an-option');`, vm.createContext(context));
  assert.equal(context.DEPT, 'finance');
  assert.equal(calls.boot, 2, '不在真实选项中的舱码不得触发 boot');
  const reloadContext = { ...context, DEPT: 'finance', DEPT_STATUS: 'unavailable', WORKSPACE_DIRECTORY: { cabins: [{ cabinCode: 'sales' }] } };
  vm.runInContext(`${switchSource}; switchCabinWorkspace('sales');`, vm.createContext(reloadContext));
  assert.equal(context.DEPT, 'finance');
  assert.equal(selector.value, 'finance');
  assert.ok(!cabinOptions.some((option) => option.value === 'sales'), '没有真实映射时不得伪造下拉项');
  assert.equal(calls.navigate, 1);
  assert.deepEqual(calls.navigateArgs[0], ['cabin', 'dept=sales']);
  assert.equal(calls.boot, 2, '映射失败时只整页重读，不在旧页伪造切换');
  context.DEPT_STATUS = 'loading';
  vm.runInContext(`${switchSource}; switchCabinWorkspace('finance');`, vm.createContext(context));
  assert.equal(calls.boot, 2, '切换加载中不得重复启动 boot');
});


test('Desktop 旧会话票据终态不得清理新会话票据', async () => {
  const eligible = { cabinCode: 'finance', cabinName: '财务舱', role: 'manager', activation: 'eligible', employeeInstallRequired: false, capabilities: ['plugin.install'], pack: { id: 'dept-finance', version: '0.1.0', channel: 'development' } };
  let ticketCalls = 0;
  let confirmCalls = 0;
  let rejectOldConfirm;
  const runtime = makeWorkspaceRuntime({
    wbApi: async () => ({ cabins: [eligible] }),
    apiRaw: async (path) => {
      if (path === 'orgPlugin.installTicket') {
        ticketCalls += 1;
        return { ok: true, ticketId: `ticket-${ticketCalls}`, ticket: `st_${ticketCalls}`, expiresInSeconds: 120, pack: { id: 'dept-finance', version: '0.1.0', channel: 'development', sha256: 'a'.repeat(64) } };
      }
      if (path === 'orgPlugin.installConfirm') {
        confirmCalls += 1;
        if (confirmCalls === 1) return new Promise((_, reject) => { rejectOldConfirm = reject; });
        throw new Error('network_down');
      }
      throw new Error('unexpected_api');
    },
  });
  await runtime.loadWorkspaceDirectory();
  const oldActivation = runtime.activateWorkspacePlugin('finance');
  for (let attempt = 0; attempt < 10 && !rejectOldConfirm; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof rejectOldConfirm, 'function');
  runtime.setToken('token-b');
  runtime.resetWorkspaceDirectory();
  await runtime.loadWorkspaceDirectory();
  await runtime.activateWorkspacePlugin('finance');
  const newTicket = runtime.getTicket();
  assert.equal(newTicket.ticketId, 'ticket-2');
  rejectOldConfirm(new Error('org_plugin_ticket_owner_mismatch'));
  await oldActivation;
  assert.equal(runtime.getTicket(), newTicket, '旧会话 owner_mismatch 只能清自己的票');
  assert.equal(ticketCalls, 2);
});


test('index 非 admin 无目标舱先渲染异常面，目录到达后原地刷新', async () => {
  const html = readFileSync(new URL('../../src/plugins/numx-org/ui/org/index.html', import.meta.url), 'utf8');
  const bootStart = html.indexOf('async function boot()');
  const start = html.indexOf('      if (!targetCabin) {', bootStart);
  const end = html.indexOf('      scopedDept = targetCabin.code;', start);
  assert.ok(start >= 0 && end > start);
  const branch = html.slice(start, end);
  let resolveDirectory;
  let directory;
  const ct = { innerHTML: 'initial' };
  const cabins = [{ code: 'finance', name: '财务舱' }];
  const workspaceResult = new Promise((resolve) => { resolveDirectory = resolve; });
  const run = new Function(
    'targetCabin', 'workspaceResult', 'ORG_BOOT_SEQ', 'bootSeq', 'TOKEN', 'bootToken', 'LIVE', 'cabinMap', 'DEPTS',
    'renderTree', 'setBadge', 'syncOrgDispatchAccess', 'memberCabins', '$', 'renderWorkspaceStrip', 'redrawWorkspaceStrip', 'escH',
    `return async () => { ${branch} };`,
  )(
    null, workspaceResult, 1, 1, 'token-a', 'token-a', { mode: 'loading' }, { cabins }, [],
    () => {}, () => {}, () => {}, cabins, (id) => id === '#ct' ? ct : null,
    () => directory ? `<div>${directory.cabins[0].cabinName}</div>` : '工作区目录加载中…',
    () => { ct.innerHTML = ct.innerHTML.replace('工作区目录加载中…', directory?.cabins?.[0]?.cabinName || ''); },
    (value) => String(value),
  );
  const pending = run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(ct.innerHTML, /工作区目录加载中/, '目录未达时先显示真实加载态而非阻塞 boot');
  assert.match(ct.innerHTML, /当前部门未映射/);
  directory = { cabins: [{ cabinName: '财务舱' }] };
  resolveDirectory(directory);
  await pending;
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(ct.innerHTML, /财务舱/);
  assert.match(ct.innerHTML, /当前部门未映射/);
  assert.match(ct.innerHTML, /id="workspace-strip"/);
  assert.doesNotMatch(ct.innerHTML, /工作区目录加载中/);
});


test('组织通知按部门与 token 丢弃旧舱慢响应', async () => {
  const orgBoot = readFileSync(new URL('../../src/plugins/numx-org/ui/org/org-boot.js', import.meta.url), 'utf8');
  const start = orgBoot.indexOf('let NOTICE_IDS = [];');
  const end = orgBoot.indexOf('function bellDegraded()', start);
  assert.ok(start >= 0 && end > start);
  const pending = [];
  const rendered = [];
  const badge = { textContent: '', style: { display: '' } };
  const context = {
    TOKEN: 'token-a',
    api: (path, input) => new Promise((resolve) => pending.push({ input, resolve })),
    $: () => badge,
    bellRecovered: () => {},
    bellDegraded: () => {},
    renderNoticeBox: (items) => rendered.push(...items.map((item) => item.dept)),
  };
  vm.createContext(context);
  vm.runInContext(orgBoot.slice(start, end), context);
  vm.runInContext("NOTICE_DEPT = 'finance';", context);
  const oldPoll = vm.runInContext('pollNotices()', context);
  context.TOKEN = 'token-b';
  vm.runInContext("NOTICE_DEPT = 'produce';", context);
  const newPoll = vm.runInContext('pollNotices()', context);
  pending[1].resolve({ ok: true, unreadCount: 1, items: [{ notice_id: 2, dept: 'produce' }] });
  await newPoll;
  pending[0].resolve({ ok: true, unreadCount: 1, items: [{ notice_id: 1, dept: 'finance' }] });
  await oldPoll;
  assert.deepEqual(rendered, ['produce']);
  assert.deepEqual(Array.from(vm.runInContext('NOTICE_IDS', context)), [2]);
  assert.equal(pending[0].input.dept, 'finance');
  assert.equal(pending[1].input.dept, 'produce');
});
