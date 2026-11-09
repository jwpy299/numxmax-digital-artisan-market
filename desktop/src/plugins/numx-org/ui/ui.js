(() => {
  const root = document.getElementById('numx-org-runtime');
  if (!root) return;
  const frames = new Map([...root.querySelectorAll('[data-org-frame]')].map((frame) => [frame.dataset.orgFrame, frame]));
  const viewButtons = [...root.querySelectorAll('[data-org-view]')];
  const fullscreenButton = root.querySelector('[data-org-fullscreen]');
  const sources = Object.fromEntries([...frames].map(([view, frame]) => [view, frame.getAttribute('src')]));
  let activeView = 'index';
  let navigationSource = null;
  function setView(view, query = '') {
    const frame = frames.get(view);
    if (!frame || !sources[view]) return;
    if (query) {
      const normalized = query.startsWith('?') ? query : `?${query}`;
      if (normalized.length <= 512 && !/[\u0000-\u001f\u007f]/.test(normalized) && frame.dataset.orgQuery !== normalized) {
        frame.src = `${sources[view]}${normalized}`;
        frame.dataset.orgQuery = normalized;
      }
    }
    activeView = view;
    for (const [name, item] of frames) item.hidden = name !== view;
    for (const button of viewButtons) button.setAttribute('aria-pressed', String(button.dataset.orgView === view));
  }

  function wireInternalNavigation(frame) {
    const frameDoc = frame.contentDocument;
    if (!frameDoc || frameDoc.__numxOrgNavigationWired) return;
    Object.defineProperty(frameDoc, '__numxOrgNavigationWired', { value: true });
    frameDoc.addEventListener('click', (event) => {
      const anchor = event.target instanceof frame.contentWindow.Element ? event.target.closest('a[href]') : null;
      if (!anchor) return;
      const url = new URL(anchor.href, frame.contentWindow.location.href);
      const match = url.pathname.match(/\/(index|cabin|station|runtime)\.html$/);
      if (!match || url.origin !== window.location.origin || !frames.has(match[1])) return;
      event.preventDefault();
      setView(match[1], url.search);
    });
  }

  for (const [view, frame] of frames) {
    frame.addEventListener('load', () => wireInternalNavigation(frame));
    if (frame.contentDocument?.readyState === 'complete') wireInternalNavigation(frame);
    if (!sources[view]) frames.delete(view);
  }
  for (const button of viewButtons) button.addEventListener('click', () => setView(button.dataset.orgView));
  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin) return;
    navigationSource = [...frames.values()].find((frame) => frame.contentWindow === event.source);
    if (!navigationSource) return;
    const data = event.data;
    if (!data || data.type !== 'numx-org:navigate' || typeof data.view !== 'string') return;
    if (data.query !== undefined && typeof data.query !== 'string') return;
    setView(data.view, data.query || '');
    if (activeView === data.view) navigationSource.contentWindow?.postMessage({ type: 'numx-org:navigated', view: data.view }, window.location.origin === 'null' ? '*' : window.location.origin);
  });

  function syncFullscreenButton() {
    const active = document.fullscreenElement === root || root.classList.contains('org-fullscreen');
    fullscreenButton.setAttribute('aria-pressed', String(active));
    fullscreenButton.textContent = active ? '退出横屏' : '横屏展开';
  }
  setView(activeView);
  if (!fullscreenButton) return;
  fullscreenButton.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement === root) await document.exitFullscreen();
      else if (root.classList.contains('org-fullscreen')) root.classList.remove('org-fullscreen');
      else if (root.requestFullscreen) await root.requestFullscreen();
      else root.classList.add('org-fullscreen');
    } catch {
      root.classList.toggle('org-fullscreen');
    }
    syncFullscreenButton();
  });
  document.addEventListener('fullscreenchange', syncFullscreenButton);
  syncFullscreenButton();
})();
