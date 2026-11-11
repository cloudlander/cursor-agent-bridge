(() => {
  'use strict';

  const $ = id => document.getElementById(id);

  const state = {
    paused: false,
    autoscroll: true,
    statusTimer: null,
    logTimer: null,
    logIntervalMs: 3000,
    logIntervalApplyTimer: null,
    statsTimer: null,
    cursorAccountTimer: null,
    lastStatusOk: true,
    agentAuthenticated: false,
    loginPollTimer: null,
    loginSessionId: null,
    dashboardPolling: false,
  };

  function fmtTokens(n) {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 10_000) return `${Math.round(n / 1000)}k`;
    return String(n);
  }

  function fmtUsd(amount) {
    if (amount < 0.01) return '< $0.01';
    if (amount < 1) return `$${amount.toFixed(3)}`;
    return `$${amount.toFixed(2)}`;
  }

  function fmtDuration(seconds) {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  }

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of children) {
      if (c == null) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  function toast(message, kind = 'ok', ttl = 3500) {
    const t = el('div', { class: `toast ${kind}` }, message);
    $('toasts').appendChild(t);
    setTimeout(() => {
      t.style.transition = 'opacity 0.2s';
      t.style.opacity = '0';
      setTimeout(() => t.remove(), 200);
    }, ttl);
  }

  function popup({ title, message, okText = 'OK', cancelText = null, danger = false }) {
    return new Promise(resolve => {
      const overlay = el('div', { class: 'popup-overlay' });
      const card = el('div', { class: 'popup-card' });
      const head = el('div', { class: 'popup-head' }, title);
      const body = el('div', { class: 'popup-body' }, message);
      const actions = el('div', { class: 'popup-actions' });
      const okBtn = el('button', { class: `btn small ${danger ? 'danger' : 'primary'}` }, okText);
      let cancelBtn = null;

      function finish(value) {
        document.removeEventListener('keydown', onKeyDown);
        overlay.remove();
        resolve(value);
      }

      function onKeyDown(e) {
        if (e.key === 'Escape') finish(false);
      }

      if (cancelText) {
        cancelBtn = el('button', { class: 'btn small' }, cancelText);
        cancelBtn.addEventListener('click', () => finish(false));
        actions.appendChild(cancelBtn);
      }
      okBtn.addEventListener('click', () => finish(true));
      actions.appendChild(okBtn);

      overlay.addEventListener('click', e => {
        if (e.target === overlay && cancelText) finish(false);
      });
      document.addEventListener('keydown', onKeyDown);

      card.appendChild(head);
      card.appendChild(body);
      card.appendChild(actions);
      overlay.appendChild(card);
      document.body.appendChild(overlay);

      setTimeout(() => {
        if (cancelBtn) cancelBtn.focus();
        else okBtn.focus();
      }, 0);
    });
  }

  function confirmPopup(message, danger = false) {
    return popup({
      title: 'Please confirm',
      message,
      okText: 'Confirm',
      cancelText: 'Cancel',
      danger,
    });
  }

  function alertPopup(message) {
    return popup({
      title: 'Notice',
      message,
      okText: 'OK',
      cancelText: null,
      danger: false,
    });
  }

  async function fetchJSON(url, opts = {}) {
    const r = await fetch(
      typeof bridgePath === "function" ? bridgePath(url) : url,
      opts,
    );
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  }

  function renderStatus(s) {
    const dot = $('status-dot');
    const summary = $('status-summary');
    if (s.running) {
      dot.classList.remove('down');
      summary.textContent = `v${s.version} · PID ${s.pid} · :${s.port} · up ${fmtDuration(s.uptimeSeconds)}`;
    } else {
      dot.classList.add('down');
      summary.textContent = 'not running';
    }

    const launchdBadge = s.launchdLoaded
      ? el('span', { class: 'badge green' }, 'enabled')
      : el('span', { class: 'badge muted' }, 'disabled');

    const runBadge = s.running
      ? el('span', { class: 'badge green' }, 'running')
      : el('span', { class: 'badge red' }, 'down');

    const cursorKey = s.apiKeyConfigured
      ? el('span', { class: 'badge green' }, 'CURSOR_API_KEY set')
      : el('span', { class: 'badge yellow' }, 'no CURSOR_API_KEY');

    const bridgeKey = s.bridgeApiKeyRequired
      ? el('span', { class: 'badge yellow' }, 'LLM /v1 API key required')
      : el('span', { class: 'badge muted' }, 'no LLM API key gate');

    const kv = el('div', { class: 'kv' },
      el('div', { class: 'k' }, 'Process'), el('div', { class: 'v' }, runBadge, ' ', `PID ${s.pid ?? '—'}`),
      el('div', { class: 'k' }, 'Listening'), el('div', { class: 'v' }, `http://${s.host}:${s.port}`),
      el('div', { class: 'k' }, 'Uptime'), el('div', { class: 'v' }, fmtDuration(s.uptimeSeconds), el('span', { class: 'dim-text' }, `  (since ${new Date(s.startedAt).toLocaleString()})`)),
      el('div', { class: 'k' }, 'Autostart'), el('div', { class: 'v' }, launchdBadge, ' ', el('span', { class: 'dim-text mono' }, (s.plistPath || '').replace(/^.*\//, ''))),
      el('div', { class: 'k' }, 'Cursor auth'), el('div', { class: 'v' }, cursorKey),
      el('div', { class: 'k' }, 'LLM API key'), el('div', { class: 'v' }, bridgeKey),
      el('div', { class: 'k' }, 'Node'), el('div', { class: 'v' }, `${s.node} (${s.platform})`),
      el('div', { class: 'k' }, 'Package'), el('div', { class: 'v mono', style: 'font-size: 11px; word-break: break-all;' }, s.packageRoot),
      el('div', { class: 'k' }, 'Sessions log'), el('div', { class: 'v mono', style: 'font-size: 11px; word-break: break-all;' }, s.sessionsLogPath),
      el('div', { class: 'k' }, 'Service log'), el('div', { class: 'v mono', style: 'font-size: 11px; word-break: break-all;' }, s.serviceLog),
    );

    const publicBlock = [];
    if (s.publicOpenAiApiBase || s.publicCursorApiBase) {
      publicBlock.push(
        el('p', {
          class: 'muted-text',
          style: 'margin: 14px 0 8px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;',
        }, 'Public URLs'),
      );
      if (s.publicOpenAiApiBase) {
        publicBlock.push(
          el('div', { class: 'copy-row' },
            el('span', { class: 'label' }, 'OpenAI API'),
            el('code', {}, s.publicOpenAiApiBase),
          ),
          el('div', { class: 'copy-row' },
            el('span', { class: 'label' }, 'OpenAI chat completions'),
            el('code', {}, `${s.publicOpenAiApiBase}/chat/completions`),
          ),
        );
      }
      if (s.publicCursorApiBase) {
        publicBlock.push(
          el('div', { class: 'copy-row' },
            el('span', { class: 'label' }, 'Cursor API'),
            el('code', {}, `${s.publicCursorApiBase}/messages`),
          ),
        );
      }
    }

    const healthRow = el('div', { class: 'copy-row', style: 'margin-top: 10px;' },
      el('span', { class: 'label' }, 'Health (process)'),
      el('code', {}, `curl -s http://${s.host}:${s.port}/healthz`),
    );

    $('status-body').replaceChildren(kv, ...publicBlock, healthRow);
  }

  function renderApps(data) {
    const body = $('apps-body');
    if (!body) return;
    if (!data || !Array.isArray(data.apps)) {
      body.replaceChildren(el('div', { class: 'empty' }, 'No app data.'));
      return;
    }
    if (data.apps.length === 0) {
      body.replaceChildren(
        el('div', { class: 'empty' },
          'No apps deployed yet. POST to ',
          el('code', {}, '/api/apps/deploy'),
          ' with ',
          el('code', {}, '{ "name": "my-app", "sourceDir": "public/my-app" }'),
          '.',
        ),
      );
      return;
    }
    const list = el('ul', { style: 'margin: 0; padding-left: 1.2rem; line-height: 1.8;' });
    for (const app of data.apps) {
      const link = el('a', { href: app.shortUrl || app.url, target: '_blank', rel: 'noopener' }, app.name);
      const meta = el('span', { class: 'dim-text mono', style: 'font-size: 11px; margin-left: 6px;' }, app.shortUrl || app.url);
      list.appendChild(el('li', {}, link, meta));
    }
    const dir = el('p', { class: 'muted-text mono', style: 'font-size: 11px; margin: 10px 0 0; word-break: break-all;' },
      data.appsDir || '',
    );
    body.replaceChildren(list, dir);
  }

  function renderConfig(cfg) {
    const skip = new Set([
      'requiredKey',
      'appSegment',
      'mount',
      'publicBase',
      'externalPathname',
    ]);
    const rows = Object.entries(cfg)
      .filter(([k]) => !skip.has(k))
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => el('tr', {},
        el('td', { class: 'mono', style: 'font-size: 12px; color: var(--muted);' }, k),
        el('td', { class: 'model', style: 'font-size: 12px; word-break: break-word;' },
          typeof v === 'object' ? JSON.stringify(v) : String(v)),
      ));
    const tbl = el('table', { class: 'mapping' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Setting'), el('th', {}, 'Value'))),
      el('tbody', {}, ...rows),
    );
    $('config-body').replaceChildren(tbl);
  }

  function isManagedBridgeAccountDir(configDir) {
    const norm = String(configDir).replace(/\\/g, '/');
    const marker = '/.cursor-api-proxy/accounts/';
    const i = norm.lastIndexOf(marker);
    if (i < 0) return false;
    const rest = norm.slice(i + marker.length);
    return rest.length > 0 && !rest.includes('/');
  }

  function renderCursorAccount(data) {
    const summary = $('cursor-account-summary');
    const body = $('cursor-account-body');
    if (!data || !Array.isArray(data.accounts)) {
      summary.textContent = '';
      body.replaceChildren(el('div', { class: 'empty' }, 'No account data.'));
      return;
    }

    const fetched = data.fetchedAt ? new Date(data.fetchedAt).toLocaleString() : '';
    summary.textContent = fetched ? `updated ${fetched}` : '';

    const configuredAccounts = data.accounts.filter(
      a => a && a.configDir && a.name !== '(none)',
    );
    const canDeleteAny = configuredAccounts.length > 1;

    const blocks = data.accounts.map(acc => {
      const headBits = [acc.name];
      if (acc.email) headBits.push(acc.email);
      const canRemove =
        canDeleteAny &&
        acc.configDir &&
        acc.name !== '(none)' &&
        isManagedBridgeAccountDir(acc.configDir);
      const removeBtn = canRemove
        ? el('button', {
          type: 'button',
          class: 'btn small danger',
          title: 'Remove this account from the bridge',
          onclick: () => void removeCursorAccount(acc),
        }, 'Remove')
        : null;
      const head = el('div', {
        style: 'display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; margin-bottom: 6px;',
      },
        el('div', { style: 'font-weight: 600;' }, headBits.join(' · ')),
        removeBtn,
      );

      if (acc.error) {
        return el('div', { style: 'margin-bottom: 16px;' }, head,
          el('div', { class: 'muted-text', style: 'font-size: 12px;' }, acc.error),
        );
      }

      const planLine = acc.planDescription
        ? el('div', { class: 'muted-text', style: 'font-size: 12px; margin-bottom: 8px;' }, acc.planDescription)
        : null;

      const sub = acc.subscription;
      const subUsd = sub && sub.monthlyListPriceUsd != null && !sub.isTeamMember
        ? fmtUsd(sub.monthlyListPriceUsd) + (sub.isYearlyPlan ? '/mo (yearly plan)' : '/mo list')
        : sub && sub.isTeamMember ? 'Team (billed separately)' : null;

      const kv = el('div', { class: 'kv', style: 'margin-bottom: 10px;' });
      if (subUsd) {
        kv.append(el('div', { class: 'k' }, 'Subscription'), el('div', { class: 'v' }, subUsd));
      }
      if (sub && sub.subscriptionStatus) {
        kv.append(el('div', { class: 'k' }, 'Status'), el('div', { class: 'v mono' }, sub.subscriptionStatus));
      }
      const b = acc.billed;
      const periodIso = (b && b.startDate) || (acc.usage && acc.usage.startOfMonth);
      if (periodIso) {
        kv.append(
          el('div', { class: 'k' }, 'Period from'),
          el('div', { class: 'v' }, new Date(periodIso).toLocaleDateString()),
        );
      }
      if (b) {
        kv.append(
          el('div', { class: 'k' }, 'Account tokens'),
          el('div', { class: 'v mono', title: 'input + output + cache write + cache read' }, fmtTokens(b.totalTokens)),
          el('div', { class: 'k' }, 'Input / Output'),
          el('div', { class: 'v mono' }, `${fmtTokens(b.inputTokens)} / ${fmtTokens(b.outputTokens)}`),
          el('div', { class: 'k' }, 'Cache write / read'),
          el('div', { class: 'v mono' }, `${fmtTokens(b.cacheWriteTokens)} / ${fmtTokens(b.cacheReadTokens)}`),
          el('div', { class: 'k' }, 'Charged this period'),
          el('div', { class: 'v' }, fmtUsd(b.costUsd)),
        );
      } else if (acc.usage) {
        kv.append(
          el('div', { class: 'k' }, 'Account tokens'),
          el('div', { class: 'v mono' }, fmtTokens(acc.usage.totalTokens)),
          el('div', { class: 'k' }, 'Requests'),
          el('div', { class: 'v mono' }, String(acc.usage.totalRequests)),
        );
      }

      const children = [head];
      if (planLine) children.push(planLine);
      if (kv.childNodes.length) children.push(kv);

      if (b && b.byModel.length) {
        const models = b.byModel.slice(0, 8);
        const max = Math.max(...models.map(m => m.totalTokens), 1);
        for (const m of models) {
          children.push(el('div', { class: 'stat-row' },
            el('div', { class: 'mono', style: 'font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;' }, m.model),
            el('div', { class: 'bar bar-OTHER' }, el('div', { style: `width: ${Math.round((m.totalTokens / max) * 100)}%` })),
            el('div', {
              class: 'count',
              title: `in ${fmtTokens(m.inputTokens)} · out ${fmtTokens(m.outputTokens)} · cache w ${fmtTokens(m.cacheWriteTokens)} · cache r ${fmtTokens(m.cacheReadTokens)}`,
            }, `${fmtTokens(m.totalTokens)} · ${fmtUsd(m.costUsd)}`),
          ));
        }
      }

      if (acc.usage && acc.usage.pools.some(p => p.numRequests > 0 || p.maxRequestUsage)) {
        const pools = acc.usage.pools.slice(0, 8);
        const maxReq = Math.max(...pools.map(p => p.maxRequestUsage || p.numRequests || 1), 1);
        for (const p of pools) {
          const denom = p.maxRequestUsage && p.maxRequestUsage > 0 ? p.maxRequestUsage : maxReq;
          const pct = Math.round((p.numRequests / denom) * 100);
          children.push(el('div', { class: 'stat-row' },
            el('div', { class: 'mono', style: 'font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;' }, p.label),
            el('div', { class: 'bar bar-OTHER' }, el('div', { style: `width: ${Math.min(100, pct)}%` })),
            el('div', { class: 'count', title: `${fmtTokens(p.numTokens)} tokens` },
              p.maxRequestUsage != null && p.maxRequestUsage > 0
                ? `${p.numRequests}/${p.maxRequestUsage}`
                : `${p.numRequests} req`,
            ),
          ));
        }
      }

      return el('div', { style: 'margin-bottom: 16px;' }, ...children);
    });

    body.replaceChildren(...blocks);
  }

  function renderUsage(usage, windowHours) {
    const summary = $('usage-summary');
    if (!usage || usage.requestCount === 0) {
      summary.textContent = `no LLM completions in ${windowHours}h window`;
      $('usage-body').replaceChildren(
        el('div', { class: 'empty' }, 'No token usage recorded yet. Successful chat/completion/message/responses calls are logged as USAGE lines in the sessions log.'),
      );
      return;
    }

    summary.textContent =
      `${fmtTokens(usage.totalTokens)} tokens · ${fmtUsd(usage.estimatedCostUsd)} est. · ${usage.requestCount} completions (${windowHours}h)`;

    const totals = el('div', { class: 'kv', style: 'margin-bottom: 12px;' },
      el('div', { class: 'k' }, 'Input'), el('div', { class: 'v mono' }, fmtTokens(usage.promptTokens)),
      el('div', { class: 'k' }, 'Output'), el('div', { class: 'v mono' }, fmtTokens(usage.completionTokens)),
      el('div', { class: 'k' }, 'Total'), el('div', { class: 'v mono' }, fmtTokens(usage.totalTokens)),
      el('div', { class: 'k' }, 'Est. cost'), el('div', { class: 'v' }, fmtUsd(usage.estimatedCostUsd)),
    );

    const models = Object.entries(usage.byModel)
      .sort((a, b) => b[1].totalTokens - a[1].totalTokens)
      .slice(0, 8);
    const max = Math.max(...models.map(([, m]) => m.totalTokens), 1);
    const rows = models.map(([name, m]) => el('div', { class: 'stat-row' },
      el('div', { class: 'mono', style: 'font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;' }, name),
      el('div', { class: 'bar bar-OTHER' }, el('div', { style: `width: ${Math.round((m.totalTokens / max) * 100)}%` })),
      el('div', { class: 'count', title: `${m.requestCount} requests` }, `${fmtTokens(m.totalTokens)} · ${fmtUsd(m.estimatedCostUsd)}`),
    ));

    $('usage-body').replaceChildren(totals, el('div', { class: 'muted-text', style: 'font-size: 11px; margin-bottom: 8px;' }, 'By model'), ...rows);
  }

  function renderStats(stats) {
    $('stats-total').textContent = stats.total > 0
      ? `${stats.total} requests · ${stats.errors} errors (${stats.windowHours}h window)`
      : 'no requests in window';

    renderUsage(stats.usage, stats.windowHours);

    if (stats.total === 0) {
      $('stats-body').replaceChildren(el('div', { class: 'empty' }, 'No lines matched in the sessions log for this window.'));
      $('recent-body').replaceChildren(el('div', { class: 'empty' }, 'No requests yet.'));
      return;
    }

    const paths = Object.entries(stats.byPath).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const max = Math.max(...paths.map(([, n]) => n));
    const rows = paths.map(([p, n]) => el('div', { class: 'stat-row' },
      el('div', { class: 'mono', style: 'font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;' }, p),
      el('div', { class: 'bar bar-OTHER' }, el('div', { style: `width: ${max ? Math.round((n / max) * 100) : 0}%` })),
      el('div', { class: 'count' }, String(n)),
    ));
    $('stats-body').replaceChildren(...rows);

    const recentTbl = el('table', { class: 'mapping' },
      el('thead', {}, el('tr', {},
        el('th', {}, 'When'),
        el('th', {}, 'Method'),
        el('th', {}, 'Path'),
        el('th', {}, 'Status'),
      )),
      el('tbody', {}, ...stats.recent.slice(0, 14).map(r => el('tr', {},
        el('td', { class: 'mono', style: 'font-size: 11px;' }, new Date(r.ts).toLocaleTimeString()),
        el('td', { class: 'mono', style: 'font-size: 12px;' }, r.method),
        el('td', { class: 'mono', style: 'font-size: 11px;' }, r.pathname),
        el('td', {}, el('span', { class: r.status >= 400 ? 'badge yellow' : 'badge green' }, String(r.status))),
      ))),
    );
    $('recent-body').replaceChildren(recentTbl);
  }

  function formatLogLine(line) {
    const m = line.match(/^(\S+Z)\s+(.+)$/);
    let tsPart = '';
    let rest = line;
    if (m) {
      tsPart = m[1];
      rest = m[2];
    }
    const wrap = el('div', { class: 'log-line' });
    if (tsPart) {
      const d = new Date(tsPart);
      wrap.appendChild(el('span', { class: 'ts' }, d.toLocaleTimeString() + ' '));
    }
    if (rest.startsWith('USAGE ')) {
      wrap.appendChild(el('span', { class: 'ok' }, rest));
    } else if (rest.includes(' ERROR ')) {
      wrap.appendChild(el('span', { class: 'err' }, rest));
    } else if (/\s(5\d\d)\s*$/.test(rest) || /\s(4\d\d)\s*$/.test(rest)) {
      wrap.appendChild(el('span', { class: 'req' }, rest));
    } else if (/listening on/.test(rest)) {
      wrap.appendChild(el('span', { class: 'ok' }, rest));
    } else {
      wrap.appendChild(document.createTextNode(rest));
    }
    return wrap;
  }

  function renderLog(lines) {
    const viewer = $('log-viewer');
    if (!lines.length) {
      viewer.replaceChildren(el('div', { class: 'empty' }, 'Log is empty.'));
      return;
    }
    viewer.replaceChildren(...lines.map(formatLogLine));
    if (state.autoscroll) viewer.scrollTop = viewer.scrollHeight;
  }

  function restartLogPolling() {
    if (state.logTimer) clearInterval(state.logTimer);
    state.logTimer = setInterval(refreshLog, state.logIntervalMs);
  }

  function applyLogIntervalFromInput() {
    const raw = $('log-interval-input').value.trim();
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      $('log-interval-input').value = String(state.logIntervalMs / 1000);
      toast('Invalid interval. Use a number in seconds.', 'err');
      return;
    }
    const nextMs = Math.max(500, Math.round(seconds * 1000));
    if (nextMs === state.logIntervalMs) return;
    state.logIntervalMs = nextMs;
    restartLogPolling();
  }

  async function refreshStatus() {
    try {
      const s = await fetchJSON('/api/status');
      renderStatus(s);
      state.lastStatusOk = true;
    } catch (e) {
      $('status-dot').classList.add('down');
      $('status-summary').textContent = 'unreachable';
      if (state.lastStatusOk) toast(`Status request failed: ${e.message}`, 'err');
      state.lastStatusOk = false;
    }
  }

  async function refreshApps() {
    try {
      const data = await fetchJSON('/api/apps');
      renderApps(data);
    } catch (e) {
      const body = $('apps-body');
      if (body) body.replaceChildren(el('div', { class: 'empty' }, `Error: ${e.message}`));
    }
  }

  async function refreshConfig() {
    try {
      const cfg = await fetchJSON('/api/config');
      renderConfig(cfg);
    } catch (e) {
      $('config-body').replaceChildren(el('div', { class: 'empty' }, `Error: ${e.message}`));
    }
  }

  async function refreshStats() {
    try {
      const stats = await fetchJSON('/api/stats?hours=24');
      renderStats(stats);
    } catch (e) {
      $('usage-summary').textContent = '';
      $('usage-body').replaceChildren(el('div', { class: 'empty' }, `Error: ${e.message}`));
      $('stats-body').replaceChildren(el('div', { class: 'empty' }, `Error: ${e.message}`));
    }
  }

  async function refreshCursorAccount() {
    try {
      const data = await fetchJSON('/api/cursor-account');
      renderCursorAccount(data);
    } catch (e) {
      $('cursor-account-summary').textContent = '';
      $('cursor-account-body').replaceChildren(el('div', { class: 'empty' }, `Error: ${e.message}`));
    }
  }

  async function removeCursorAccount(acc) {
    const label = acc.email || acc.displayName || acc.name || 'this account';
    const msg = `Remove ${label}? Local login data under this bridge will be deleted.`;
    if (!(await confirmPopup(msg, true))) return;
    try {
      await fetchJSON('/api/cursor-account', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ configDir: acc.configDir }),
      });
      toast('Account removed', 'ok');
      await refreshCursorAccount();
      await refreshStatus();
    } catch (e) {
      toast(`Remove failed: ${e.message}`, 'err');
    }
  }

  async function refreshLog() {
    if (state.paused) return;
    try {
      const data = await fetchJSON('/api/log?lines=80');
      renderLog(data.lines);
    } catch (e) {
      $('log-viewer').replaceChildren(el('div', { class: 'empty' }, `Error: ${e.message}`));
    }
  }

  async function doControl(action) {
    const confirmMsg = {
      stop: 'Stop the proxy? Clients will fail until you restart.',
      restart: 'Restart the proxy? The dashboard will briefly disconnect.',
      enable: null,
      disable: null,
    };
    const msg = confirmMsg[action];
    if (msg && !(await confirmPopup(msg, action === 'stop'))) return;

    try {
      const r = await fetchJSON('/api/control', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      toast(`Scheduled: cursor-api-proxy ${r.action}`, 'ok');
      if (action === 'restart' || action === 'stop') {
        toast('Reconnecting…', 'warn', 6000);
        setTimeout(() => refreshAll(), 1500);
        setTimeout(() => refreshAll(), 3500);
        setTimeout(() => refreshAll(), 5500);
      } else {
        setTimeout(() => refreshAll(), 800);
      }
    } catch (e) {
      toast(`Action failed: ${e.message}`, 'err');
      await alertPopup(`Action failed: ${e.message}`);
    }
  }

  function refreshAll() {
    refreshStatus();
    refreshConfig();
    refreshApps();
    refreshStats();
    refreshCursorAccount();
    refreshLog();
  }

  function showDashboardMain() {
    $('login-gate').classList.add('hidden');
    $('login-gate').setAttribute('aria-hidden', 'true');
    $('dashboard-main').classList.remove('hidden');
  }

  function showLoginGate(message) {
    $('dashboard-main').classList.add('hidden');
    $('login-gate').classList.remove('hidden');
    $('login-gate').setAttribute('aria-hidden', 'false');
    const err = $('login-gate-error');
    if (err) err.textContent = message || '';
  }

  function startDashboardPolling() {
    if (state.dashboardPolling) return;
    state.dashboardPolling = true;
    refreshAll();
    state.statusTimer = setInterval(refreshStatus, 5000);
    restartLogPolling();
    state.statsTimer = setInterval(refreshStats, 15000);
    state.cursorAccountTimer = setInterval(refreshCursorAccount, 60000);
  }

  function stopLoginPoll() {
    if (state.loginPollTimer) {
      clearInterval(state.loginPollTimer);
      state.loginPollTimer = null;
    }
    state.loginSessionId = null;
  }

  function showAgentOAuthDialog(session) {
    const url = session.loginUrl || '';
    $('agent-oauth-hint').textContent =
      'Open the link below and sign in with your Cursor account. This tab will unlock when login completes.';
    const wrap = $('agent-oauth-url-wrap');
    if (url) {
      wrap.style.display = 'block';
      const link = $('agent-oauth-url-link');
      link.href = url;
      link.textContent = url;
      $('agent-oauth-open').onclick = () => window.open(url, '_blank', 'noopener');
      $('agent-oauth-copy').onclick = async () => {
        try {
          await navigator.clipboard.writeText(url);
          toast('Login URL copied', 'ok');
        } catch {
          toast('Could not copy URL', 'err');
        }
      };
    } else {
      wrap.style.display = 'none';
    }
    $('agent-oauth-wait').textContent = 'Waiting for Cursor to confirm sign-in…';
    $('agent-oauth-dialog').showModal();
    if (url) {
      try {
        window.open(url, '_blank', 'noopener');
      } catch {
        /* popup blocked — user can use Open link in the dialog */
      }
    }
  }

  function onAgentLoginTerminal(session) {
    stopLoginPoll();
    $('agent-oauth-dialog').close();
    if (session.status === 'success') {
      state.agentAuthenticated = true;
      showDashboardMain();
      toast(session.email ? `Signed in as ${session.email}` : 'Cursor sign-in complete', 'ok', 5000);
      refreshCursorAccount();
      if (!session.email) {
        toast('Restart the proxy to pick up the new account pool if requests still fail.', 'warn', 8000);
      }
      startDashboardPolling();
      return;
    }
    const msg = session.error || `Login ${session.status}`;
    $('login-gate-error').textContent = msg;
    toast(msg, 'err');
  }

  function pollAgentLoginSession(sessionId) {
    stopLoginPoll();
    state.loginSessionId = sessionId;
    state.loginPollTimer = setInterval(async () => {
      try {
        const session = await fetchJSON(
          `/api/agent-login/status?session=${encodeURIComponent(sessionId)}`,
        );
        if (session.status === 'success' || session.status === 'failed' || session.status === 'cancelled') {
          onAgentLoginTerminal(session);
        }
      } catch (e) {
        if (String(e.message).startsWith('404')) {
          onAgentLoginTerminal({
            status: 'failed',
            error: 'Login session ended (reload the dashboard and try again)',
          });
        } else {
          onAgentLoginTerminal({ status: 'failed', error: e.message || 'Login status check failed' });
        }
      }
    }, 2000);
  }

  async function beginAddCursorAccount() {
    const suggested = `account-${Date.now().toString().slice(-4)}`;
    const raw = window.prompt(
      'Account folder name (letters, numbers, dots, dashes). Cancel to abort.',
      suggested,
    );
    if (raw === null) return;
    await beginAgentOAuthLogin(raw.trim() || undefined);
  }

  async function beginAgentOAuthLogin(accountName) {
    $('login-gate-error').textContent = '';
    const addBtn = $('cursor-account-add-btn');
    if (addBtn) addBtn.disabled = true;
    $('agent-login-btn').disabled = true;
    try {
      const body = accountName ? { accountName } : {};
      const session = await fetchJSON('/api/agent-login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      showAgentOAuthDialog(session);
      pollAgentLoginSession(session.sessionId);
    } catch (e) {
      $('login-gate-error').textContent = e.message;
      toast(`Could not start login: ${e.message}`, 'err');
    } finally {
      $('agent-login-btn').disabled = false;
      const addBtn = $('cursor-account-add-btn');
      if (addBtn) addBtn.disabled = false;
    }
  }

  async function ensureAgentAuth() {
    try {
      const auth = await fetchJSON('/api/agent-auth');
      state.agentAuthenticated = Boolean(auth.authenticated);
      if (auth.authenticated) {
        showDashboardMain();
        return true;
      }
      showLoginGate();
      void beginAgentOAuthLogin();
      return false;
    } catch (e) {
      showLoginGate(`Could not check Cursor auth: ${e.message}`);
      return false;
    }
  }

  function bind() {
    $('refresh-btn').addEventListener('click', refreshAll);
    $('pause-btn').addEventListener('click', () => {
      state.paused = !state.paused;
      $('pause-btn').textContent = state.paused ? 'Resume' : 'Pause';
    });
    $('clear-btn').addEventListener('click', async () => {
      if (!(await confirmPopup('Clear and archive current sessions log?', true))) return;
      try {
        const r = await fetchJSON('/api/log/clear', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        });
        toast(`Archived log to ${r.archivePath}`, 'ok', 5000);
        refreshAll();
      } catch (e) {
        toast(`Clear failed: ${e.message}`, 'err');
        await alertPopup(`Clear failed: ${e.message}`);
      }
    });
    $('log-interval-input').addEventListener('input', () => {
      if (state.logIntervalApplyTimer) clearTimeout(state.logIntervalApplyTimer);
      state.logIntervalApplyTimer = setTimeout(() => {
        applyLogIntervalFromInput();
        state.logIntervalApplyTimer = null;
      }, 1000);
    });
    $('autoscroll').addEventListener('change', e => {
      state.autoscroll = e.target.checked;
    });
    for (const btn of document.querySelectorAll('[data-action]')) {
      btn.addEventListener('click', () => doControl(btn.dataset.action));
    }
    $('agent-login-btn').addEventListener('click', () => beginAgentOAuthLogin());
    const addAcctBtn = $('cursor-account-add-btn');
    if (addAcctBtn) {
      addAcctBtn.addEventListener('click', () => void beginAddCursorAccount());
    }
    $('agent-oauth-close').addEventListener('click', () => {
      $('agent-oauth-dialog').close();
    });
  }

  async function start() {
    bind();
    const ok = await ensureAgentAuth();
    if (ok) startDashboardPolling();
  }

  document.addEventListener('DOMContentLoaded', start);
})();
