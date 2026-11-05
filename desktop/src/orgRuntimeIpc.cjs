function errorCode(value) {
  const code = String(value || '')
  return /^[a-z0-9_]{1,80}$/i.test(code) ? code : 'org_plugin_error'
}

/** 主进程 IPC 行为件：只接受当前主窗口主框的本地应用页；成功返回原 data（含 null/error 字段），失败一律抛出带码 Error。 */
function createOrgRuntimeInvoker({ host, getWindow, isAppFileUrl }) {
  return async function invokeOrgRuntime(event, payload) {
    const win = getWindow()
    const contents = win && !win.isDestroyed() ? win.webContents : null
    const mainFrame = contents && !contents.isDestroyed() ? contents.mainFrame : null
    if (!contents || event.sender !== contents || event.senderFrame !== mainFrame || !isAppFileUrl(event.senderFrame?.url)) {
      throw new Error('org_plugin_sender_denied')
    }
    try {
      const result = await host.invoke(payload)
      if (result?.ok === true) return result.data
      throw new Error(errorCode(result?.error?.code))
    } catch (error) {
      throw new Error(errorCode(error?.message))
    }
  }
}

module.exports = { createOrgRuntimeInvoker }
