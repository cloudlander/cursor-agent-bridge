(() => {
  'use strict';

  const THREADS_KEY = 'cursor-bridge-chat-threads';
  const ACTIVE_KEY = 'cursor-bridge-chat-active';
  const THEME_KEY = 'cursor-bridge-chat-theme';
  const SIDEBAR_KEY = 'cursor-bridge-chat-sidebar';
  const MIGRATED_KEY = 'cursor-bridge-chat-migrated';

  const SOURCE_LABELS = {
    web: 'Web',
    api: 'API',
    cli: 'CLI',
    acp: 'ACP',
  };

  const STARTER_PROMPTS = [
    { icon: '🧭', text: 'Summarize the project structure and main entry points.' },
    { icon: '🐞', text: 'Find bugs or risky patterns in the codebase.' },
    { icon: '📖', text: 'Explain how cursor-api-proxy routes agent requests.' },
    { icon: '🧪', text: 'Suggest tests that are missing and sketch them.' },
  ];

  /** Poll interval for multi-endpoint session sync (API / CLI / ACP / other tabs). */
  const SESSION_SYNC_MS = 4000;

  const state = {
    config: null,
    models: [],
    /** Editable web threads only (persisted on server). */
    threads: [],
    /** Sidebar entries: web + api + cli + acp (from server catalog). */
    sessionCatalog: [],
    activeId: null,
    /** threadId -> AbortController */
    streams: new Map(),
    searchQuery: '',
    stickToBottom: true,
    paintScheduled: false,
    editingIdx: null,
    threadsLoaded: false,
    persistTimer: null,
    /** Web thread ids with local metadata edits to push (not full history sync). */
    dirtyThreadIds: new Set(),
    dirtyActiveId: false,
    loadingSessionId: null,
    /** Pending uploads before send: { name, mimeType, path, url, previewUrl? } */
    pendingAttachments: [],
    /** Background poll handle for cross-client session sync. */
    sessionSyncTimer: null,
    sessionSyncBusy: false,
    /** threadId -> { updatedAt, messageCount } last seen from server/local. */
    sessionSnapshots: new Map(),
  };

  const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

  let markedReady = false;

  // ───────────────────────── helpers ─────────────────────────

  const $ = id => document.getElementById(id);

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children) {
      if (c == null) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return `t-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = el('textarea', { style: 'position:fixed;opacity:0' });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { /* ignore */ }
      ta.remove();
      return ok;
    }
  }

  function flash(btn, label = 'Copied') {
    const prev = btn.textContent;
    btn.textContent = label;
    setTimeout(() => { btn.textContent = prev; }, 1400);
  }

  function toast(msg) {
    const t = el('div', { class: 'chat-toast' }, msg);
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 250);
    }, 2200);
  }

  // ───────────────────────── markdown ─────────────────────────

  /** Map agent filesystem paths to the proxy file endpoint. */
  function toWorkspaceFileUrl(raw) {
    const p = String(raw || '').trim();
    if (!p || /^https?:\/\//i.test(p) || p.startsWith('/api/workspace-file')) return p;
    if (/^data:image\//i.test(p)) return p;
    let path = p;
    if (path.startsWith('file://')) {
      try {
        path = decodeURIComponent(path.slice('file://'.length));
      } catch {
        return p;
      }
    }
    if (path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path)) {
      return `/api/workspace-file?path=${encodeURIComponent(path)}`;
    }
    return p;
  }

  function rewriteLocalPathsInMarkdown(text) {
    return String(text || '').replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (match, alt, url) => {
      const next = toWorkspaceFileUrl(url);
      return next === url ? match : `![${alt}](${next})`;
    });
  }

  function highlightCode(text, lang) {
    if (typeof hljs === 'undefined') return escapeHtml(text);
    try {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(text, { language: lang }).value;
      }
      return hljs.highlightAuto(text).value;
    } catch {
      return escapeHtml(text);
    }
  }

  function initMarked() {
    if (markedReady || typeof marked === 'undefined') return;
    marked.setOptions({ gfm: true, breaks: true });
    marked.use({
      renderer: {
        // marked v12 calls code(code, infostring, escaped) — not { text, lang }.
        code(code, infostring) {
          const text =
            typeof code === 'string'
              ? code
              : typeof code?.text === 'string'
                ? code.text
                : '';
          const lang =
            typeof code === 'object' && code != null && code.lang != null
              ? code.lang
              : infostring;
          const language = (lang || '').split(/\s+/)[0];
          const inner = highlightCode(text, language);
          return (
            `<div class="chat-code-block">` +
            `<div class="chat-code-head">` +
            `<span class="chat-code-lang mono">${escapeHtml(language || 'text')}</span>` +
            `<button type="button" class="chat-code-copy" data-copy="1">Copy</button>` +
            `</div>` +
            `<pre><code class="hljs language-${escapeHtml(language || 'plaintext')}">${inner}</code></pre>` +
            `</div>`
          );
        },
        image(href, title, text) {
          const src = toWorkspaceFileUrl(href);
          const alt = escapeHtml(text || '');
          const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
          return `<img src="${escapeHtml(src)}" alt="${alt}"${titleAttr}>`;
        },
      },
    });
    markedReady = true;
  }

  const BLOCKED_TAGS = 'script,style,iframe,object,embed,link,meta,form,base,frame,frameset';

  /** Strip active content from rendered markdown (model output is untrusted). */
  function sanitizeHtml(html) {
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    doc.body.querySelectorAll(BLOCKED_TAGS).forEach(n => n.remove());
    doc.body.querySelectorAll('*').forEach(n => {
      for (const attr of [...n.attributes]) {
        const name = attr.name.toLowerCase();
        const val = attr.value.trim().toLowerCase();
        if (name.startsWith('on') || name === 'srcdoc' || name === 'style') {
          n.removeAttribute(attr.name);
        } else if (['href', 'src', 'xlink:href', 'action'].includes(name)) {
          const safeData = n.tagName === 'IMG' && /^data:image\/(png|jpe?g|gif|webp);/.test(val);
          if (/^(javascript|vbscript|data):/.test(val) && !safeData) n.removeAttribute(attr.name);
        }
      }
      if (n.tagName === 'A') {
        n.setAttribute('target', '_blank');
        n.setAttribute('rel', 'noopener noreferrer');
      }
      if (n.tagName === 'IMG' && n.hasAttribute('src')) {
        const next = toWorkspaceFileUrl(n.getAttribute('src'));
        if (next !== n.getAttribute('src')) n.setAttribute('src', next);
      }
    });
    return doc.body.innerHTML;
  }

  function renderMarkdown(text) {
    initMarked();
    const normalized = rewriteLocalPathsInMarkdown(text || '');
    if (markedReady && marked.parse) {
      try {
        return sanitizeHtml(marked.parse(normalized));
      } catch {
        /* fall through */
      }
    }
    return escapeHtml(normalized).replace(/\n/g, '<br>');
  }

  function wireCopyButtons(root) {
    root.querySelectorAll('.chat-code-copy[data-copy]').forEach(btn => {
      if (btn.dataset.wired) return;
      btn.dataset.wired = '1';
      btn.addEventListener('click', async () => {
        const code = btn.closest('.chat-code-block')?.querySelector('code');
        const ok = await copyText(code?.textContent ?? '');
        flash(btn, ok ? 'Copied' : 'Failed');
      });
    });
  }

  // ───────────────────────── threads ─────────────────────────

  function activeThread() {
    return state.threads.find(t => t.id === state.activeId) ?? null;
  }

  function isBusy(thread = activeThread()) {
    return !!thread && state.streams.has(thread.id);
  }

  function finalizeInterruptedMessages(threads, activeGenerationIds = new Set()) {
    for (const t of threads) {
      if (activeGenerationIds.has(t.id)) continue;
      for (const m of t.messages || []) {
        if (m.streaming) {
          m.streaming = false;
          if (!m.content) m.content = '(interrupted)';
        }
      }
    }
  }

  /** Reconnect races can mark a successful reply with errorDetail "not_found". */
  function isBenignGenerationError(detail) {
    return String(detail || '').trim() === 'not_found';
  }

  function sanitizeAssistantMessage(m) {
    if (m?.role !== 'assistant') return false;
    const detail = (m.errorDetail || '').trim();
    if (m.error && isBenignGenerationError(detail) && m.content?.trim()) {
      m.error = false;
      delete m.errorDetail;
      return true;
    }
    return false;
  }

  function sanitizeThreadMessages(thread) {
    let changed = false;
    for (const m of thread?.messages || []) {
      if (sanitizeAssistantMessage(m)) changed = true;
    }
    return changed;
  }

  async function fetchActiveGenerations() {
    try {
      const r = await fetch('/api/chat/generations');
      if (!r.ok) return [];
      const data = await r.json();
      return Array.isArray(data.active) ? data.active : [];
    } catch {
      return [];
    }
  }

  function catalogEntry(id) {
    return state.sessionCatalog.find(s => s.id === id) ?? null;
  }

  function isReadOnlySession(id = state.activeId) {
    const entry = catalogEntry(id);
    return !!entry && entry.readOnly;
  }

  function activeSessionMeta() {
    return catalogEntry(state.activeId);
  }

  async function migrateLocalThreadsIfNeeded() {
    try {
      if (localStorage.getItem(MIGRATED_KEY)) return;
      const raw = localStorage.getItem(THREADS_KEY);
      if (!raw) {
        localStorage.setItem(MIGRATED_KEY, '1');
        return;
      }
      const threads = JSON.parse(raw);
      if (!Array.isArray(threads) || !threads.length) {
        localStorage.setItem(MIGRATED_KEY, '1');
        return;
      }
      const r = await fetch('/api/chat/migrate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ threads }),
      });
      if (r.ok) {
        const data = await r.json();
        if (data.merged > 0) toast(`Imported ${data.merged} chat(s) from this browser`);
      }
      localStorage.setItem(MIGRATED_KEY, '1');
    } catch {
      /* ignore migration errors */
    }
  }

  async function loadThreads() {
    try {
      await migrateLocalThreadsIfNeeded();
      const [threadsRes, activeGens] = await Promise.all([
        fetch('/api/chat/threads'),
        fetchActiveGenerations(),
      ]);
      if (!threadsRes.ok) throw new Error(String(threadsRes.status));
      const data = await threadsRes.json();
      state.sessionCatalog = Array.isArray(data.sessions) ? data.sessions : [];
      state.threads = Array.isArray(data.threads)
        ? data.threads.map(t => ({
          ...t,
          source: 'web',
          title: t.title || null,
          model: t.model || '',
          mode: t.mode || '',
          messages: Array.isArray(t.messages) ? t.messages : [],
        }))
        : [];
      state.threads.forEach(sanitizeThreadMessages);
      const activeIds = new Set(activeGens.map(g => g.threadId));
      finalizeInterruptedMessages(state.threads, activeIds);
      for (const gen of activeGens) {
        applyGenerationSnapshot(gen);
      }
      state.activeId = data.activeId || state.threads[0]?.id || state.sessionCatalog[0]?.id || null;
      state.threadsLoaded = true;
      for (const t of state.threads) updateSessionSnapshot(t.id);
      if (state.activeId) updateSessionSnapshot(state.activeId);
      return activeGens;
    } catch {
      state.sessionCatalog = [];
      state.threads = [];
      state.activeId = null;
      state.threadsLoaded = true;
      toast('Could not load chats from server');
      return [];
    }
  }

  function applyGenerationSnapshot(gen) {
    const thread = state.threads.find(t => t.id === gen.threadId);
    if (!thread) return;
    let msg = thread.messages[thread.messages.length - 1];
    if (!msg || msg.role !== 'assistant') {
      msg = { role: 'assistant', content: '', streaming: true };
      thread.messages.push(msg);
    }
    msg.content = gen.content || msg.content || '';
    if (gen.reasoning) msg.reasoning = gen.reasoning;
    msg.streaming = gen.status === 'running';
    if (gen.status === 'error') {
      msg.error = true;
      if (gen.error) msg.errorDetail = gen.error;
      if (!msg.content?.trim()) msg.content = gen.error || 'Generation failed';
    }
  }

  function markThreadDirty(id) {
    if (!id || isReadOnlySession(id)) return;
    state.dirtyThreadIds.add(id);
    schedulePersistThreads();
  }

  function markActiveIdDirty() {
    state.dirtyActiveId = true;
    schedulePersistThreads();
  }

  function schedulePersistThreads() {
    if (state.persistTimer) clearTimeout(state.persistTimer);
    state.persistTimer = setTimeout(() => {
      state.persistTimer = null;
      void persistThreads();
    }, 400);
  }

  /** Push only UI metadata / active selection — message bodies come from server + agent chat. */
  async function persistThreads() {
    const threads = state.threads
      .filter(t => !t.readOnly && state.dirtyThreadIds.has(t.id))
      .map(t => ({ ...t, source: 'web' }));
    if (!threads.length && !state.dirtyActiveId) return;
    try {
      const body = { threads };
      if (state.dirtyActiveId) body.activeId = state.activeId;
      await fetch('/api/chat/threads', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      for (const t of threads) state.dirtyThreadIds.delete(t.id);
      state.dirtyActiveId = false;
    } catch {
      toast('Failed to save chat to server');
    }
  }

  async function refreshSessionCatalog() {
    try {
      const r = await fetch('/api/chat/threads');
      if (!r.ok) return;
      const data = await r.json();
      state.sessionCatalog = Array.isArray(data.sessions) ? data.sessions : [];
      if (data.activeId) state.activeId = data.activeId;
      renderThreadList();
    } catch {
      /* ignore */
    }
  }

  function mergeServerWebThread(serverThread) {
    if (!serverThread?.id || state.streams.has(serverThread.id)) return false;
    const idx = state.threads.findIndex(t => t.id === serverThread.id);
    const entry = catalogEntry(serverThread.id);
    const local = idx >= 0 ? state.threads[idx] : null;
    if (local && (local.updatedAt ?? 0) > (serverThread.updatedAt ?? 0)) return false;

    const merged = {
      ...serverThread,
      source: 'web',
      readOnly: false,
      messages: Array.isArray(serverThread.messages) ? serverThread.messages : [],
    };
    if (idx >= 0) state.threads[idx] = merged;
    else state.threads.push(merged);
    sanitizeThreadMessages(merged);

    if (entry) {
      entry.updatedAt = merged.updatedAt;
      entry.messageCount = countStableMessages(merged.messages);
      const title = merged.title || threadTitle(merged);
      if (title) entry.title = title;
    }
    return true;
  }

  function mergeServerWebThreads(serverThreads) {
    let changed = false;
    for (const t of serverThreads || []) {
      if (mergeServerWebThread(t)) changed = true;
    }
    return changed;
  }

  async function fetchAndApplySession(id) {
    const entry = catalogEntry(id);
    try {
      const r = await fetch(`/api/chat/threads/${encodeURIComponent(id)}`);
      if (!r.ok) return false;
      const body = await r.json();
      const session = body.session;
      if (!session) return false;

      const messages = session.messages || [];
      const thread = {
        id,
        source: entry?.source || session.source || 'web',
        title: entry?.title || session.title || null,
        pinned: entry?.pinned ?? session.pinned ?? false,
        createdAt: entry?.createdAt ?? session.createdAt ?? Date.now(),
        updatedAt: session.updatedAt ?? entry?.updatedAt ?? Date.now(),
        model: entry?.model ?? session.model ?? '',
        mode: entry?.mode ?? session.mode ?? '',
        messages,
        readOnly: entry?.readOnly ?? session.readOnly ?? true,
      };

      const idx = state.threads.findIndex(t => t.id === id);
      if (idx >= 0) state.threads[idx] = thread;
      else state.threads.push(thread);

      if (entry) {
        entry.updatedAt = thread.updatedAt;
        entry.messageCount = countStableMessages(messages);
        if (session.title) entry.title = session.title;
      }
      updateSessionSnapshot(id);
      return true;
    } catch {
      return false;
    }
  }

  async function syncActiveSession(data) {
    const id = state.activeId;
    if (!id || state.streams.has(id) || state.editingIdx != null || state.persistTimer) return;

    const entry = (data.sessions || []).find(s => s.id === id) ?? catalogEntry(id);
    const serverThread = (data.threads || []).find(t => t.id === id);
    const local = state.threads.find(t => t.id === id);
    const snap = state.sessionSnapshots.get(id);

    const serverUpdatedAt = Math.max(serverThread?.updatedAt ?? 0, entry?.updatedAt ?? 0);
    const serverMsgCount = serverThread
      ? countStableMessages(serverThread.messages)
      : (entry?.messageCount ?? 0);

    const localUpdatedAt = Math.max(snap?.updatedAt ?? 0, local?.updatedAt ?? 0);
    const localMsgCount = snap?.messageCount ?? countStableMessages(local?.messages);

    const stale =
      serverUpdatedAt > localUpdatedAt ||
      (serverUpdatedAt === localUpdatedAt && serverMsgCount !== localMsgCount);
    if (!stale) return;

    let changed = false;
    if (serverThread && !entry?.readOnly) {
      changed = mergeServerWebThread(serverThread);
    } else if (entry?.readOnly || !serverThread) {
      changed = await fetchAndApplySession(id);
    } else if (serverThread) {
      changed = mergeServerWebThread(serverThread);
    }

    if (changed) {
      updateSessionSnapshot(id);
      renderMessages();
      renderToolbar();
    }
  }

  async function pollSessionUpdates() {
    if (state.sessionSyncBusy || document.hidden) return;
    state.sessionSyncBusy = true;
    try {
      const prevCatalog = state.sessionCatalog;
      const [threadsRes, activeGens] = await Promise.all([
        fetch('/api/chat/threads'),
        fetchActiveGenerations(),
      ]);
      if (!threadsRes.ok) return;
      const data = await threadsRes.json();

      const nextCatalog = Array.isArray(data.sessions) ? data.sessions : [];
      const catalogChanged = sessionCatalogDiffers(prevCatalog, nextCatalog);
      state.sessionCatalog = nextCatalog;
      const threadsChanged = mergeServerWebThreads(data.threads || []);

      if (catalogChanged || threadsChanged) renderThreadList();
      await syncActiveSession(data);
      await reconnectActiveGenerations(activeGens);
    } catch {
      /* ignore transient poll errors */
    } finally {
      state.sessionSyncBusy = false;
    }
  }

  function onSessionSyncVisibility() {
    if (!document.hidden) void pollSessionUpdates();
  }

  function startSessionSync() {
    if (state.sessionSyncTimer) return;
    state.sessionSyncTimer = setInterval(() => void pollSessionUpdates(), SESSION_SYNC_MS);
    document.addEventListener('visibilitychange', onSessionSyncVisibility);
  }

  function stopSessionSync() {
    if (state.sessionSyncTimer) {
      clearInterval(state.sessionSyncTimer);
      state.sessionSyncTimer = null;
    }
    document.removeEventListener('visibilitychange', onSessionSyncVisibility);
  }

  async function ensureExternalSessionLoaded(id) {
    const entry = catalogEntry(id);
    if (!entry?.readOnly) return;
    if (state.loadingSessionId === id) return;
    const existing = state.threads.find(t => t.id === id);
    if (existing?.messages?.length) return;
    state.loadingSessionId = id;
    try {
      const r = await fetch(`/api/chat/threads/${encodeURIComponent(id)}`);
      if (!r.ok) throw new Error(String(r.status));
      const body = await r.json();
      const session = body.session;
      const messages = session?.messages || [];
      const thread = {
        id,
        source: entry.source,
        title: entry.title,
        pinned: false,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        model: entry.model || '',
        mode: entry.mode || '',
        messages,
        readOnly: true,
      };
      const idx = state.threads.findIndex(t => t.id === id);
      if (idx >= 0) state.threads[idx] = thread;
      else state.threads.push(thread);
      updateSessionSnapshot(id);
      if (state.activeId === id) renderMessages();
    } catch {
      toast('Could not load session messages');
    } finally {
      state.loadingSessionId = null;
    }
  }

  function createThread() {
    const now = Date.now();
    const thread = {
      id: uuid(),
      source: 'web',
      title: null,
      pinned: false,
      createdAt: now,
      updatedAt: now,
      model: '',
      mode: '',
      messages: [],
    };
    state.threads.unshift(thread);
    state.sessionCatalog.unshift({
      id: thread.id,
      source: 'web',
      title: 'New chat',
      pinned: false,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      readOnly: false,
    });
    return thread;
  }

  function ensureActiveThread() {
    if (activeThread()) return activeThread();
    // Reuse an existing empty web thread instead of piling up blanks.
    const blank = state.threads.find(t => !t.readOnly && !t.messages.length);
    const t = blank ?? createThread();
    state.activeId = t.id;
    markThreadDirty(t.id);
    markActiveIdDirty();
    return t;
  }

  function threadTitle(threadOrId) {
    const thread = typeof threadOrId === 'string'
      ? state.threads.find(t => t.id === threadOrId)
      : threadOrId;
    const entry = typeof threadOrId === 'string' ? catalogEntry(threadOrId) : catalogEntry(thread?.id);
    if (thread?.title) return thread.title;
    if (entry?.title) return entry.title;
    const first = thread?.messages?.find(m => m.role === 'user');
    if (first?.content?.trim()) {
      const t = first.content.trim().replace(/\s+/g, ' ');
      return t.length > 48 ? `${t.slice(0, 48)}…` : t;
    }
    const att = first?.attachments?.[0]?.name;
    if (att) return att.length > 48 ? `${att.slice(0, 48)}…` : att;
    return 'New chat';
  }

  function threadMatchesSearch(entry, q) {
    if (!q) return true;
    const needle = q.toLowerCase();
    const title = threadTitle(entry.id);
    if (title.toLowerCase().includes(needle)) return true;
    const thread = state.threads.find(t => t.id === entry.id);
    return thread?.messages?.some(
      m => typeof m.content === 'string' && m.content.toLowerCase().includes(needle),
    );
  }

  function selectThread(id) {
    state.activeId = id;
    state.stickToBottom = true;
    state.editingIdx = null;
    markActiveIdDirty();
    renderAll();
    void ensureExternalSessionLoaded(id).then(() => updateSessionSnapshot(id));
    if (window.matchMedia('(max-width: 768px)').matches) setSidebar(false);
  }

  function newChat() {
    state.editingIdx = null;
    const t = createThread();
    state.activeId = t.id;
    state.stickToBottom = true;
    markThreadDirty(t.id);
    markActiveIdDirty();
    renderAll();
    $('chat-input')?.focus();
    if (window.matchMedia('(max-width: 768px)').matches) setSidebar(false);
  }

  async function deleteThread(id) {
    const entry = catalogEntry(id);
    if (entry?.readOnly) {
      toast('External sessions are read-only');
      return;
    }
    const t = state.threads.find(x => x.id === id);
    if (!t) return;
    if (t.messages.length && !confirm(`Delete "${threadTitle(t)}"?`)) return;
    state.streams.get(id)?.abort();
    state.threads = state.threads.filter(x => x.id !== id);
    state.sessionCatalog = state.sessionCatalog.filter(x => x.id !== id);
    if (state.activeId === id) {
      state.activeId = state.sessionCatalog[0]?.id ?? null;
      if (!state.activeId) ensureActiveThread();
    }
    try {
      await fetch(`/api/chat/threads/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch {
      toast('Failed to delete on server');
    }
    markActiveIdDirty();
    renderAll();
  }

  async function clearAllThreads() {
    const webWithMessages = state.threads.filter(t => !t.readOnly && t.messages.length);
    if (!webWithMessages.length) return;
    if (!confirm('Delete all web chats? External sessions stay on the server.')) return;
    for (const ac of state.streams.values()) ac.abort();
    for (const t of webWithMessages) {
      try {
        await fetch(`/api/chat/threads/${encodeURIComponent(t.id)}`, { method: 'DELETE' });
      } catch { /* ignore */ }
    }
    state.threads = state.threads.filter(t => t.readOnly);
    state.sessionCatalog = state.sessionCatalog.filter(s => s.readOnly);
    state.activeId = state.sessionCatalog[0]?.id ?? null;
    if (!state.activeId) ensureActiveThread();
    markActiveIdDirty();
    renderAll();
  }

  function togglePin(id) {
    if (isReadOnlySession(id)) return;
    const t = state.threads.find(x => x.id === id);
    if (!t) return;
    t.pinned = !t.pinned;
    const entry = catalogEntry(id);
    if (entry) entry.pinned = t.pinned;
    markThreadDirty(id);
    renderThreadList();
  }

  function startRename(id, titleNode) {
    const t = state.threads.find(x => x.id === id);
    if (!t) return;
    const input = el('input', {
      class: 'chat-thread-rename',
      type: 'text',
      value: threadTitle(t),
      maxlength: '100',
    });
    let done = false;
    const finish = save => {
      if (done) return;
      done = true;
      if (save) {
        const v = input.value.trim();
        t.title = v || null;
        const entry = catalogEntry(id);
        if (entry) entry.title = t.title || threadTitle(t);
        markThreadDirty(id);
      }
      renderThreadList();
      renderToolbar();
    };
    input.addEventListener('click', e => e.stopPropagation());
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    titleNode.replaceWith(input);
    input.focus();
    input.select();
  }

  function dayBucket(ts) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const day = 86400000;
    const diff = start.getTime() - ts;
    if (ts >= start.getTime()) return 'Today';
    if (diff <= day) return 'Yesterday';
    if (diff <= 7 * day) return 'Previous 7 days';
    if (diff <= 30 * day) return 'Previous 30 days';
    return 'Older';
  }

  function renderThreadList() {
    const list = $('chat-thread-list');
    if (!list) return;
    const q = state.searchQuery.trim();
    const activityAt = s => s.updatedAt ?? s.createdAt ?? 0;
    const filtered = state.sessionCatalog
      .filter(s => s.messageCount > 0 && threadMatchesSearch(s, q))
      .sort((a, b) => activityAt(b) - activityAt(a));

    if (!filtered.length) {
      list.replaceChildren(
        el('li', { class: 'chat-thread-empty muted-text' }, q ? 'No matching chats' : 'No chats yet'),
      );
      return;
    }

    const groups = new Map();
    const push = (label, s) => {
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(s);
    };
    for (const s of filtered) push(s.pinned ? 'Pinned' : dayBucket(activityAt(s)), s);
    const order = ['Pinned', 'Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days', 'Older'];

    const nodes = [];
    for (const label of order) {
      const items = groups.get(label);
      if (!items) continue;
      nodes.push(el('li', { class: 'chat-sidebar-label' }, label));
      for (const s of items) nodes.push(buildThreadItem(s));
    }
    list.replaceChildren(...nodes);
  }

  function buildThreadItem(s) {
    const title = el('span', { class: 'chat-thread-item-title' }, threadTitle(s.id));
    const busy = state.streams.has(s.id);
    const readOnly = !!s.readOnly;
    const sourceBadge = el('span', {
      class: `chat-thread-source chat-thread-source-${s.source}`,
      title: readOnly ? 'Read-only session from server' : 'Editable web chat',
    }, SOURCE_LABELS[s.source] || s.source);
    const item = el('li', {
      class: `chat-thread-item${s.id === state.activeId ? ' active' : ''}${readOnly ? ' readonly' : ''}`,
      onclick: () => selectThread(s.id),
    },
      busy ? el('span', { class: 'chat-thread-busy', title: 'Generating…' }) : null,
      sourceBadge,
      title,
      readOnly ? null : el('span', { class: 'chat-thread-actions' },
        el('button', {
          type: 'button',
          class: 'chat-thread-btn',
          title: s.pinned ? 'Unpin' : 'Pin',
          onclick: e => { e.stopPropagation(); togglePin(s.id); },
        }, s.pinned ? '★' : '☆'),
        el('button', {
          type: 'button',
          class: 'chat-thread-btn',
          title: 'Rename',
          onclick: e => { e.stopPropagation(); startRename(s.id, title); },
        }, '✎'),
        el('button', {
          type: 'button',
          class: 'chat-thread-btn danger',
          title: 'Delete',
          onclick: e => { e.stopPropagation(); void deleteThread(s.id); },
        }, '×'),
      ),
    );
    if (!readOnly) {
      title.addEventListener('dblclick', e => { e.stopPropagation(); startRename(s.id, title); });
    }
    return item;
  }

  // ───────────────────────── messages UI ─────────────────────────

  function messagesWrap() {
    return $('chat-messages-wrap');
  }

  function isNearBottom(wrap, threshold = 80) {
    if (!wrap) return true;
    return wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < threshold;
  }

  function scrollToBottom(smooth = false) {
    const wrap = messagesWrap();
    if (!wrap) return;
    wrap.scrollTo({ top: wrap.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
    updateScrollButton();
  }

  function updateScrollButton() {
    const btn = $('chat-scroll-bottom');
    const wrap = messagesWrap();
    if (!btn || !wrap) return;
    btn.classList.toggle('hidden', isNearBottom(wrap, 120));
  }

  function buildWelcome() {
    const cfg = state.config || {};
    return el('div', { class: 'chat-welcome' },
      el('div', { class: 'chat-welcome-logo' }, '✦'),
      el('h2', {}, 'How can I help?'),
      el('p', { class: 'muted-text' },
        `Talking directly to the Cursor agent on this proxy${cfg.defaultModel ? ` · ${cfg.defaultModel}` : ''}. No API key needed.`,
      ),
      el('div', { class: 'chat-suggestions' },
        ...STARTER_PROMPTS.map(p =>
          el('button', {
            type: 'button',
            class: 'chat-suggestion',
            onclick: () => void submitUserMessage(p.text),
          }, el('span', { class: 'chat-suggestion-icon' }, p.icon), p.text),
        ),
      ),
    );
  }

  function buildReasoning(m) {
    if (!m.reasoning) return null;
    const d = el('details', { class: 'chat-think' },
      el('summary', {}, m.streaming && !m.content ? 'Thinking…' : 'Thought process'),
      el('div', { class: 'chat-think-body' }, m.reasoning),
    );
    if (m.streaming && !m.content) d.open = true;
    return d;
  }

  function assistantErrorNotice(m) {
    if (!m.error) return null;
    const detail = (m.errorDetail || '').trim();
    if (isBenignGenerationError(detail) && m.content?.trim()) return null;
    const text = detail
      || (m.content?.trim()
        ? 'The agent run did not finish successfully — the reply below may be incomplete.'
        : 'Generation failed.');
    return el('div', { class: 'chat-msg-notice error', role: 'status' }, text);
  }

  function buildEditBox(m, i) {
    const ta = el('textarea', { class: 'chat-edit-input', rows: '3' });
    ta.value = m.content;
    const autosize = () => {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(320, ta.scrollHeight)}px`;
    };
    ta.addEventListener('input', autosize);
    ta.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submitEdit(i, ta.value);
      } else if (e.key === 'Escape') {
        state.editingIdx = null;
        renderMessages();
      }
    });
    setTimeout(() => { autosize(); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);
    return el('div', { class: 'chat-edit' },
      ta,
      el('div', { class: 'chat-edit-actions' },
        el('button', {
          type: 'button',
          class: 'btn small',
          onclick: () => { state.editingIdx = null; renderMessages(); },
        }, 'Cancel'),
        el('button', {
          type: 'button',
          class: 'btn small primary',
          onclick: () => submitEdit(i, ta.value),
        }, 'Save & submit'),
      ),
    );
  }

  function actionBtn(label, title, onclick) {
    return el('button', { type: 'button', class: 'chat-msg-action', title, onclick }, label);
  }

  function buildMessageAttachments(attachments) {
    if (!attachments?.length) return null;
    return el('div', { class: 'chat-msg-attachments' },
      ...attachments.map(a => {
        if ((a.mimeType || '').startsWith('image/') && a.url) {
          return el('div', { class: 'chat-msg-attachment' },
            el('img', { src: a.url, alt: a.name || 'attachment', loading: 'lazy' }),
          );
        }
        return el('div', { class: 'chat-msg-attachment chat-msg-attachment-file' },
          `📎 ${a.name || 'file'}`,
        );
      }),
    );
  }

  function buildMessageRow(m, i, thread) {
    const isUser = m.role === 'user';
    const avatar = el('div', { class: 'chat-avatar' }, isUser ? 'You' : '✦');
    const bubble = el('div', { class: 'chat-bubble' });
    const editing = isUser && state.editingIdx === i;

    if (isUser) {
      if (m.content) bubble.textContent = m.content;
      const attRow = buildMessageAttachments(m.attachments);
      if (attRow) bubble.appendChild(attRow);
    } else if (m.error && !m.content?.trim()) {
      bubble.classList.add('error');
      bubble.textContent = m.errorDetail || m.content || 'Generation failed';
    } else if (m.streaming && !m.content) {
      bubble.innerHTML = '<span class="chat-typing"><i></i><i></i><i></i></span>';
    } else {
      bubble.innerHTML = renderMarkdown(m.content);
    }

    const busy = isBusy(thread);
    const actions = el('div', { class: 'chat-msg-actions' });
    if (isUser && !editing && !busy) {
      actions.appendChild(actionBtn('Edit', 'Edit and resend', () => {
        state.editingIdx = i;
        renderMessages();
      }));
    }
    if (m.content && !m.streaming) {
      actions.appendChild(actionBtn('Copy', 'Copy message', async e => {
        flash(e.currentTarget, (await copyText(m.content)) ? 'Copied' : 'Failed');
      }));
    }
    const isLast = i === thread.messages.length - 1;
    if (!isUser && isLast && !m.streaming && !busy) {
      actions.appendChild(actionBtn('Regenerate', 'Regenerate response', regenerateReply));
    }
    if (m.ts && !m.streaming) {
      const d = new Date(m.ts);
      actions.appendChild(el('span', { class: 'chat-msg-time', title: d.toLocaleString() },
        d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
    }

    const body = el('div', { class: 'chat-msg-body' },
      isUser ? null : buildReasoning(m),
      editing ? buildEditBox(m, i) : bubble,
      !isUser && !editing ? assistantErrorNotice(m) : null,
    );
    if (actions.childNodes.length && !editing) body.appendChild(actions);

    if (!isUser) wireCopyButtons(bubble);
    return el('article', {
      class: `chat-msg ${isUser ? 'user' : 'assistant'}${m.streaming ? ' streaming' : ''}`,
      'data-idx': String(i),
    }, avatar, body);
  }

  function renderMessages(opts = {}) {
    const container = $('chat-messages');
    const thread = activeThread();
    if (!container) return;

    if (!thread?.messages.length) {
      container.replaceChildren(buildWelcome());
      return;
    }

    // Fast path while streaming: only repaint the live bubble.
    if (opts.streamingPatch) {
      const i = thread.messages.length - 1;
      const last = thread.messages[i];
      const row = container.querySelector(`.chat-msg.assistant.streaming[data-idx="${i}"]`);
      if (last?.role === 'assistant' && last.streaming && row) {
        const bubble = row.querySelector('.chat-bubble');
        if (bubble) {
          if (last.content) {
            bubble.innerHTML = renderMarkdown(last.content);
            wireCopyButtons(bubble);
          }
          const think = row.querySelector('.chat-think');
          if (last.reasoning) {
            if (think) {
              think.querySelector('.chat-think-body').textContent = last.reasoning;
              const s = think.querySelector('summary');
              if (last.content && s) s.textContent = 'Thought process';
            } else {
              row.querySelector('.chat-msg-body').prepend(buildReasoning(last));
            }
          }
          if (state.stickToBottom) scrollToBottom();
          return;
        }
      }
    }

    container.replaceChildren(...thread.messages.map((m, i) => buildMessageRow(m, i, thread)));
    if (state.stickToBottom) scrollToBottom();
    updateScrollButton();
  }

  function renderModelOptions() {
    const sel = $('chat-model');
    if (!sel) return;
    const thread = activeThread();
    const cfg = state.config || {};
    const def = cfg.defaultModel || 'auto';
    const current = thread?.model || '';
    const ids = state.models.map(m => m.id);
    if (current && !ids.includes(current)) ids.unshift(current);
    sel.replaceChildren(
      el('option', { value: '' }, `Default (${def})`),
      ...ids.map(id => el('option', { value: id }, id)),
    );
    sel.value = current;
  }

  function renderToolbar() {
    const thread = activeThread();
    const titleEl = $('chat-title');
    if (titleEl) titleEl.textContent = thread ? threadTitle(thread) : 'New chat';

    const meta = $('chat-sidebar-meta');
    if (meta && state.config) {
      const c = state.config;
      meta.textContent = `${c.defaultModel || 'default'} · ${c.mode || 'agent'}`;
    }

    const modeSel = $('chat-mode');
    if (modeSel) modeSel.value = thread?.mode || state.config?.mode || 'agent';
    renderModelOptions();
    renderComposerState();
  }

  function renderComposerState() {
    const busy = isBusy();
    const readOnly = isReadOnlySession();
    const send = $('chat-send');
    const stop = $('chat-stop');
    send?.classList.toggle('hidden', busy || readOnly);
    stop?.classList.toggle('hidden', !busy);
    const input = $('chat-input');
    if (input) {
      input.disabled = readOnly;
      if (readOnly) {
        input.placeholder = 'Read-only session — start a new web chat to continue';
      } else {
        input.placeholder = busy
          ? 'Generating… (you can type your next message)'
          : 'Message the agent…';
      }
    }
    const hint = document.querySelector('.chat-hint');
    if (hint) {
      const meta = activeSessionMeta();
      hint.textContent = readOnly && meta
        ? `Read-only ${SOURCE_LABELS[meta.source] || meta.source} session on this proxy.`
        : 'Internal session on this proxy — no API key. Enter send · Shift+Enter newline · ↑ edit last · / focus';
    }
  }

  function renderAll() {
    renderThreadList();
    renderMessages();
    renderToolbar();
  }

  function schedulePaint() {
    if (state.paintScheduled) return;
    state.paintScheduled = true;
    requestAnimationFrame(() => {
      state.paintScheduled = false;
      renderMessages({ streamingPatch: true });
    });
  }

  // ───────────────────────── networking ─────────────────────────

  async function loadConfig() {
    try {
      const r = await fetch('/api/config');
      if (!r.ok) throw new Error(String(r.status));
      state.config = await r.json();
    } catch {
      state.config = { defaultModel: 'auto', mode: 'agent' };
    }
    renderToolbar();
    if (!activeThread()?.messages.length) renderMessages();
  }

  async function loadModels() {
    try {
      const r = await fetch('/api/agent/models');
      if (!r.ok) throw new Error(String(r.status));
      const data = await r.json();
      state.models = (data.data || []).filter(m => m && m.id);
    } catch {
      state.models = [];
    }
    renderModelOptions();
  }

  function messageHasPayload(m) {
    return !!(m.content?.trim?.() || m.attachments?.length);
  }

  function countStableMessages(messages) {
    return (messages || []).filter(m => !m.streaming && !m.error && messageHasPayload(m)).length;
  }

  function updateSessionSnapshot(id) {
    if (!id) return;
    const thread = state.threads.find(t => t.id === id);
    const entry = catalogEntry(id);
    state.sessionSnapshots.set(id, {
      updatedAt: Math.max(thread?.updatedAt ?? 0, entry?.updatedAt ?? 0),
      messageCount: thread
        ? countStableMessages(thread.messages)
        : (entry?.messageCount ?? 0),
    });
  }

  function sessionCatalogDiffers(prev, next) {
    if (!Array.isArray(prev) || !Array.isArray(next)) return true;
    if (prev.length !== next.length) return true;
    const prevMap = new Map(prev.map(s => [s.id, s]));
    for (const s of next) {
      const p = prevMap.get(s.id);
      if (!p) return true;
      if (p.updatedAt !== s.updatedAt || p.messageCount !== s.messageCount) return true;
    }
    return false;
  }

  function mapMessageForApi(m) {
    const base = { role: m.role };
    const attachments = Array.isArray(m.attachments) ? m.attachments : [];
    if (!attachments.length) {
      return { ...base, content: m.content };
    }
    const parts = [];
    if (m.content?.trim()) parts.push({ type: 'text', text: m.content });
    for (const a of attachments) {
      if ((a.mimeType || '').startsWith('image/') && a.url) {
        parts.push({ type: 'image_url', image_url: { url: a.url } });
      }
    }
    const payload = {
      ...base,
      attachments: attachments.map(a => ({
        name: a.name,
        mimeType: a.mimeType,
        path: a.path,
        size: a.size,
      })),
    };
    if (parts.length === 1 && parts[0].type === 'text') payload.content = parts[0].text;
    else if (parts.length) payload.content = parts;
    else payload.content = m.content || '';
    return payload;
  }

  function buildPayload(thread) {
    const cfg = state.config || {};
    return {
      threadId: thread.id,
      model: thread.model || cfg.defaultModel,
      mode: thread.mode || cfg.mode || 'agent',
      stream: true,
      messages: thread.messages
        .filter(m => !m.streaming && !m.error && messageHasPayload(m))
        .map(mapMessageForApi),
    };
  }

  function touch(thread) {
    thread.updatedAt = Date.now();
    const entry = catalogEntry(thread.id);
    if (entry) {
      entry.updatedAt = thread.updatedAt;
      entry.messageCount = thread.messages.filter(m => !m.streaming && messageHasPayload(m)).length;
      if (!entry.title || entry.title === 'New chat') {
        const first = thread.messages.find(m => m.role === 'user');
        if (first?.content) entry.title = threadTitle(thread);
      }
    }
    updateSessionSnapshot(thread.id);
  }

  function repaint(thread, streaming) {
    if (thread.id !== state.activeId) {
      renderThreadList();
      return;
    }
    if (streaming) schedulePaint();
    else renderMessages();
  }

  function applyGenerationEvent(msg, event) {
    if (event.type === 'snapshot') {
      msg.content = event.content || '';
      if (event.reasoning) msg.reasoning = event.reasoning;
      msg.streaming = event.status === 'running';
      if (event.status === 'error') {
        msg.error = true;
        if (event.error) msg.errorDetail = event.error;
        if (!msg.content?.trim()) msg.content = event.error || 'Generation failed';
      }
      return;
    }
    if (event.type === 'delta') {
      if (event.content) msg.content = (msg.content || '') + event.content;
      if (event.reasoning) msg.reasoning = (msg.reasoning || '') + event.reasoning;
      return;
    }
    if (event.type === 'done') {
      msg.streaming = false;
      if (event.error) {
        if (isBenignGenerationError(event.error) && msg.content?.trim()) {
          sanitizeAssistantMessage(msg);
          return;
        }
        msg.error = true;
        msg.errorDetail = event.error;
        if (!msg.content?.trim()) msg.content = event.error;
      } else if (msg.content?.trim()) {
        msg.error = false;
        delete msg.errorDetail;
      }
    }
  }

  /** Subscribe to a server-side generation (survives page refresh). */
  async function runGenerationStream(thread) {
    const msg = thread.messages[thread.messages.length - 1];
    const ac = new AbortController();
    state.streams.set(thread.id, ac);
    state.stickToBottom = true;
    renderComposerState();
    renderThreadList();

    try {
      const res = await fetch(`/api/chat/generations/${encodeURIComponent(thread.id)}/stream`, {
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      if (!res.body) throw new Error('No response body');

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (!data) continue;
          let event;
          try { event = JSON.parse(data); } catch { continue; }
          applyGenerationEvent(msg, event);
          if (event.type === 'delta' || event.type === 'snapshot') repaint(thread, event.type === 'delta');
          if (event.type === 'done') break;
        }
      }
      if (!msg.content && !msg.reasoning) msg.content = '(empty reply)';
    } catch (e) {
      if (e.name !== 'AbortError') {
        msg.error = true;
        msg.errorDetail = String(e.message || e);
        if (!msg.content?.trim()) msg.content = msg.errorDetail;
      }
    } finally {
      msg.streaming = false;
      msg.ts = Date.now();
      sanitizeAssistantMessage(msg);
      state.streams.delete(thread.id);
      touch(thread);
      renderComposerState();
      if (thread.id === state.activeId) renderMessages();
      renderThreadList();
      void refreshSessionCatalog();
      if (thread.id === state.activeId) $('chat-input')?.focus();
    }
  }

  async function reconnectActiveGenerations(activeGens) {
    for (const gen of activeGens) {
      if (gen.status !== 'running') continue;
      const thread = state.threads.find(t => t.id === gen.threadId);
      if (!thread || state.streams.has(thread.id)) continue;
      const last = thread.messages[thread.messages.length - 1];
      if (last?.role === 'assistant' && !last.streaming && last.content?.trim()) continue;
      applyGenerationSnapshot(gen);
      void runGenerationStream(thread);
    }
  }

  /** Streams an assistant reply for `thread` (last message must be the pending assistant). */
  async function runAssistantStream(thread) {
    const msg = thread.messages[thread.messages.length - 1];
    const ac = new AbortController();
    state.streams.set(thread.id, ac);
    state.stickToBottom = true;
    renderComposerState();
    renderThreadList();

    try {
      const res = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildPayload(thread)),
        signal: ac.signal,
      });

      if (!res.ok) {
        let detail = `${res.status} ${res.statusText}`;
        try {
          const errBody = await res.json();
          detail = errBody?.error?.message || detail;
        } catch { /* ignore */ }
        throw new Error(detail);
      }

      const ctype = res.headers.get('content-type') || '';
      if (!res.body || ctype.includes('application/json')) {
        const data = await res.json();
        if (data?.error) throw new Error(data.error.message || 'Request failed');
        msg.content = data?.choices?.[0]?.message?.content ?? '';
        return;
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let json;
          try { json = JSON.parse(data); } catch { continue; }
          if (json.error) throw new Error(json.error.message || 'Agent error');
          const delta = json.choices?.[0]?.delta;
          if (delta?.reasoning_content) msg.reasoning = (msg.reasoning || '') + delta.reasoning_content;
          if (delta?.content) msg.content += delta.content;
          if (delta?.content || delta?.reasoning_content) repaint(thread, true);
        }
      }
      if (!msg.content && !msg.reasoning) msg.content = '(empty reply)';
    } catch (e) {
      if (e.name === 'AbortError') {
        if (!msg.content && !msg.reasoning) {
          // Nothing produced: drop the placeholder instead of leaving a stub.
          const idx = thread.messages.indexOf(msg);
          if (idx >= 0) thread.messages.splice(idx, 1);
        }
      } else {
        msg.error = true;
        msg.errorDetail = String(e.message || e);
        if (!msg.content?.trim()) msg.content = msg.errorDetail;
      }
    } finally {
      msg.streaming = false;
      msg.ts = Date.now();
      sanitizeAssistantMessage(msg);
      state.streams.delete(thread.id);
      touch(thread);
      renderComposerState();
      if (thread.id === state.activeId) renderMessages();
      renderThreadList();
      void refreshSessionCatalog();
      if (thread.id === state.activeId) $('chat-input')?.focus();
    }
  }

  function startAssistant(thread) {
    thread.messages.push({ role: 'assistant', content: '', streaming: true });
    touch(thread);
    state.stickToBottom = true;
    renderAll();
    return runAssistantStream(thread);
  }

  async function uploadAttachment(file) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      toast(`File too large (max ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB)`);
      return null;
    }
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    const data = btoa(binary);
    const res = await fetch('/api/chat/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: file.name,
        mimeType: file.type || 'application/octet-stream',
        data,
      }),
    });
    if (!res.ok) {
      let detail = `${res.status}`;
      try {
        const err = await res.json();
        detail = err?.error?.message || detail;
      } catch { /* ignore */ }
      toast(`Upload failed: ${detail}`);
      return null;
    }
    const body = await res.json();
    const att = body.attachment;
    if (!att?.path) return null;
    const item = {
      name: att.name || file.name,
      mimeType: att.mimeType || file.type || 'application/octet-stream',
      path: att.path,
      url: att.url,
      size: att.size,
    };
    if (item.mimeType.startsWith('image/')) {
      item.previewUrl = item.url;
    }
    return item;
  }

  async function addAttachmentFiles(fileList) {
    if (isReadOnlySession()) {
      toast('This session is read-only');
      return;
    }
    const files = Array.from(fileList || []).filter(Boolean);
    if (!files.length) return;
    for (const file of files) {
      try {
        const item = await uploadAttachment(file);
        if (item) {
          state.pendingAttachments.push(item);
        }
      } catch (e) {
        toast(`Upload failed: ${e.message || e}`);
      }
    }
    renderPendingAttachments();
  }

  function removePendingAttachment(idx) {
    state.pendingAttachments.splice(idx, 1);
    renderPendingAttachments();
  }

  function renderPendingAttachments() {
    const wrap = $('chat-attachments');
    if (!wrap) return;
    const items = state.pendingAttachments;
    if (!items.length) {
      wrap.hidden = true;
      wrap.replaceChildren();
      return;
    }
    wrap.hidden = false;
    wrap.replaceChildren(...items.map((a, i) => {
      const preview = a.previewUrl
        ? el('img', { src: a.previewUrl, alt: '' })
        : el('span', { class: 'chat-attachment-icon' }, '📎');
      return el('div', { class: 'chat-attachment-chip' },
        preview,
        el('span', { class: 'chat-attachment-name', title: a.name }, a.name),
        el('button', {
          type: 'button',
          class: 'chat-attachment-remove',
          title: 'Remove',
          onclick: () => removePendingAttachment(i),
        }, '×'),
      );
    }));
  }

  async function submitUserMessage(text, attachments) {
    const clean = String(text ?? '').trim();
    const atts = attachments ?? state.pendingAttachments;
    if (!clean && !atts.length) return;
    if (isReadOnlySession()) {
      toast('This session is read-only');
      return;
    }
    const thread = ensureActiveThread();
    if (isBusy(thread)) return;
    const msg = {
      role: 'user',
      content: clean,
      ts: Date.now(),
    };
    if (atts.length) {
      msg.attachments = atts.map(a => ({
        name: a.name,
        mimeType: a.mimeType,
        path: a.path,
        url: a.url,
        size: a.size,
      }));
    }
    thread.messages.push(msg);
    state.pendingAttachments = [];
    renderPendingAttachments();
    await startAssistant(thread);
  }

  function submitEdit(idx, text) {
    const thread = activeThread();
    const clean = String(text ?? '').trim();
    if (!thread || !clean || isBusy(thread)) return;
    thread.messages = thread.messages.slice(0, idx);
    state.editingIdx = null;
    thread.messages.push({ role: 'user', content: clean, ts: Date.now() });
    void startAssistant(thread);
  }

  function regenerateReply() {
    const thread = activeThread();
    if (!thread || isBusy(thread)) return;
    const last = thread.messages[thread.messages.length - 1];
    if (last?.role !== 'assistant') return;
    thread.messages.pop();
    if (thread.messages[thread.messages.length - 1]?.role !== 'user') return;
    void startAssistant(thread);
  }

  function stopGenerating() {
    const t = activeThread();
    if (!t) return;
    state.streams.get(t.id)?.abort();
    void fetch(`/api/chat/generations/${encodeURIComponent(t.id)}`, { method: 'DELETE' }).catch(() => undefined);
  }

  // ───────────────────────── composer / chrome ─────────────────────────

  function autoResizeInput(input) {
    input.style.height = 'auto';
    input.style.height = `${Math.min(220, Math.max(44, input.scrollHeight))}px`;
  }

  function sendMessage() {
    const input = $('chat-input');
    if (!input || isBusy()) return;
    const text = input.value.trim();
    if (!text && !state.pendingAttachments.length) return;
    input.value = '';
    autoResizeInput(input);
    void submitUserMessage(text);
  }

  function editLastUserMessage() {
    const thread = activeThread();
    if (!thread || isBusy(thread)) return;
    for (let i = thread.messages.length - 1; i >= 0; i--) {
      if (thread.messages[i].role === 'user') {
        state.editingIdx = i;
        renderMessages();
        return;
      }
    }
  }

  function exportThread() {
    const t = activeThread();
    if (!t?.messages.length) {
      toast('Nothing to export yet');
      return;
    }
    const md = [`# ${threadTitle(t)}`, '']
      .concat(
        t.messages
          .filter(m => m.content && !m.streaming)
          .map(m => `## ${m.role === 'user' ? 'You' : 'Agent'}\n\n${m.content}\n`),
      )
      .join('\n');
    const blob = new Blob([md], { type: 'text/markdown' });
    const a = el('a', {
      href: URL.createObjectURL(blob),
      download: `${threadTitle(t).replace(/[^\w\-]+/g, '_').slice(0, 40) || 'chat'}.md`,
    });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    const hl = $('hljs-theme-note');
    if (hl) hl.dataset.theme = theme;
    const btn = $('chat-theme');
    if (btn) btn.textContent = theme === 'light' ? '🌙' : '☀️';
  }

  function initTheme() {
    let theme = 'dark';
    try {
      theme = localStorage.getItem(THEME_KEY)
        || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    } catch { /* ignore */ }
    applyTheme(theme);
  }

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* ignore */ }
  }

  function resolveSidebarOpen() {
    let open = true;
    try {
      const saved = localStorage.getItem(SIDEBAR_KEY);
      if (saved != null) open = saved === '1';
    } catch { /* ignore */ }
    if (window.matchMedia('(max-width: 768px)').matches) open = false;
    return open;
  }

  function setSidebar(open) {
    $('chat-shell')?.classList.toggle('sidebar-collapsed', !open);
    try { localStorage.setItem(SIDEBAR_KEY, open ? '1' : '0'); } catch { /* ignore */ }
  }

  /** Mobile browsers: sync --chat-vh when URL bar / keyboard changes visible viewport. */
  function bindChatViewportHeight() {
    const root = document.documentElement;
    const apply = () => {
      const h = window.visualViewport?.height ?? window.innerHeight;
      if (h > 0) root.style.setProperty('--chat-vh', `${Math.round(h)}px`);
    };
    apply();
    window.visualViewport?.addEventListener('resize', apply);
    window.visualViewport?.addEventListener('scroll', apply);
    window.addEventListener('resize', apply);
    window.addEventListener('orientationchange', () => {
      setTimeout(apply, 100);
    });
  }

  function sidebarOpen() {
    return !$('chat-shell')?.classList.contains('sidebar-collapsed');
  }

  function bind() {
    $('chat-new')?.addEventListener('click', newChat);
    $('chat-attach')?.addEventListener('click', () => $('chat-file-input')?.click());
    $('chat-file-input')?.addEventListener('change', e => {
      void addAttachmentFiles(e.target.files);
      e.target.value = '';
    });
    const composer = $('chat-composer');
    composer?.addEventListener('dragover', e => {
      e.preventDefault();
      composer.classList.add('drag-over');
    });
    composer?.addEventListener('dragleave', () => composer.classList.remove('drag-over'));
    composer?.addEventListener('drop', e => {
      e.preventDefault();
      composer.classList.remove('drag-over');
      void addAttachmentFiles(e.dataTransfer?.files);
    });
    $('chat-send')?.addEventListener('click', sendMessage);
    $('chat-stop')?.addEventListener('click', stopGenerating);
    $('chat-export')?.addEventListener('click', exportThread);
    $('chat-theme')?.addEventListener('click', toggleTheme);
    $('chat-clear-all')?.addEventListener('click', clearAllThreads);
    $('chat-backdrop')?.addEventListener('click', () => setSidebar(false));
    $('chat-sidebar-toggle')?.addEventListener('click', () => setSidebar(!sidebarOpen()));
    $('chat-scroll-bottom')?.addEventListener('click', () => {
      state.stickToBottom = true;
      scrollToBottom(true);
    });

    const search = $('chat-search');
    search?.addEventListener('input', () => {
      state.searchQuery = search.value;
      renderThreadList();
    });

    const wrap = messagesWrap();
    wrap?.addEventListener('scroll', () => {
      state.stickToBottom = isNearBottom(wrap, 120);
      updateScrollButton();
    }, { passive: true });

    wrap?.addEventListener('click', e => {
      const a = e.target.closest?.('a[href^="#"]');
      if (a) e.preventDefault();
    });

    const input = $('chat-input');
    input?.addEventListener('input', () => autoResizeInput(input));
    input?.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        sendMessage();
      } else if (e.key === 'Escape') {
        if (isBusy()) stopGenerating();
        else input.blur();
      } else if (e.key === 'ArrowUp' && !input.value) {
        e.preventDefault();
        editLastUserMessage();
      }
    });

    $('chat-mode')?.addEventListener('change', e => {
      if (isReadOnlySession()) return;
      const t = ensureActiveThread();
      t.mode = e.target.value;
      markThreadDirty(t.id);
    });
    $('chat-model')?.addEventListener('change', e => {
      if (isReadOnlySession()) return;
      const t = ensureActiveThread();
      t.model = e.target.value;
      markThreadDirty(t.id);
    });

    document.addEventListener('keydown', e => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        newChat();
      } else if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (!sidebarOpen()) setSidebar(true);
        search?.focus();
        search?.select();
      } else if (
        e.key === '/' &&
        !mod &&
        !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')
      ) {
        e.preventDefault();
        input?.focus();
      }
    });

    window.addEventListener('beforeunload', () => {
      stopSessionSync();
      if (state.persistTimer) {
        clearTimeout(state.persistTimer);
        state.persistTimer = null;
      }
      try {
        const threads = state.threads
          .filter(t => !t.readOnly && state.dirtyThreadIds.has(t.id))
          .map(t => ({ ...t, source: 'web' }));
        if (!threads.length && !state.dirtyActiveId) return;
        const payload = { threads };
        if (state.dirtyActiveId) payload.activeId = state.activeId;
        const body = JSON.stringify(payload);
        fetch('/api/chat/threads', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body,
          keepalive: true,
        }).catch(() => undefined);
      } catch {
        /* ignore */
      }
    });
  }

  async function start() {
    initTheme();
    initMarked();
    bindChatViewportHeight();
    setSidebar(resolveSidebarOpen());
    bind();
    renderAll();
    const activeGens = await loadThreads();
    ensureActiveThread();
    if (state.activeId) void ensureExternalSessionLoaded(state.activeId);
    await reconnectActiveGenerations(activeGens);

    setSidebar(resolveSidebarOpen());

    renderAll();
    void loadConfig();
    void loadModels();
    startSessionSync();
    void pollSessionUpdates();
    const input = $('chat-input');
    if (input) {
      autoResizeInput(input);
      if (!isReadOnlySession()) input.focus();
    }
    updateScrollButton();
  }

  /** Collapse sidebar on mobile before paint/async work (avoids full-screen backdrop). */
  (function initMobileSidebarCollapsed() {
    try {
      if (!window.matchMedia('(max-width: 768px)').matches) return;
      document.getElementById('chat-shell')?.classList.add('sidebar-collapsed');
    } catch { /* ignore */ }
  })();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
