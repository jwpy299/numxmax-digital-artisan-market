import { createHash } from 'node:crypto';
import { limits } from './contract.js';

const SESSION_STATE = Symbol.for('numx-org.session-state.v1');
const MAX_SESSIONS = limits().maxSessions;
export const SESSION_TTL_MS = limits().sessionTtlMs;

function createState() {
  return { sessions: new Map(), inflight: new Map(), generations: new Map(), epoch: 0 };
}

function registryForGlobal() {
  if (!globalThis[SESSION_STATE]) {
    try {
      Object.defineProperty(globalThis, SESSION_STATE, { value: new WeakMap(), enumerable: false, writable: false, configurable: false });
    } catch (error) {
      throw new Error('org_plugin_credentials_unavailable', { cause: error });
    }
  }
  return globalThis[SESSION_STATE];
}

function stateFor(ctx) {
  const key = ctx?.credentials;
  if ((typeof key === 'object' && key !== null) || typeof key === 'function') {
    const registry = registryForGlobal();
    let state = registry.get(key);
    if (!state) {
      state = createState();
      registry.set(key, state);
    }
    return state;
  }
  throw new Error('org_plugin_credentials_unavailable');
}
function sessionsFor(ctx) {
  return stateFor(ctx).sessions;
}
function sessionKey(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > limits().sessionIdChars) throw new Error('org_plugin_session_scope_required');
  return sessionId.trim();
}
function normalizedToken(value) {
  if (typeof value !== 'string') throw new Error('org_plugin_session_required');
  const token = value.trim();
  if (!token) throw new Error('org_plugin_session_required');
  if (token.length > limits().tokenChars) throw new Error('org_plugin_token_too_long');
  return token;
}
function invalidate(state, key) {
  if (state.inflight.has(key)) state.generations.set(key, (state.generations.get(key) || 0) + 1);
  else state.generations.delete(key);
}
function prune(state, now = Date.now()) {
  for (const [key, record] of state.sessions) {
    if (record.expiresAt <= now) {
      state.sessions.delete(key);
      invalidate(state, key);
    }
  }
}
function touch(sessions, key, record) {
  sessions.delete(key);
  sessions.set(key, record);
}

/** 仅供宿主登录 UI/凭据桥调用；不得把 token 注册为模型工具参数或写入会话审计。 */
export function loginWithToken(value, sessionId, options = {}, ctx) {
  const key = sessionKey(sessionId);
  const token = normalizedToken(value);
  const state = stateFor(ctx);
  const sessions = state.sessions;
  const requestedTtl = Number(options?.ttlMs);
  const ttlMs = Number.isInteger(requestedTtl) && requestedTtl > 0 ? Math.min(requestedTtl, SESSION_TTL_MS) : SESSION_TTL_MS;
  const now = Date.now();
  prune(state, now);
  if (!sessions.has(key) && sessions.size >= MAX_SESSIONS) {
    const evicted = sessions.keys().next().value;
    sessions.delete(evicted);
    invalidate(state, evicted);
  }
  state.generations.set(key, (state.generations.get(key) || 0) + 1);
  touch(sessions, key, { token, expiresAt: now + ttlMs });
  return { ok: true, expiresAt: now + ttlMs };
}

function logoutMemory(sessionId, ctx) {
  sessionsFor(ctx).delete(sessionKey(sessionId));
  return { ok: true };
}

export function currentToken(sessionId, ctx) {
  const sessions = sessionsFor(ctx);
  const key = sessionKey(sessionId);
  const now = Date.now();
  prune(stateFor(ctx), now);
  const record = sessions.get(key);
  if (!record) throw new Error('org_plugin_session_required');
  touch(sessions, key, record);
  return record.token;
}

export async function isLoggedIn(sessionId, ctx) {
  const key = sessionKey(sessionId);
  const state = stateFor(ctx);
  prune(state);
  if (state.sessions.has(key)) return true;
  try {
    await resolveToken(key, ctx);
    return true;
  } catch (error) {
    if (error?.message === 'org_plugin_session_required') return false;
    throw error;
  }
}

export function disposeSessions(ctx) {
  const state = stateFor(ctx);
  state.sessions.clear();
  state.generations.clear();
  state.inflight.clear();
  state.epoch += 1;
}

export function credentialKeyForSession(sessionId) {
  const key = sessionKey(sessionId);
  return `numx-org/${createHash('sha256').update(key).digest('hex').slice(0, limits().credentialHashChars)}`;
}

export async function resolveToken(sessionId, ctx) {
  const key = sessionKey(sessionId);
  try {
    return currentToken(key, ctx);
  } catch (error) {
    if (error?.message !== 'org_plugin_session_required') throw error;
  }
  if (typeof ctx?.credentials?.readRecord !== 'function') throw new Error('org_plugin_session_required');
  const state = stateFor(ctx);
  const existing = state.inflight.get(key);
  if (existing) return existing;
  const epoch = state.epoch;
  const generation = state.generations.get(key) || 0;
  const promise = (async () => {
    let timeout;
    const record = await Promise.race([
      ctx.credentials.readRecord(credentialKeyForSession(key)),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('org_plugin_upstream_timeout')), limits().timeoutMs); }),
    ]);
    clearTimeout(timeout);
    if (record?.kind === 'api-key' && typeof record.key === 'string' && record.key.trim()) {
      if (state.epoch !== epoch || (state.generations.get(key) || 0) !== generation) throw new Error('org_plugin_session_required');
      const token = normalizedToken(record.key);
      loginWithToken(token, key, { ttlMs: Math.min(limits().credentialCacheTtlMs, SESSION_TTL_MS) }, ctx);
      return token;
    }
    throw new Error('org_plugin_session_required');
  })();
  state.inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    if (state.inflight.get(key) === promise) state.inflight.delete(key);
    if (!state.sessions.has(key) && (state.generations.get(key) || 0) === generation) state.generations.delete(key);
  }
}

/** 宿主登录桥：只暴露给 DSH 宿主/登录 UI，不注册为模型工具。 */
export function createSessionStore(ctx) {
  return Object.freeze({
    login: (args = {}) => loginWithToken(args?.token, args?.agentId, { ttlMs: args?.ttlMs }, ctx),
    persist: async (args = {}) => {
      const { agentId, token } = args ?? {};
      const key = sessionKey(agentId);
      const normalized = normalizedToken(token);
      if (typeof ctx?.credentials?.modifyRecord !== 'function') throw new Error('org_plugin_credentials_unavailable');
      await ctx.credentials.modifyRecord(credentialKeyForSession(key), async () => ({ kind: 'api-key', key: normalized }));
      return loginWithToken(normalized, key, {}, ctx);
    },
    logout: (agentId) => logoutSession(agentId, ctx),
    isLoggedIn: (agentId) => isLoggedIn(agentId, ctx),
  });
}

export async function logoutSession(sessionId, ctx) {
  const key = sessionKey(sessionId);
  if (ctx?.credentials) {
    if (typeof ctx.credentials.deleteRecord !== 'function') throw new Error('org_plugin_credentials_unavailable');
    await ctx.credentials.deleteRecord(credentialKeyForSession(key));
  }
  const state = stateFor(ctx);
  invalidate(state, key);
  logoutMemory(key, ctx);
  return { ok: true };
}

export { logoutSession as logout };
