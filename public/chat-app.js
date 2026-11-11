(() => {
  'use strict';

  const _fetch = globalThis.fetch.bind(globalThis);
  function apiFetch(input, init) {
    if (
      typeof input === "string" &&
      input.startsWith("/") &&
      !input.startsWith("//") &&
      typeof bridgePath === "function"
    ) {
      return _fetch(bridgePath(input), init);
    }
    return _fetch(input, init);
  }

  const THREADS_KEY = 'cursor-bridge-chat-threads';
  const ACTIVE_KEY = 'cursor-bridge-chat-active';
  const THEME_KEY = 'cursor-bridge-chat-theme';
  const SIDEBAR_KEY = 'cursor-bridge-chat-sidebar';
  const SIDEBAR_WIDTH_KEY = 'cursor-bridge-chat-sidebar-width';
  const SIDEBAR_WIDTH_MIN = 200;
  const SIDEBAR_WIDTH_MAX = 520;
  const SIDEBAR_WIDTH_DEFAULT = 280;
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

  const ACCOUNT_USAGE_POLL_MS = 60_000;

  const state = {
    config: null,
    models: [],
    /** Cursor account rows from GET /api/cursor-account */
    accounts: [],
    accountSnapshotAt: null,
    accountRefreshTimer: null,
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
    /** Selected index in the pending-attachments preview carousel. */
    pendingPreviewIndex: 0,
    /** Background poll handle for cross-client session sync. */
    sessionSyncTimer: null,
    sessionSyncBusy: false,
    networkDown: false,
    networkFailStreak: 0,
    statusPollTimer: null,
    /** threadId -> { updatedAt, messageCount } last seen from server/local. */
    sessionSnapshots: new Map(),
    searchDebounce: null,
    /** Bumped on each loadModels(); stale responses are ignored. */
    modelsLoadSeq: 0,
    modelsLoadProgressTimer: null,
  };

  const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
  /** Compress images above this size before upload (bytes). */
  const IMAGE_COMPRESS_MIN_BYTES = 512 * 1024;
  const IMAGE_MAX_EDGE_PX = 2048;
  const IMAGE_JPEG_QUALITY = 0.85;

  let markedReady = false;
  let mermaidReady = false;
  let mermaidActiveTheme = null;
  let mermaidIdSeq = 0;
  /** Max Mermaid source characters per diagram (client render). */
  const MAX_MERMAID_CHARS = 12_000;
  /** Max diagrams rendered per assistant message. */
  const MAX_MERMAID_PER_MESSAGE = 16;
  const mermaidUtils = window.ChatMermaidUtils || {};
  const MERMAID_HEAD_RE = /^(flowchart|graph)\s+(TB|BT|RL|LR|TD|DT)\b/i;

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

  function pathBasename(p) {
    const s = String(p || '').replace(/\\/g, '/');
    const i = s.lastIndexOf('/');
    return i >= 0 ? s.slice(i + 1) : s;
  }

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
      const q = `/api/workspace-file?path=${encodeURIComponent(path)}`;
      return typeof bridgePath === "function" ? bridgePath(q) : q;
    }
    return p;
  }

  function isLocalFilesystemPath(raw) {
    const p = String(raw || '').trim();
    if (!p || /^https?:\/\//i.test(p) || p.startsWith('/api/')) return false;
    if (p.startsWith('file://')) return true;
    return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p);
  }

  function workspaceDownloadUrl(raw) {
    const base = toWorkspaceFileUrl(raw);
    const ws = typeof bridgePath === "function" ? bridgePath("/api/workspace-file") : "/api/workspace-file";
    if (!base.includes("/api/workspace-file") && !base.startsWith(ws)) return base;
    return base.includes('?') ? `${base}&download=1` : `${base}?download=1`;
  }

  function workspaceInlinePdfUrl(raw) {
    const base = toWorkspaceFileUrl(raw);
    const ws = typeof bridgePath === "function" ? bridgePath("/api/workspace-file") : "/api/workspace-file";
    if (!base.includes("/api/workspace-file") && !base.startsWith(ws)) return base;
    return base.includes('?') ? `${base}&inline=1` : `${base}?inline=1`;
  }

  function resolveAttachmentUrl(att) {
    if (att?.path) return toWorkspaceFileUrl(att.path);
    const url = String(att?.url || '').trim();
    if (url && !url.startsWith('blob:')) return url;
    return '';
  }

  function rehydrateThreadAttachments(thread) {
    for (const m of thread?.messages || []) {
      if (!Array.isArray(m.attachments)) continue;
      for (const a of m.attachments) {
        if (a.path) a.url = toWorkspaceFileUrl(a.path);
      }
    }
  }

  function isImageAttachment(a) {
    return (a?.mimeType || '').startsWith('image/');
  }

  function isPdfAttachment(a) {
    const mime = a?.mimeType || '';
    const name = a?.name || '';
    return mime === 'application/pdf' || /\.pdf$/i.test(name);
  }

  function openMermaidLightbox(diagramEl) {
    const svg = diagramEl?.querySelector?.('svg');
    if (!svg) return;
    const existing = document.getElementById('chat-mermaid-lightbox');
    if (existing) existing.remove();
    const backdrop = el('div', {
      id: 'chat-mermaid-lightbox',
      class: 'chat-mermaid-lightbox',
      role: 'dialog',
      'aria-label': 'Diagram preview',
    });
    let onResize;
    const close = () => {
      if (onResize) window.removeEventListener('resize', onResize);
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
    };
    const onKey = e => {
      if (e.key === 'Escape') close();
    };
    backdrop.addEventListener('click', e => {
      if (e.target === backdrop) close();
    });
    document.addEventListener('keydown', onKey);
    const diagramHost = el('div', { class: 'chat-mermaid-lightbox-diagram' });
    diagramHost.appendChild(svg.cloneNode(true));
    const scrollEl = el('div', { class: 'chat-mermaid-lightbox-scroll' }, diagramHost);
    const layoutLightbox = () => {
      if (typeof mermaidUtils.layoutMermaidLightbox === 'function') {
        mermaidUtils.layoutMermaidLightbox(diagramHost, scrollEl);
      }
    };
    onResize = () => layoutLightbox();
    const panel = el('div', { class: 'chat-mermaid-lightbox-panel' },
      el('button', {
        type: 'button',
        class: 'chat-mermaid-lightbox-close',
        title: 'Close',
        'aria-label': 'Close',
        onclick: close,
      }, '×'),
      scrollEl,
    );
    panel.addEventListener('click', e => e.stopPropagation());
    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);
    window.addEventListener('resize', onResize);
    requestAnimationFrame(() => {
      layoutLightbox();
      requestAnimationFrame(layoutLightbox);
    });
  }

  function wireMermaidZoomButtons(root) {
    if (!root) return;
    root.querySelectorAll('.chat-mermaid-zoom').forEach(btn => {
      if (btn.dataset.wired) return;
      btn.dataset.wired = '1';
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const diagramEl = btn.closest('.chat-mermaid-diagram-wrap')?.querySelector('.chat-mermaid-diagram');
        if (diagramEl) openMermaidLightbox(diagramEl);
      });
    });
  }

  function attachmentPreviewSrc(att) {
    if (!att) return '';
    return att.previewUrl || resolveAttachmentUrl(att);
  }

  function openAttachmentGallery(attachments, startIndex = 0) {
    const list = (attachments || []).filter(Boolean);
    if (!list.length) return;
    let index = Math.max(0, Math.min(startIndex, list.length - 1));
    const existing = document.getElementById('chat-image-lightbox');
    if (existing) existing.remove();
    const backdrop = el('div', {
      id: 'chat-image-lightbox',
      class: 'chat-image-lightbox',
      role: 'dialog',
      'aria-label': 'Attachment preview',
    });
    const close = () => {
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
    };
    const onKey = e => {
      if (e.key === 'Escape') close();
      if (list.length < 2) return;
      if (e.key === 'ArrowLeft') go(-1);
      if (e.key === 'ArrowRight') go(1);
    };
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('click', e => {
      if (e.target === backdrop) close();
    });

    const viewport = el('div', { class: 'chat-image-lightbox-viewport' });
    const counter = el('span', { class: 'chat-image-lightbox-counter mono' });
    const caption = el('span', { class: 'chat-image-lightbox-caption' });

    const renderSlide = () => {
      const att = list[index];
      const name = att.name || 'attachment';
      const url = attachmentPreviewSrc(att);
      viewport.replaceChildren();
      caption.textContent = name;
      counter.textContent = list.length > 1 ? `${index + 1} / ${list.length}` : '';
      if (isImageAttachment(att) && url) {
        viewport.appendChild(el('img', {
          src: url,
          alt: name,
          class: 'chat-image-lightbox-img',
        }));
      } else {
        viewport.appendChild(el('div', { class: 'chat-image-lightbox-file' },
          el('span', { class: 'chat-image-lightbox-file-icon' }, isPdfAttachment(att) ? '📄' : '📎'),
          el('span', { class: 'chat-image-lightbox-file-name' }, name),
          el('button', {
            type: 'button',
            class: 'btn small',
            onclick: () => openAttachment(att, { skipGallery: true }),
          }, isPdfAttachment(att) ? 'Open PDF' : 'Download'),
        ));
      }
    };

    const go = delta => {
      index = (index + delta + list.length) % list.length;
      renderSlide();
    };

    const navPrev = el('button', {
      type: 'button',
      class: 'chat-image-lightbox-nav chat-image-lightbox-nav-prev',
      title: 'Previous attachment',
      'aria-label': 'Previous attachment',
      hidden: list.length < 2,
      onclick: e => { e.stopPropagation(); go(-1); },
    }, '‹');
    const navNext = el('button', {
      type: 'button',
      class: 'chat-image-lightbox-nav chat-image-lightbox-nav-next',
      title: 'Next attachment',
      'aria-label': 'Next attachment',
      hidden: list.length < 2,
      onclick: e => { e.stopPropagation(); go(1); },
    }, '›');

    const panel = el('div', { class: 'chat-image-lightbox-panel' },
      el('button', {
        type: 'button',
        class: 'chat-image-lightbox-close',
        title: 'Close',
        'aria-label': 'Close',
        onclick: close,
      }, '×'),
      navPrev,
      el('div', { class: 'chat-image-lightbox-stage' },
        viewport,
        el('div', { class: 'chat-image-lightbox-meta' }, caption, counter),
      ),
      navNext,
    );
    panel.addEventListener('click', e => e.stopPropagation());
    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);
    renderSlide();
  }

  function openAttachment(att, opts = {}) {
    const url = resolveAttachmentUrl(att);
    if (!url && !att?.previewUrl) return;
    if (!opts.skipGallery) {
      const pending = state.pendingAttachments;
      const inPending = pending.indexOf(att);
      if (inPending >= 0 && pending.length > 1) {
        openAttachmentGallery(pending, inPending);
        return;
      }
    }
    if (!url) return;
    if (isImageAttachment(att)) {
      openAttachmentGallery([att], 0);
      return;
    }
    if (isPdfAttachment(att)) {
      window.open(workspaceInlinePdfUrl(att.path || url), '_blank', 'noopener,noreferrer');
      return;
    }
    const dl = workspaceDownloadUrl(att.path || url);
    window.open(dl, '_blank', 'noopener,noreferrer');
  }

  function rewriteLocalPathsInMarkdown(text) {
    let out = String(text || '').replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (match, alt, url) => {
      const next = toWorkspaceFileUrl(url);
      return next === url ? match : `![${alt}](${next})`;
    });
    out = out.replace(/(?<!!)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (match, label, url) => {
      if (!isLocalFilesystemPath(url)) return match;
      const next = workspaceDownloadUrl(url);
      return `[${label}](${next})`;
    });
    return out;
  }

  function isMermaidCodeLang(lang) {
    return String(lang || '').trim().toLowerCase() === 'mermaid';
  }

  /** Detect Mermaid when the model omits the ```mermaid fence language. */
  function looksLikeMermaidSource(text) {
    const t = String(text || '').trimStart();
    if (!t) return false;
    if (/^(sequenceDiagram|classDiagram|stateDiagram-v?\d|erDiagram|gantt\b|pie\b|gitGraph\b|journey\b|timeline\b|mindmap\b|quadrantChart\b|xychart-beta\b|sankey-beta\b|block-beta\b|C4Context\b)/i.test(t)) {
      return true;
    }
    return MERMAID_HEAD_RE.test(t) && /(-->|-\.->|---)/.test(t);
  }

  function mermaidDiagramContinues(line) {
    const t = String(line || '').trim();
    if (!t) return true;
    if (MERMAID_HEAD_RE.test(t)) return true;
    if (/^subgraph\b/i.test(t)) return true;
    if (/^end\s*$/i.test(t)) return true;
    if (/^(classDef|class|style|linkStyle)\b/i.test(t)) return true;
    if (/(-->|-\.->|---)/.test(t)) return true;
    if (/^[\w][\w0-9-]*\s*[\[({"]/.test(t)) return true;
    return false;
  }

  /** Wrap bare flowchart blocks so marked runs them through the Mermaid renderer. */
  function promoteBareMermaidFences(md) {
    if (/```\s*mermaid\b/i.test(md)) return md;
    const lines = String(md || '').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (MERMAID_HEAD_RE.test(line.trim())) {
        const chunk = [line];
        i += 1;
        while (i < lines.length) {
          const next = lines[i];
          if (!mermaidDiagramContinues(next)) break;
          chunk.push(next);
          i += 1;
        }
        if (chunk.length >= 2 && /(-->|-\.->|---)/.test(chunk.join('\n'))) {
          out.push('```mermaid', ...chunk, '```');
          continue;
        }
        out.push(...chunk);
        continue;
      }
      out.push(line);
      i += 1;
    }
    return out.join('\n');
  }

  function prepareMermaidSource(source) {
    if (typeof mermaidUtils.prepareMermaidSource === 'function') {
      return mermaidUtils.prepareMermaidSource(source);
    }
    return String(source || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/\r\n/g, '\n');
  }

  function mermaidBlockHtml(text) {
    return (
      `<div class="chat-mermaid-block" data-mermaid-pending="1">` +
      `<div class="chat-code-head">` +
      `<span class="chat-code-lang mono">mermaid</span>` +
      `<button type="button" class="chat-code-copy" data-copy="1">Copy</button>` +
      `</div>` +
      `<pre class="chat-mermaid-src" hidden>${escapeHtml(text)}</pre>` +
      `<div class="chat-mermaid-diagram-wrap">` +
      `<div class="chat-mermaid-diagram" aria-busy="true" role="img" aria-label="Diagram"></div>` +
      `<button type="button" class="chat-mermaid-zoom" title="Enlarge diagram" aria-label="Enlarge diagram">⤢</button>` +
      `</div>` +
      `<div class="chat-mermaid-fallback" hidden>` +
      `<pre><code class="mono">${escapeHtml(text)}</code></pre>` +
      `</div>` +
      `</div>`
    );
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
          if (isMermaidCodeLang(language) || (!language && looksLikeMermaidSource(text))) {
            return mermaidBlockHtml(text);
          }
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
        link(href, title, text) {
          const raw = String(href || '');
          const mapped = isLocalFilesystemPath(raw)
            ? workspaceDownloadUrl(raw)
            : toWorkspaceFileUrl(raw);
          const label = escapeHtml(text || pathBasename(raw) || 'Download');
          const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
          const cls =
            mapped.startsWith('/api/workspace-file') && mapped.includes('download=1')
              ? ' class="chat-workspace-download"'
              : '';
          return `<a href="${escapeHtml(mapped)}"${cls}${titleAttr}>${label}</a>`;
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
    const normalized = promoteBareMermaidFences(rewriteLocalPathsInMarkdown(text || ''));
    if (markedReady && marked.parse) {
      try {
        return sanitizeHtml(marked.parse(normalized));
      } catch {
        /* fall through */
      }
    }
    return escapeHtml(normalized).replace(/\n/g, '<br>');
  }

  function currentMermaidTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'default';
  }

  function initMermaid(force) {
    if (typeof mermaid === 'undefined') return false;
    const theme = currentMermaidTheme();
    if (!force && mermaidReady && mermaidActiveTheme === theme) return true;
    try {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        htmlLabels: false,
        maxTextSize: 50_000,
        maxEdges: 200,
        theme,
        fontFamily: 'var(--sans, system-ui, sans-serif)',
      });
      mermaidReady = true;
      mermaidActiveTheme = theme;
    } catch {
      mermaidReady = false;
      mermaidActiveTheme = null;
    }
    return mermaidReady;
  }

  function chatMessagesRoot() {
    return $('chat-messages') || document;
  }

  async function refreshMermaidDiagramsForTheme() {
    if (typeof mermaid === 'undefined') return;
    const root = chatMessagesRoot();
    const done = root.querySelectorAll('.chat-mermaid-block.chat-mermaid-done');
    if (!done.length) {
      mermaidReady = false;
      mermaidActiveTheme = null;
      initMermaid(true);
      return;
    }
    if (!initMermaid(true)) return;
    done.forEach(block => {
      block.classList.remove('chat-mermaid-done', 'chat-mermaid-error', 'chat-mermaid-too-large');
      const diagramEl = block.querySelector('.chat-mermaid-diagram');
      const fallback = block.querySelector('.chat-mermaid-fallback');
      if (diagramEl) {
        diagramEl.innerHTML = '';
        diagramEl.setAttribute('aria-busy', 'true');
      }
      if (fallback) fallback.hidden = true;
      block.setAttribute('data-mermaid-pending', '1');
    });
    await renderMermaidInRoot(root);
  }

  /** Strip active content from Mermaid-generated SVG before inline display. */
  function sanitizeMermaidSvg(svg) {
    if (typeof mermaidUtils.sanitizeMermaidSvg === 'function') {
      return mermaidUtils.sanitizeMermaidSvg(svg);
    }
    return svg || '';
  }

  function isMeaningfulMermaidSvg(svg) {
    if (typeof mermaidUtils.isMeaningfulMermaidSvg === 'function') {
      return mermaidUtils.isMeaningfulMermaidSvg(svg);
    }
    return !!svg && svg.length > 80;
  }

  function showMermaidFallback(block, diagramEl, fallback, message) {
    block.classList.add('chat-mermaid-error');
    if (fallback) fallback.hidden = false;
    if (diagramEl) {
      if (message) {
        diagramEl.innerHTML = `<p class="chat-mermaid-load-hint muted-text">${escapeHtml(message)}</p>`;
      } else {
        diagramEl.innerHTML = '';
      }
      diagramEl.removeAttribute('aria-busy');
    }
    block.removeAttribute('data-mermaid-pending');
  }

  async function renderMermaidInRoot(root) {
    if (typeof mermaid === 'undefined') {
      root.querySelectorAll('.chat-mermaid-block[data-mermaid-pending="1"]').forEach(block => {
        showMermaidFallback(
          block,
          block.querySelector('.chat-mermaid-diagram'),
          block.querySelector('.chat-mermaid-fallback'),
          'Mermaid failed to load. Hard-refresh or check /static/vendor/mermaid.min.js.',
        );
      });
      return;
    }
    if (!initMermaid()) {
      root.querySelectorAll('.chat-mermaid-block[data-mermaid-pending="1"]').forEach(block => {
        showMermaidFallback(
          block,
          block.querySelector('.chat-mermaid-diagram'),
          block.querySelector('.chat-mermaid-fallback'),
          null,
        );
      });
      return;
    }
    const blocks = [...root.querySelectorAll('.chat-mermaid-block[data-mermaid-pending="1"]')];
    let rendered = 0;
    for (const block of blocks) {
      const srcEl = block.querySelector('.chat-mermaid-src');
      const diagramEl = block.querySelector('.chat-mermaid-diagram');
      const fallback = block.querySelector('.chat-mermaid-fallback');
      if (!srcEl || !diagramEl) {
        block.removeAttribute('data-mermaid-pending');
        continue;
      }
      const source = prepareMermaidSource(srcEl.textContent || '').trim();
      if (!source) {
        block.removeAttribute('data-mermaid-pending');
        continue;
      }
      if (rendered >= MAX_MERMAID_PER_MESSAGE || source.length > MAX_MERMAID_CHARS) {
        block.classList.add('chat-mermaid-too-large');
        if (fallback) fallback.hidden = false;
        diagramEl.innerHTML = '';
        diagramEl.removeAttribute('aria-busy');
        block.removeAttribute('data-mermaid-pending');
        continue;
      }
      rendered += 1;
      const id = `chat-mmd-${++mermaidIdSeq}`;
      try {
        const out = await mermaid.render(id, source);
        const clean = sanitizeMermaidSvg(out.svg);
        if (!clean || !isMeaningfulMermaidSvg(clean)) throw new Error('empty_svg');
        diagramEl.innerHTML = clean;
        if (typeof out.bindFunctions === 'function') {
          try {
            out.bindFunctions(diagramEl.querySelector('svg'));
          } catch {
            /* non-interactive diagrams */
          }
        }
        if (fallback) fallback.hidden = true;
        block.classList.add('chat-mermaid-done');
      } catch (err) {
        showMermaidFallback(block, diagramEl, fallback, null);
        if (typeof console !== 'undefined' && console.debug) {
          console.debug('[chat-mermaid]', err?.message || err, source.slice(0, 120));
        }
      }
      diagramEl.removeAttribute('aria-busy');
      block.removeAttribute('data-mermaid-pending');
    }
    wireMermaidZoomButtons(root);
  }

  function wireMermaidDiagrams(root) {
    wireMermaidZoomButtons(root);
    if (!root?.querySelector?.('.chat-mermaid-block[data-mermaid-pending="1"]')) return;
    void renderMermaidInRoot(root);
  }

  /** Cheap live preview while tokens stream (full markdown runs once on completion). */
  function renderStreamingBubbleHtml(text) {
    return escapeHtml(text || '').replace(/\n/g, '<br>');
  }

  function wireCopyButtons(root) {
    root.querySelectorAll('.chat-code-copy[data-copy]').forEach(btn => {
      if (btn.dataset.wired) return;
      btn.dataset.wired = '1';
      btn.addEventListener('click', async () => {
        const block = btn.closest('.chat-code-block, .chat-mermaid-block');
        const code =
          block?.querySelector('code') ??
          block?.querySelector('.chat-mermaid-src');
        const ok = await copyText(code?.textContent ?? '');
        flash(btn, ok ? 'Copied' : 'Failed');
      });
    });
  }

  // ───────────────────────── threads ─────────────────────────

  function activeThread() {
    return state.threads.find(t => t.id === state.activeId) ?? null;
  }

  function formatContextTokens(n) {
    if (!Number.isFinite(n) || n < 0) return '—';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
    if (n >= 10_000) return `${Math.round(n / 1000)}k`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(Math.round(n));
  }

  function applyContextUsageToThread(thread, usage) {
    if (!thread || !usage) return;
    const used = Number(usage.used);
    const size = Number(usage.size);
    if (!Number.isFinite(used) || !Number.isFinite(size)) return;
    thread.contextWindowUsage = {
      used,
      size,
      cost: Number.isFinite(Number(usage.cost)) ? Number(usage.cost) : undefined,
      updatedAt: usage.updatedAt || Date.now(),
      source: usage.source === 'acp' ? 'acp' : usage.source === 'estimate' ? 'estimate' : thread.contextWindowUsage?.source,
    };
  }

  function renderContextUsage() {
    const wrap = $('chat-context-usage');
    const fill = $('chat-context-usage-fill');
    const label = $('chat-context-usage-label');
    if (!wrap || !fill || !label) return;
    const usage = activeThread()?.contextWindowUsage;
    if (!usage || !usage.size) {
      wrap.classList.add('hidden');
      wrap.hidden = true;
      return;
    }
    const pct = usage.size > 0 ? Math.min(100, Math.max(0, (usage.used / usage.size) * 100)) : 0;
    fill.style.width = `${pct.toFixed(1)}%`;
    const pctLabel = usage.size > 0 ? ` · ${pct.toFixed(1)}%` : '';
    const approx = usage.source === 'estimate' ? '~' : '';
    label.textContent = `Context ${approx}${formatContextTokens(usage.used)} / ${formatContextTokens(usage.size)}${pctLabel}`;
    wrap.classList.remove('hidden');
    wrap.hidden = false;
    wrap.title =
      usage.source === 'estimate'
        ? 'Estimated from conversation size (Cursor CLI does not yet send ACP usage_update). Replaced automatically when the CLI reports usage.'
        : 'Model-reported context window usage for this session';
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
      const r = await apiFetch('/api/chat/generations');
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
      const r = await apiFetch('/api/chat/migrate', {
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
        apiFetch('/api/chat/threads?compact=1'),
        fetchActiveGenerations(),
      ]);
      if (!threadsRes.ok) throw new Error(String(threadsRes.status));
      const data = await threadsRes.json();
      const compactList = data.compact === true;
      state.sessionCatalog = Array.isArray(data.sessions) ? data.sessions : [];
      state.threads = Array.isArray(data.threads)
        ? data.threads.map(t => ({
          ...t,
          source: 'web',
          title: t.title || null,
          model: t.model || '',
          mode: t.mode || '',
          messages: compactList || !Array.isArray(t.messages) ? [] : t.messages,
        }))
        : [];
      state.threads.forEach(t => {
        rehydrateThreadAttachments(t);
        sanitizeThreadMessages(t);
      });
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
    if (gen.contextWindowUsage) applyContextUsageToThread(thread, gen.contextWindowUsage);
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
      await apiFetch('/api/chat/threads', {
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
      const r = await apiFetch('/api/chat/threads?compact=1');
      if (!r.ok) return;
      const data = await r.json();
      state.sessionCatalog = Array.isArray(data.sessions) ? data.sessions : [];
      if (data.activeId) state.activeId = data.activeId;
      mergeServerWebThreads(data.threads || [], data.compact === true);
      renderThreadList();
    } catch {
      /* ignore */
    }
  }

  function mergeServerWebThread(serverThread, compact = false) {
    if (!serverThread?.id || state.streams.has(serverThread.id)) return false;
    const idx = state.threads.findIndex(t => t.id === serverThread.id);
    const entry = catalogEntry(serverThread.id);
    const local = idx >= 0 ? state.threads[idx] : null;

    if (compact) {
      if (!local) {
        const stub = {
          id: serverThread.id,
          source: 'web',
          title: serverThread.title ?? entry?.title ?? null,
          pinned: serverThread.pinned ?? entry?.pinned ?? false,
          createdAt: serverThread.createdAt ?? entry?.createdAt ?? Date.now(),
          updatedAt: serverThread.updatedAt ?? entry?.updatedAt ?? Date.now(),
          model: serverThread.model ?? entry?.model ?? '',
          mode: serverThread.mode ?? entry?.mode ?? '',
          messages: [],
          readOnly: false,
        };
        state.threads.push(stub);
        if (entry && serverThread.updatedAt) entry.updatedAt = serverThread.updatedAt;
        return true;
      }
      if ((local.updatedAt ?? 0) > (serverThread.updatedAt ?? 0)) return false;
      local.title = serverThread.title ?? local.title;
      local.pinned = serverThread.pinned ?? local.pinned;
      local.model = serverThread.model ?? local.model;
      local.mode = serverThread.mode ?? local.mode;
      local.updatedAt = Math.max(local.updatedAt ?? 0, serverThread.updatedAt ?? 0);
      if (entry) {
        entry.title = local.title || entry.title;
        entry.pinned = local.pinned;
        if (serverThread.updatedAt) entry.updatedAt = serverThread.updatedAt;
      }
      return true;
    }

    if (local && (local.updatedAt ?? 0) > (serverThread.updatedAt ?? 0)) return false;

    const merged = {
      ...serverThread,
      source: 'web',
      readOnly: false,
      messages: Array.isArray(serverThread.messages) ? serverThread.messages : [],
    };
    if (idx >= 0) state.threads[idx] = merged;
    else state.threads.push(merged);
    rehydrateThreadAttachments(merged);
    sanitizeThreadMessages(merged);

    if (entry) {
      entry.updatedAt = merged.updatedAt;
      entry.messageCount = countStableMessages(merged.messages);
      const title = merged.title || threadTitle(merged);
      if (title) entry.title = title;
    }
    return true;
  }

  function mergeServerWebThreads(serverThreads, compact = false) {
    let changed = false;
    for (const t of serverThreads || []) {
      if (mergeServerWebThread(t, compact)) changed = true;
    }
    return changed;
  }

  async function fetchAndApplySession(id) {
    const entry = catalogEntry(id);
    try {
      const r = await apiFetch(`/api/chat/threads/${encodeURIComponent(id)}`);
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
        contextWindowUsage: session.contextWindowUsage,
      };

      const idx = state.threads.findIndex(t => t.id === id);
      if (idx >= 0) state.threads[idx] = thread;
      else state.threads.push(thread);
      rehydrateThreadAttachments(thread);

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

  async function syncActiveSession(data, compact = false) {
    const id = state.activeId;
    if (!id || state.streams.has(id) || state.editingIdx != null || state.persistTimer) return;

    const entry = (data.sessions || []).find(s => s.id === id) ?? catalogEntry(id);
    const serverThread = (data.threads || []).find(t => t.id === id);
    const local = state.threads.find(t => t.id === id);
    const snap = state.sessionSnapshots.get(id);
    const serverHasMessages = !!serverThread && Array.isArray(serverThread.messages);

    const serverUpdatedAt = Math.max(serverThread?.updatedAt ?? 0, entry?.updatedAt ?? 0);
    const serverMsgCount = serverHasMessages && !compact
      ? countStableMessages(serverThread.messages)
      : (entry?.messageCount ?? (serverHasMessages ? countStableMessages(serverThread.messages) : 0));

    const localUpdatedAt = Math.max(snap?.updatedAt ?? 0, local?.updatedAt ?? 0);
    const localMsgCount = snap?.messageCount ?? countStableMessages(local?.messages);

    const stale =
      serverUpdatedAt > localUpdatedAt ||
      (serverUpdatedAt === localUpdatedAt && serverMsgCount !== localMsgCount);
    if (!stale) return;

    let changed = false;
    if (entry?.readOnly || !serverThread) {
      changed = await fetchAndApplySession(id);
    } else if (compact || !serverHasMessages) {
      changed = await fetchAndApplySession(id);
    } else {
      changed = mergeServerWebThread(serverThread, false);
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
    let ok = false;
    try {
      const prevCatalog = state.sessionCatalog;
      const [threadsRes, activeGens] = await Promise.all([
        apiFetch('/api/chat/threads?compact=1'),
        fetchActiveGenerations(),
      ]);
      if (!threadsRes.ok) {
        noteNetworkFailure();
        return;
      }
      const data = await threadsRes.json();
      const compactList = data.compact === true;

      const nextCatalog = Array.isArray(data.sessions) ? data.sessions : [];
      const catalogChanged = sessionCatalogDiffers(prevCatalog, nextCatalog);
      state.sessionCatalog = nextCatalog;
      const threadsChanged = mergeServerWebThreads(data.threads || [], compactList);

      if (catalogChanged || threadsChanged) renderThreadList();
      await syncActiveSession(data, compactList);
      await reconnectActiveGenerations(activeGens);
      ok = true;
    } catch {
      noteNetworkFailure();
    } finally {
      state.sessionSyncBusy = false;
      if (ok) noteNetworkRecovery();
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
    if (!entry) return;
    if (state.loadingSessionId === id) return;
    const existing = state.threads.find(t => t.id === id);
    const localCount = countStableMessages(existing?.messages);
    const expectCount = entry.messageCount ?? 0;
    if (localCount > 0 && (!expectCount || localCount >= expectCount)) return;
    if (!entry.readOnly && !expectCount && localCount === 0) return;
    state.loadingSessionId = id;
    try {
      const ok = await fetchAndApplySession(id);
      if (!ok) throw new Error('missing session');
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
      accountConfigDir: activeAccountConfigDir() || '',
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
    if (isMobileChatLayout()) setSidebar(false);
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
    if (isMobileChatLayout()) setSidebar(false);
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
      await apiFetch(`/api/chat/threads/${encodeURIComponent(id)}`, { method: 'DELETE' });
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
        await apiFetch(`/api/chat/threads/${encodeURIComponent(t.id)}`, { method: 'DELETE' });
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

  /** Update generating indicators without rebuilding the sidebar. */
  function patchThreadListBusyState() {
    const list = $('chat-thread-list');
    if (!list) return;
    list.querySelectorAll('.chat-thread-item[data-thread-id]').forEach(item => {
      const id = item.getAttribute('data-thread-id');
      const busy = id && state.streams.has(id);
      item.classList.toggle('generating', !!busy);
      let dot = item.querySelector('.chat-thread-busy');
      if (busy && !dot) {
        dot = el('span', { class: 'chat-thread-busy', title: 'Generating…' });
        item.insertBefore(dot, item.firstChild);
      } else if (!busy && dot) {
        dot.remove();
      }
    });
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
      class: `chat-thread-item${s.id === state.activeId ? ' active' : ''}${readOnly ? ' readonly' : ''}${busy ? ' generating' : ''}`,
      'data-thread-id': s.id,
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
  const openFromMessage = (idx) => {
    if (attachments.length > 1) {
      openAttachmentGallery(attachments, idx);
    } else {
      openAttachment(attachments[0]);
    }
  };
    return el('div', { class: 'chat-msg-attachments' },
      ...attachments.map((a, attIdx) => {
        const url = resolveAttachmentUrl(a);
        const name = a.name || 'file';
        if (isImageAttachment(a) && url) {
          return el('button', {
            type: 'button',
            class: 'chat-msg-attachment chat-msg-attachment-image',
            title: `Preview ${name}`,
            onclick: () => openFromMessage(attIdx),
          },
            el('img', { src: url, alt: name, loading: 'lazy' }),
          );
        }
        const actionLabel = isPdfAttachment(a) ? 'Preview PDF' : 'Download';
        return el('button', {
          type: 'button',
          class: 'chat-msg-attachment chat-msg-attachment-file',
          title: `${actionLabel}: ${name}`,
          onclick: () => openFromMessage(attIdx),
        },
          el('span', { class: 'chat-msg-attachment-icon' }, isPdfAttachment(a) ? '📄' : '📎'),
          el('span', { class: 'chat-msg-attachment-name' }, name),
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
    } else if (m.streaming) {
      bubble.innerHTML = renderStreamingBubbleHtml(m.content);
      bubble.classList.add('streaming-plain');
    } else {
      bubble.classList.remove('streaming-plain');
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

    if (!isUser) {
      wireCopyButtons(bubble);
      wireMermaidDiagrams(bubble);
    }
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
            bubble.classList.add('streaming-plain');
            bubble.innerHTML = renderStreamingBubbleHtml(last.content);
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

  function fmtCompactTokens(n) {
    const x = Number(n);
    if (!Number.isFinite(x) || x <= 0) return '0';
    if (x >= 1_000_000) return `${(x / 1_000_000).toFixed(1)}M`;
    if (x >= 1000) return `${(x / 1000).toFixed(1)}k`;
    return String(Math.round(x));
  }

  function accountUsageLabel(acc) {
    if (!acc || acc.error) return acc?.error ? 'err' : '—';
    const b = acc.billed;
    if (b && typeof b.costUsd === 'number') return `$${b.costUsd.toFixed(2)}`;
    const u = acc.usage;
    if (u) {
      const req = u.totalRequests;
      const tok = u.totalTokens;
      if (req > 0 && tok > 0) return `${req} req · ${fmtCompactTokens(tok)} tok`;
      if (req > 0) return `${req} req`;
      if (tok > 0) return `${fmtCompactTokens(tok)} tok`;
    }
    return '·';
  }

  function accountOptionLabel(acc) {
    const who = acc.email || acc.displayName || acc.name || 'account';
    const use = accountUsageLabel(acc);
    return `${who} (${use})`;
  }

  function selectedAccountRow() {
    const dir = activeAccountConfigDir();
    if (!dir) return null;
    return accountRows().find(a => a.configDir === dir) || null;
  }

  const MODELS_LOAD_PROGRESS_DELAY_MS = 280;
  const PAGE_LOAD_DEFAULT_TITLE = 'Loading chat…';
  const ACCOUNT_SWITCH_LOAD_TITLE = 'Switching account…';

  function updateAccountVisible() {
    const vis = $('chat-account-visible');
    const wrap = $('chat-account-wrap');
    const sel = $('chat-account');
    if (!vis || !wrap) return;
    const rows = accountRows();
    if (!rows.length) {
      vis.textContent = 'No Cursor account';
      wrap.classList.add('no-account');
      wrap.classList.remove('single-account', 'multi-account');
      if (sel) sel.classList.add('hidden');
      return;
    }
    const acc = selectedAccountRow() || rows[0];
    vis.textContent = accountOptionLabel(acc);
    wrap.classList.remove('no-account');
    if (rows.length <= 1) {
      wrap.classList.add('single-account');
      wrap.classList.remove('multi-account');
      if (sel) sel.classList.add('hidden');
    } else {
      wrap.classList.add('multi-account');
      wrap.classList.remove('single-account');
      if (sel) sel.classList.remove('hidden');
    }
  }

  function accountRows() {
    return state.accounts.filter(a => a.configDir);
  }

  function activeAccountConfigDir() {
    const thread = activeThread();
    if (thread?.accountConfigDir) return thread.accountConfigDir;
    const sel = $('chat-account');
    if (sel?.value) return sel.value;
    const first = accountRows()[0];
    return first?.configDir || '';
  }

  function ensureThreadAccountConfigDir(thread = activeThread()) {
    if (!thread || thread.readOnly) return;
    const rows = accountRows();
    if (!rows.length) return;
    const picked = activeAccountConfigDir();
    const valid = picked && rows.some(a => a.configDir === picked);
    const dir = valid ? picked : rows[0].configDir;
    if (thread.accountConfigDir !== dir) {
      thread.accountConfigDir = dir;
      markThreadDirty(thread.id);
    }
  }

  function renderAccountOptions() {
    const sel = $('chat-account');
    if (!sel) return;
    const rows = accountRows();
    const picked = activeAccountConfigDir();
    if (!rows.length) {
      sel.replaceChildren(el('option', { value: '' }, 'No Cursor account'));
      sel.disabled = true;
      updateAccountVisible();
      return;
    }
    sel.replaceChildren(
      ...rows.map(acc => el('option', {
        value: acc.configDir,
        title: `${acc.email || acc.name || ''} · ${accountUsageLabel(acc)}`,
      }, accountOptionLabel(acc))),
    );
    if (picked && rows.some(a => a.configDir === picked)) sel.value = picked;
    else if (rows[0]) sel.value = rows[0].configDir;
    sel.disabled = rows.length <= 1;
    ensureThreadAccountConfigDir();
    updateAccountVisible();
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
    renderAccountOptions();
    renderModelOptions();
    renderComposerState();
    renderContextUsage();
  }

  function renderComposerState() {
    const busy = isBusy();
    const readOnly = isReadOnlySession();
    const noAccount = !accountRows().length;
    const send = $('chat-send');
    const stop = $('chat-stop');
    send?.classList.toggle('hidden', busy || readOnly || noAccount);
    stop?.classList.toggle('hidden', !busy);
    const input = $('chat-input');
    if (input) {
      input.disabled = readOnly || noAccount;
      if (readOnly) {
        input.placeholder = 'Read-only session — start a new web chat to continue';
      } else if (noAccount) {
        input.placeholder = 'No Cursor account — sign in from the dashboard';
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

  const STATUS_POLL_MS = 30_000;
  const NETWORK_FAIL_THRESHOLD = 2;

  function isTransientNetworkError(e) {
    if (!e || e.name === 'AbortError') return false;
    if (e instanceof TypeError) return true;
    const m = String(e.message || e).toLowerCase();
    return (
      m.includes('network')
      || m.includes('failed to fetch')
      || m.includes('load failed')
      || m.includes('connection')
      || m.includes('internet')
    );
  }

  function setChatPageLoading(on, opts = {}) {
    const overlay = $('chat-page-load');
    if (!overlay) return;
    const titleEl = $('chat-page-load-title');
    if (on) {
      if (opts.title && titleEl) titleEl.textContent = opts.title;
      overlay.classList.toggle('page-load-overlay--chat', !opts.blocking);
    } else {
      if (titleEl) titleEl.textContent = PAGE_LOAD_DEFAULT_TITLE;
      overlay.classList.add('page-load-overlay--chat');
    }
    overlay.classList.toggle('hidden', !on);
    overlay.hidden = !on;
    overlay.setAttribute('aria-busy', on ? 'true' : 'false');
  }

  function setAccountSwitchLoading(on) {
    if (on) {
      setChatPageLoading(true, { title: ACCOUNT_SWITCH_LOAD_TITLE, blocking: true });
    } else {
      setChatPageLoading(false);
    }
  }

  function setNetworkBanner(down, message) {
    state.networkDown = down;
    const bar = $('chat-network-banner');
    const text = $('chat-network-banner-text');
    if (!bar) return;
    if (!down) {
      bar.classList.add('hidden');
      bar.hidden = true;
      return;
    }
    if (message && text) text.textContent = message;
    bar.classList.remove('hidden');
    bar.hidden = false;
  }

  function noteNetworkFailure() {
    state.networkFailStreak += 1;
    if (state.networkFailStreak >= NETWORK_FAIL_THRESHOLD || !navigator.onLine) {
      setNetworkBanner(
        true,
        navigator.onLine
          ? 'Cannot reach the proxy. Retrying…'
          : 'Connection lost. Your chats will sync again when the network is back.',
      );
    }
    const dot = $('chat-brand-dot');
    if (dot && state.networkFailStreak >= NETWORK_FAIL_THRESHOLD) dot.classList.add('down');
  }

  function noteNetworkRecovery() {
    const wasDown = state.networkDown;
    state.networkFailStreak = 0;
    if (wasDown) {
      setNetworkBanner(false);
      toast('Back online — syncing…');
      void refreshAgentStatus();
      void pollSessionUpdates();
    }
  }

  async function refreshAgentStatus() {
    const dot = $('chat-brand-dot');
    if (!dot) return;
    try {
      const r = await apiFetch('/api/status');
      if (!r.ok) throw new Error(String(r.status));
      const s = await r.json();
      dot.classList.toggle('down', !s.running);
      dot.title = s.running
        ? `Bridge running · v${s.version || ''}`
        : 'Bridge not running';
      state.networkFailStreak = 0;
      if (state.networkDown) noteNetworkRecovery();
    } catch {
      dot.classList.add('down');
      dot.title = 'Cannot reach bridge';
      noteNetworkFailure();
    }
  }

  function startAgentStatusPolling() {
    if (state.statusPollTimer) return;
    void refreshAgentStatus();
    state.statusPollTimer = setInterval(() => void refreshAgentStatus(), STATUS_POLL_MS);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) void refreshAgentStatus();
    });
    window.addEventListener('online', () => {
      state.networkFailStreak = 0;
      noteNetworkRecovery();
    });
    window.addEventListener('offline', () => {
      setNetworkBanner(
        true,
        'Connection lost. Your chats will sync again when the network is back.',
      );
      const dot = $('chat-brand-dot');
      dot?.classList.add('down');
    });
  }

  function markStreamInterrupted(msg) {
    msg.interrupted = true;
    msg.error = false;
    delete msg.errorDetail;
    if (!msg.content?.trim()) msg.content = '';
  }

  async function loadConfig() {
    try {
      const r = await apiFetch('/api/config');
      if (!r.ok) throw new Error(String(r.status));
      state.config = await r.json();
    } catch {
      state.config = { defaultModel: 'auto', mode: 'agent' };
    }
    renderToolbar();
    if (!activeThread()?.messages.length) renderMessages();
  }

  async function loadModels(configDir, opts = {}) {
    const { showProgress = false } = opts;
    const dir = configDir || activeAccountConfigDir();
    const seq = ++state.modelsLoadSeq;
    if (state.modelsLoadProgressTimer) {
      clearTimeout(state.modelsLoadProgressTimer);
      state.modelsLoadProgressTimer = null;
    }
    if (showProgress) setAccountSwitchLoading(false);

    if (!dir) {
      state.models = [];
      renderModelOptions();
      return;
    }
    if (showProgress) {
      state.modelsLoadProgressTimer = setTimeout(() => {
        if (seq === state.modelsLoadSeq) setAccountSwitchLoading(true);
      }, MODELS_LOAD_PROGRESS_DELAY_MS);
    }
    const qs = `?configDir=${encodeURIComponent(dir)}`;
    try {
      const r = await apiFetch(`/api/agent/models${qs}`);
      if (!r.ok) throw new Error(String(r.status));
      const data = await r.json();
      if (seq !== state.modelsLoadSeq) return;
      state.models = (data.data || []).filter(m => m && m.id);
    } catch {
      if (seq !== state.modelsLoadSeq) return;
      state.models = [];
    } finally {
      if (seq === state.modelsLoadSeq) {
        if (state.modelsLoadProgressTimer) {
          clearTimeout(state.modelsLoadProgressTimer);
          state.modelsLoadProgressTimer = null;
        }
        if (showProgress) setAccountSwitchLoading(false);
        renderModelOptions();
      }
    }
  }

  async function refreshAccounts() {
    try {
      const r = await apiFetch('/api/cursor-account');
      if (!r.ok) throw new Error(String(r.status));
      const data = await r.json();
      state.accounts = Array.isArray(data.accounts) ? data.accounts : [];
      state.accountSnapshotAt = data.fetchedAt || null;
    } catch {
      state.accounts = [];
    }
    renderAccountOptions();
    renderComposerState();
    const dir = activeAccountConfigDir();
    if (dir) await loadModels(dir);
  }

  function startAccountUsagePolling() {
    if (state.accountRefreshTimer) return;
    void refreshAccounts();
    state.accountRefreshTimer = setInterval(() => void refreshAccounts(), ACCOUNT_USAGE_POLL_MS);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) void refreshAccounts();
    });
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
      const imgUrl = resolveAttachmentUrl(a);
      if ((a.mimeType || '').startsWith('image/') && imgUrl) {
        parts.push({ type: 'image_url', image_url: { url: imgUrl } });
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
    const payload = {
      threadId: thread.id,
      model: thread.model || cfg.defaultModel,
      mode: thread.mode || cfg.mode || 'agent',
      stream: true,
      messages: thread.messages
        .filter(m => !m.streaming && !m.error && messageHasPayload(m))
        .map(mapMessageForApi),
    };
    const accountDir = thread.accountConfigDir || activeAccountConfigDir();
    payload.accountConfigDir = accountDir || '';
    return payload;
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
      patchThreadListBusyState();
      return;
    }
    if (streaming) schedulePaint();
    else renderMessages();
  }

  function applyGenerationEvent(thread, msg, event) {
    if (event.type === 'snapshot') {
      msg.content = event.content || '';
      if (event.reasoning) msg.reasoning = event.reasoning;
      msg.streaming = event.status === 'running';
      if (event.status === 'error') {
        msg.error = true;
        if (event.error) msg.errorDetail = event.error;
        if (!msg.content?.trim()) msg.content = event.error || 'Generation failed';
      }
      if (event.contextWindowUsage) applyContextUsageToThread(thread, event.contextWindowUsage);
      return;
    }
    if (event.type === 'context_usage') {
      applyContextUsageToThread(thread, event.usage);
      if (thread.id === state.activeId) renderContextUsage();
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
    patchThreadListBusyState();

    try {
      const res = await apiFetch(`/api/chat/generations/${encodeURIComponent(thread.id)}/stream`, {
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
          applyGenerationEvent(thread, msg, event);
          if (event.type === 'delta' || event.type === 'snapshot') repaint(thread, event.type === 'delta');
          if (event.type === 'context_usage' || (event.type === 'snapshot' && event.contextWindowUsage)) {
            if (thread.id === state.activeId) renderContextUsage();
          }
          if (event.type === 'done') break;
        }
      }
      if (!msg.content && !msg.reasoning) msg.content = '(empty reply)';
    } catch (e) {
      if (e.name === 'AbortError') {
        /* user stop */
      } else if (isTransientNetworkError(e)) {
        markStreamInterrupted(msg);
        setNetworkBanner(
          true,
          navigator.onLine
            ? 'Connection interrupted. Will resume when the network is back.'
            : 'Connection lost. Your chats will sync again when the network is back.',
        );
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
      if (!msg.interrupted) touch(thread);
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
      if (last?.role === 'assistant' && !last.streaming && last.content?.trim() && !last.interrupted) continue;
      if (last?.interrupted) {
        delete last.interrupted;
        last.streaming = true;
      }
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
    patchThreadListBusyState();

    try {
      const res = await apiFetch('/api/agent/chat', {
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
          if (json.object === 'bridge.context_usage' && json.usage) {
            applyContextUsageToThread(thread, json.usage);
            if (thread.id === state.activeId) renderContextUsage();
            continue;
          }
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
      } else if (isTransientNetworkError(e)) {
        markStreamInterrupted(msg);
        setNetworkBanner(
          true,
          navigator.onLine
            ? 'Connection interrupted. Will resume when the network is back.'
            : 'Connection lost. Your chats will sync again when the network is back.',
        );
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
      if (!msg.interrupted) touch(thread);
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

  async function compressImageForUpload(file) {
    if (!file.type?.startsWith('image/')) return file;
    if (file.type === 'image/gif' || file.type === 'image/svg+xml') return file;
    if (file.size < IMAGE_COMPRESS_MIN_BYTES) return file;
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      return file;
    }
    const scale = Math.min(1, IMAGE_MAX_EDGE_PX / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close?.();
      return file;
    }
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const preferWebp = file.type === 'image/webp';
    const mime = preferWebp ? 'image/webp' : 'image/jpeg';
    const blob = await new Promise((resolve) => {
      canvas.toBlob((b) => resolve(b || file), mime, IMAGE_JPEG_QUALITY);
    });
    if (!(blob instanceof Blob) || blob.size >= file.size) return file;
    const ext = preferWebp ? '.webp' : '.jpg';
    const base = file.name.replace(/\.[^.]+$/, '') || 'image';
    return new File([blob], `${base}${ext}`, { type: mime, lastModified: file.lastModified });
  }

  function uploadAttachmentMultipart(file, previewUrl, onProgress) {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open(
        'POST',
        typeof bridgePath === "function" ? bridgePath('/api/chat/upload') : '/api/chat/upload',
      );
      xhr.responseType = 'json';
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable && typeof onProgress === 'function') {
          onProgress(ev.loaded / ev.total);
        }
      };
      xhr.onload = () => {
        const ok = xhr.status >= 200 && xhr.status < 300;
        const body = xhr.response && typeof xhr.response === 'object'
          ? xhr.response
          : (() => {
            try { return JSON.parse(xhr.responseText || '{}'); } catch { return {}; }
          })();
        if (!ok) {
          const detail = body?.error?.message || `${xhr.status}`;
          toast(`Upload failed: ${detail}`);
          resolve(null);
          return;
        }
        const att = body.attachment;
        if (!att?.path) {
          resolve(null);
          return;
        }
        const mimeType = att.mimeType || file.type || 'application/octet-stream';
        const item = {
          name: att.name || file.name,
          mimeType,
          path: att.path,
          url: att.url,
          size: att.size,
        };
        if (mimeType.startsWith('image/')) {
          item.previewUrl = previewUrl || att.url;
        }
        resolve(item);
      };
      xhr.onerror = () => {
        toast('Upload failed: network error');
        resolve(null);
      };
      const fd = new FormData();
      fd.append('file', file, file.name);
      xhr.send(fd);
    });
  }

  async function uploadAttachment(file, previewUrl, onProgress) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      toast(`File too large (max ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB)`);
      return null;
    }
    let payload = file;
    if (file.type?.startsWith('image/')) {
      try {
        payload = await compressImageForUpload(file);
      } catch {
        payload = file;
      }
    }
    return uploadAttachmentMultipart(payload, previewUrl, onProgress);
  }

  async function mapWithConcurrency(items, limit, fn) {
    const out = [];
    let i = 0;
    async function worker() {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    }
    const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
    await Promise.all(workers);
    return out;
  }

  async function addAttachmentFiles(fileList) {
    if (isReadOnlySession()) {
      toast('This session is read-only');
      return;
    }
    const files = Array.from(fileList || []).filter(Boolean);
    if (!files.length) return;
    const placeholders = files.map((file) => {
      const previewUrl =
        file.type?.startsWith('image/') ? URL.createObjectURL(file) : undefined;
      const placeholder = {
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        path: '',
        url: '',
        previewUrl,
        uploading: true,
        uploadProgress: 0,
      };
      state.pendingAttachments.push(placeholder);
      state.pendingPreviewIndex = state.pendingAttachments.length - 1;
      return { file, placeholder, previewUrl };
    });
    renderPendingAttachments();
    await mapWithConcurrency(placeholders, 3, async ({ file, placeholder, previewUrl }) => {
      try {
        const item = await uploadAttachment(file, previewUrl, (ratio) => {
          placeholder.uploadProgress = ratio;
          renderPendingAttachments();
        });
        const idx = state.pendingAttachments.indexOf(placeholder);
        if (!item) {
          if (idx >= 0) state.pendingAttachments.splice(idx, 1);
          if (previewUrl) URL.revokeObjectURL(previewUrl);
          return;
        }
        if (idx >= 0) {
          state.pendingAttachments[idx] = item;
        } else {
          state.pendingAttachments.push(item);
        }
      } catch (e) {
        const idx = state.pendingAttachments.indexOf(placeholder);
        if (idx >= 0) state.pendingAttachments.splice(idx, 1);
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        toast(`Upload failed: ${e.message || e}`);
      }
    });
    renderPendingAttachments();
  }

  function removePendingAttachment(idx) {
    const item = state.pendingAttachments[idx];
    if (item?.previewUrl?.startsWith('blob:')) {
      try { URL.revokeObjectURL(item.previewUrl); } catch { /* ignore */ }
    }
    state.pendingAttachments.splice(idx, 1);
    if (!state.pendingAttachments.length) {
      state.pendingPreviewIndex = 0;
    } else if (state.pendingPreviewIndex >= state.pendingAttachments.length) {
      state.pendingPreviewIndex = state.pendingAttachments.length - 1;
    } else if (idx < state.pendingPreviewIndex) {
      state.pendingPreviewIndex -= 1;
    }
    renderPendingAttachments();
  }

  function shiftPendingPreview(delta) {
    const n = state.pendingAttachments.length;
    if (n < 2) return;
    state.pendingPreviewIndex = (state.pendingPreviewIndex + delta + n) % n;
    renderPendingAttachments();
  }

  function buildPendingPreviewBody(att) {
    if (att.uploading) {
      return el('div', { class: 'chat-attachments-preview-uploading' },
        el('span', { class: 'chat-attachment-spinner', 'aria-hidden': 'true' }, '…'),
        el('span', {}, 'Uploading…'),
        typeof att.uploadProgress === 'number'
          ? el('div', { class: 'chat-attachment-progress', role: 'progressbar' },
            el('div', {
              class: 'chat-attachment-progress-fill',
              style: { width: `${Math.round(Math.min(1, att.uploadProgress) * 100)}%` },
            }),
          )
          : null,
      );
    }
    const src = attachmentPreviewSrc(att);
    if (isImageAttachment(att) && src) {
      return el('img', {
        class: 'chat-attachments-preview-img',
        src,
        alt: att.name || '',
      });
    }
    return el('div', { class: 'chat-attachments-preview-file' },
      el('span', { class: 'chat-attachments-preview-file-icon' }, isPdfAttachment(att) ? '📄' : '📎'),
      el('span', { class: 'chat-attachments-preview-file-name', title: att.name }, att.name || 'file'),
    );
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
    const multi = items.length > 1;
    if (state.pendingPreviewIndex >= items.length) {
      state.pendingPreviewIndex = items.length - 1;
    }
    if (state.pendingPreviewIndex < 0) state.pendingPreviewIndex = 0;
    const active = items[state.pendingPreviewIndex];
    wrap.hidden = false;

    const previewStage = el('div', { class: 'chat-attachments-preview-stage' },
      buildPendingPreviewBody(active),
    );
    if (!active.uploading && (active.path || resolveAttachmentUrl(active))) {
      previewStage.classList.add('is-clickable');
      previewStage.title = 'Open full preview';
      previewStage.addEventListener('click', () => openAttachmentGallery(items, state.pendingPreviewIndex));
    }

    const carousel = el('div', { class: 'chat-attachments-carousel' },
      el('button', {
        type: 'button',
        class: 'chat-attachments-nav chat-attachments-nav-prev',
        title: 'Previous attachment',
        'aria-label': 'Previous attachment',
        disabled: !multi,
        onclick: () => shiftPendingPreview(-1),
      }, '‹'),
      el('div', { class: 'chat-attachments-preview' },
        previewStage,
        el('div', { class: 'chat-attachments-preview-label', title: active.name },
          el('span', { class: 'chat-attachments-preview-name' }, active.name || 'file'),
          multi
            ? el('span', { class: 'chat-attachments-preview-counter mono' },
              `${state.pendingPreviewIndex + 1} / ${items.length}`,
            )
            : null,
        ),
      ),
      el('button', {
        type: 'button',
        class: 'chat-attachments-nav chat-attachments-nav-next',
        title: 'Next attachment',
        'aria-label': 'Next attachment',
        disabled: !multi,
        onclick: () => shiftPendingPreview(1),
      }, '›'),
    );

    const chips = el('div', { class: 'chat-attachments-chips' }, ...items.map((a, i) => {
      const preview = a.uploading
        ? el('span', { class: 'chat-attachment-icon chat-attachment-spinner', title: 'Uploading' }, '…')
        : a.previewUrl
          ? el('img', { src: a.previewUrl, alt: '' })
          : el('span', { class: 'chat-attachment-icon' }, '📎');
      const progressBar = a.uploading && typeof a.uploadProgress === 'number'
        ? el('div', { class: 'chat-attachment-progress', role: 'progressbar' },
          el('div', {
            class: 'chat-attachment-progress-fill',
            style: { width: `${Math.round(Math.min(1, a.uploadProgress) * 100)}%` },
          }),
        )
        : null;
      const chip = el('div', {
        class: 'chat-attachment-chip'
          + (a.uploading ? ' is-uploading' : '')
          + (i === state.pendingPreviewIndex ? ' is-active' : ''),
      },
        preview,
        el('div', { class: 'chat-attachment-meta' },
          el('span', { class: 'chat-attachment-name', title: a.name }, a.name),
          progressBar,
        ),
        el('button', {
          type: 'button',
          class: 'chat-attachment-remove',
          title: 'Remove',
          onclick: (e) => {
            e.stopPropagation();
            removePendingAttachment(i);
          },
        }, '×'),
      );
      if (!a.uploading && (a.path || resolveAttachmentUrl(a))) {
        chip.classList.add('is-clickable');
      }
      chip.title = a.name || 'attachment';
      chip.addEventListener('click', () => {
        state.pendingPreviewIndex = i;
        renderPendingAttachments();
      });
      return chip;
    }));

    wrap.replaceChildren(carousel, chips);
  }

  async function submitUserMessage(text, attachments) {
    const clean = String(text ?? '').trim();
    const atts = attachments ?? state.pendingAttachments;
    if (!clean && !atts.length) return;
    if (isReadOnlySession()) {
      toast('This session is read-only');
      return;
    }
    if (!activeAccountConfigDir()) {
      toast('No Cursor account — sign in from the dashboard');
      return;
    }
    const thread = ensureActiveThread();
    ensureThreadAccountConfigDir(thread);
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
    state.pendingPreviewIndex = 0;
    renderPendingAttachments();
    await startAssistant(thread);
  }

  function submitEdit(idx, text) {
    const thread = activeThread();
    const clean = String(text ?? '').trim();
    const original = thread?.messages[idx];
    const preserved = original?.attachments;
    if (!thread || (!clean && !preserved?.length) || isBusy(thread)) return;
    if (!activeAccountConfigDir()) {
      toast('No Cursor account — sign in from the dashboard');
      return;
    }
    ensureThreadAccountConfigDir(thread);
    thread.messages = thread.messages.slice(0, idx);
    state.editingIdx = null;
    const msg = { role: 'user', content: clean, ts: Date.now() };
    if (preserved?.length) {
      msg.attachments = preserved.map(a => ({
        name: a.name,
        mimeType: a.mimeType,
        path: a.path,
        url: a.path ? toWorkspaceFileUrl(a.path) : a.url,
        size: a.size,
      }));
    }
    thread.messages.push(msg);
    void startAssistant(thread);
  }

  function regenerateReply() {
    const thread = activeThread();
    if (!thread || isBusy(thread)) return;
    if (!activeAccountConfigDir()) {
      toast('No Cursor account — sign in from the dashboard');
      return;
    }
    ensureThreadAccountConfigDir(thread);
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
    void apiFetch(`/api/chat/generations/${encodeURIComponent(t.id)}`, { method: 'DELETE' }).catch(() => undefined);
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
    const prev = document.documentElement.getAttribute('data-theme');
    document.documentElement.dataset.theme = theme;
    const hl = $('hljs-theme-note');
    if (hl) hl.dataset.theme = theme;
    const btn = $('chat-theme');
    if (btn) btn.textContent = theme === 'light' ? '🌙' : '☀️';
    if (prev && prev !== theme) {
      void refreshMermaidDiagramsForTheme();
    }
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
    if (isMobileChatLayout()) open = false;
    return open;
  }

  function setSidebar(open) {
    $('chat-shell')?.classList.toggle('sidebar-collapsed', !open);
    try { localStorage.setItem(SIDEBAR_KEY, open ? '1' : '0'); } catch { /* ignore */ }
  }

  function readSidebarWidth() {
    try {
      const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
      const n = raw != null ? Number.parseInt(raw, 10) : SIDEBAR_WIDTH_DEFAULT;
      if (!Number.isFinite(n)) return SIDEBAR_WIDTH_DEFAULT;
      return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, n));
    } catch {
      return SIDEBAR_WIDTH_DEFAULT;
    }
  }

  function applySidebarWidth(px) {
    const w = Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(px)));
    document.documentElement.style.setProperty('--chat-sidebar-width', `${w}px`);
    try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(w)); } catch { /* ignore */ }
    return w;
  }

  function initSidebarWidth() {
    applySidebarWidth(readSidebarWidth());
  }

  function bindSidebarResize() {
    const handle = $('chat-sidebar-resize');
    const shell = $('chat-shell');
    if (!handle || !shell) return;

    const onPointerMove = e => {
      if (!shell.classList.contains('sidebar-resizing')) return;
      const sidebar = $('chat-sidebar');
      const left = sidebar?.getBoundingClientRect().left ?? 0;
      applySidebarWidth(e.clientX - left);
    };

    const endResize = () => {
      shell.classList.remove('sidebar-resizing');
      document.body.classList.remove('chat-sidebar-dragging');
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', endResize);
      window.removeEventListener('pointercancel', endResize);
    };

    const startResize = e => {
      if (isMobileChatLayout() || !sidebarOpen()) return;
      e.preventDefault();
      shell.classList.add('sidebar-resizing');
      document.body.classList.add('chat-sidebar-dragging');
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', endResize);
      window.addEventListener('pointercancel', endResize);
    };

    handle.addEventListener('pointerdown', startResize);

    handle.addEventListener('keydown', e => {
      if (isMobileChatLayout()) return;
      let delta = 0;
      if (e.key === 'ArrowLeft') delta = -16;
      else if (e.key === 'ArrowRight') delta = 16;
      else if (e.key === 'Home') applySidebarWidth(SIDEBAR_WIDTH_MIN);
      else if (e.key === 'End') applySidebarWidth(SIDEBAR_WIDTH_MAX);
      else return;
      e.preventDefault();
      applySidebarWidth(readSidebarWidth() + delta);
    });

    handle.addEventListener('dblclick', () => {
      if (isMobileChatLayout()) return;
      applySidebarWidth(SIDEBAR_WIDTH_DEFAULT);
    });
  }

  /** Mobile browsers: sync --chat-vh when URL bar / keyboard changes visible viewport. */
  function bindChatViewportHeight() {
    const root = document.documentElement;
    const apply = () => {
      const h = window.visualViewport?.height ?? window.innerHeight;
      if (h > 0) root.style.setProperty('--chat-vh', `${Math.round(h)}px`);
      window.ChatTerminal?.fit?.();
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
    $('chat-sidebar-collapse')?.addEventListener('click', () => setSidebar(false));
    $('chat-scroll-bottom')?.addEventListener('click', () => {
      state.stickToBottom = true;
      scrollToBottom(true);
    });

    const search = $('chat-search');
    search?.addEventListener('input', () => {
      state.searchQuery = search.value;
      if (state.searchDebounce) clearTimeout(state.searchDebounce);
      state.searchDebounce = setTimeout(() => {
        state.searchDebounce = null;
        renderThreadList();
      }, 120);
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

    $('chat-account')?.addEventListener('change', e => {
      if (isReadOnlySession() || e.target.disabled) return;
      const t = ensureActiveThread();
      t.accountConfigDir = e.target.value;
      markThreadDirty(t.id);
      updateAccountVisible();
      void loadModels(t.accountConfigDir, { showProgress: true });
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
      } else if (mod && e.key === '\\') {
        e.preventDefault();
        setSidebar(!sidebarOpen());
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
        apiFetch('/api/chat/threads', {
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
    setChatPageLoading(true);
    initTheme();
    initMarked();
    bindChatViewportHeight();
    initSidebarWidth();
    setSidebar(resolveSidebarOpen());
    bind();
    bindSidebarResize();
    try {
      MOBILE_LAYOUT_MQ.addEventListener('change', e => {
        if (e.matches) setSidebar(false);
      });
    } catch { /* ignore */ }
    let activeGens = [];
    try {
      activeGens = await loadThreads();
      ensureActiveThread();
      if (state.activeId) await ensureExternalSessionLoaded(state.activeId);
      await reconnectActiveGenerations(activeGens);

      setSidebar(resolveSidebarOpen());

      await refreshAccounts();
      renderAll();
      void loadConfig();
      startAccountUsagePolling();
      startSessionSync();
      startAgentStatusPolling();
      void pollSessionUpdates();
    } finally {
      setChatPageLoading(false);
    }
    const input = $('chat-input');
    if (input) {
      autoResizeInput(input);
      if (!isReadOnlySession()) input.focus();
    }
    updateScrollButton();
  }

  const MOBILE_LAYOUT_MQ = window.matchMedia('(max-width: 768px)');

  function isMobileChatLayout() {
    return MOBILE_LAYOUT_MQ.matches;
  }

  /** Collapse sidebar on mobile before paint/async work (avoids full-screen backdrop). */
  (function initMobileSidebarCollapsed() {
    try {
      if (!isMobileChatLayout()) return;
      document.getElementById('chat-shell')?.classList.add('sidebar-collapsed');
    } catch { /* ignore */ }
  })();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
