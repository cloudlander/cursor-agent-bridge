(() => {
  'use strict';

  const POLL_MS = 60_000;
  const SEEN_KEY = 'upstreamSyncBannerSeenId';

  function $(id) {
    return document.getElementById(id);
  }

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') node.className = v;
        else if (k.startsWith('on') && typeof v === 'function') {
          node.addEventListener(k.slice(2), v);
        } else if (v != null) node.setAttribute(k, v);
      }
    }
    for (const c of children) {
      if (c == null) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  function dashboardToast(message, kind) {
    const stack = $('toasts');
    if (!stack) return;
    const t = el('div', { class: `toast ${kind || 'ok'}` }, message);
    stack.appendChild(t);
    setTimeout(() => {
      t.style.transition = 'opacity 0.2s';
      t.style.opacity = '0';
      setTimeout(() => t.remove(), 200);
    }, 6000);
  }

  async function dismissBanner() {
    try {
      await fetch('/api/upstream-sync/dismiss', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
    } catch {
      /* ignore */
    }
    const bar = $('upstream-sync-banner');
    if (bar) {
      bar.classList.add('hidden');
      bar.hidden = true;
      bar.replaceChildren();
    }
  }

  function renderBanner(banner) {
    const bar = $('upstream-sync-banner');
    if (!bar) return;
    if (!banner) {
      bar.classList.add('hidden');
      bar.hidden = true;
      bar.replaceChildren();
      return;
    }

    bar.classList.remove('hidden');
    bar.hidden = false;
    bar.dataset.kind = banner.kind;
    bar.replaceChildren();

    const text = el('div', { class: 'upstream-sync-banner-text' });
    text.appendChild(el('strong', {}, banner.title));
    if (banner.detail) {
      text.appendChild(document.createTextNode(` — ${banner.detail}`));
    }
    if (banner.needsRestart) {
      text.appendChild(
        el('span', { class: 'upstream-sync-banner-restart' }, ' Restart the proxy to apply server changes.'),
      );
    }

    const actions = el('div', { class: 'upstream-sync-banner-actions' });
    if (banner.needsRestart && $('toasts')) {
      const restartBtn = el(
        'button',
        { type: 'button', class: 'btn small primary' },
        'Restart proxy',
      );
      restartBtn.addEventListener('click', () => {
        const ctrl = document.querySelector('[data-action="restart"]');
        if (ctrl) ctrl.click();
        else dashboardToast('Use your process manager to restart the proxy.', 'warn');
      });
      actions.appendChild(restartBtn);
    }
    actions.appendChild(
      el(
        'button',
        { type: 'button', class: 'btn small' },
        'Dismiss',
      ),
    );
    actions.lastChild.addEventListener('click', () => void dismissBanner());

    bar.appendChild(text);
    bar.appendChild(actions);

    try {
      const seen = sessionStorage.getItem(SEEN_KEY);
      if (seen !== banner.id) {
        sessionStorage.setItem(SEEN_KEY, banner.id);
        if ($('toasts')) {
          const kind = banner.kind === 'error' ? 'err' : banner.kind === 'success' ? 'ok' : 'warn';
          dashboardToast(banner.title, kind);
        }
      }
    } catch {
      /* ignore */
    }
  }

  async function refreshUpstreamSyncBanner() {
    try {
      const res = await fetch('/api/upstream-sync');
      if (!res.ok) return;
      const data = await res.json();
      renderBanner(data.banner);
    } catch {
      /* ignore */
    }
  }

  function start() {
    void refreshUpstreamSyncBanner();
    setInterval(() => void refreshUpstreamSyncBanner(), POLL_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
