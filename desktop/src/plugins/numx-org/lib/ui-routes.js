import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, acquireRequestSlot } from './client.js';
import contract, { isProcedureName } from './contract.js';
import { resolveToken } from './session.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const HTML_HEADERS = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
const TEXT_HEADERS = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' };
const MAX_BODY = contract.limits.maxPayloadBytes;
const MAX_RESPONSE = contract.limits.maxResponseBytes;
const UI_AGENT_ID = 'dsh-org-ui';
const UI_BASE = '/api/numx-org';
const DEFAULT_ORG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../ui');

function jsonResponse(status, value) {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

function publicError(error) {
  const raw = typeof error?.code === 'string' ? error.code : String(error?.message || '');
  const code = /^[a-z_][a-z0-9_]{1,64}$/.test(raw) ? raw : 'org_plugin_upstream_error';
  const messages = {
    org_plugin_session_required: '请先登录后再访问组织数据',
    org_plugin_origin_denied: '请求来源已拒绝',
    org_plugin_payload_invalid: '请求格式不正确',
    org_plugin_payload_too_large: '请求内容过大',
    org_plugin_rate_limited: '请求过于繁忙，请稍后重试',
    org_plugin_cancelled: '请求已取消',
    org_plugin_timeout: '请求超时，请稍后重试',
    org_plugin_upstream_timeout: '上游响应超时，请稍后重试',
    org_plugin_upstream_unreachable: '组织服务暂时无法连接',
    org_plugin_upstream_error: '组织服务返回异常',
    org_plugin_upstream_invalid_response: '组织服务响应格式异常',
    org_plugin_response_too_large: '下载内容超过安全上限',
    org_plugin_response_invalid: '组织服务响应格式异常',
    org_plugin_upstream_content_type: '下载内容类型不在允许范围',
    org_plugin_concurrency_unavailable: '并发控制不可用，请稍后重试',
    org_plugin_upstream_http_400: '请求参数校验失败',
    org_plugin_upstream_http_401: '账号、密码或会话校验失败',
    org_plugin_upstream_http_403: '当前账号无权执行此操作',
    org_plugin_upstream_http_404: '请求的资源不存在',
    org_plugin_upstream_http_409: '请求与现有数据冲突',
    org_plugin_upstream_http_429: '请求过于频繁，请稍后重试',
  };
  const upstreamHttp = /^org_plugin_upstream_http_(\d{3})$/.exec(code);
  const fallback = upstreamHttp && Number(upstreamHttp[1]) >= 500 ? '组织服务暂时不可用' : code;
  return { message: messages[code] || fallback, code };
}

function errorStatus(error) {
  const status = Number(error?.statusCode);
  if (Number.isInteger(status) && status >= 400 && status <= 599) return status;
  const raw = String(error?.code || error?.message || '');
  const upstream = /^org_plugin_upstream_http_([45]\d\d)$/.exec(raw);
  if (upstream) return Number(upstream[1]);
  const statuses = {
    org_plugin_session_required: 401,
    org_plugin_origin_denied: 403,
    org_plugin_read_denied: 403,
    org_plugin_write_denied: 403,
    org_plugin_payload_invalid: 400,
    org_plugin_procedure_denied: 400,
    org_plugin_payload_too_large: 413,
    org_plugin_rate_limited: 429,
    org_plugin_cancelled: 408,
    org_plugin_timeout: 504,
    org_plugin_upstream_timeout: 504,
    org_plugin_concurrency_unavailable: 503,
  };
  return statuses[raw] || 502;
}

function safeOrgFile(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\0') || relative.includes('..')) {
    const error = new Error('org_ui_path_invalid');
    error.statusCode = 400;
    throw error;
  }
  const rootReal = fs.realpathSync(root);
  const target = path.resolve(rootReal, relative);
  if (target !== rootReal && !target.startsWith(`${rootReal}${path.sep}`)) {
    const error = new Error('org_ui_path_denied');
    error.statusCode = 403;
    throw error;
  }
  const stat = fs.lstatSync(target);
  if (!stat.isFile()) {
    const error = new Error('org_ui_not_found');
    error.statusCode = 404;
    throw error;
  }
  return target;
}

