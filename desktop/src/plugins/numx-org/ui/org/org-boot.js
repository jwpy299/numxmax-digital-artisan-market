const AUTH_QUERY_TOKEN = new URLSearchParams(location.search).get('token') || '';
function persistQueryToken(identity) {
  if (!AUTH_QUERY_TOKEN || !identity || TOKEN !== AUTH_QUERY_TOKEN) return; // 新会话已替换 URL token 时，旧值不得覆盖
  const nextSession = {
    token: AUTH_QUERY_TOKEN,
    username: identity.username ?? null,
    displayName: identity.displayName ?? null,
    role: identity.role ?? identity.orgRole ?? null,
    orgRole: identity.orgRole ?? identity.role ?? null,
    factoryId: identity.factoryId ?? null,
    enterpriseName: identity.enterpriseName ?? null,
    deptId: identity.deptId ?? null,
    departmentId: identity.deptId ?? null,
    isDeptHead: identity.isDeptHead === true,
    scope: identity.scope ?? null,
  };
  try { localStorage.setItem('nebula_auth', JSON.stringify(nextSession)); } catch { /* 存储不可用时当前页仍可用 */ }
}
let TOKEN = (() => {
  if (AUTH_QUERY_TOKEN) return AUTH_QUERY_TOKEN;
  try { const a = JSON.parse(localStorage.getItem('nebula_auth') || '{}'); return a.token || ''; } catch { return ''; }
})();
if (AUTH_QUERY_TOKEN) {
  const cleanUrl = new URL(location.href);
  cleanUrl.searchParams.delete('token');
  try { history.replaceState(null, '', `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`); } catch { /* URL 清理失败不阻断 API 层 */ }
}
const API_BASE = location.protocol === 'file:' ? String(window.NUMX_API_BASE || '').replace(/\/+$/, '') : '';
const DSH_UI_PATH = location.pathname.startsWith('/api/numx-org/org/');
// 前缀已含 API 路径：DSH 三屏用插件命名空间，其他宿主用 /api；调用方只追加 /{endpoint}，不得再补 /api。
const BINARY_API_BASE = DSH_UI_PATH ? `${API_BASE}/api/numx-org` : `${API_BASE}/api`;
function parseOrgTimestamp(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const normalized = raw.replace(' ', 'T');
  const iso = /(?:[zZ]|[+-]\d\d:?\d\d)$/.test(normalized) ? normalized : `${normalized}Z`;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}
