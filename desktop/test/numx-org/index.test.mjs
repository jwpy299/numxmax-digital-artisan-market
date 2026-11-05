import { test, beforeEach } from 'node:test';

import assert from 'node:assert/strict';
import { apply, inject, name } from '../../src/plugins/numx-org/lib/index.js';
import { tools } from '../../src/plugins/numx-org/lib/tools.js';
import { limits } from '../../src/plugins/numx-org/lib/contract.js';
import { assertToolPoliciesComplete, createApprovalGate, TOOL_POLICIES } from '../../src/plugins/numx-org/lib/approval.js';
import { loginWithToken, logout, logoutSession, isLoggedIn, currentToken, disposeSessions, credentialKeyForSession, resolveToken } from '../../src/plugins/numx-org/lib/session.js';

const sessionCtx = { credentials: { deleteRecord: async () => {} } };
const connection = { fetch: { register: () => async () => {} } };
beforeEach(() => disposeSessions(sessionCtx));
test('插件：命名导出、工具注册和真实 DSH 审批前置门', async () => {
  assert.equal(name, 'numx-org');
  assert.deepEqual(inject, ['tools', 'credentials', 'connection']);
  const registered = [];
  const activeTools = new Set();
  const listeners = new Map();
  const provided = new Map();
  const records = new Map();
  const cleanupEvents = [];
  let credentialReads = 0;
  const pluginContext = { connection,
    on: (event, listener) => { listeners.set(event, listener); return () => { if (event === 'tools/pre-execute') cleanupEvents.push('gate'); listeners.delete(event); }; },
    provide: (key, value) => { provided.set(key, value); return () => { cleanupEvents.push('auth'); provided.delete(key); }; },
    credentials: {
      readRecord: async (key) => { credentialReads += 1; return records.get(key); },
      deleteRecord: async (key) => { records.delete(key); },
      modifyRecord: async (key, mutate) => {
        const next = await mutate(records.get(key));
        if (next === undefined) return records.get(key);
        records.set(key, next);
        return next;
      },
    },
    tools: { register: (tool) => { registered.push(tool); activeTools.add(tool.name); return () => { cleanupEvents.push(`tool:${tool.name}`); activeTools.delete(tool.name); }; } },
  };
  const dispose = await apply(pluginContext);
  assert.equal(typeof dispose, 'function');
  assert.equal(registered.length, tools.length);
  assert.ok(registered.every((tool) => Object.hasOwn(TOOL_POLICIES, tool.name)), '每个本插件工具都必须有审批策略');
  assert.ok(registered.every((tool) => {
    const branches = tool.output?.schema?.oneOf;
    return typeof tool.output?.render === 'function' && Array.isArray(branches)
      && branches.every((branch) => typeof branch.type === 'string')
      && ['object', 'array', 'null'].every((type) => branches.some((branch) => branch.type === type));
  }), 'DSH 只接受单 type 字符串，oneOf 覆盖 object/array/null');
  assert.ok(registered.some((tool) => tool.name === 'cabin_list'));
  assert.ok(registered.some((tool) => tool.name === 'org_query'));
  assert.ok(registered.some((tool) => tool.name === 'market_search'));
  assert.equal(registered.some((tool) => tool.name === 'session_login'), false);
  assert.equal(registered.some((tool) => tool.name === 'session_logout'), false, '登出只允许宿主调用，不暴露给模型');
  assert.equal(registered.some((tool) => tool.parameters?.properties?.token), false, 'token 不得成为模型工具参数');
  assert.equal('default' in (await import('../../src/plugins/numx-org/lib/index.js')), false);

  const gate = listeners.get('tools/pre-execute');
  assert.equal(typeof gate, 'function');
  const allow = async () => ({ kind: 'allow' });
  for (const exec of [
    { name: 'org_write', arguments: { dept: 'finance', task: 'test' } },
    { name: 'file_dispatch', arguments: { toDept: 'finance' } },
    { name: 'cross_collab', arguments: { action: 'propose' } },
  ]) {
    const decision = await gate(exec, allow);
    assert.equal(decision.kind, 'ask');
    assert.match(decision.reason, /harnessProxy\./);
  }
  assert.equal((await gate({ name: 'org_write', arguments: {} })).kind, 'ask', '缺少 next 也不得跳过确认');
  assert.equal((await gate({ name: 'org_write', arguments: {} }, async () => undefined)).kind, 'ask', '下游未决不得跳过确认');
  assert.deepEqual(await gate({ name: 'market_search', arguments: {} }, async () => undefined), { kind: 'allow' });
  assert.equal(await gate({ name: 'bash', arguments: {} }, async () => undefined), undefined, '其他插件工具必须保持未决，不得被提升为 allow');
  assert.deepEqual(await gate({ name: 'cross_collab', arguments: { action: 'list' } }, allow), { kind: 'allow' });
  const invalidCollab = await gate({ name: 'cross_collab', arguments: {} }, allow);
  assert.equal(invalidCollab.kind, 'deny', '未知协同动作不得被误映射为 collabPropose 后再请求确认');
  assert.match(invalidCollab.reason, /org_plugin_confirmation_unmapped/);
  assert.deepEqual(await gate({ name: 'market_search', arguments: {} }, allow), { kind: 'allow' });
  const denied = { kind: 'deny', reason: 'other-policy' };
  assert.equal(await gate({ name: 'org_write', arguments: {} }, async () => denied), denied);
  const auth = provided.get('numxOrgAuth');
  auth.login({ agentId: 'host-login-session', token: 'host-token' });
  assert.equal(currentToken('host-login-session', pluginContext), 'host-token');
  await auth.persist({ agentId: 'persist-session', token: 'persisted-token' });
  disposeSessions(pluginContext);
  assert.equal(await auth.isLoggedIn('persist-session'), true, '内存清空后，宿主状态必须与持久凭据一致');
  disposeSessions(pluginContext);
  const readsBeforeResolve = credentialReads;
  assert.equal(await resolveToken('persist-session', pluginContext), 'persisted-token');
  assert.equal(await resolveToken('persist-session', pluginContext), 'persisted-token');
  assert.equal(credentialReads, readsBeforeResolve + 1, '两次凭据回读只能有一次穿透，第二次必须命中会话缓存');
  assert.equal(currentToken('persist-session', pluginContext), 'persisted-token', '凭据回读必须进入同会话缓存，不能每次穿透凭据库');
  loginWithToken('dispose-check', 'dispose-session', {}, pluginContext);
  await dispose();
  assert.equal(await auth.isLoggedIn('dispose-session'), false);
  assert.equal(await auth.isLoggedIn('host-login-session'), false);
  assert.equal(provided.size, 0);
  assert.equal(listeners.size, 0);
  assert.equal(activeTools.size, 0, '正常卸载必须先注销全部工具，再释放审批门');
  const gateCleanupIndex = cleanupEvents.indexOf('gate');
  assert.ok(gateCleanupIndex > 0 && cleanupEvents.slice(0, gateCleanupIndex).every((event) => event.startsWith('tool:')), '全部工具必须先于审批门注销');
  await logout('dispose-session', pluginContext);
});

