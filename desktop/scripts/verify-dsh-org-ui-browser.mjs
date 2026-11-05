import http from 'node:http';
// Isolated verification only; never used as the production launcher.
function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`probe_not_configured:${name}`);
  return value;
}
const playwrightModule = requiredEnv('PLAYWRIGHT_CORE_MODULE');
const hostModule = requiredEnv('DSH_DESKTOP_HOST_MODULE');
const { chromium } = await import(playwrightModule);
const { runDesktopHost } = await import(hostModule);
const profile = requiredEnv('NUMX_DSH_PROFILE');
const allowLinkedPackages = process.env.DSH_ALLOW_LINKED_PACKAGES === '1';
const screenshot = process.env.NUMX_UI_SCREENSHOT || '/tmp/numx-org-ui-browser.png';
const workspaceRoleScreenshot = process.env.NUMX_WORKSPACE_SCREENSHOT || '/tmp/numx-workspace-roles.png';
const pending = new Map();
let nextStream = 1;
const controller = await runDesktopHost(profile, async (frame) => {
  const type = frame.readUInt8(4);
  const streamId = frame.readUInt32BE(5);
  const length = frame.readUInt32BE(9);
  const payload = frame.subarray(13, 13 + length);
  const item = pending.get(streamId);
  if (!item) return;
  if (type === 1) item.start = JSON.parse(payload.toString('utf8'));
  else if (type === 2) item.chunks.push(payload);
  else if (type === 3) {
    try {
      const start = item.start || { status: 500, headers: [] };
      const response = new Response(item.chunks.length ? Buffer.concat(item.chunks) : null, { status: start.status, headers: start.headers });
      pending.delete(streamId);
      item.resolve(response);
    } catch (error) {
      pending.delete(streamId);
      item.reject(error);
    }
  } else if (type === 4) {
    pending.delete(streamId);
    item.reject(new Error('dsh_host_frame_error'));
  }
}, { allowLinkedPackages });

async function hostFetch(url, method, headers, body) {
  const streamId = nextStream++;
  let entry;
  const result = new Promise((resolve, reject) => {
    entry = { resolve, reject, chunks: [] };
    pending.set(streamId, entry);
  });
  const timer = setTimeout(() => {
    if (pending.delete(streamId)) {
      controller.cancel(streamId);
      entry.reject(new Error(`dsh_host_stream_timeout:${streamId}`));
    }
  }, 90000);
  const guarded = result.finally(() => clearTimeout(timer));
  guarded.catch(() => {});
  try {
    await controller.fetch({ streamId, request: { url, method, headers } }, body);
  } catch (error) {
    if (pending.delete(streamId)) entry.reject(error);
  }
  return guarded;
}

