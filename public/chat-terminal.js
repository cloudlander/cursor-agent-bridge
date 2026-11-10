(() => {
  'use strict';

  const PANEL_OPEN_KEY = 'cursor-bridge-chat-right-panel';
  const PANEL_WIDTH_KEY = 'cursor-bridge-chat-right-panel-width';
  const PANEL_TAB_KEY = 'cursor-bridge-chat-right-panel-tab';
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
      fitAddon?.fit();
      sendResize();
      term.focus();
    });

    socket.addEventListener('message', ev => {
      if (!term) return;
      let data = ev.data;
      if (data instanceof ArrayBuffer) data = new Uint8Array(data);
      term.write(data);
    });

    socket.addEventListener('close', () => {
      setStatus('Disconnected', 'warn');
      socket = null;
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
    const ro = new ResizeObserver(() => {
      if (!panelOpen()) return;
      fitAddon?.fit();
      sendResize();
    });
    ro.observe(host);
    window.addEventListener('resize', () => {
      if (!shouldConnect()) return;
      fitAddon?.fit();
      sendResize();
    });
  }

  function refreshConnection() {
    if (shouldConnect()) {
      ensureTerm();
      requestAnimationFrame(() => {
        fitAddon?.fit();
        sendResize();
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
    if (panelOpen()) {
      fitAddon?.fit();
      sendResize();
    }
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
      if (panelOpen()) {
        fitAddon?.fit();
        sendResize();
      }
    });
    ro.observe(shell);
    window.addEventListener('resize', () => {
      applyPanelWidth(readPanelWidth());
      if (panelOpen()) {
        fitAddon?.fit();
        sendResize();
      }
    });
  }

  function setActiveTab(tab) {
    activeTab = tab === 'terminal' ? 'terminal' : 'terminal';
    const tabBtn = $('chat-right-tab-terminal');
    tabBtn?.classList.toggle('active', activeTab === 'terminal');
    tabBtn?.setAttribute('aria-selected', activeTab === 'terminal' ? 'true' : 'false');
    try {
      localStorage.setItem(PANEL_TAB_KEY, activeTab);
    } catch {
      /* ignore */
    }
    refreshConnection();
  }

  async function loadStatus() {
    try {
      const fetchFn =
        typeof apiFetch === 'function'
          ? apiFetch
          : (p, init) => fetch(typeof bridgePath === 'function' ? bridgePath(p) : p, init);
      const res = await fetchFn('/api/terminal/status');
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
      toolbarBtn.disabled = !enabled;
      toolbarBtn.title = enabled ? 'Terminal panel' : 'Terminal disabled on server';
    }
  }

  function readSavedTab() {
    try {
      const v = localStorage.getItem(PANEL_TAB_KEY);
      if (v === 'terminal') return v;
    } catch {
      /* ignore */
    }
    return 'terminal';
  }

  function bind() {
    $('chat-right-panel-toggle')?.addEventListener('click', () => {
      if (!enabled) return;
      togglePanel();
    });
    $('chat-right-panel-collapse')?.addEventListener('click', () => setPanelOpen(false));
    $('chat-right-tab-terminal')?.addEventListener('click', () => {
      if (!enabled) return;
      setActiveTab('terminal');
      if (!panelOpen()) setPanelOpen(true);
    });
    $('chat-terminal-reconnect')?.addEventListener('click', () => connect());
  }

  async function init() {
    await loadStatus();
    initPanelWidth();
    bindPanelResize();
    bindPanelWidthObserver();
    bind();
    setActiveTab(readSavedTab());
    setPanelOpen(resolvePanelOpen());
    if (panelOpen()) ensureTerm();
  }

  window.ChatTerminal = {
    init,
    setPanelOpen,
    togglePanel,
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