async function readBoundedBody(body, maxBytes, code, statusCode) {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = Buffer.from(value);
      size += bytes.byteLength;
      if (size > maxBytes) {
        const error = new Error(code);
        error.statusCode = statusCode;
        try { await reader.cancel(error); } catch { /* keep the original size-limit error */ }
        throw error;
      }
      chunks.push(bytes);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

async function readRequestJson(request) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY) {
    const error = new Error('org_plugin_payload_too_large');
    error.statusCode = 413;
    throw error;
  }
  const body = await readBoundedBody(request.body, MAX_BODY, 'org_plugin_payload_too_large', 413);
  let value;
  try { value = JSON.parse(body.toString('utf8') || '{}'); } catch {
    const error = new Error('org_plugin_payload_invalid');
    error.statusCode = 400;
    throw error;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    const error = new Error('org_plugin_payload_invalid');
    error.statusCode = 400;
    throw error;
  }
  return value;
}

function procedureFromRequest(request) {
  const pathname = new URL(request.url).pathname;
  const raw = pathname.startsWith('/api/trpc/') ? pathname.slice('/api/trpc/'.length) : '';
  let procedure;
  try { procedure = decodeURIComponent(raw); } catch {
    const error = new Error('org_plugin_procedure_denied');
    error.statusCode = 400;
    throw error;
  }
  if (!isProcedureName(procedure)) {
    const error = new Error('org_plugin_procedure_denied');
    error.statusCode = 400;
    throw error;
  }
  return procedure;
}

function assertSameOrigin(request) {
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && !['same-origin', 'same-site', 'none'].includes(fetchSite)) {
    const error = new Error('org_plugin_origin_denied');
    error.statusCode = 403;
    throw error;
  }
  if (origin === 'null' && !fetchSite) {
    const error = new Error('org_plugin_origin_denied');
    error.statusCode = 403;
    throw error;
  }
  if (origin && origin !== 'null' && origin !== new URL(request.url).origin) {
    const error = new Error('org_plugin_origin_denied');
    error.statusCode = 403;
    throw error;
  }
}

function assertTrpcRequest(request) {
  assertSameOrigin(request);
  const contentType = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    const error = new Error('org_plugin_payload_invalid');
    error.statusCode = 415;
    throw error;
  }
}

async function currentToken(ctx, supplied) {
  if (typeof supplied === 'string' && supplied.trim()) return supplied.trim();
  return resolveToken(UI_AGENT_ID, ctx);
}

function registerFetchRoute(ctx, routePath, methods, handler, track) {
  const dispose = ctx.connection.fetch.register({
    path: routePath,
    methods,
    requestBody: 'buffered',
    fetch: handler,
  });
  if (typeof dispose !== 'function') throw new Error('org_ui_route_disposer_unavailable');
  track(dispose);
  return dispose;
}

function loadOrgAssets(orgRoot) {
  const assets = new Map();
  const add = (routePath, relative, contentType) => {
    assets.set(routePath, {
      body: fs.readFileSync(safeOrgFile(orgRoot, relative), 'utf8'),
      headers: { ...TEXT_HEADERS, 'content-type': contentType },
    });
  };
  add(`${UI_BASE}/ui.js`, 'ui.js', 'text/javascript; charset=utf-8');
  add(`${UI_BASE}/ui.css`, 'ui.css', 'text/css; charset=utf-8');
  for (const relative of ['index.html', 'cabin.html', 'station.html']) {
    add(`${UI_BASE}/org/${relative}`, `org/${relative}`, HTML_HEADERS['content-type']);
  }
  add(`${UI_BASE}/org/org-boot.js`, 'org/org-boot.js', 'text/javascript; charset=utf-8');
  return assets;
}

function registerStaticRoutes(ctx, assets, track) {
  for (const [routePath, asset] of assets) {
    registerFetchRoute(ctx, routePath, ['GET', 'HEAD'], async (request) => new Response(
      request.method === 'HEAD' ? null : asset.body,
      { status: 200, headers: asset.headers },
    ), track);
  }
}

