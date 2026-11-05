// Isolated verification only; never used as the production launcher.
function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`probe_not_configured:${name}`);
  return value;
}
const hostModule = requiredEnv('DSH_DESKTOP_HOST_MODULE');
const { runDesktopHost } = await import(hostModule);
const profile = requiredEnv('NUMX_DSH_PROFILE');
const allowLinkedPackages = process.env.DSH_ALLOW_LINKED_PACKAGES === '1';
const pending = new Map();
const controller = await runDesktopHost(profile, async (frame) => {
  if (frame.length < 13) {
    for (const item of pending.values()) item.reject(new Error('DSH_HOST_TRUNCATED_FRAME_HEADER'));
    pending.clear();
    return;
  }
  const type = frame.readUInt8(4);
  const streamId = frame.readUInt32BE(5);
  const declaredLength = frame.readUInt32BE(9);
  if (frame.length !== 13 + declaredLength) {
    const item = pending.get(streamId);
    if (item) { pending.delete(streamId); item.reject(new Error('DSH_HOST_TRUNCATED_FRAME_BODY')); }
    return;
  }
  const payload = frame.subarray(13, 13 + declaredLength);
  const item = pending.get(streamId);
  if (!item) return;
  if (type === 3) {
    pending.delete(streamId);
    item.resolve(item.frames);
  } else if (type === 4) {
    pending.delete(streamId);
    item.reject(new Error(`DSH_HOST_REQUEST_FAILED:${payload.toString('utf8')}`));
  } else {
    item.frames.push({ type, streamId, payload });
  }
}, { allowLinkedPackages });
async function request(streamId, url, method = 'GET', json) {
  const body = json === undefined ? null : new Response(JSON.stringify(json)).body;
  let entry;
  const result = new Promise((resolve, reject) => {
    entry = { frames: [], resolve, reject };
    pending.set(streamId, entry);
  });
  const timer = setTimeout(() => {
    if (pending.delete(streamId)) {
      controller.cancel(streamId);
      entry.reject(new Error('DSH_HOST_INCOMPLETE_RESPONSE'));
    }
  }, 90000);
  const guarded = result.finally(() => clearTimeout(timer));
  guarded.catch(() => {});
  try {
    await controller.fetch({ streamId, request: { url, method, headers: json === undefined ? [] : [['content-type', 'application/json']] } }, body);
  } catch (error) {
    if (pending.delete(streamId)) entry.reject(error);
  }
  return guarded;
}
function bodyText(frames) {
  return Buffer.concat(frames.filter((frame) => frame.type === 2).map((frame) => frame.payload)).toString('utf8');
}
function status(frames) {
  const start = frames.find((frame) => frame.type === 1);
  return start ? JSON.parse(start.payload.toString('utf8')).status : 0;
}
try {
  const home = await request(1, 'http://localhost/');
  const homeText = bodyText(home);
  if (!homeText.includes('numx-org-runtime') || !homeText.includes('/api/numx-org/org/index.html') || !homeText.includes('/api/numx-org/ui.js')) {
    throw new Error('DSH_UI_HOME_INJECTION_MISSING');
  }
  if ((homeText.match(/data-org-frame=/g) || []).length !== 3) throw new Error('DSH_UI_THREE_FRAME_STATE_MISSING');
  for (const [streamId, screen] of [[2, 'index.html'], [3, 'cabin.html'], [4, 'station.html']]) {
    const response = await request(streamId, `http://localhost/api/numx-org/org/${screen}`);
    if (status(response) !== 200 || !bodyText(response).includes('<html')) throw new Error(`DSH_UI_SCREEN_MISSING:${screen}`);
  }
  const script = await request(5, 'http://localhost/api/numx-org/ui.js');
  if (!bodyText(script).includes('setView') || !bodyText(script).includes('item.hidden')) throw new Error('DSH_UI_STATE_SCRIPT_MISSING');
  const unknown = await request(6, 'http://localhost/api/trpc/not.allowed', 'POST', { json: {} });
  if (status(unknown) !== 404) throw new Error(`DSH_UI_UNKNOWN_PROCEDURE_NOT_CLOSED:${status(unknown)}`);
  const privateRead = await request(7, 'http://localhost/api/trpc/entCabin.map', 'POST', { json: {} });
  if (status(privateRead) !== 401 || !bodyText(privateRead).includes('org_plugin_session_required')) throw new Error('DSH_UI_PRIVATE_SESSION_NOT_CLOSED');
  const qrPublic = await request(8, 'http://localhost/api/numx-org/invite-qr?code=iv_probe');
  const qrStatus = status(qrPublic);
  if (qrStatus < 400 || !bodyText(qrPublic).includes(`org_plugin_upstream_http_${qrStatus}`)) throw new Error(`DSH_UI_QR_PUBLIC_PROXY_FAILED:${qrStatus}:${bodyText(qrPublic).slice(0, 160)}`);
  const login = await request(9, 'http://localhost/api/trpc/agentic.authLogin', 'POST', { json: { identifier: '__probe_invalid__', password: '__probe_invalid__' } });
  const loginText = bodyText(login);
  if (status(login) !== 401 || !loginText.includes('error')) throw new Error(`DSH_UI_LOGIN_UNEXPECTED:${status(login)}`);
  console.log(JSON.stringify({ ok: true, home: 'injection_ok', screens: 3, independentFrames: true, unknownProcedure: 404, privateRead: 401, qrPublic: `upstream_${qrStatus}_no_token`, login: 'real_upstream_error_not_faked', loginStatus: status(login) }));
} finally {
  await controller.dispose();
}
