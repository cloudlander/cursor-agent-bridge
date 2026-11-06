(() => {
  'use strict';

  const POLL_MS = 90_000;

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

  function fmtAccountLine(account, thresholdPct) {
    const name = account.label || 'account';
    if (account.status === 'rate_limited') {
      return `${name}: rate limited — routing uses default model`;
    }
    if (account.remainingPercent == null) {
      return `${name}: quota unknown`;
    }
    const pct = `${account.remainingPercent}%`;
    const tag =
      account.status === 'low'
        ? 'LOW'
        : account.status === 'ok'
          ? 'OK'
          : 'unknown';
    return `${name}: ${pct} remaining (${tag})`;
  }

  function buildMarqueeText(data) {
    const thresholdPct = Math.round((data.threshold ?? 0.1) * 1000) / 10;
    const parts = [];
    if (Array.isArray(data.accounts) && data.accounts.length) {
      for (const a of data.accounts) {
        parts.push(fmtAccountLine(a, thresholdPct));
      }
    } else {
      parts.push('No account pool directories — quota uses default Cursor profile');
    }
    parts.push(`Router threshold ${thresholdPct}%`);
    if (data.monthlyBudgetUsd > 0) {
      parts.push(`Monthly budget reference $${data.monthlyBudgetUsd}`);
    }
    return parts.join(' · ');
  }

  function renderQuotaBanner(data) {
    const bar = $('router-quota-banner');
    if (!bar) return;

    if (!data || !data.enabled) {
      bar.classList.add('hidden');
      bar.hidden = true;
      bar.replaceChildren();
      return;
    }

    const text = buildMarqueeText(data);
    bar.classList.remove('hidden');
    bar.hidden = false;
    bar.dataset.kind =
      Array.isArray(data.accounts) &&
      data.accounts.some((a) => a.status === 'low' || a.status === 'rate_limited')
        ? 'warn'
        : 'info';

    bar.replaceChildren();
    const track = el('div', { class: 'router-quota-marquee-track' });
    const line = el('span', { class: 'router-quota-marquee-text' }, text);
    track.appendChild(line);
    track.appendChild(line.cloneNode(true));
    bar.appendChild(track);

    const actions = el('div', { class: 'router-quota-banner-actions' });
    const cfgBtn = el(
      'button',
      { type: 'button', class: 'btn small' },
      'Configure routing',
    );
    cfgBtn.addEventListener('click', () => {
      if (window.RouterConfigUI?.open) {
        window.RouterConfigUI.open();
        return;
      }
      window.location.href = '/chat#routing';
    });
    actions.appendChild(cfgBtn);
    bar.appendChild(actions);
  }

  async function refreshRouterQuotaBanner() {
    try {
      const res = await fetch('/api/router/quota');
      if (!res.ok) return;
      const data = await res.json();
      renderQuotaBanner(data);
    } catch {
      /* ignore */
    }
  }

  function start() {
    void refreshRouterQuotaBanner();
    setInterval(() => void refreshRouterQuotaBanner(), POLL_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
