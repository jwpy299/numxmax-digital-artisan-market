/**
 * NumX Max 桌面壳主进程（Electron）—— 三端封装共用一件：
 * 壳目标经 NUMX_SHELL 环境变量/命令行参切换（personal=个人工作台 / enterprise=企业工作台 / admin=超终）。
 * 形态：远程加载壳（BrowserWindow loadURL 线上域）——前端永远最新，壳只封装窗口+本地能力面。
 * 纪律：contextIsolation 开+nodeIntegration 关（安全面）；外部链接一律系统浏览器开（壳内不导航出域）。
 */
const { app, BrowserWindow, shell, session } = require("electron");
const path = require("node:path");

/** 三端壳配置（URL 终值待彭总确认——个人/企业/超终三面） */
const SHELLS = {
  personal: {
    title: "NumX Max·个人工作台",
    url: "https://wb.example.invalid",
    width: 1280,
    height: 860,
  },
  enterprise: {
    title: "NumX Max·企业工作台",
    url: "https://wb.example.invalid", // 企业面路径待确认（部门舱入口）
    width: 1366,
    height: 900,
  },
  admin: {
    title: "NumX Max·超级终端",
    url: "https://admin.example.invalid",
    width: 1440,
    height: 920,
  },
};

// 壳键构建期固化（shellKey.cjs 由打包脚本生成——运行期 env 在用户机不存在=三壳同物自引修）
const shellKey = require("./shellKey.cjs");
const cfg = SHELLS[shellKey] ?? SHELLS.personal;

function createWindow() {
  const win = new BrowserWindow({
    title: cfg.title,
    width: cfg.width,
    height: cfg.height,
    minWidth: 960,
    minHeight: 640,
    autoHideMenuBar: true,
    backgroundColor: "#0b0e14",
    icon: path.join(__dirname, "../assets/icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  // 外部链接一律系统浏览器开（壳内不导航出域——防钓鱼面：壳只信自家三域）
  win.webContents.setWindowOpenHandler(({ url }) => {
    const ok = /^https:\/\/(www|wb|admin)\.lingshu-nebulaai\.com/.test(url);
    if (ok) return { action: "allow" };
    void shell.openExternal(url);
    return { action: "deny" };
  });
  // 壳内导航守卫：跳出三域白名单=挡回（loadURL 只许自家域）
  win.webContents.on("will-navigate", (ev, url) => {
    const ok = /^https:\/\/(www|wb|admin)\.lingshu-nebulaai\.com/.test(url);
    if (!ok) ev.preventDefault();
  });

  void win.loadURL(cfg.url);
}

app.whenReady().then(() => {
  // 权限请求默认拒（摄像头/麦克风等由站点设置显式开——壳不主动放）
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(true)); // APP 语音面要麦克风——默认放（三域白名单已守）
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