const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) throw new Error('probe_body_too_large');
      chunks.push(chunk);
    }
    const bodyBytes = Buffer.concat(chunks);
    const url = new URL(req.url || '/', `http://127.0.0.1:${req.socket.localPort}`);
    const headers = Object.entries(req.headers).filter(([, value]) => typeof value === 'string').map(([key, value]) => [key, value]);
    const response = await hostFetch(url.toString(), req.method || 'GET', headers, bodyBytes.length ? new Response(bodyBytes).body : null);
    const outHeaders = Object.fromEntries(response.headers.entries());
    const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    if (cookies.length) outHeaders['set-cookie'] = cookies;
    res.writeHead(response.status, outHeaders);
    if (response.body) res.end(Buffer.from(await response.arrayBuffer())); else res.end();
  } catch {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('dsh_host_probe_error');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
let browser;
const pageErrors = [];
const consoleErrors = [];
const staticFailures = [];
try {
  browser = await chromium.launch({ executablePath: requiredEnv('CHROMIUM_EXECUTABLE'), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('response', (response) => {
    if (response.url().includes('/api/numx-org/') && response.status() >= 400) staticFailures.push(`${response.status()}:${response.url()}`);
  });
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1' && url.port === String(port)) return route.continue();
    return route.abort();
  });
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const runtime = page.locator('#numx-org-runtime');
  await runtime.waitFor({ state: 'visible', timeout: 30000 });
  await runtime.scrollIntoViewIfNeeded();
  const indexFrame = page.frameLocator('iframe[data-org-frame="index"]');
  await indexFrame.locator('#ag-id').waitFor({ state: 'visible', timeout: 30000 });

  await indexFrame.locator('#ag-id').fill('__probe_invalid__');
  await indexFrame.locator('#ag-pw').fill('__probe_invalid__');
  const loginResponsePromise = page.waitForResponse((response) => response.url().includes('/api/trpc/agentic.authLogin') && response.request().method() === 'POST');
  await indexFrame.locator('#ag-login-btn').click();
  const loginResponse = await loginResponsePromise;
  const loginPayload = await loginResponse.json();
  const loginCode = loginPayload?.error?.json?.code || loginPayload?.error?.code || '';
  if (['org_plugin_origin_denied', 'org_plugin_payload_invalid', 'org_plugin_session_required', 'org_plugin_read_denied'].includes(loginCode)) throw new Error(`BROWSER_LOGIN_PROXY_ERROR:${loginResponse.status()}:${loginCode}`);
  await indexFrame.locator('#ag-err').waitFor({ state: 'visible', timeout: 25000 });
  const loginError = await indexFrame.locator('#ag-err').textContent();
  if (!loginError || !loginError.trim()) throw new Error('BROWSER_LOGIN_ERROR_MISSING');

  await indexFrame.locator('#ag-to-reg').click();
  await indexFrame.locator('#ag-r-ent').fill('__probe_invalid_enterprise__');
  await indexFrame.locator('#ag-r-ind').selectOption('其他');
  await indexFrame.locator('#ag-r-head').fill('1');
  await indexFrame.locator('#ag-r-user').fill('__probe_invalid__');
  await indexFrame.locator('#ag-r-pw').fill('__probe_invalid__');
  await indexFrame.locator('#ag-r-code').fill('iv_invalid');
  const registerResponsePromise = page.waitForResponse((response) => response.url().includes('/api/trpc/agentic.authRegister') && response.request().method() === 'POST');
  await indexFrame.locator('#ag-reg-btn').click();
  const registerResponse = await registerResponsePromise;
  const registerPayload = await registerResponse.json();
  const registerCode = registerPayload?.error?.json?.code || registerPayload?.error?.code || '';
  if (['org_plugin_session_required', 'org_plugin_origin_denied', 'org_plugin_payload_invalid', 'org_plugin_read_denied'].includes(registerCode)) {
    throw new Error(`BROWSER_PUBLIC_REGISTER_ROUTE_INVALID:${registerResponse.status()}:${registerCode}`);
  }
  await indexFrame.locator('#ag-r-err').waitFor({ state: 'visible', timeout: 25000 });
  const registerError = await indexFrame.locator('#ag-r-err').textContent();
  if (!registerError || !registerError.trim() || /not found/i.test(registerError)) {
    throw new Error(`BROWSER_PUBLIC_REGISTER_ROUTE_INVALID:${registerError || 'empty'}`);
  }
  await indexFrame.locator('#ag-to-login').click();
  await indexFrame.locator('#ag-id').waitFor({ state: 'visible' });

  const marker = 'browser_state_keep_probe';
  await indexFrame.locator('#ag-id').fill(marker);
  const urlsBefore = await page.locator('#numx-org-runtime iframe').evaluateAll((frames) => frames.map((frame) => frame.src));
  await page.locator('[data-org-view="cabin"]').click();
  await page.waitForFunction(() => !document.querySelector('iframe[data-org-frame="cabin"]').hidden && document.querySelector('iframe[data-org-frame="index"]').hidden);
  await page.frameLocator('iframe[data-org-frame="cabin"]').locator('body').waitFor({ state: 'visible' });
  const cabinBrowserFrame = page.frames().find((frame) => frame.url().includes('/api/numx-org/org/cabin.html'));
  if (!cabinBrowserFrame) throw new Error('BROWSER_CABIN_FRAME_NOT_FOUND');
  const cabinBinaryProbe = await cabinBrowserFrame.evaluate(() => ({
    type: typeof BINARY_API_BASE,
    value: typeof BINARY_API_BASE === 'string' ? BINARY_API_BASE : null,
  }));
  if (cabinBinaryProbe.type !== 'string' || cabinBinaryProbe.value !== '/api/numx-org') {
    throw new Error(`BROWSER_CABIN_BINARY_BASE_MISMATCH:${JSON.stringify(cabinBinaryProbe)}`);
  }
  await page.locator('[data-org-view="station"]').click();
  await page.waitForFunction(() => !document.querySelector('iframe[data-org-frame="station"]').hidden && document.querySelector('iframe[data-org-frame="cabin"]').hidden);
  await page.frameLocator('iframe[data-org-frame="station"]').locator('body').waitFor({ state: 'visible' });
  await page.locator('[data-org-view="index"]').click();
  const retained = await indexFrame.locator('#ag-id').inputValue();
  if (retained !== marker) throw new Error(`BROWSER_FRAME_STATE_LOST:${retained}`);
  const urlsAfter = await page.locator('#numx-org-runtime iframe').evaluateAll((frames) => frames.map((frame) => frame.src));
  if (JSON.stringify(urlsBefore) !== JSON.stringify(urlsAfter)) throw new Error('BROWSER_FRAME_RELOAD_DETECTED');

  const ackSourceIndexUrl = await page.locator('iframe[data-org-frame="index"]').getAttribute('src');
  const indexBrowserFrame = page.frames().find((frame) => frame.url().includes('/api/numx-org/org/index.html'));
  if (!indexBrowserFrame) throw new Error('BROWSER_INDEX_FRAME_NOT_FOUND');
  await indexBrowserFrame.evaluate(() => window.parent.postMessage({ type: 'numx-org:navigate', view: 'station', query: 'dept=sc' }, window.location.origin));
  await page.waitForFunction(() => !document.querySelector('iframe[data-org-frame="station"]').hidden);
  await page.waitForTimeout(600);
  const indexAfterAck = await page.locator('iframe[data-org-frame="index"]').getAttribute('src');
  const stationAfterAck = await page.locator('iframe[data-org-frame="station"]').getAttribute('src');
  if (indexAfterAck !== ackSourceIndexUrl) throw new Error('BROWSER_ACK_FALLBACK_DUPLICATED');
  if (!stationAfterAck.includes('dept=sc')) throw new Error('BROWSER_ACK_TARGET_NOT_APPLIED');
  await page.locator('[data-org-view="index"]').click();
  if ((await indexFrame.locator('#ag-id').inputValue()) !== marker) throw new Error('BROWSER_ACK_STATE_LOST');

  const publicErrorProbe = await indexBrowserFrame.evaluate(() => ({
    type: typeof orgPublicErrorText,
    source: typeof orgPublicErrorText === 'function' ? orgPublicErrorText(new Error("Error invoking remote method 'org-runtime:invoke': Error: org_plugin_upstream_http_412")) : null,
    network: typeof orgPublicErrorText === 'function' ? orgPublicErrorText(new Error('Failed to fetch')) : null,
    business: typeof orgPublicErrorText === 'function' ? orgPublicErrorText(new Error('口令不对——浏览器探针')) : null,
  }));
  if (publicErrorProbe.type !== 'function') throw new Error('BROWSER_PUBLIC_ERROR_HELPER_MISSING');
  if (publicErrorProbe.source !== '请求来源校验未通过，请稍后重试或联系运维') throw new Error(`BROWSER_PUBLIC_ERROR_MAPPING_FAILED:${publicErrorProbe.source}`);
  if (publicErrorProbe.network !== '组织服务暂时无法连接，请检查网络后重试') throw new Error(`BROWSER_NETWORK_ERROR_MAPPING_FAILED:${publicErrorProbe.network}`);
  if (publicErrorProbe.business !== '口令不对——浏览器探针') throw new Error(`BROWSER_BUSINESS_ERROR_NOT_PRESERVED:${publicErrorProbe.business}`);

  const workspacePreviousState = await indexBrowserFrame.evaluate(() => ({
    previous: WORKSPACE_DIRECTORY,
    previousAuthDisplay: document.getElementById('authgate').style.display,
  }));
  let workspaceRenderProbe;
  let stationWorkspaceProbe;
  let stationReadback;
  try {
    workspaceRenderProbe = await indexBrowserFrame.evaluate(() => {
    const cabins = [
      { cabinCode: 'finance', cabinName: '财务舱', role: 'manager', current: false, activation: 'eligible', entitlement: { packageKey: 'fin_basic' }, pack: { id: 'dept-finance', version: '0.1.0', channel: 'development' }, capabilities: ['plugin.install'] },
      { cabinCode: 'produce', cabinName: '生产舱', role: 'staff', current: true, activation: 'not_required', employeeInstallRequired: false, capabilities: ['task.execute'] },
    ];
    WORKSPACE_DIRECTORY = null;
    const failure = renderWorkspaceStrip();
    WORKSPACE_DIRECTORY = { packChannels: ['development'], cabins };
    const html = renderWorkspaceStrip();
    document.getElementById('authgate').style.display = 'none';
    renderDash();
    return { failure, html, cards: document.querySelectorAll('.ws-card').length, text: document.querySelector('.ws-grid')?.textContent || '' };
  });
  if (!workspaceRenderProbe.failure.includes('工作区目录未读回')) throw new Error('BROWSER_WORKSPACE_HONEST_FAILURE_MISSING');
  if (!workspaceRenderProbe.html.includes('本舱可激活') || !workspaceRenderProbe.html.includes('员工免安装部门包')) throw new Error('BROWSER_WORKSPACE_ROLE_RENDER_FAILED');
  if (workspaceRenderProbe.cards !== 2 || !workspaceRenderProbe.text.includes('财务舱') || !workspaceRenderProbe.text.includes('生产舱')) throw new Error('BROWSER_WORKSPACE_DOM_RENDER_FAILED');
  await indexBrowserFrame.locator('.ws-grid').scrollIntoViewIfNeeded();
  await page.screenshot({ path: workspaceRoleScreenshot, fullPage: false });
  const stationBrowserFrame = page.frames().find((frame) => frame.url().includes('/api/numx-org/org/station.html'));
  if (!stationBrowserFrame) throw new Error('BROWSER_STATION_FRAME_NOT_FOUND');
  await stationBrowserFrame.waitForSelector('#workspace-strip', { state: 'attached', timeout: 30000 });
  await stationBrowserFrame.waitForFunction(() => {
    const el = document.getElementById('workspace-strip');
    return !!el?.textContent?.trim() && !el.textContent.includes('工作区目录加载中')
      && (typeof LIVE === 'undefined' || LIVE.mode !== 'loading')
      && (typeof DEPT_STATUS === 'undefined' || DEPT_STATUS !== 'loading');
  }, undefined, { timeout: 30000 });
  stationWorkspaceProbe = await stationBrowserFrame.evaluate(() => {
    const previous = WORKSPACE_DIRECTORY;
    const mount = document.getElementById('workspace-strip');
    if (!mount) return { html: '', text: '', mounted: false };
    const previousHtml = mount.innerHTML;
    const bootText = mount.textContent || '';
    if (!bootText.trim() || bootText.includes('工作区目录加载中')) return { html: '', text: '', mounted: false, bootRendered: false, bootText };
    WORKSPACE_DIRECTORY = { cabins: [{ cabinCode: 'produce', cabinName: '生产舱', role: 'staff', current: true, activation: 'not_required', employeeInstallRequired: false, capabilities: ['task.execute'] }] };
    const html = renderWorkspaceStrip();
    mount.innerHTML = html;
    const text = mount.textContent || '';
    WORKSPACE_DIRECTORY = previous;
    mount.innerHTML = previousHtml;
    return { html, text, mounted: true, bootRendered: true, bootText, liveMode: LIVE.mode, deptStatus: DEPT_STATUS };
  });
  if (!stationWorkspaceProbe.bootRendered) throw new Error(`BROWSER_STATION_BOOT_WORKSPACE_MISSING:${JSON.stringify(stationWorkspaceProbe)}`);
  if (stationWorkspaceProbe.liveMode === 'loading' || stationWorkspaceProbe.deptStatus === 'loading') throw new Error(`BROWSER_STATION_BOOT_NOT_SETTLED:${JSON.stringify(stationWorkspaceProbe)}`);
  // 真实读回与诚实降级都可接受；bootRendered 已保证不是空白或永久加载，记录实际状态而不强迫接口失败。
  stationReadback = stationWorkspaceProbe.bootText.includes('工作区目录未读回') ? 'degraded' : 'loaded';
  if (!stationWorkspaceProbe.mounted || !stationWorkspaceProbe.html.includes('员工免安装部门包') || !stationWorkspaceProbe.text.includes('员工免安装部门包')) throw new Error('BROWSER_STATION_WORKSPACE_ROLE_MISSING');
  } finally {
    try {
      await indexBrowserFrame.evaluate((probe) => {
        WORKSPACE_DIRECTORY = probe.previous;
        document.getElementById('authgate').style.display = probe.previousAuthDisplay;
        renderDash();
      }, workspacePreviousState);
    } catch { /* 恢复失败不覆盖主断言 */ }
  }

  await page.locator('[data-org-fullscreen]').click();
  await page.waitForFunction(() => document.querySelector('[data-org-fullscreen]').textContent.includes('退出横屏'));
  await page.locator('[data-org-fullscreen]').click();
  await page.waitForFunction(() => document.querySelector('[data-org-fullscreen]').textContent.includes('横屏展开'));
  await runtime.scrollIntoViewIfNeeded();
  await page.screenshot({ path: screenshot, fullPage: false });
  if (pageErrors.length) throw new Error(`BROWSER_PAGE_ERRORS:${pageErrors.join('|')}`);
  if (staticFailures.length) throw new Error(`BROWSER_ASSET_FAILURES:${staticFailures.join('|')}`);
  const unexpectedConsoleErrors = consoleErrors.filter((message) => !message.startsWith('Failed to load resource:'));
  if (unexpectedConsoleErrors.length) throw new Error(`BROWSER_CONSOLE_ERRORS:${unexpectedConsoleErrors.join('|')}`);
  console.log(JSON.stringify({ ok: true, realDesktopHost: true, chromium: true, screens: 3, statePreserved: true, fullscreenRoundTrip: true, invalidLoginErrorShown: true, invalidRegistrationErrorShown: true, publicErrorMapping: true, workspaceRoleRendering: true, workspaceRoleSource: 'stub', stationBootReadback: stationReadback, stationBootText: stationWorkspaceProbe.bootText, workspaceRoleScreenshot, pageErrors, staticFailures, expectedResourceConsoleErrors: consoleErrors.length, screenshot }));
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await controller.dispose();
}