test('插件：缺少审批挂钩时 fail-closed，且不注册工具', async () => {
  const registered = [];
  await assert.rejects(apply({ connection, tools: { register: (tool) => registered.push(tool) } }), /org_plugin_approval_gate_unavailable/);
  assert.equal(registered.length, 0);
});

test('会话：token 按 agent.id 隔离，TTL 到期与退出均失效', async () => {
  const a = 'test-session-a';
  const b = 'test-session-b';
  try {
    loginWithToken('token-a', a, {}, sessionCtx);
    loginWithToken('token-b', b, {}, sessionCtx);
    assert.equal(await isLoggedIn(a, sessionCtx), true);
    assert.equal(await isLoggedIn(b, sessionCtx), true);
    assert.equal(currentToken(a, sessionCtx), 'token-a');
    assert.equal(currentToken(b, sessionCtx), 'token-b');
    loginWithToken('padded-token', ' padded-session ', {}, sessionCtx);
    loginWithToken('null-options', 'null-options-session', null, sessionCtx);
    assert.equal(currentToken('null-options-session', sessionCtx), 'null-options');
    assert.equal(currentToken('padded-session', sessionCtx), 'padded-token');
    assert.equal(await isLoggedIn(' padded-session ', sessionCtx), true);
    await logout(' padded-session ', sessionCtx);
    await logout(a, sessionCtx);
    assert.equal(await isLoggedIn(a, sessionCtx), false);
    assert.equal(await isLoggedIn(b, sessionCtx), true);
    assert.throws(() => currentToken(a, sessionCtx), /org_plugin_session_required/);
    assert.throws(() => currentToken(undefined, sessionCtx), /org_plugin_session_scope_required/);
    loginWithToken('short-lived', a, { ttlMs: 1 }, sessionCtx);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await isLoggedIn(a, sessionCtx), false);
    assert.throws(() => currentToken(a, sessionCtx), /org_plugin_session_required/);
    loginWithToken('disposable', a, {}, sessionCtx);
    disposeSessions(sessionCtx);
    assert.equal(await isLoggedIn(a, sessionCtx), false);
    assert.equal(await isLoggedIn(b, sessionCtx), false);
  } finally {
    await logout(a, sessionCtx);
    await logout(b, sessionCtx);
  }
});

