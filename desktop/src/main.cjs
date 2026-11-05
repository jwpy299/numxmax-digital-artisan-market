/**
 * NumX Max 桌面端主进程（Electron）—— 三端封装共用一件（桌面端应用化②·彭总定调「不要网页版」）：
 *
 * 形态：本地应用壳（BrowserWindow loadFile 壳内前端件）——
 *   前端代码打进安装包（asar 内 frontend/），打开即本地渲染，不拉网页；
 *   API 走 https 公网后端（构建期 VITE_API_BASE 固化进前端 bundle）。
 *   五壳：personal=个人工作台 / enterprise=企业工作台 / admin=超终 / org=组织运行时 / ops=门户管理台。
 *   每壳独立 persist 会话分区，管理 token 与企业 token 不共享 localStorage/IndexedDB。
 *
 * 纪律：contextIsolation 开+nodeIntegration 关（安全面）；外部链接一律系统浏览器开（壳内不导航出域）。
 */
const { app, BrowserWindow, Tray, Menu, shell, session, nativeImage, dialog, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

const { SHELL_API_BASE, SHELL_APP_URL, API_BASE_ARG, isTrustedUrl, isTrustedRequestUrl } = require("./apiAllowlist.cjs");

/** 五壳配置（personal/enterprise 同 frontend/ 件；admin 二期入壳） */
const SHELLS = {
  personal: {
    title: "NumX Max·个人工作台",
    entry: "frontend/index.html", // 本地件（wb 前端桌面变体——VITE_DESKTOP=1 构建）
    apiHint: SHELL_API_BASE.personal,
    width: 1280,
    height: 860,
  },
  enterprise: {
    title: "NumX Max·企业工作台",
    entry: "frontend/index.html",
    apiHint: SHELL_API_BASE.enterprise,
    width: 1366,
    height: 900,
  },
  admin: {
    title: "NumX Max·超级终端",
    entry: null, // 二期入壳（portal-admin 前端变体）——一期维持远程过渡
    url: SHELL_APP_URL.admin,
    apiHint: SHELL_API_BASE.admin,
    width: 1440,
    height: 920,
  },
  // 第四壳[彭总 2026-10-22 令]：组织智能体运行时桌面端——org 三屏件入壳（本地渲染不拉网页；
  //  API 走 wb 域公网后端[壳件 file:// 适配面=wb#133 姊妹票]）
  org: {
    title: "NumX Max·组织智能体运行时",
    entry: "frontend/org/index.html",
    apiHint: SHELL_API_BASE.org,
    width: 1440,
    height: 920,
  },
  // 第五壳[彭总 2026-10-24 令]：门户管理台本地应用——三视图（邀测口令运营/下载通道/组织运行时管理台）
  //  件入 asar 本地渲染；API 走 admin 域公网后端（admin token 与 wb 域分家[管理账号 vs 企业账号]）
  ops: {
    title: "NumX Max·门户管理台",
    entry: "frontend/ops/index.html",
    apiHint: SHELL_API_BASE.ops,
    webSecurity: true,
    width: 1440,
    height: 920,
  },
};

// 壳键构建期固化（shellKey.cjs 由打包脚本生成——运行期 env 在用户机不存在=三壳同物自引修）
let shellKey;
try { shellKey = require("./generated/shellKey.cjs"); } catch { shellKey = null; }
// NumX critical 复锚修②：shellKey=构建期生成件（build-desktop-app.sh 写入）——
// 缺失/非法时宁可炸也不静默落 admin 远程壳（历史：提交值="admin"=不走脚本全起超终接管面）
if (!shellKey || !Object.keys(SHELLS).includes(shellKey)) {
  throw new Error(`shellKey 非法或缺失: ${shellKey}——构建期必须由 scripts/build-desktop-app.sh 生成（personal/enterprise/admin/org/ops 五键）`);
}
const cfg = SHELLS[shellKey];
// 只有 org 壳加载插件 manifest/宿主；其他四壳即使插件件损坏也不受连坐，也没有多余 IPC 面。
const orgRuntimeHost = shellKey === "org" ? require("./orgPluginHost.cjs").create() : null;
if (orgRuntimeHost) {
  const { createOrgRuntimeInvoker } = require("./orgRuntimeIpc.cjs");
  ipcMain.handle("org-runtime:invoke", createOrgRuntimeInvoker({
    host: orgRuntimeHost,
    getWindow: () => currentWindow,
    isAppFileUrl,
  }));
}
// apiHint 与 SHELL_API_BASE 同表声明；asar 打包再按壳读回，避免运行时环境变量改壳域。
// persist 分区升级说明：旧 defaultSession 的 token/站点数据不自动迁移，用户需重新登录；不复制管理 token 到新壳。
const SESSION_PARTITION = `persist:${shellKey}`;

// file:// 仅允许应用目录，pathToFileURL 统一 Windows/POSIX 路径与边界。
function isAppFileUrl(value) {
  try {
    const root = pathToFileURL(`${app.getAppPath()}${path.sep}`).href;
    const url = new URL(String(value));
    return url.protocol === "file:" && url.href.startsWith(root);
  } catch {
    return false;
  }
}

/** 窗口状态记忆（userData/win-state.json——位置尺寸跨启动保留） */
const stateFile = () => path.join(app.getPath("userData"), `win-state-${shellKey}.json`);
function loadWinState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), "utf8")); } catch { return {}; }
}
function saveWinState(win) {
  try { fs.writeFileSync(stateFile(), JSON.stringify(win.getBounds())); } catch { /* 静默 */ }
}