function registerTrpcProxy(ctx, track, fetchImpl) {
  const handler = async (request) => {
    try {
      assertTrpcRequest(request);
      const procedure = procedureFromRequest(request);
      const body = await readRequestJson(request);
      let input = body;
      if (Object.hasOwn(body, 'json')) {
        if (!body.json || typeof body.json !== 'object' || Array.isArray(body.json)) {
          const error = new Error('org_plugin_payload_invalid');
          error.statusCode = 400;
          throw error;
        }
        input = body.json;
      }
      const isPublic = contract.procedures.public.includes(procedure);
      const token = isPublic ? '' : await currentToken(ctx, input.token);
      const client = createClient({ apiBase: contract.network.endpoint, token, fetchImpl, allowAnonymous: isPublic, queueIfBusy: true });
      const write = contract.procedures.write.includes(procedure);
      const result = await client.postTrpc(procedure, input, write, request.signal, { revive: false });
      return jsonResponse(200, { result: { data: { json: result } } });
    } catch (error) {
      return jsonResponse(errorStatus(error), { error: { json: publicError(error) } });
    }
  };
  const procedures = new Set([...contract.procedures.read, ...contract.procedures.write, ...contract.procedures.public]);
  for (const procedure of procedures) registerFetchRoute(ctx, `/api/trpc/${procedure}`, ['POST'], handler, track);
}

function suppliedBearer(request) {
  const value = request.headers.get('authorization') || '';
  return value.slice(0, 7).toLowerCase() === 'bearer ' ? value.slice(7).trim() : '';
}

function boundedUpstreamStream(body, maxBytes, onDone = () => {}, timeoutMs) {
  if (!body) { onDone(); return null; }
  const reader = body.getReader();
  let size = 0;
  let finished = false;
  let timer;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    onDone();
  };
  return new ReadableStream({
    start(controller) {
      if (Number.isInteger(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
          const error = new Error('org_plugin_upstream_timeout');
          finish();
          controller.error(error);
          void reader.cancel(error).catch(() => {});
        }, timeoutMs);
      }
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { finish(); controller.close(); return; }
        size += value.byteLength;
        if (size > maxBytes) {
          const error = new Error('org_plugin_response_too_large');
          error.statusCode = 502;
          try { await reader.cancel(error); } catch { /* retain size-limit semantics */ }
          finish();
          controller.error(error);
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) { finish(); await reader.cancel(reason); },
  });
}

function binaryUpstream(ctx, request, fetchImpl, { path: upstreamPath, query, maxBytes, contentType, anonymous = false }) {
  let slot;
  let released = false;
  const release = () => { if (!released) { released = true; slot?.release(); } };
  return (async () => {
    try {
      assertSameOrigin(request);
      const token = anonymous ? '' : await currentToken(ctx, suppliedBearer(request));
      const target = new URL(upstreamPath, contract.network.endpoint);
      for (const [key, value] of Object.entries(query(new URL(request.url).searchParams))) {
        target.searchParams.set(key, value);
      }
      slot = await acquireRequestSlot({ queueIfBusy: true, callerSignal: request.signal });
      const timeout = AbortSignal.timeout(contract.limits.artifactTimeoutMs);
      let response;
      try {
        response = await fetchImpl(target, {
          headers: anonymous ? {} : { authorization: `Bearer ${token}` },
          redirect: 'error',
          signal: request.signal ? AbortSignal.any([request.signal, timeout]) : timeout,
        });
      } catch (error) {
        release();
        throw error;
      }
      if (!response.ok) {
        release();
        await response.body?.cancel();
        const code = `org_plugin_upstream_http_${response.status}`;
        return jsonResponse(response.status, { error: { json: publicError(new Error(code)) } });
      }
      const actualType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!contentType(actualType)) {
        release();
        await response.body?.cancel();
        throw new Error('org_plugin_upstream_content_type');
      }
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) {
        release();
        await response.body?.cancel();
        throw new Error('org_plugin_response_too_large');
      }
      const body = boundedUpstreamStream(response.body, maxBytes, release, contract.limits.artifactTimeoutMs);
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': actualType,
          'cache-control': 'no-store',
          'content-disposition': response.headers.get('content-disposition') || 'attachment',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; sandbox",
        },
      });
    } catch (error) {
      release();
      return jsonResponse(errorStatus(error), { error: { json: publicError(error) } });
    }
  })();
}

function limitedParam(params, key, maxChars, pattern) {
  const value = params.get(key) || '';
  if (!value || value.length > maxChars || (pattern && !pattern.test(value))) {
    const error = new Error('org_plugin_payload_invalid');
    error.statusCode = 400;
    throw error;
  }
  return value;
}

function artifactNameParam(params) {
  const value = limitedParam(params, 'name', contract.limits.fileNameChars, /^[^/\\\x00-\x1f\x7f]+$/);
  if (value === '.' || value === '..') {
    const error = new Error('org_plugin_payload_invalid');
    error.statusCode = 400;
    throw error;
  }
  return value;
}

