(() => {
  'use strict';

  const PANEL_OPEN_KEY = 'cursor-bridge-chat-right-panel';
  const PANEL_WIDTH_KEY = 'cursor-bridge-chat-right-panel-width';
  const PANEL_TAB_KEY = 'cursor-bridge-chat-right-panel-tab';
  const PANEL_APP_KEY = 'cursor-bridge-chat-right-panel-app';
  const PANEL_WIDTH_MIN = 280;
  const PANEL_WIDTH_DEFAULT = 420;

  function $(id) {
    return document.getElementById(id);
  }

  function wsUrl() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const path =
      typeof bridgePath === 'function'
        ? bridgePath('/api/terminal/ws')
        : '/api/terminal/ws';
    return `${proto}//${window.location.host}${path}`;
  }

  let term = null;
  let fitAddon = null;
  let socket = null;
  let enabled = false;
  let activeTab = 'terminal';
  let apps = [];
  let appsLoaded = false;

  function setStatus(text, kind) {
    const el = $('chat-terminal-status');
    if (!el) return;
    el.textContent = text;
    el.dataset.kind = kind || '';
  }

  function panelOpen() {
    const shell = $('chat-shell');
    return shell ? !shell.classList.contains('right-panel-collapsed') : false;
  }

  function sendResize() {
    if (!socket || socket.readyState !== WebSocket.OPEN || !term) return;
    socket.send(
      JSON.stringify({
        type: 'resize',
        cols: term.cols,
        rows: term.rows,
      }),
    );
  }

  let fitRaf = 0;

  function fitTerminal() {
    if (!term || !panelOpen() || activeTab !== 'terminal') return;
    fitAddon?.fit();
    sendResize();
  }

  function scheduleFit() {
    if (fitRaf) cancelAnimationFrame(fitRaf);
    fitRaf = requestAnimationFrame(() => {
      fitRaf = 0;
      fitTerminal();
    });
  }

  function disconnect() {
    if (socket) {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      socket = null;
    }
  }

  function shouldConnect() {
    return enabled && panelOpen() && activeTab === 'terminal';
  }

  function connect() {
    if (!shouldConnect()) return;
    disconnect();
    if (!term) {
      setStatus('Terminal unavailable', 'error');
      return;
    }
    setStatus('Connecting…', 'pending');
    try {
      socket = new WebSocket(wsUrl());
      socket.binaryType = 'arraybuffer';
    } catch (e) {
      setStatus(`WebSocket failed: ${e.message}`, 'error');
      return;
    }

    socket.addEventListener('open', () => {
      setStatus('Connected', 'ok');
      scheduleFit();
      term.focus();
    });

    socket.addEventListener('message', ev => {
      if (!term) return;
      let data = ev.data;
      if (data instanceof ArrayBuffer) data = new Uint8Array(data);
      term.write(data);
    });

    socket.addEventListener('close', ev => {
      setStatus('Disconnected', 'warn');
      socket = null;
      // Proxy idle timeouts often drop the socket (1006) without user action.
      if (shouldConnect() && ev.code === 1006) {
        window.setTimeout(() => {
          if (shouldConnect() && (!socket || socket.readyState !== WebSocket.OPEN)) connect();
        }, 1500);
      }
    });

    socket.addEventListener('error', () => {
      setStatus('Connection error', 'error');
    });
  }

  function ensureTerm() {
    if (term || typeof Terminal === 'undefined') return;
    const host = $('chat-terminal-host');
    if (!host) return;
    term = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      theme: {
        background: 'transparent',
      },
      allowProposedApi: true,
    });
    if (typeof FitAddon !== 'undefined') {
      fitAddon = new FitAddon.FitAddon();
      term.loadAddon(fitAddon);
    }
    term.open(host);
    term.onData(data => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(data);
    });
    requestAnimationFrame(() => requestAnimationFrame(() => scheduleFit()));

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => scheduleFit());
      ro.observe(host);
      const panelBody = $('chat-right-panel-body');
      if (panelBody && panelBody !== host) ro.observe(panelBody);
    }
    window.addEventListener('resize', () => scheduleFit());
    window.visualViewport?.addEventListener('resize', () => scheduleFit());
    window.visualViewport?.addEventListener('scroll', () => scheduleFit());
  }

  function refreshConnection() {
    if (shouldConnect()) {
      ensureTerm();
      requestAnimationFrame(() => {
        scheduleFit();
        if (!socket || socket.readyState !== WebSocket.OPEN) connect();
        else term?.focus();
      });
    } else {
      disconnect();
    }
  }

  function setPanelOpen(open) {
    const shell = $('chat-shell');
    if (!shell) return;
    shell.classList.toggle('right-panel-collapsed', !open);
    try {
      localStorage.setItem(PANEL_OPEN_KEY, open ? '1' : '0');
    } catch {
      /* ignore */
    }
    const toggle = $('chat-right-panel-toggle');
    toggle?.classList.toggle('active', open);
    toggle?.setAttribute('aria-pressed', open ? 'true' : 'false');
    refreshConnection();
    if (open) showActiveTab();
  }

  function togglePanel() {
    setPanelOpen(!panelOpen());
  }

  function resolvePanelOpen() {
    try {
      const saved = localStorage.getItem(PANEL_OPEN_KEY);
      if (saved === '1') return true;
      if (saved === '0') return false;
    } catch {
      /* ignore */
    }
    return false;
  }

  function effectivePanelWidthMax() {
    const half = Math.floor(window.innerWidth / 2);
    return Math.max(PANEL_WIDTH_MIN, half);
  }

  function readPanelWidth() {
    const maxW = effectivePanelWidthMax();
    try {
      const raw = localStorage.getItem(PANEL_WIDTH_KEY);
      const n = raw != null ? Number.parseInt(raw, 10) : PANEL_WIDTH_DEFAULT;
      if (!Number.isFinite(n)) return Math.min(PANEL_WIDTH_DEFAULT, maxW);
      return Math.min(maxW, Math.max(PANEL_WIDTH_MIN, n));
    } catch {
      return Math.min(PANEL_WIDTH_DEFAULT, maxW);
    }
  }

  function applyPanelWidth(px) {
    const maxW = effectivePanelWidthMax();
    const w = Math.min(maxW, Math.max(PANEL_WIDTH_MIN, Math.round(px)));
    document.documentElement.style.setProperty('--chat-right-panel-width', `${w}px`);
    try {
      localStorage.setItem(PANEL_WIDTH_KEY, String(w));
    } catch {
      /* ignore */
    }
    if (panelOpen()) scheduleFit();
  }

  function initPanelWidth() {
    applyPanelWidth(readPanelWidth());
  }

  function bindPanelResize() {
    const handle = $('chat-right-panel-resize');
    const shell = $('chat-shell');
    if (!handle || !shell) return;

    const onMove = e => {
      if (!shell.classList.contains('right-panel-resizing')) return;
      const right = window.innerWidth;
      applyPanelWidth(right - e.clientX);
    };

    const onUp = () => {
      shell.classList.remove('right-panel-resizing');
      document.body.classList.remove('chat-right-panel-dragging');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };

    const onDown = e => {
      if (shell.classList.contains('right-panel-collapsed')) return;
      e.preventDefault();
      shell.classList.add('right-panel-resizing');
      document.body.classList.add('chat-right-panel-dragging');
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    };

    handle.addEventListener('pointerdown', onDown);

    handle.addEventListener('keydown', e => {
      if (shell.classList.contains('right-panel-collapsed')) return;
      let delta = 0;
      if (e.key === 'ArrowLeft') delta = e.shiftKey ? -40 : -16;
      else if (e.key === 'ArrowRight') delta = e.shiftKey ? 40 : 16;
      else if (e.key === 'Home') {
        applyPanelWidth(PANEL_WIDTH_MIN);
        return;
      } else if (e.key === 'End') {
        applyPanelWidth(effectivePanelWidthMax());
        return;
      } else return;
      e.preventDefault();
      applyPanelWidth(readPanelWidth() + delta);
    });

    handle.addEventListener('dblclick', () => {
      applyPanelWidth(PANEL_WIDTH_DEFAULT);
    });
  }

  function bindPanelWidthObserver() {
    const shell = $('chat-shell');
    if (!shell || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      applyPanelWidth(readPanelWidth());
      if (panelOpen()) scheduleFit();
    });
    ro.observe(shell);
    window.addEventListener('resize', () => {
      applyPanelWidth(readPanelWidth());
      if (panelOpen()) scheduleFit();
    });
  }

  function fetchApi(path) {
    const url = typeof bridgePath === 'function' ? bridgePath(path) : path;
    return fetch(url);
  }

  function appUrl(app) {
    return app?.shortUrl || app?.url || '';
  }

  function appOptionLabel(app) {
    const name = app.title || app.name;
    if (app.kind !== 'proxy') return `${name} · static`;
    if (app.desired === 'stopped') return `${name} · stopped`;
    if (app.online === false) return `${name} · offline`;
    return `${name} · online`;
  }

  function readSavedApp() {
    try {
      return localStorage.getItem(PANEL_APP_KEY) || '';
    } catch {
      return '';
    }
  }

  function setAppsMessage(text, show) {
    const empty = $('chat-apps-empty');
    if (!empty) return;
    empty.hidden = !show;
    empty.textContent = text;
  }

  function showAppFrame(name, force) {
    const frame = $('chat-apps-frame');
    const open = $('chat-apps-open');
    const select = $('chat-apps-select');
    const app = apps.find(item => item.name === name);
    const url = appUrl(app);
    if (!url) {
      frame?.setAttribute('hidden', '');
      frame?.removeAttribute('src');
      if (open) {
        open.hidden = true;
        open.removeAttribute('href');
      }
      setAppsMessage(appsLoaded ? 'No apps deployed yet.' : 'Loading apps…', true);
      return;
    }
    try {
      localStorage.setItem(PANEL_APP_KEY, name);
    } catch {
      /* ignore */
    }
    if (select && select.value !== name) select.value = name;
    setAppsMessage('', false);
    if (frame) {
      frame.hidden = false;
      if (force || frame.getAttribute('src') !== url) frame.src = url;
    }
    if (open) {
      open.hidden = false;
      open.href = url;
    }
  }

  function renderAppSelect(preferred, force) {
    const select = $('chat-apps-select');
    if (!select) return;
    const current = preferred || select.value || readSavedApp();
    select.replaceChildren();
    if (apps.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No apps';
      select.appendChild(opt);
      select.disabled = true;
      showAppFrame('');
      return;
    }
    select.disabled = false;
    for (const app of apps) {
      const opt = document.createElement('option');
      opt.value = app.name;
      opt.textContent = appOptionLabel(app);
      select.appendChild(opt);
    }
    const pick = apps.some(app => app.name === current) ? current : apps[0].name;
    select.value = pick;
    showAppFrame(pick, force);
  }

  let appsRequest = 0;

  async function loadApps(forceReload) {
    const ticket = ++appsRequest;
    const res = await fetchApi('/api/apps');
    if (ticket !== appsRequest) return;
    if (!res.ok) throw new Error(String(res.status));
    const body = await res.json();
    if (ticket !== appsRequest) return;
    apps = Array.isArray(body.apps) ? body.apps : [];
    appsLoaded = true;
    renderAppSelect(undefined, forceReload);
  }

  function showActiveTab() {
    if (activeTab === 'apps' && panelOpen()) {
      loadApps(false).catch(err => {
        appsLoaded = false;
        setAppsMessage(`Could not load apps: ${err.message}`, true);
      });
    }
  }

  function syncTabChrome() {
    const appsOn = activeTab === 'apps';
    $('chat-terminal-host')?.toggleAttribute('hidden', appsOn);
    $('chat-apps-pane')?.toggleAttribute('hidden', !appsOn);
    for (const el of document.querySelectorAll('.chat-terminal-tools')) {
      el.toggleAttribute('hidden', appsOn);
    }
    const termTab = $('chat-right-tab-terminal');
    const appsTab = $('chat-right-tab-apps');
    termTab?.setAttribute('aria-selected', activeTab === 'terminal' ? 'true' : 'false');
    appsTab?.setAttribute('aria-selected', appsOn ? 'true' : 'false');
    termTab?.toggleAttribute('focusgroupstart', activeTab === 'terminal');
    appsTab?.toggleAttribute('focusgroupstart', appsOn);
  }

  function setActiveTab(tab) {
    if (tab === 'apps') activeTab = 'apps';
    else if (tab === 'terminal' && enabled) activeTab = 'terminal';
    else if (!enabled) activeTab = 'apps';
    else activeTab = 'terminal';
    syncTabChrome();
    try {
      localStorage.setItem(PANEL_TAB_KEY, activeTab);
    } catch {
      /* ignore */
    }
    showActiveTab();
    refreshConnection();
  }

  async function loadStatus() {
    try {
      const res = await fetchApi('/api/terminal/status');
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      enabled = !!body.enabled;
    } catch {
      enabled = true;
    }
    const tabBtn = $('chat-right-tab-terminal');
    const toolbarBtn = $('chat-right-panel-toggle');
    if (tabBtn) {
      tabBtn.disabled = !enabled;
      tabBtn.title = enabled
        ? 'SSH terminal (WebSocket)'
        : 'Terminal disabled on server';
    }
    if (toolbarBtn) {
      toolbarBtn.title = enabled
        ? 'Tools panel (Terminal or apps)'
        : 'Tools panel (apps; terminal disabled on server)';
    }
  }

  function readSavedTab() {
    try {
      const v = localStorage.getItem(PANEL_TAB_KEY);
      if (v === 'terminal' || v === 'apps') return v;
    } catch {
      /* ignore */
    }
    return 'terminal';
  }

  function bind() {
    $('chat-right-panel-toggle')?.addEventListener('click', () => {
      togglePanel();
    });
    $('chat-right-panel-collapse')?.addEventListener('click', () => setPanelOpen(false));
    $('chat-right-tab-terminal')?.addEventListener('click', () => {
      if (!enabled) return;
      setActiveTab('terminal');
      if (!panelOpen()) setPanelOpen(true);
    });
    $('chat-right-tab-apps')?.addEventListener('click', () => {
      setActiveTab('apps');
      if (!panelOpen()) setPanelOpen(true);
    });
    $('chat-terminal-reconnect')?.addEventListener('click', () => connect());
    $('chat-apps-select')?.addEventListener('change', event => {
      showAppFrame(event.target.value);
    });
    $('chat-apps-reload')?.addEventListener('click', () => {
      loadApps(true).catch(err => {
        appsLoaded = false;
        setAppsMessage(`Could not load apps: ${err.message}`, true);
      });
    });
  }

  async function init() {
    await loadStatus();
    initPanelWidth();
    bindPanelResize();
    bindPanelWidthObserver();
    bind();
    let tab = readSavedTab();
    if (tab === 'terminal' && !enabled) tab = 'apps';
    setActiveTab(tab);
    setPanelOpen(resolvePanelOpen());
    if (panelOpen() && activeTab === 'terminal') ensureTerm();
  }

  window.ChatTerminal = {
    init,
    setPanelOpen,
    togglePanel,
    fit: scheduleFit,
    get panelOpen() {
      return panelOpen();
    },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void init());
  } else {
    void init();
  }
})();