test('插件：缺少 Connection 时 UI 停链并回滚已注册工具', async () => {
  const activeTools = new Set();
  await assert.rejects(apply({
    on: () => () => {},
    provide: () => () => {},
    credentials: { readRecord: async () => undefined, deleteRecord: async () => {}, modifyRecord: async () => {} },
    tools: { register: (tool) => { activeTools.add(tool.name); return () => activeTools.delete(tool.name); } },
  }), /org_ui_route_registry_unavailable/);
  assert.equal(activeTools.size, 0);
});

test('插件：缺少凭据服务时 fail-closed，且不注册工具', async () => {
  const registered = [];
  await assert.rejects(apply({ connection,
    on: () => () => {},
    provide: () => () => {},
    tools: { register: (tool) => registered.push(tool) },
    credentials: {},
  }), /org_plugin_credentials_unavailable/);
  assert.equal(registered.length, 0);
});

test('插件：注册结果不确定时清理已确认工具并保守保留审批门', async () => {
  const listeners = new Map();
  const provided = new Map();
  const activeTools = new Set();
  let calls = 0;
  await assert.rejects(apply({ connection,
    on: (event, listener) => { listeners.set(event, listener); return () => listeners.delete(event); },
    provide: (key, value) => { provided.set(key, value); return () => provided.delete(key); },
    credentials: { readRecord: async () => undefined, deleteRecord: async () => {}, modifyRecord: async () => {} },
    tools: { register: (tool) => {
      calls += 1;
      activeTools.add(tool.name);
      if (calls === 3) throw new Error('register_failed');
      return () => activeTools.delete(tool.name);
    } },
  }), /register_failed/);
  assert.equal(activeTools.size, 1, '注册抛出前的潜在孤儿工具无法被证明不存在');
  assert.equal(listeners.size, 1, '注册结果不确定时必须保留审批门');
  assert.equal(provided.size, 0);
});

test('插件：任一工具注销失败都保留审批门并清理宿主服务', async () => {
  const listeners = new Map();
  const provided = new Map();
  const activeTools = new Set();
  const dispose = await apply({ connection,
    on: (event, listener) => { listeners.set(event, listener); return () => listeners.delete(event); },
    provide: (key, value) => { provided.set(key, value); return () => provided.delete(key); },
    credentials: { readRecord: async () => undefined, deleteRecord: async () => {}, modifyRecord: async () => {} },
    tools: { register: (tool) => {
      activeTools.add(tool.name);
      return () => {
        if (tool.name === 'org_write') throw new Error('dispose_failed');
        activeTools.delete(tool.name);
      };
    } },
  });
  await assert.rejects(dispose, /dispose_failed/);
  assert.equal(activeTools.has('org_write'), true);
  assert.equal(listeners.has('tools/pre-execute'), true, '仍有写工具可能活跃时审批门必须保留');
  assert.equal(provided.size, 0, '宿主认证服务仍按序清理');
});

test('插件：部门工具清单缺策略时启动即失败', () => {
  assert.throws(() => createApprovalGate({}, [{ name: 'dept_missing' }]), /org_plugin_policy_missing:dept_missing/);
});

test('插件：审批门注册失败也会回滚宿主服务且不注册工具', async () => {
  const provided = new Map();
  let registrations = 0;
  await assert.rejects(apply({ connection,
    on: () => { throw new Error('gate_register_failed'); },
    provide: (key, value) => { provided.set(key, value); return () => provided.delete(key); },
    credentials: { readRecord: async () => undefined, deleteRecord: async () => {}, modifyRecord: async () => {} },
    tools: { register: () => { registrations += 1; return () => {}; } },
  }), /gate_register_failed/);
  assert.equal(registrations, 0);
  assert.equal(provided.size, 0);
});

test('插件：多过程策略只允许只读工具，写工具不得通过启动校验', () => {
  assert.throws(() => assertToolPoliciesComplete(
    [{ name: 'invalid_multi_write' }],
    { invalid_multi_write: { procedures: ['harnessProxy.delegate'] } },
  ), /org_plugin_policy_plural_write/);
  assert.throws(() => assertToolPoliciesComplete([{ name: 'missing_policy' }], { missing_policy: null }), /org_plugin_policy_missing:missing_policy/);
  assert.throws(() => assertToolPoliciesComplete([{ name: 'empty_procedures' }], { empty_procedures: { readOnly: true, procedures: [] } }), /org_plugin_policy_procedures_empty:empty_procedures/);
});