function registerBinaryRoutes(ctx, track, fetchImpl) {
  registerFetchRoute(ctx, `${UI_BASE}/invite-qr`, ['GET'], (request) => binaryUpstream(ctx, request, fetchImpl, {
    path: '/api/invite-qr',
    query: (params) => ({ code: limitedParam(params, 'code', 128, /^[a-zA-Z0-9_-]+$/) }),
    maxBytes: MAX_RESPONSE,
    anonymous: true,
    contentType: (value) => value === 'image/png',
  }), track);
  registerFetchRoute(ctx, `${UI_BASE}/org-artifact`, ['GET'], (request) => binaryUpstream(ctx, request, fetchImpl, {
    path: '/api/org-artifact',
    query: (params) => ({
      station: limitedParam(params, 'station', contract.limits.stationKeyChars, /^[a-zA-Z0-9_.:-]+$/),
      name: artifactNameParam(params),
    }),
    maxBytes: contract.limits.maxArtifactBytes,
    contentType: (value) => new Set([
      'application/octet-stream', 'application/pdf', 'application/zip',
      'application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'image/png', 'image/jpeg', 'text/plain', 'text/csv', 'text/markdown',
    ]).has(value),
  }), track);
}

function registerIndexInjection(ctx, css) {
  const dispose = ctx.on('webserver/index-inject', (table) => {
    const section = `<section id="numx-org-runtime" aria-label="NumX Max 组织智能运行时">
  <header class="numx-org-head">
    <div><strong>NumX Max 组织智能运行时</strong><span>企业 · 部门舱 · 工位</span></div>
    <nav aria-label="组织视图">
      <button type="button" data-org-view="index" aria-pressed="true">组织总览</button>
      <button type="button" data-org-view="cabin" aria-pressed="false">部门舱</button>
      <button type="button" data-org-view="station" aria-pressed="false">我的工位</button>
      <button type="button" data-org-fullscreen aria-pressed="false">横屏展开</button>
    </nav>
  </header>
  <div class="numx-org-frames">
    <iframe data-org-frame="index" src="${UI_BASE}/org/index.html" title="组织总览" loading="eager"></iframe>
    <iframe data-org-frame="cabin" src="${UI_BASE}/org/cabin.html" title="部门舱" loading="lazy" hidden></iframe>
    <iframe data-org-frame="station" src="${UI_BASE}/org/station.html" title="我的工位" loading="lazy" hidden></iframe>
  </div>
</section>`;
    table.push(
      { kind: 'html', placement: 'body', html: section },
      { kind: 'style', text: css },
      { kind: 'script-src', placement: 'body', src: `${UI_BASE}/ui.js` },
    );
  });
  if (typeof dispose !== 'function') throw new Error('org_ui_injection_disposer_unavailable');
  return dispose;
}

export async function registerOrgUi(ctx, { fetchImpl = fetch } = {}) {
  if (!ctx.connection?.fetch?.register) throw new Error('org_ui_route_registry_unavailable');
  if (typeof ctx.on !== 'function') throw new Error('org_ui_injections_unavailable');
  const assets = loadOrgAssets(DEFAULT_ORG_ROOT);
  const disposers = [];
  const track = (dispose) => { disposers.push(dispose); };
  try {
    registerTrpcProxy(ctx, track, fetchImpl);
    registerStaticRoutes(ctx, assets, track);
    registerBinaryRoutes(ctx, track, fetchImpl);
    track(registerIndexInjection(ctx, assets.get(`${UI_BASE}/ui.css`).body));
    let disposed = false;
    return async () => {
      if (disposed) return;
      disposed = true;
      let firstError;
      for (const dispose of [...disposers].reverse()) {
        try { await dispose(); } catch (error) { firstError ||= error; }
      }
      if (firstError) throw firstError;
    };
  } catch (error) {
    for (const dispose of disposers.reverse()) {
      try { await dispose(); } catch { /* rollback never masks the original error */ }
    }
    throw error;
  }
}

export const __test = { DEFAULT_ORG_ROOT, safeOrgFile, procedureFromRequest, publicError, errorStatus, readRequestJson, readBoundedBody, assertTrpcRequest, limitedParam, boundedUpstreamStream };