/** 单实例锁（重复双击=唤起既有窗口，不起第二实例） */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
}

let tray = null;
let currentWindow = null;

function installNavigationGuards(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (isAppFileUrl(url) || isTrustedUrl(url, shellKey)) return { action: "allow" };
    if (["https:", "http:", "mailto:", "tel:", "numx:"].some((scheme) => url.startsWith(scheme))) void shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (ev, url) => {
    const ok = isAppFileUrl(url) || isTrustedUrl(url, shellKey);
    if (!ok) ev.preventDefault();
  });
}
app.on("web-contents-created", (_event, contents) => installNavigationGuards(contents));

function createWindow() {
  const prev = loadWinState();
  const win = new BrowserWindow({
    title: cfg.title,
    width: prev.width ?? cfg.width,
    height: prev.height ?? cfg.height,
    x: prev.x,
    y: prev.y,
    minWidth: 960,
    minHeight: 640,
    autoHideMenuBar: true,
    backgroundColor: "#0b0e14",
    icon: path.join(__dirname, "../assets/icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "generated", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      partition: SESSION_PARTITION,
      ...(cfg.apiHint ? { additionalArguments: [`${API_BASE_ARG}${cfg.apiHint}`] } : {}),
      // ops 管理 token 面恢复 webSecurity；其余历史本地壳暂保留原 CORS 行为，但统一受下方请求域闸约束。
      webSecurity: !cfg.entry || Boolean(cfg.webSecurity),
    },
  });

  installNavigationGuards(win.webContents);

  currentWindow = win;
  win.webContents.on("did-finish-load", async () => {
    const apiError = await win.webContents.executeJavaScript("window.numxShell?.apiError || ''");
    if (apiError) {
      dialog.showErrorBox("NumX Max 配置错误", String(apiError));
      win.destroy();
    }
  });
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
    if (isMainFrame) dialog.showErrorBox("NumX Max 页面加载失败", `${errorCode}: ${errorDescription}`);
  });
  win.on("close", () => saveWinState(win));

  // 加载面：本地件优先（三壳一期 personal/enterprise）；admin 壳远程过渡
  if (cfg.entry) {
    void win.loadFile(path.join(__dirname, "..", cfg.entry));
  } else {
    void win.loadURL(cfg.url);
  }

  // 托盘（关窗最小化不退出——桌面应用常驻面；退出走托盘菜单）
  if (!tray) {
    const icon = nativeImage.createFromPath(path.join(__dirname, "../assets/icon.png"));
    tray = new Tray(icon.resize({ width: 16, height: 16 }));
    tray.setToolTip(cfg.title);
    const menu = Menu.buildFromTemplate([
      { label: "显示窗口", click: () => { const w = BrowserWindow.getAllWindows()[0]; if (w) { w.show(); w.focus(); } } },
      { type: "separator" },
      { label: "开机自启", type: "checkbox", checked: app.getLoginItemSettings().openAtLogin,
        click: (mi) => { try { app.setLoginItemSettings({ openAtLogin: mi.checked }); } catch { /* 静默 */ } } }, // NumX medium：注释称「托盘可关」实现无=用户关不掉面修
      { type: "separator" },
      { label: "退出", click: () => { void orgRuntimeHost?.close(); app.exit(0); } },
    ]);
    tray.setContextMenu(menu);
    tray.on("click", () => { const w = BrowserWindow.getAllWindows()[0]; if (w) { w.show(); w.focus(); } });
  }
  win.on("closed", () => { /* 窗关=驻托盘（macOS 除外全退面见 window-all-closed 改面） */ });
}