test('插件：函数型策略可用自有样本校验，不写死协同 action', () => {
  assert.doesNotThrow(() => assertToolPoliciesComplete(
    [{ name: 'custom_scope_read' }],
    { custom_scope_read: {
      sampleArguments: [{ scope: 'mine' }],
      readOnly: (args) => args.scope === 'mine',
      procedure: (args) => args.scope === 'mine' ? 'harnessProxy.tasks' : null,
    } },
  ));
  assert.throws(() => assertToolPoliciesComplete(
    [{ name: 'custom_scope_read' }],
    { custom_scope_read: { sampleArguments: [], procedure: () => 'harnessProxy.tasks' } },
  ), /org_plugin_policy_samples_invalid:custom_scope_read/);
});

test('宿主登录参数缺省时返回稳定作用域错误', async () => {
  const provided = new Map();
  const dispose = await apply({ connection,
    on: () => () => {},
    provide: (key, value) => { provided.set(key, value); return () => provided.delete(key); },
    credentials: { readRecord: async () => undefined, deleteRecord: async () => {}, modifyRecord: async () => {} },
    tools: { register: () => () => {} },
  });
  try {
    const auth = provided.get('numxOrgAuth');
    assert.throws(() => auth.login(), /org_plugin_session_scope_required/);
    assert.throws(() => auth.login(null), /org_plugin_session_scope_required/);
    await assert.rejects(auth.persist(), /org_plugin_session_scope_required/);
    await assert.rejects(auth.persist(null), /org_plugin_session_scope_required/);
  } finally {
    await dispose();
  }
});

test('会话：不同物理模块实例共享同一宿主登录', async () => {
  const a = await import(new URL('../../src/plugins/numx-org/lib/session.js?instance=a', import.meta.url));
  const b = await import(new URL('../../src/plugins/numx-org/lib/session.js?instance=b', import.meta.url));
  const ctx = { credentials: { readRecord: async () => undefined } };
  try {
    a.loginWithToken('cross-module-token', 'cross-module-session', {}, ctx);
    assert.equal(b.currentToken('cross-module-session', ctx), 'cross-module-token');
  } finally {
    b.disposeSessions(ctx);
  }
});

test('插件：宿主不支持工具注销时保留审批门保护孤儿工具', async () => {
  const listeners = new Map();
  const provided = new Map();
  const activeTools = new Set();
  let calls = 0;
  await assert.rejects(apply({ connection,
    on: (event, listener) => { listeners.set(event, listener); return () => listeners.delete(event); },
    provide: (key, value) => { provided.set(key, value); return () => provided.delete(key); },
    credentials: { readRecord: async () => undefined, deleteRecord: async () => {}, modifyRecord: async () => {} },
    tools: { register: (tool) => {
      calls += 1;
      activeTools.add(tool.name);
      if (calls === 3) return undefined;
      return () => activeTools.delete(tool.name);
    } },
  }), new RegExp(`org_plugin_tool_disposer_unavailable:${tools[2].name}`));
  assert.equal(activeTools.size, 1, '未支持注销的孤儿工具必须被明确保留在审批门后');
  assert.equal(listeners.size, 1, '审批门不得先于孤儿工具被释放');
  assert.equal(provided.size, 0);
});

test('会话：登出先删持久凭据，删除失败不伪装成功', async () => {
  let allowDelete = false;
  const credentialKey = credentialKeyForSession('logout-session');
  const records = new Map([[credentialKey, { kind: 'api-key', key: 'logout-token' }]]);
  const ctx = { credentials: {
    readRecord: async (key) => records.get(key),
    deleteRecord: async (key) => { if (!allowDelete) throw new Error('delete_failed'); records.delete(key); },
  } };
  loginWithToken('logout-token', 'logout-session', {}, ctx);
  await assert.rejects(logoutSession('logout-session', ctx), /delete_failed/);
  assert.equal(currentToken('logout-session', ctx), 'logout-token', '删除失败时保留可重试会话，不先造成“内存登出、持久化又复活”');
  assert.equal(records.has(credentialKey), true);
  allowDelete = true;
  await logoutSession('logout-session', ctx);
  assert.equal(await isLoggedIn('logout-session', ctx), false);
  assert.equal(records.has(credentialKey), false, '持久凭据必须真实删除');
  assert.equal(await ctx.credentials.readRecord(credentialKey), undefined);
  assert.throws(() => currentToken('logout-session', ctx), /org_plugin_session_required/);
});

