import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTools } from '../../src/plugins/dept-finance/lib/tools.js';
import { credentialKeyForSession, disposeSessions } from '../../src/plugins/numx-org/lib/session.js';
import { limits } from '../../src/plugins/numx-org/lib/contract.js';
import { API, createExec, okResponse, createToolContext } from '../numx-org/fixtures.mjs';

const exec = createExec();
const READ_LIMITS = Object.freeze({ finance_tasks: limits().queryLimitMin, finance_employees: limits().queryLimitMax });
const DEFAULT_READ_STATUSES = Object.freeze({ finance_reviews: 'pending', finance_notices: 'unread' });
const toolContext = createToolContext(exec.agent.id);
const tools = createTools(toolContext);
const byName = (name) => {
  const tool = tools.find((item) => item.name === name);
  assert.ok(tool, `未注册的财务工具：${name}`);
  return tool;
};
afterEach(() => disposeSessions(toolContext));

test('财务舱：五个真实只读接口都带 finance 部门与状态参数', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, init) => { calls.push({ url, init }); return okResponse(); };
    const cases = [
      ['finance_tasks', { limit: limits().queryLimitMin - 1 }, 'harnessProxy.tasks'],
      ['finance_delegations', { status: 'open', dept: 'produce' }, 'harnessProxy.delegations'],
      ['finance_employees', { limit: limits().queryLimitMax + 1 }, 'harnessProxy.employees'],
      ['finance_reviews', {}, 'harnessProxy.reviews'],
      ['finance_notices', {}, 'harnessProxy.notices'],
    ];
    for (const [name, args, procedure] of cases) {
      await byName(name).execute(args, exec);
      const call = calls.at(-1);
      assert.equal(call.url, `${API}/api/trpc/${procedure}`);
      const body = JSON.parse(call.init.body);
      const expected = { token: 'test-token', dept: 'finance' };
      if (Object.hasOwn(READ_LIMITS, name)) expected.limit = READ_LIMITS[name];
      const expectedStatus = args.status ?? DEFAULT_READ_STATUSES[name];
      if (expectedStatus) expected.status = expectedStatus;
      assert.deepEqual(body.json, expected);
    }
    assert.equal(JSON.parse(calls[0].init.body).json.limit, limits().queryLimitMin);
    assert.equal(JSON.parse(calls[2].init.body).json.limit, limits().queryLimitMax);
    for (const index of [1, 3, 4]) assert.equal(Object.hasOwn(JSON.parse(calls[index].init.body).json, 'limit'), false, '未传 limit 时应使用上游默认，而不是借用协同常量');
    assert.equal(JSON.parse(calls[3].init.body).json.status, 'pending');
    assert.equal(JSON.parse(calls[4].init.body).json.status, 'unread');
    await assert.rejects(byName('finance_tasks').execute({}, { agent: { id: 'other-session' } }), /org_plugin_session_required/);
    assert.equal(calls.length, 5);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('财务舱：委派、复核提交/裁决与通知已读使用真实写接口', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, init) => { calls.push({ url, init }); return okResponse(); };
    await byName('finance_delegate').execute({ dept: 'produce', task: '  核对本月账龄  ', idemKey: 'finance-ageing-001', priority: limits().priorityMax }, exec);
    let call = calls[0];
    assert.equal(call.url, `${API}/api/trpc/harnessProxy.delegate`);
    let body = JSON.parse(call.init.body);
    assert.deepEqual(body.json, { token: 'test-token', dept: 'finance', task: '核对本月账龄', idemKey: 'finance-ageing-001', priority: limits().priorityMax });

    await byName('finance_review_submit').execute({ dept: 'produce', title: '  月度复核表  ', stationKey: 'dept-produce-lead', itemType: 'rpt', summary: '  摘要  ', payloadUri: 'wbfile:123', domain: 'finance' }, exec);
    call = calls[1];
    assert.equal(call.url, `${API}/api/trpc/harnessProxy.reviewSubmit`);
    body = JSON.parse(call.init.body);
    assert.equal(body.json.dept, 'finance');
    assert.equal(body.json.stationKey, 'dept-finance-lead', '模型传入的他部门工位不得被转发');
    assert.equal(byName('finance_review_submit').parameters.properties.stationKey, undefined);
    assert.equal(body.json.title, '月度复核表');
    assert.equal(body.json.summary, '摘要');
    assert.equal(body.json.payloadUri, 'wbfile:123');
    assert.equal(body.json.itemType, 'rpt');
    assert.equal(body.json.domain, 'finance');

    await byName('finance_review_decide').execute({ dept: 'produce', reviewId: ' rv-1 ', decision: 'rejected', note: '  数据不一致  ' }, exec);
    call = calls[2];
    assert.equal(call.url, `${API}/api/trpc/harnessProxy.reviewDecide`);
    body = JSON.parse(call.init.body);
    assert.deepEqual(body.json, { token: 'test-token', dept: 'finance', reviewId: 'rv-1', decision: 'rejected', note: '数据不一致' });

    await byName('finance_notice_read').execute({ ids: [' n1 ', 'n2'] }, exec);
    call = calls[3];
    assert.equal(call.url, `${API}/api/trpc/harnessProxy.noticeRead`);
    body = JSON.parse(call.init.body);
    assert.deepEqual(body.json, { token: 'test-token', dept: 'finance', ids: ['n1', 'n2'] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('财务舱：null 与异形参数不会泄漏原生 TypeError', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => okResponse();
    for (const name of ['finance_tasks', 'finance_delegations', 'finance_employees', 'finance_reviews', 'finance_notices']) {
      await byName(name).execute(null, exec);
    }
    await assert.rejects(byName('finance_delegate').execute(null, exec), /dept_finance_task_required/);
    await assert.rejects(byName('finance_review_submit').execute(null, exec), /dept_finance_title_required/);
    await assert.rejects(byName('finance_review_decide').execute(null, exec), /dept_finance_review_id_invalid/);
    await assert.rejects(byName('finance_notice_read').execute(null, exec), /dept_finance_notice_ids_invalid/);
    await assert.rejects(byName('finance_delegate').execute([], exec), /dept_finance_task_required/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('财务舱：非法写参数在上游调用前拒绝', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  try {
    globalThis.fetch = async () => { fetchCalls += 1; return okResponse(); };
    await assert.rejects(byName('finance_delegate').execute({ task: 'x', idemKey: 'bad key' }, exec), /dept_finance_idem_key_invalid/);
    await assert.rejects(byName('finance_delegate').execute({ task: 'x'.repeat(limits().taskChars + 1), idemKey: 'valid-key-001' }, exec), /dept_finance_input_too_long/);
    await assert.rejects(byName('finance_delegate').execute({ task: 'x', idemKey: 'valid-key-001', priority: limits().priorityMax + 1 }, exec), /dept_finance_priority_invalid/);
    await assert.rejects(byName('finance_review_submit').execute({ title: 'x', payloadUri: 'https://example.invalid/a' }, exec), /dept_finance_file_uri_invalid/);
    await assert.rejects(byName('finance_review_submit').execute({ title: 'x', payloadUri: `wbfile:${'1'.repeat(limits().payloadUriChars + 1)}` }, exec), /dept_finance_input_too_long/);
    await assert.rejects(byName('finance_delegate').execute({ task: 'x', idemKey: 'valid-key-001', priority: '9' }, exec), /dept_finance_priority_invalid/);
    await assert.rejects(byName('finance_tasks').execute({ limit: true }, exec), /dept_finance_limit_invalid/);
    await assert.rejects(byName('finance_delegations').execute({ status: 'unknown' }, exec), /dept_finance_status_invalid/);
    await assert.rejects(byName('finance_reviews').execute({ status: 'unknown' }, exec), /dept_finance_status_invalid/);
    await assert.rejects(byName('finance_notices').execute({ status: 'unknown' }, exec), /dept_finance_status_invalid/);
    await assert.rejects(byName('finance_review_submit').execute({ title: 'x', itemType: 'bad' }, exec), /dept_finance_status_invalid/);
    await assert.rejects(byName('finance_review_decide').execute({ reviewId: 'rv-1', decision: 'unknown' }, exec), /dept_finance_status_invalid/);

    await assert.rejects(byName('finance_review_decide').execute({ reviewId: 'rv-1' }, exec), /dept_finance_decision_required/);
    await assert.rejects(byName('finance_review_decide').execute({ reviewId: 'rv-1', decision: ' ' }, exec), /dept_finance_decision_required/);
    await assert.rejects(byName('finance_review_decide').execute({ reviewId: 'rv-1', decision: 'rejected' }, exec), /dept_finance_reject_note_required/);
    await assert.rejects(byName('finance_notice_read').execute({ ids: [] }, exec), /dept_finance_notice_ids_invalid/);
    await assert.rejects(byName('finance_notice_read').execute({ ids: Array.from({ length: limits().noticeIdsMax + 1 }, (_, i) => `n${i}`) }, exec), /dept_finance_notice_ids_invalid/);
    await assert.rejects(byName('finance_delegate').execute({ task: { text: 'x' }, idemKey: 'valid-key-001' }, exec), /dept_finance_input_type/);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
