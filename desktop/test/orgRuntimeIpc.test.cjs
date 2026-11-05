const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createOrgRuntimeInvoker } = require('../src/orgRuntimeIpc.cjs')

function fixture(hostResult, options = {}) {
  const mainFrame = { url: 'file:///app/frontend/org/index.html' }
  const contents = { mainFrame, isDestroyed: () => false }
  const win = { webContents: contents, isDestroyed: () => options.destroyed === true }
  const event = { sender: contents, senderFrame: options.subframe ? { url: mainFrame.url } : mainFrame }
  if (options.external) event.senderFrame = { url: 'https://example.com' }
  let calls = 0
  const host = {
    async invoke() {
      calls += 1
      if (hostResult instanceof Error) throw hostResult
      return hostResult
    },
  }
  const invoke = createOrgRuntimeInvoker({ host, getWindow: () => win, isAppFileUrl: (url) => String(url).startsWith('file:///app/') })
  return { invoke, event, calls: () => calls }
}

test('org IPC 行为：成功原样返回 data，包含 null 与合法 error 字段', async () => {
  const nullResult = fixture({ ok: true, data: null })
  assert.equal(await nullResult.invoke(nullResult.event, {}), null)
  const legitimate = { error: { message: 'legitimate-business-field' } }
  const success = fixture({ ok: true, data: legitimate })
  assert.deepEqual(await success.invoke(success.event, {}), legitimate)
})

test('org IPC 行为：失败一律 reject 带码，敏感原文不透 renderer', async () => {
  const upstream = fixture({ ok: false, error: { code: 'org_plugin_upstream_error' } })
  await assert.rejects(upstream.invoke(upstream.event, {}), /org_plugin_upstream_error/)
  const raw = fixture(new Error('sensitive upstream detail'))
  await assert.rejects(raw.invoke(raw.event, {}), /org_plugin_error/)
})

test('org IPC 行为：子框、外域与已销毁窗口全部拒绝且不触达宿主', async () => {
  for (const options of [{ subframe: true }, { external: true }, { destroyed: true }]) {
    const item = fixture({ ok: true, data: null }, options)
    await assert.rejects(item.invoke(item.event, {}), /org_plugin_sender_denied/)
    assert.equal(item.calls(), 0)
  }
})
