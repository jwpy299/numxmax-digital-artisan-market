import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTools, optionalText, requiredText } from '../../src/plugins/numx-org/lib/tools.js';
import { createSessionStore, credentialKeyForSession, logout, disposeSessions } from '../../src/plugins/numx-org/lib/session.js';
import { limits } from '../../src/plugins/numx-org/lib/contract.js';
import { API, createExec, okResponse, createToolContext } from './fixtures.mjs';

const exec = createExec();

const toolContext = createToolContext(exec.agent.id);
const tools = createTools(toolContext);
const byName = (name) => tools.find((tool) => tool.name === name);
afterEach(() => disposeSessions(toolContext));

test('工具：输入上限配置必须为正整数', () => {
  assert.throws(() => requiredText('x', 'missing', 0), /org_plugin_input_invalid_limit/);
  assert.throws(() => requiredText('x', 'missing', 1.5), /org_plugin_input_invalid_limit/);
  assert.throws(() => optionalText('x', 0), /org_plugin_input_invalid_limit/);
});

test('工具：读参数夹取且非法数字不退成默认值', async (t) => {
  const calls = [];
  try {
    t.mock.method(globalThis, 'fetch', async (url, init) => { calls.push({ url, init }); return okResponse(); });
    await assert.rejects(byName('org_query').execute({}, { agent: { id: 'other-session' } }), /org_plugin_session_required/);
    assert.equal(calls.length, 0, '其他会话不得借用当前 token');
    await byName('org_query').execute({ dept: '  finance  ', limit: 0 }, exec);
    assert.match(calls[0].url, /\/api\/trpc\/harnessProxy\.tasks$/);
    let body = JSON.parse(calls[0].init.body);
    assert.equal(body.json.dept, 'finance');
    assert.equal(body.json.limit, limits().queryLimitMin);
    await byName('contacts_query').execute({ limit: 99 }, exec);
    assert.match(calls[1].url, /\/api\/trpc\/harnessProxy\.employees$/);
    body = JSON.parse(calls[1].init.body);
    assert.equal(body.json.limit, limits().queryLimitMax);
    await assert.rejects(byName('org_query').execute({ limit: 'abc' }, exec), /org_plugin_limit_invalid/);
    await assert.rejects(byName('org_query').execute({ limit: true }, exec), /org_plugin_limit_invalid/);
    await assert.rejects(byName('org_query').execute({ limit: {} }, exec), /org_plugin_limit_invalid/);
    assert.equal(calls.length, 2);
  } finally {
    await logout(exec.agent.id, toolContext);
  }
});

test('工具：写参数先规范化/拒绝空值，再进入传输层', async (t) => {
  const calls = [];
  try {
    t.mock.method(globalThis, 'fetch', async (url, init) => { calls.push({ url, init }); return okResponse(); });
    await assert.rejects(byName('org_write').execute({ dept: ' ', task: 'x' }, exec), /org_plugin_dept_required/);
    await assert.rejects(byName('org_write').execute({ dept: 'finance', task: ' ' }, exec), /org_plugin_task_required/);
    await assert.rejects(byName('org_write').execute({ dept: 'finance', task: 'x'.repeat(limits().taskChars + 1) }, exec), /org_plugin_input_too_long/);
    await assert.rejects(byName('org_write').execute({ dept: { value: 'finance' }, task: 'x' }, exec), /org_plugin_input_type/);
    await assert.rejects(byName('file_dispatch').execute({ toDept: 'finance', fileName: 'a.docx', toName: ' ' }, exec), /org_plugin_recipient_required/);
    assert.equal(calls.length, 0);

    await byName('org_write').execute({ dept: ' finance ', task: '  真实任务  ', idemKey: 'org-write-001' }, exec);
    assert.match(calls[0].url, /\/api\/trpc\/harnessProxy\.delegate$/);
    let body = JSON.parse(calls[0].init.body);
    assert.equal(body.json.dept, 'finance');
    assert.equal(body.json.task, '真实任务');
    assert.equal(body.json.idemKey, 'org-write-001');
    await assert.rejects(byName('org_write').execute({ dept: 'finance', task: 'x', idemKey: 'bad key' }, exec), /org_plugin_idem_key_invalid/);

    await byName('file_dispatch').execute({ toDept: ' finance ', fileName: ' a.docx ', toName: ' 张三 ', fileUri: ' ' }, exec);
    assert.match(calls[1].url, /\/api\/trpc\/harnessProxy\.dispatchFile$/);
    body = JSON.parse(calls[1].init.body);
    assert.equal(body.json.toDept, 'finance');
    assert.equal(body.json.fileName, 'a.docx');
    assert.equal(body.json.toName, '张三');
    assert.equal('fileUri' in body.json, false);
    await assert.rejects(byName('file_dispatch').execute({ toDept: 'finance', fileName: 'a.docx', toName: '张三', fileUri: 'https://example.invalid/a' }, exec), /org_plugin_file_uri_invalid/);
    assert.equal(calls.length, 2, '非法附件 URI 不得发往上游');

    await byName('cross_collab').execute({ action: 'propose', toFactoryId: 2, note: '  协作说明  ' }, exec);
    assert.match(calls[2].url, /\/api\/trpc\/harnessProxy\.collabPropose$/);
    body = JSON.parse(calls[2].init.body);
    assert.equal(body.json.note, '协作说明');
    await assert.rejects(byName('cross_collab').execute({ action: 'propose', toFactoryId: 0 }, exec), /org_plugin_collab_factory_required/);
    assert.equal(calls.length, 3);
  } finally {
    await logout(exec.agent.id, toolContext);
  }
});

