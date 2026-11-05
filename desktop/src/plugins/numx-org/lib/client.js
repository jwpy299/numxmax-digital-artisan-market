import { assertNetworkAllowed, assertProcedureAllowed, limits } from './contract.js';
import { transport } from './transport-loader.js';

export { transport };
const { jsonStringByteLength, normalizeWithinBudget, readTrpcResponse, trpcUrl, upstreamErrorCode } = transport;
const ACTIVE_REQUESTS = Symbol.for('numx-org.active-requests.v1');
function activeRequestState() {
  try {
    if (!globalThis[ACTIVE_REQUESTS]) Object.defineProperty(globalThis, ACTIVE_REQUESTS, { value: { count: 0, waiters: [] }, enumerable: false, writable: false, configurable: false });
    const state = globalThis[ACTIVE_REQUESTS];
    if (!state || !Number.isInteger(state.count) || state.count < 0) throw new Error('invalid_state');
    state.waiters ||= [];
    return state;
  } catch (error) {
    throw new Error('org_plugin_concurrency_unavailable', { cause: error });
  }
}
export function assertActiveRequestsIdleForTest() {
  const state = activeRequestState();
  if (state.count !== 0) throw new Error('org_plugin_requests_active');
  if (state.waiters.length !== 0) throw new Error('org_plugin_requests_queued');
}

function combinedSignal(timeoutMs, callerSignal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
}

function transportError(error, callerSignal, fallback) {
  if (callerSignal?.aborted) return new Error('org_plugin_cancelled', { cause: error });
  return new Error(upstreamErrorCode(error, fallback), { cause: error });
}

async function acquireActiveRequest(maxConcurrent, queue, callerSignal) {
  const requests = activeRequestState();
  let waited = false;
  if (requests.count >= maxConcurrent) {
    waited = true;
    const { maxQueuedRequests, queueTimeoutMs } = limits();
    if (!queue || requests.waiters.length >= maxQueuedRequests) throw new Error('org_plugin_rate_limited');
    await new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      // releaseActiveRequest 已把名额原样移交，这里不能再自增，否则会短暂低于实际上限。
      const remove = () => {
        const index = requests.waiters.indexOf(waiter);
        if (index >= 0) requests.waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        if (callerSignal) callerSignal.removeEventListener('abort', waiter.onAbort);
      };
      waiter.remove = remove;
      waiter.onAbort = () => { remove(); reject(new Error('org_plugin_cancelled')); };
      waiter.timer = setTimeout(() => { remove(); reject(new Error('org_plugin_rate_limited')); }, queueTimeoutMs);
      if (callerSignal) {
        if (callerSignal.aborted) { remove(); reject(new Error('org_plugin_cancelled')); return; }
        callerSignal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      requests.waiters.push(waiter);
    });
  }
  if (!waited) requests.count += 1;
  return requests;
}
function releaseActiveRequest(requests) {
  const next = requests.waiters.shift();
  if (next) {
    next.remove();
    next.resolve();
  } else {
    requests.count = Math.max(0, requests.count - 1);
  }
}
export async function acquireRequestSlot({ queueIfBusy = false, callerSignal } = {}) {
  const requests = await acquireActiveRequest(limits().maxConcurrentRequests, queueIfBusy, callerSignal);
  let released = false;
  return { requests, release: () => {
    if (released) return;
    released = true;
    releaseActiveRequest(requests);
  } };
}

export function createClient({ apiBase, token, fetchImpl = fetch, allowAnonymous = false, queueIfBusy = false } = {}) {
  const origin = assertNetworkAllowed(apiBase);
  const { maxPayloadBytes, maxResponseBytes, maxConcurrentRequests, timeoutMs } = limits();
  const normalizedToken = typeof token === 'string' ? token.trim() : '';
  if (!allowAnonymous && !normalizedToken) throw new Error('org_plugin_session_required');
  if (normalizedToken.length > limits().tokenChars) throw new Error('org_plugin_token_too_long');

  return {
    async postTrpc(procedure, input = {}, write = false, callerSignal, { revive = true } = {}) {
      assertProcedureAllowed(procedure, write, { publicOnly: allowAnonymous });
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('org_plugin_payload_invalid');
      const normalizedInput = normalizeWithinBudget(input, maxPayloadBytes, 'org_plugin_payload_too_large');
      const payload = { ...normalizedInput, ...(normalizedToken ? { token: normalizedToken } : {}) };
      if (!normalizedToken) delete payload.token;
      if (jsonStringByteLength(payload) > maxPayloadBytes) throw new Error('org_plugin_payload_too_large');
      const requests = await acquireActiveRequest(maxConcurrentRequests, queueIfBusy, callerSignal);
      try {
        let response;
        try {
          response = await fetchImpl(trpcUrl(origin, procedure), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ json: payload }),
            redirect: 'error',
            signal: combinedSignal(timeoutMs, callerSignal),
          });
        } catch (error) {
          throw transportError(error, callerSignal, 'org_plugin_upstream_unreachable');
        }
        try {
          return await readTrpcResponse(response, maxResponseBytes, { revive });
        } catch (error) {
          throw transportError(error, callerSignal, 'org_plugin_upstream_unreachable');
        }
      } finally {
        releaseActiveRequest(requests);
      }
    },
  };
}