app.whenReady().then(() => {
  // numx:// 协议唤起（9abb1ca 宣称未落面——本次真落：外部链 numx://open 唤起壳窗口）
  try { app.setAsDefaultProtocolClient("numx"); } catch { /* 静默 */ }
  // 开机自启（同宣称面补落——托盘菜单可关）
  try { app.setLoginItemSettings({ openAtLogin: true }); } catch { /* 静默 */ }
  // 权限请求+权限检查+网络请求三面同闸：仅应用目录/可信域，且只放 media。
  // defaultSession 仅作未来无 partition 窗口的兜底；当前窗口均走 SESSION_PARTITION。
  const ALLOWED_PERMS = new Set(["media"]);
  const permissionAllowed = (wc, perm, requestingOrigin) => {
    const url = wc ? wc.getURL() : String(requestingOrigin ?? "");
    return Boolean(url) && (isAppFileUrl(url) || isTrustedUrl(url, shellKey)) && ALLOWED_PERMS.has(perm);
  };
  const permissionRequestHandler = (wc, perm, cb) => cb(permissionAllowed(wc, perm));
  const blockedRequestUrls = new Set();
  const requestKey = (value) => {
    try {
      const parsed = new URL(value);
      return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    } catch { return "invalid-url"; }
  };
  const requestGuard = (details, cb) => {
    // 远程 admin 页面的第三方资产不在本仓控制面内，webSecurity 保持开启，不用本地域闸误杀；
    // 本地壳则只放应用目录、可信 API 域与 data/blob，拦截记录不带 query/token。
    if (cfg.entry) {
      const url = details.url;
      const allowed = isAppFileUrl(url) || isTrustedRequestUrl(url, shellKey) || url.startsWith("data:") || url.startsWith("blob:");
      const key = requestKey(url);
      if (!allowed && blockedRequestUrls.size < 50 && !blockedRequestUrls.has(key)) {
        blockedRequestUrls.add(key);
        console.warn(`[desktop] 阻断非白名单请求: ${key}`.slice(0, 220));
        currentWindow?.webContents.send("desktop:request-blocked", { url: key });
      }
      cb({ cancel: !allowed });
      return;
    }
    cb({ cancel: false });
  };
  for (const ses of [session.defaultSession, session.fromPartition(SESSION_PARTITION)]) {
    ses.setPermissionRequestHandler(permissionRequestHandler);
    ses.setPermissionCheckHandler((wc, perm, requestingOrigin) => permissionAllowed(wc, perm, requestingOrigin));
    ses.webRequest.onBeforeRequest(requestGuard);
  }
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
// 关窗≠退出（托盘常驻）；全关也留（桌面应用面）——真退出走托盘菜单
app.on("before-quit", () => { orgRuntimeHost?.close(); });
app.on("window-all-closed", () => { /* 驻托盘不 quit */ });
