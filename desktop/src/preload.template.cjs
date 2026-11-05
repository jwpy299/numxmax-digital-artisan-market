/** preload（sandbox 安全桥）：不 require 本地文件；构建期按壳渲染 shell、单域白名单与参数名。 */
const { contextBridge, ipcRenderer } = require("electron");
const API_BASE_ALLOWLIST = new Set(__API_BASE_ALLOWLIST__);
const API_BASE_ARG = __API_BASE_ARG__;
const SHELL_KEY = __NUMX_SHELL__;

function apiState() {
  const matches = process.argv.filter((x) => x.startsWith(API_BASE_ARG));
  if (matches.length !== 1) {
    const error = `API 基址参数须恰好 1 个，实际 ${matches.length} 个——请用 NumX Max 官方安装壳`;
    console.warn(`[preload] ${error}`);
    return { base: "", error };
  }
  const value = matches[0].slice(API_BASE_ARG.length);
  if (!API_BASE_ALLOWLIST.has(value)) {
    const error = "API 基址不在本壳白名单——请用 NumX Max 官方安装壳";
    console.warn(`[preload] ${error}`);
    return { base: "", error };
  }
  return { base: value, error: "" };
}

const api = apiState();
contextBridge.exposeInMainWorld("numxShell", {
  isDesktop: true,
  shell: SHELL_KEY,
  platform: process.platform,
  apiBase: api.base,
  apiError: api.error,
  onRequestBlocked: (callback) => {
    if (typeof callback !== "function") throw new TypeError("onRequestBlocked 需要函数");
    ipcRenderer.on("desktop:request-blocked", (_event, data) => callback(data));
  },
  ...(SHELL_KEY === "org" ? {
    orgRuntime: {
      invoke: (procedure, input = {}) => ipcRenderer.invoke("org-runtime:invoke", { procedure, input }),
    },
  } : {}),
});