test('会话：凭据服务缺少删除接口时不得伪装持久登出', async () => {
  const ctx = { credentials: { readRecord: async () => undefined } };
  loginWithToken('logout-token', 'logout-without-delete', {}, ctx);
  await assert.rejects(logoutSession('logout-without-delete', ctx), /org_plugin_credentials_unavailable/);
  assert.equal(currentToken('logout-without-delete', ctx), 'logout-token', '删除不可用时保留可重试会话，不先清内存造成假登出');
  ctx.credentials.deleteRecord = async () => {};
  await logoutSession('logout-without-delete', ctx);
  assert.throws(() => currentToken('logout-without-delete', ctx), /org_plugin_session_required/);
});

test('会话：并发凭据回读去重，登出后旧异步回读不得复活 token', async () => {
  const credentialKey = credentialKeyForSession('dedup-session');
  const records = new Map([[credentialKey, { kind: 'api-key', key: 'dedup-token' }]]);
  let reads = 0;
  const ctx = { credentials: {
    readRecord: async () => { reads += 1; await new Promise((resolve) => setTimeout(resolve, 10)); return records.get(credentialKey); },
    deleteRecord: async (key) => { records.delete(key); },
  } };
  const [left, right] = await Promise.all([resolveToken('dedup-session', ctx), resolveToken('dedup-session', ctx)]);
  assert.equal(left, 'dedup-token');
  assert.equal(right, 'dedup-token');
  assert.equal(reads, 1);
  await logoutSession('dedup-session', ctx);
  await assert.rejects(resolveToken('dedup-session', ctx), /org_plugin_session_required/);

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  records.set(credentialKey, { kind: 'api-key', key: 'stale-token' });
  ctx.credentials.readRecord = async () => { reads += 1; const snapshot = records.get(credentialKey); await gate; return snapshot; };
  const pending = resolveToken('dedup-session', ctx);
  await new Promise((resolve) => setImmediate(resolve));
  await logoutSession('dedup-session', ctx);
  release();
  await assert.rejects(pending, /org_plugin_session_required/);
  assert.equal(await isLoggedIn('dedup-session', ctx), false);
});

test('会话：token 长度超过契约上限时 fail-closed', async () => {
  assert.throws(() => loginWithToken('x'.repeat(limits().tokenChars + 1), 'too-long-token'), /org_plugin_token_too_long/);
  assert.equal(await isLoggedIn('too-long-token', sessionCtx), false);
});

test('会话：容量淘汰使旧异步回读失效，不让最老会话复活', async () => {
  const ctx = { credentials: { readRecord: async () => undefined, deleteRecord: async () => {} } };
  const credentialKey = credentialKeyForSession('session-0');
  const records = new Map([[credentialKey, { kind: 'api-key', key: 'stale-token' }]]);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  ctx.credentials.readRecord = async () => { await gate; return records.get(credentialKey); };
  const pending = resolveToken('session-0', ctx);
  await new Promise((resolve) => setImmediate(resolve));
  loginWithToken('token-0', 'session-0', {}, ctx);
  for (let index = 1; index < limits().maxSessions; index += 1) loginWithToken(`token-${index}`, `session-${index}`, {}, ctx);
  loginWithToken(`token-${limits().maxSessions}`, `session-${limits().maxSessions}`, {}, ctx);
  release();
  await assert.rejects(pending, /org_plugin_session_required/);
  assert.throws(() => currentToken('session-0', ctx), /org_plugin_session_required/, '容量淘汰后旧内存会话不得复活');
  records.delete(credentialKey);
  assert.equal(await isLoggedIn('session-0', ctx), false);
  assert.equal(await isLoggedIn(`session-${limits().maxSessions}`, ctx), true);
});

test('插件：未知部门策略工具必须 fail-closed', () => {
  assert.throws(() => createApprovalGate({ unknown_tool: { readOnly: true, procedure: 'harnessProxy.tasks' } }), /org_plugin_policy_unknown_tool:unknown_tool/);
});

test('插件：空部门策略不得进入审批门', () => {
  assert.throws(() => createApprovalGate(null), /org_plugin_policy_invalid/);
});

test('插件：部门扩展不得覆盖核心写审批策略', () => {
  assert.throws(() => createApprovalGate({ org_write: { readOnly: true, procedure: 'harnessProxy.tasks' } }), /org_plugin_policy_conflict:org_write/);
});