test('工具：订阅目录与本企业权益真实调用各自只读接口', async (t) => {
  const urls = [];
  try {
    t.mock.method(globalThis, 'fetch', async (url) => {
      urls.push(url);
      const entitlement = url.includes('packages.myEntitlement');
      return new Response(JSON.stringify({ result: { data: { json: entitlement ? null : [{ key: 'dept_finance' }] } } }), { status: 200 });
    });
    const result = await byName('market_search').execute({}, exec);
    assert.deepEqual(result, { catalog: [{ key: 'dept_finance' }], entitlement: null });
    assert.equal(urls.length, 2);
    assert.ok(urls.some((url) => url.includes('/api/trpc/packages.list')));
    assert.ok(urls.some((url) => url.includes('/api/trpc/packages.myEntitlement')));
    assert.deepEqual(urls.map((url) => url.split('/api/trpc/')[1]).sort(), ['packages.list', 'packages.myEntitlement']);
  } finally {
    await logout(exec.agent.id, toolContext);
  }
});

test('工具：workspace_list 只读真实工作区，角色与员工免安装来自 WB', async (t) => {
  const urls = [];
  try {
    t.mock.method(globalThis, 'fetch', async (url) => {
      urls.push(url);
      const payload = { result: { data: { json: { cabins: [{ cabinCode: 'finance', role: 'manager', activation: 'eligible', employeeInstallRequired: false, capabilities: ['plugin.install'] }] } } } };
      return new Response(JSON.stringify(payload), { status: 200 });
    });
    const result = await byName('workspace_list').execute({}, exec);
    assert.equal(result.cabins[0].role, 'manager');
    assert.equal(result.cabins[0].employeeInstallRequired, false);
    assert.deepEqual(result.cabins[0].capabilities, ['plugin.install']);
    assert.deepEqual(urls, [`${API}/api/trpc/orgPlugin.workspaces`]);
  } finally {
    await logout(exec.agent.id, toolContext);
  }
});

test('工具：null 与异形参数不会泄漏原生 TypeError', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => okResponse());
  await byName('workspace_list').execute(null, exec);
  await byName('cabin_list').execute(null, exec);
  await byName('org_query').execute(null, exec);
  await byName('contacts_query').execute(null, exec);
  await byName('market_search').execute(null, exec);
  await assert.rejects(byName('org_write').execute(null, exec), /org_plugin_dept_required/);
  await assert.rejects(byName('file_dispatch').execute(null, exec), /org_plugin_dept_required/);
  await assert.rejects(byName('cross_collab').execute(null, exec), /org_plugin_collab_action_invalid/);
  await assert.rejects(byName('cross_collab').execute([], exec), /org_plugin_collab_action_invalid/);
});

test('工具：cabin_list 实调舱图，宿主 logout 删除凭据后不可再查询', async (t) => {
  const deletedCredentials = new Set();
  const logoutContext = {
    credentials: {
      readRecord: async (key) => !deletedCredentials.has(key) && key === credentialKeyForSession(exec.agent.id)
        ? { kind: 'api-key', key: 'test-token' }
        : undefined,
      deleteRecord: async (key) => { deletedCredentials.add(key); },
    },
  };
  const logoutTools = createTools(logoutContext);
  const byLogoutName = (name) => logoutTools.find((tool) => tool.name === name);
  const logoutStore = createSessionStore(logoutContext);
  const urls = [];
  try {
    t.mock.method(globalThis, 'fetch', async (url) => { urls.push(url); return okResponse(); });
    assert.equal(await byLogoutName('cabin_list').execute({}, exec), null);
    assert.deepEqual(urls, [`${API}/api/trpc/entCabin.map`]);
    await logoutStore.logout(exec.agent.id);
    assert.equal(deletedCredentials.has(credentialKeyForSession(exec.agent.id)), true);
    await assert.rejects(byLogoutName('cabin_list').execute({}, exec), /org_plugin_session_required/);
    await assert.rejects(byLogoutName('org_query').execute({}, exec), /org_plugin_session_required/);
  } finally {
    disposeSessions(logoutContext);
  }
});