function timeoutSignal(ms) {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined;
}
const ORG_PUBLIC_ERROR_MESSAGES = Object.freeze({
  org_api_base_unconfigured: '桌面服务地址未配置，请联系运维',
  org_plugin_session_required: '请先登录后再访问组织数据',
  org_plugin_origin_denied: '请求来源校验未通过，请稍后重试或联系运维',
  org_plugin_sender_denied: '桌面运行时接口调用未通过安全校验，请重启客户端或联系运维',
  org_plugin_read_denied: '当前账号无权执行此操作',
  org_plugin_write_denied: '当前账号无权执行此操作',
  org_plugin_timeout: '组织服务响应超时，请稍后重试',
  org_plugin_upstream_timeout: '组织服务响应超时，请稍后重试',
  org_plugin_upstream_unreachable: '组织服务暂时无法连接，请检查网络后重试',
  org_plugin_rate_limited: '操作过于频繁，请稍后重试',
  org_plugin_cancelled: '请求已取消，请稍后重试',
  org_plugin_concurrency_unavailable: '组织服务繁忙，请稍后重试',
  org_plugin_network_denied: '桌面运行时网络配置未通过安全校验，请联系运维',
  org_plugin_procedure_denied: '桌面运行时接口配置未通过安全校验，请联系运维',
  org_plugin_payload_invalid: '提交内容未通过校验，请核对后重试',
  org_plugin_payload_too_large: '提交内容过大，请精简后重试',
  org_plugin_response_invalid: '组织服务返回异常，请稍后重试',
  org_plugin_response_too_large: '组织服务返回内容过大，请联系运维',
  org_plugin_upstream_invalid_response: '组织服务返回异常，请稍后重试',
  org_plugin_upstream_content_type: '组织服务返回内容异常，请联系运维',
  org_plugin_upstream_error: '组织服务暂时不可用，请稍后重试',
  org_plugin_pack_unavailable: '当前部门包未开放或登记信息不完整',
  org_plugin_ticket_invalid: '安装票据无效，请刷新后重试',
  org_plugin_install_confirm_failed: '安装确认失败，请重试；重试将复用原票据',
  org_plugin_registry_unavailable: '部门包登记服务未配置，请联系运维',
  org_plugin_pack_not_registered: '部门包未登记、版本不匹配或当前渠道未开放',
  org_plugin_ticket_expired: '安装票据已过期，请重新激活',
  org_plugin_ticket_consumed: '安装票据已使用，正在核对安装状态',
  org_plugin_ticket_owner_mismatch: '安装票据不属于当前账号，请重新登录',
  org_plugin_pack_conflict: '本舱已激活其他部门包，请先核对安装记录',
  org_plugin_already_active: '本舱已激活该部门包，正在核对安装状态',
  subscription_required: '当前有效订阅不包含此部门包',
  org_plugin_pack_not_entitled: '当前权益不覆盖此部门包，请核对订阅范围',
  department_mapping_required: '部门映射待补，暂不能激活',
  package_mapping_required: '订阅包映射待补，暂不能激活',
  infra_unavailable: '组织服务暂时不可用，请稍后重试',
});
function orgPublicErrorText(error) {
  const message = String(error?.message || error || '').trim();
  const wrappedCode = message.match(/(?:^|[\s:])(org_(?:plugin|api)_[a-z0-9_]+)(?=$|[\s,;])/i)?.[1] || '';
  const knownMessageCode = message.match(/(?:^|[\s:])(subscription_required|department_mapping_required|package_mapping_required|infra_unavailable)(?=$|[\s,;])/)?.[1] || '';
  const code = String(wrappedCode || knownMessageCode || error?.code || '').toLowerCase();
  if (Object.hasOwn(ORG_PUBLIC_ERROR_MESSAGES, code)) return ORG_PUBLIC_ERROR_MESSAGES[code];
  const http = code.match(/^org_plugin_upstream_http_(\d{3})$/);
  if (http) {
    const status = Number(http[1]);
    const messages = {
      400: '请求未通过校验，请核对输入后重试',
      401: '账号、密码或会话校验失败，请重新登录',
      403: '当前账号无权执行此操作',
      404: '组织服务接口暂不可用，请稍后重试',
      409: '当前数据状态已变化，请刷新后重试',
      412: '请求来源校验未通过，请稍后重试或联系运维',
      429: '操作过于频繁，请稍后重试',
    };
    if (Object.hasOwn(messages, status)) return messages[status];
    if (status >= 500) return '组织服务暂时不可用，请稍后重试';
  }
  const errorName = String(error?.name || '');
  if (errorName === 'TimeoutError' || errorName === 'AbortError') return ORG_PUBLIC_ERROR_MESSAGES.org_plugin_upstream_timeout;
  if (/^(failed to fetch|fetch failed|load failed|networkerror|network request failed|signal timed out)/i.test(message)) {
    return ORG_PUBLIC_ERROR_MESSAGES.org_plugin_upstream_unreachable;
  }
  // Web 直连可拿到服务端明确业务原因；Electron 包装与内部错误码不直接展示给操作者。
  if (message && !message.startsWith('Error invoking remote method') && !/^org_(?:plugin|api)_/i.test(message)) return message.slice(0, 160);
  return '组织服务调用失败，请稍后重试';
}
function recoverExpiredSession(error) {
  if (!TOKEN) return;
  const status = Number(error?.status || error?.statusCode);
  // 桌面壳插件路径的错误码只在 message 里（orgRuntimeIpc 只 throw new Error(code)，Electron 还会加
  // `Error invoking remote method...` 前缀），因此不能只认 error.code；message 用尾部锚定避免正文误伤。
  const expiredCodes = ['session_expired', 'org_plugin_upstream_http_401', 'org_plugin_session_required'];
  const message = String(error?.message || error);
  const expiredByMessage = /(?:^|[\s:])(session_expired|org_plugin_upstream_http_401|org_plugin_session_required)(?=$|[\s,;])/.test(message);
  if (status !== 401 && !expiredCodes.includes(error?.code) && !expiredByMessage) return;
  const failedToken = TOKEN;
  TOKEN = '';
  try {
    const stored = JSON.parse(localStorage.getItem('nebula_auth') || '{}');
    if (!stored?.token || stored.token === failedToken) localStorage.removeItem('nebula_auth');
  } catch {}
  const gate = document.getElementById('authgate');
  if (gate) {
    gate.style.display = 'flex';
    if (typeof agShow === 'function') agShow(true);
  } else {
    location.assign('index.html');
  }
}
async function apiRaw(routerPath, input = {}) {
  try {
    if (window.numxShell?.orgRuntime?.invoke) {
      const result = await window.numxShell.orgRuntime.invoke(routerPath, { token: TOKEN, ...input });
      return result?.result?.data?.json ?? result?.result?.data ?? result;
    }
    if (location.protocol === 'file:' && !API_BASE) throw new Error('org_api_base_unconfigured');
    const r = await fetch(`${API_BASE}/api/trpc/${routerPath}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json: { token: TOKEN, ...input } }),
      signal: timeoutSignal(15000),
    });
    const j = await r.json().catch(() => null);
    if (j?.error) {
      const error = new Error(j.error.json?.message || j.error.message || 'api_error');
      error.status = r.status;
      error.code = j.error.json?.code || j.error.code || 'api_error';
      throw error;
    }
    if (!r.ok) {
      const error = new Error(`org_plugin_upstream_http_${r.status}`);
      error.status = r.status;
      error.code = `org_plugin_upstream_http_${r.status}`;
      throw error;
    }
    if (!j) throw new Error('org_plugin_response_invalid');
    return j?.result?.data?.json ?? j?.result?.data ?? j;
  } catch (error) {
    recoverExpiredSession(error);
    throw error;
  }
}

let WORKSPACE_DIRECTORY;
let WORKSPACE_DIRECTORY_ERROR = '';
let workspaceDirectoryEpoch = 0;
let workspaceActivationPending = null;
let workspaceActivationTicket = null;
function resetWorkspaceDirectory() {
  workspaceDirectoryEpoch += 1;
  WORKSPACE_DIRECTORY = undefined;
  WORKSPACE_DIRECTORY_ERROR = '';
  workspaceActivationTicket = null;
  if (workspaceActivationPending?.token !== TOKEN) workspaceActivationPending = null;
  if (typeof onWorkspaceDirectoryReset === 'function') onWorkspaceDirectoryReset();
  paintWorkspaceStrip();
}
function paintWorkspaceStrip() {
  const html = renderWorkspaceStrip();
  const mount = document.getElementById('workspace-strip');
  if (mount) mount.innerHTML = html;
}
function failWorkspaceDirectory(error) {
  // 已成功读回的目录不得被页面级降级覆盖；在飞请求仍可随后成功覆盖本次错误。
  if (WORKSPACE_DIRECTORY) return;
  WORKSPACE_DIRECTORY = null;
  WORKSPACE_DIRECTORY_ERROR = orgPublicErrorText(error);
  paintWorkspaceStrip();
}
function ensureWorkspaceStyle() {
  if (document.getElementById('numx-workspace-style')) return;
  const style = document.createElement('style');
  style.id = 'numx-workspace-style';
  style.textContent = '.ws-wrap{margin-bottom:14px}.ws-head{font-size:12px;color:var(--t2);margin-bottom:8px}.ws-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px}.ws-card{border:1px solid var(--line);border-radius:10px;padding:10px 12px;background:rgba(17,27,46,.72);cursor:pointer}.ws-card:hover{border-color:var(--cyan)}.ws-blocked{cursor:default;opacity:.62}.ws-install{margin-left:6px;border:1px solid var(--cyan);border-radius:6px;background:transparent;color:var(--cyan);padding:2px 6px;cursor:pointer}.ws-title{font-size:13px;font-weight:700;color:var(--t1)}.ws-meta{font-size:10px;color:var(--t3);margin-top:4px;line-height:1.5}.ws-current{color:var(--mint);margin-left:6px}.ws-empty{font-size:11px;color:var(--t3);border:1px dashed var(--line);border-radius:9px;padding:10px}';
  document.head.appendChild(style);
}
function workspaceChannelAllowed(channel) {
  const channels = WORKSPACE_DIRECTORY?.packChannels;
  return Array.isArray(channels) && channels.includes(channel);
}
const WORKSPACE_ROLE_LABELS = Object.freeze({ admin: '企业管理员', manager: '部门负责人', staff: '员工' });
function workspaceRoleLabel(role) { return Object.hasOwn(WORKSPACE_ROLE_LABELS, role) ? WORKSPACE_ROLE_LABELS[role] : '角色未读回'; }
function workspaceIsCurrent(w) {
  if (typeof curView !== 'undefined' && curView === 'cabin' && typeof curDept !== 'undefined' && curDept) return curDept === w.cabinCode;
  if (typeof curView !== 'undefined' && curView === 'dash') return false;
  if (typeof DEPT_STATUS !== 'undefined' && DEPT_STATUS !== 'ready') return false;
  if (typeof DEPT !== 'undefined' && DEPT) return DEPT === w.cabinCode;
  return w.current === true;
}
function workspaceActivationLabel(w) {
  if (typeof DEPT_STATUS !== 'undefined' && DEPT_STATUS === 'loading') return '激活状态读取中…';
  if (workspaceActivationPending?.token === TOKEN && workspaceActivationPending.code === w.cabinCode) return '正在激活…';
  const installNote = w.employeeInstallRequired === true ? ' · 本机需安装' : '';
  if (w.activation === 'active') return `本舱已激活${installNote}`;
  if (w.activation === 'stale') return `安装包版本待核对${installNote}`;
  if (w.activation === 'registry_unavailable') return `${w.installed === true ? '已安装，登记信息未读回' : '登记信息未读回'}${installNote}`;
  if (w.activation === 'entitlement_unavailable') return `权益信息未读回${installNote}`;
  if (w.activation === 'eligible') {
    if (!w.pack || !workspaceChannelAllowed(w.pack.channel)) return `当前部门包未开放安装${installNote}`;
    return `${workspaceActivationEligible(w) ? '本舱可激活' : '负责人待激活'}${w.entitlement?.packageKey ? ` · ${w.entitlement.packageKey}` : ''}${installNote}`;
  }
  if (w.activation === 'subscription_required') return `负责人待订阅${installNote}`;
  if (w.activation === 'department_mapping_required') return `部门映射待补${installNote}`;
  if (w.activation === 'package_mapping_required') return `订阅包映射待补${installNote}`;
  if (w.activation === 'pack_unavailable') return `当前部门包未开放安装${installNote}`;
  if (w.activation === 'not_required') return w.employeeInstallRequired === false && w.role === 'staff' ? '员工免安装部门包' : `组织视图${installNote}`;
  return `激活状态未读回${installNote}`;
}
let workspaceNavPending = null;
function navigateOrgView(view, query) {
  const targetView = view === 'station' ? 'station' : 'cabin';
  const targetPage = targetView === 'station' ? 'station.html' : 'cabin.html';
  if (!window.parent || window.parent === window) { location.assign(`${targetPage}?${query}`); return; }
  if (workspaceNavPending) {
    clearTimeout(workspaceNavPending.timer);
    window.removeEventListener('message', workspaceNavPending.onAck);
    workspaceNavPending = null;
  }
  const pending = {};
  pending.onAck = (event) => {
    if (event.origin !== window.location.origin || event.source !== window.parent || event.data?.type !== 'numx-org:navigated' || event.data?.view !== targetView) return;
    clearTimeout(pending.timer);
    window.removeEventListener('message', pending.onAck);
    workspaceNavPending = null;
  };
  pending.timer = setTimeout(() => {
    window.removeEventListener('message', pending.onAck);
    workspaceNavPending = null;
    location.assign(`${targetPage}?${query}`);
  }, 1500);
  workspaceNavPending = pending;
  window.addEventListener('message', pending.onAck);
  const targetOrigin = window.location.origin === 'null' ? '*' : window.location.origin;
  window.parent.postMessage({ type: 'numx-org:navigate', view: targetView, query }, targetOrigin);
}
function openWorkspaceCabin(code) {
  const target = String(code || '');
  if (!target || workspaceIsCurrent({ cabinCode: target })) return;
  const targetView = location.pathname.endsWith('station.html') ? 'station' : 'cabin';
  if (typeof switchCabinWorkspace === 'function') { switchCabinWorkspace(target); return; }
  if (typeof goCabin === 'function' && typeof DEPTS !== 'undefined' && Array.isArray(DEPTS) && DEPTS.some((dept) => dept.key === target)) { goCabin(target); return; }
  navigateOrgView(targetView, `dept=${encodeURIComponent(target)}`);
}
function workspaceCardEnterable(w) {
  if (workspaceIsCurrent(w)) return false;
  if (w.employeeInstallRequired === true) return false;
  return w.role === 'admin' || w.role === 'manager' || w.role === 'staff';
}
function workspaceActivationEligible(w) {
  if (typeof DEPT_STATUS !== 'undefined' && DEPT_STATUS === 'loading') return false;
  if (w.activation !== 'eligible') return false;
  if (!w.pack || typeof w.pack.id !== 'string' || !w.pack.id || !workspaceChannelAllowed(w.pack.channel)) return false;
  return (Array.isArray(w.capabilities) ? w.capabilities : []).includes('plugin.install');
}
function workspaceCanActivate(w) {
  return workspaceActivationPending?.token !== TOKEN && workspaceActivationEligible(w);
}
const INSTALL_TERMINAL_ERROR_CODES = Object.freeze([
  'org_plugin_ticket_expired', 'org_plugin_ticket_invalid', 'org_plugin_ticket_owner_mismatch',
  'org_plugin_pack_conflict', 'org_plugin_pack_not_registered', 'org_plugin_pack_not_entitled',
  'org_plugin_registry_unavailable', 'subscription_required', 'department_mapping_required', 'package_mapping_required',
]);
function installErrorMatches(text, code) {
  return new RegExp(`(?:^|[\\s:])${code}(?=$|[\\s,;])`).test(text);
}
function classifyInstallError(error) {
  const text = `${String(error?.code || '')} ${String(error?.message || error)}`;
  const expired = installErrorMatches(text, 'org_plugin_ticket_expired');
  const consumed = installErrorMatches(text, 'org_plugin_ticket_consumed') || installErrorMatches(text, 'org_plugin_already_active');
  const terminalFailure = expired || INSTALL_TERMINAL_ERROR_CODES.some((code) => installErrorMatches(text, code));
  return { expired, consumed, terminalFailure };
}
function validWorkspaceTicket(ticket, packId) {
  return ticket?.ok === true && !!ticket.ticketId && !!ticket.ticket && ticket.pack?.id === packId
    && workspaceChannelAllowed(ticket.pack?.channel) && /^[a-f0-9]{64}$/.test(String(ticket.pack?.sha256 || ''))
    && typeof ticket.pack?.version === 'string' && ticket.pack.version.length > 0
    && Number.isFinite(Number(ticket.expiresInSeconds)) && Number(ticket.expiresInSeconds) > 0;
}
async function refreshWorkspaceActivation(code, expectedToken = TOKEN) {
  await loadWorkspaceDirectory({ keepPrevious: true });
  if (TOKEN !== expectedToken) return false;
  const active = WORKSPACE_DIRECTORY?.cabins?.find((row) => row.cabinCode === code)?.activation === 'active';
  redrawWorkspaceStrip();
  return active;
}
async function activateWorkspacePlugin(code) {
  if (workspaceActivationPending?.token === TOKEN) return;
  const cabin = WORKSPACE_DIRECTORY?.cabins?.find((row) => row.cabinCode === code);
  if (!cabin || !workspaceCanActivate(cabin)) return;
  const requestToken = TOKEN;
  const packId = cabin.pack.id;
  let pending = null;
  try {
    workspaceActivationPending = { token: requestToken, code };
    redrawWorkspaceStrip();
    if (!window.confirm(`确认激活「${cabin.cabinName}」？将签发安装票据并写入安装台账。`)) return;
    pending = workspaceActivationTicket;
    if (!pending || pending.code !== code || pending.packId !== packId || pending.token !== requestToken || pending.expiresAt <= Date.now()) {
      workspaceActivationTicket = null;
      pending = null;
    }
    if (!pending) {
      const ticket = await apiRaw('orgPlugin.installTicket', { cabinCode: code, packId });
      if (!validWorkspaceTicket(ticket, packId)) throw new Error('org_plugin_ticket_invalid');
      pending = { code, packId, token: requestToken, ticketId: ticket.ticketId, ticket: ticket.ticket, expiresAt: Date.now() + Number(ticket.expiresInSeconds) * 1000 };
      workspaceActivationTicket = pending;
    }
    if (TOKEN !== requestToken) throw new Error('org_plugin_ticket_owner_mismatch');
    const result = await apiRaw('orgPlugin.installConfirm', { ticketId: pending.ticketId, ticket: pending.ticket });
    if (!result?.ok) throw new Error('org_plugin_install_confirm_failed');
    if (TOKEN !== requestToken) throw new Error('org_plugin_ticket_owner_mismatch');
    if (workspaceActivationTicket === pending) workspaceActivationTicket = null;
    const active = await refreshWorkspaceActivation(code, requestToken);
    if (TOKEN !== requestToken) return;
    alert(active ? `「${cabin.cabinName}」已激活，安装台账已写入。` : '激活已提交，但安装状态未读回，请刷新核对。');
  } catch (error) {
    const { expired, consumed, terminalFailure } = classifyInstallError(error);
    if (terminalFailure) {
      // 旧会话的终态只能清理自己那张票，不得误删新会话已开始复用的新票。
      if (workspaceActivationTicket === pending) workspaceActivationTicket = null;
      if (TOKEN === requestToken) await refreshWorkspaceActivation(code, requestToken);
    }
    if (expired) {
      if (TOKEN === requestToken) alert(orgPublicErrorText(error));
      return;
    }
    if (consumed && workspaceActivationTicket === pending) workspaceActivationTicket = null;
    if (consumed && TOKEN === requestToken) {
      const active = await refreshWorkspaceActivation(code, requestToken);
      if (active) {
        alert(`「${cabin.cabinName}」已激活，安装台账已写入。`);
        return;
      }
    }
    if (TOKEN === requestToken) alert(orgPublicErrorText(error));
  } finally {
    if (workspaceActivationPending?.token === requestToken && workspaceActivationPending.code === code) {
      workspaceActivationPending = null;
      if (TOKEN === requestToken) redrawWorkspaceStrip();
    }
  }
}

function renderWorkspaceStrip() {
  ensureWorkspaceStyle();
  if (WORKSPACE_DIRECTORY === undefined) return '<div class="ws-wrap"><div class="ws-empty">工作区目录加载中…</div></div>';
  if (WORKSPACE_DIRECTORY === null) return `<div class="ws-wrap"><div class="ws-empty">工作区目录未读回${WORKSPACE_DIRECTORY_ERROR ? `（${escH(WORKSPACE_DIRECTORY_ERROR)}）` : ''}——不显示伪造角色或安装状态 <button type="button" class="ws-install" onclick="loadWorkspaceDirectory()">重试</button></div></div>`;
  const rows = Array.isArray(WORKSPACE_DIRECTORY.cabins) ? WORKSPACE_DIRECTORY.cabins : [];
  if (!rows.length) return '<div class="ws-wrap"><div class="ws-empty">当前账号暂无可进入工作区</div></div>';
  const refreshError = WORKSPACE_DIRECTORY_ERROR ? ` · 刷新未达：${escH(WORKSPACE_DIRECTORY_ERROR)}` : '';
  return `<div class="ws-wrap"><div class="ws-head">我的部门工作区 · 角色与权益来自 WB${refreshError}</div><div class="ws-grid">${rows.map(w => `<div class="ws-card${workspaceCardEnterable(w) ? '' : ' ws-blocked'}" data-key="${escH(w.cabinCode)}" ${workspaceCardEnterable(w) ? 'onclick="openWorkspaceCabin(this.dataset.key)"' : ''} title="${escH((Array.isArray(w.capabilities) ? w.capabilities : []).join(' · '))}"><div class="ws-title">${escH(w.cabinName)}${workspaceIsCurrent(w) ? '<span class="ws-current">当前</span>' : ''}</div><div class="ws-meta">${escH(workspaceRoleLabel(w.role))} · ${escH(workspaceActivationLabel(w))}${workspaceCanActivate(w) ? ` <button type="button" class="ws-install" data-key="${escH(w.cabinCode)}" onclick="event.stopPropagation();activateWorkspacePlugin(this.dataset.key)">激活本舱</button>` : ''}</div></div>`).join('')}</div></div>`;
}
function redrawWorkspaceStrip() {
  // 只重绘工作区挂载条，不重建整屏；输入、当前视图和未映射说明均保持不变。
  paintWorkspaceStrip();
}

async function loadWorkspaceDirectory(options = {}) {
  const keepPrevious = options.keepPrevious === true;
  const previous = WORKSPACE_DIRECTORY;
  const epoch = ++workspaceDirectoryEpoch;
  const requestToken = TOKEN;
  if (!keepPrevious) {
    WORKSPACE_DIRECTORY = undefined;
    WORKSPACE_DIRECTORY_ERROR = '';
    paintWorkspaceStrip();
  }
  try {
    const result = await wbApi('orgPlugin.workspaces');
    if (epoch !== workspaceDirectoryEpoch) return null;
    if (requestToken !== TOKEN) {
      WORKSPACE_DIRECTORY = null;
      WORKSPACE_DIRECTORY_ERROR = '登录状态已变化，请重新读取工作区';
      return null;
    }
    const validChannels = result && Array.isArray(result.packChannels)
      && result.packChannels.every((channel) => typeof channel === 'string' && channel.length > 0);
    const validCabins = result && Array.isArray(result.cabins) && result.cabins.every((row) => row && typeof row === 'object' && !Array.isArray(row) && typeof row.cabinCode === 'string' && row.cabinCode);
    if (!result || !validChannels || !validCabins) {
      if (!keepPrevious || previous === undefined) {
        WORKSPACE_DIRECTORY = null;
        WORKSPACE_DIRECTORY_ERROR = ORG_PUBLIC_ERROR_MESSAGES.org_plugin_response_invalid;
        return null;
      }
      WORKSPACE_DIRECTORY_ERROR = ORG_PUBLIC_ERROR_MESSAGES.org_plugin_response_invalid;
      return previous;
    }
    const normalized = { ...result, cabins: result.cabins.map((row) => ({ ...row, cabinName: typeof row.cabinName === 'string' && row.cabinName.trim() ? row.cabinName : row.cabinCode })) };
    WORKSPACE_DIRECTORY = normalized;
    WORKSPACE_DIRECTORY_ERROR = '';
    paintWorkspaceStrip();
    return normalized;
  } catch (error) {
    if (epoch !== workspaceDirectoryEpoch) return null;
    if (requestToken !== TOKEN) {
      WORKSPACE_DIRECTORY = null;
      WORKSPACE_DIRECTORY_ERROR = '登录状态已变化，请重新读取工作区';
      return null;
    }
    if (!keepPrevious || previous === undefined) {
      WORKSPACE_DIRECTORY = null;
      WORKSPACE_DIRECTORY_ERROR = orgPublicErrorText(error);
      return null;
    }
    WORKSPACE_DIRECTORY_ERROR = orgPublicErrorText(error);
    return previous;
  } finally {
    paintWorkspaceStrip();
  }
}

// 三屏共享表现与通知 helpers；页面仅提供 LIVE/api/$，不再各维护一套复制实现。
function escH(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
const MODE_LABELS = {
  live: { chip: '真数据', suffix: 'LIVE', off: false },
  partial: { chip: '部分数据接通', suffix: 'PARTIAL', off: true },
  expired: { chip: '未登录或会话已失效', suffix: 'SESSION EXPIRED', off: true },
  demo: { chip: '数据未接通（API 未达）', suffix: 'OFFLINE', off: true },
  loading: { chip: '数据加载中…', suffix: 'LINKING', off: false },
};
function modeBadgeFor(live) {
  const meta = MODE_LABELS[live.mode] || MODE_LABELS.loading;
  const el = document.createElement('span');
  el.className = 'chip';
  el.style.cssText = live.mode === 'live'
    ? 'color:var(--mint);border-color:rgba(52,211,153,.4);background:rgba(52,211,153,.08)'
    : live.mode === 'loading'
      ? 'color:var(--t3)'
      : 'color:var(--amber);border-color:rgba(251,191,36,.4);background:rgba(251,191,36,.08)';
  el.textContent = meta.chip;
  return el;
}
function setBadgeFor(live, prefix) {
  const meta = MODE_LABELS[live.mode] || MODE_LABELS.loading;
  const liveEl = document.querySelector('.live');
  const chipLabels = Object.values(MODE_LABELS).map((item) => item.chip);
  document.querySelectorAll('.chip').forEach((chip) => { if (chipLabels.some((label) => chip.textContent.includes(label))) chip.remove(); });
  if (liveEl) {
    liveEl.classList.toggle('off', meta.off);
    liveEl.innerHTML = `<span class="dot"></span>${prefix} ${meta.suffix}`;
    liveEl.before(modeBadgeFor(live));
  } else document.querySelector('.hd')?.prepend(modeBadgeFor(live));
}
async function delegationStatusText(id) {
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await wbApi('orgTask.delegation', { id });
      const row = response.item || {};
      const status = String(row.status || '');
      if (['done', 'failed', 'blocked'].includes(status)) {
        const raw = row.result_head ?? row.result ?? '';
        const detail = (typeof raw === 'string' ? raw : JSON.stringify(raw)).slice(0, 120);
        return `${status}${detail ? `：${detail}` : ''}`;
      }
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return 'open（后台执行中）';
  } catch {
    return '状态暂未读回（请以任务流水为准）';
  }
}
let PENDING_IDEM = null;
function newIdemKey() {
  const uuid = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `org-${uuid.replace(/[^a-zA-Z0-9-]/g, '')}`.slice(0, 64);
}
function idemKeyFor(dept, task) {
  if (!PENDING_IDEM || PENDING_IDEM.dept !== dept || PENDING_IDEM.task !== task) PENDING_IDEM = { dept, task, key: newIdemKey() };
  return PENDING_IDEM.key;
}
function clearIdemKey() { PENDING_IDEM = null; }
let NOTICE_IDS = [];
let NOTICE_DEPT = '';
let NOTICE_TIMER = null;
let NOTICE_EPOCH = 0;
function invalidateNoticePoll() { NOTICE_EPOCH += 1; }
async function pollNotices() {
  const epoch = ++NOTICE_EPOCH;
  const requestDept = NOTICE_DEPT;
  const requestToken = TOKEN;
  try {
    const response = await api('notices', { status: 'unread', limit: 30, ...(requestDept ? { dept: requestDept } : {}) });
    if (epoch !== NOTICE_EPOCH || requestDept !== NOTICE_DEPT || requestToken !== TOKEN) return;
    if (!response || response.ok !== true) return;
    bellRecovered();
    NOTICE_IDS = (response.items || []).map((item) => item.notice_id);
    const badge = $('#nbadge');
    if (response.unreadCount > 0) { badge.textContent = response.unreadCount > 99 ? '99+' : String(response.unreadCount); badge.style.display = ''; }
    else badge.style.display = 'none';
    renderNoticeBox(response.items || []);
  } catch {
    if (epoch === NOTICE_EPOCH && requestDept === NOTICE_DEPT && requestToken === TOKEN) bellDegraded();
  }
}
function bellDegraded() { const bell = $('#bell'); if (bell && !bell.dataset.deg) { bell.dataset.deg = '1'; bell.title = '通知面未达（降级——挂账在案）'; bell.style.opacity = '.45'; } }
function bellRecovered() { const bell = $('#bell'); if (bell && bell.dataset.deg) { delete bell.dataset.deg; bell.title = '组织通知（待审/告警/叫人）'; bell.style.opacity = ''; } }
function renderNoticeBox(items) {
  const box = $('#nbox');
  if (!box) return;
  if (!items.length) {
    box.innerHTML = '<div class="nact"><span>组织通知</span></div><div class="ni"><div class="nb">没有未读通知——队列清空</div></div>';
    return;
  }
  box.innerHTML = '<div class="nact"><span>未读 ' + items.length + ' 条</span><a onclick="readAllNotices(event)">全部已读</a></div>' + items.map((item) =>
    '<div class="ni"><div class="nt">' + (item.kind === 'warn' ? '<span style="color:var(--amber)">告警</span> ' : '<span style="color:var(--cyan)">待审</span> ') + escH(item.title || '') + '</div><div class="nb">' + escH(item.body || '') + '</div><div class="nm">' + escH(item.dept || '全厂') + ' · ' + escH(String(item.created_at || '').replace('T', ' ').slice(0, 16)) + '</div></div>').join('');
}
function toggleNoticeBox(event) {
  if (event) event.stopPropagation();
  const box = $('#nbox');
  if (box) box.style.display = box.style.display === 'none' ? '' : 'none';
}
async function readAllNotices(event) {
  if (event) event.stopPropagation();
  if (!NOTICE_IDS.length) return;
  try { await api('noticeRead', { ids: NOTICE_IDS }); await pollNotices(); } catch { /* 保留当前通知面 */ }
}
document.addEventListener('click', (event) => {
  const box = $('#nbox');
  const bell = $('#bell');
  if (box && bell && box.style.display !== 'none' && !bell.contains(event.target)) box.style.display = 'none';
});
function startNoticeLoop() { if (NOTICE_TIMER) return; void pollNotices(); NOTICE_TIMER = setInterval(pollNotices, 30000); }
