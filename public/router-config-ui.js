(() => {
  'use strict';

  const routerFieldStyle =
    'width: 100%; padding: 6px 8px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 4px; color: var(--text); font-family: var(--mono); font-size: 12px;';

  const state = {
    routerRoutes: [],
    routerEnabled: false,
    routerConfigPath: '',
    routerThreshold: 0.1,
    toast: (msg) => window.alert(msg),
  };

  function $(id) {
    return document.getElementById(id);
  }

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2), v);
      } else if (v != null) node.setAttribute(k, v);
    }
    for (const c of children) {
      if (c == null) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  async function fetchJSON(url, opts) {
    const res = await fetch(url, opts);
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(text || `${res.status} ${res.statusText}`);
    }
    if (!res.ok) {
      throw new Error(data?.error?.message || data?.message || `${res.status}`);
    }
    return data;
  }

  function collectRouterRoutesFromDom() {
    const rows = document.querySelectorAll('#router-body tr[data-router-row]');
    const routes = [];
    for (const row of rows) {
      const model = row.querySelector('[data-field="model"]')?.value?.trim() ?? '';
      const when = row.querySelector('[data-field="when"]')?.value?.trim() ?? '';
      if (model && when) routes.push({ model, when });
    }
    return routes;
  }

  function renderRouterConfig(data) {
    const summary = $('router-summary');
    const body = $('router-body');
    const pathEl = $('router-config-path');
    if (!body) return;

    state.routerEnabled = Boolean(data?.enabled);
    state.routerConfigPath = data?.configPath ?? '';
    state.routerThreshold = data?.threshold ?? 0.1;
    state.routerRoutes = Array.isArray(data?.routes)
      ? data.routes.map((r) => ({ ...r }))
      : [];

    if (pathEl) pathEl.textContent = state.routerConfigPath || '—';

    if (!data?.enabled) {
      if (summary) {
        summary.textContent = 'disabled (set CURSOR_BRIDGE_ROUTER_ENABLED=true)';
      }
      body.replaceChildren(
        el(
          'div',
          { class: 'empty' },
          'Auto routing is off. Enable ',
          el('code', {}, 'CURSOR_BRIDGE_ROUTER_ENABLED'),
          ' and restart the proxy.',
        ),
      );
      return;
    }

    const thresholdPct = Math.round((data.threshold ?? 0.1) * 1000) / 10;
    if (summary) {
      summary.textContent = `threshold ${thresholdPct}% · ${state.routerRoutes.length} route(s)`;
    }

    if (state.routerRoutes.length === 0) {
      state.routerRoutes.push({ model: '', when: '' });
    }

    const tbody = el(
      'tbody',
      {},
      ...state.routerRoutes.map((route, idx) =>
        el('tr', { 'data-router-row': String(idx) },
          el('td', { style: 'width: 28%; vertical-align: top; padding: 6px 8px 6px 0;' },
            el('input', {
              'data-field': 'model',
              value: route.model,
              placeholder: 'composer-2.5',
              style: routerFieldStyle,
            }),
          ),
          el('td', { style: 'vertical-align: top; padding: 6px 0;' },
            el('textarea', {
              'data-field': 'when',
              rows: '2',
              placeholder: 'When to pick this model (English, specific strengths)…',
              style:
                routerFieldStyle +
                ' resize: vertical; min-height: 52px; font-family: var(--sans);',
            }, route.when),
          ),
          el('td', { style: 'width: 72px; vertical-align: top; padding: 6px 0 6px 8px;' },
            el('button', {
              type: 'button',
              class: 'btn small danger',
              'data-router-remove': String(idx),
            }, 'Remove'),
          ),
        ),
      ),
    );

    const tbl = el('table', { class: 'mapping', style: 'width: 100%;' },
      el('thead', {}, el('tr', {},
        el('th', {}, 'Model id'),
        el('th', {}, 'When (classifier hint)'),
        el('th', {}, ''),
      )),
      tbody,
    );

    const addBtn = el('button', {
      type: 'button',
      class: 'btn small',
      id: 'router-add-row-btn',
      style: 'margin-top: 10px;',
    }, 'Add route');
    addBtn.disabled = state.routerRoutes.length >= 5;

    body.replaceChildren(tbl, addBtn);

    for (const btn of body.querySelectorAll('[data-router-remove]')) {
      btn.addEventListener('click', () => {
        const routes = collectRouterRoutesFromDom();
        const i = Number(btn.getAttribute('data-router-remove'));
        routes.splice(i, 1);
        renderRouterConfig({
          enabled: true,
          configPath: state.routerConfigPath,
          threshold: state.routerThreshold,
          routes,
        });
      });
    }
    addBtn.addEventListener('click', () => {
      const routes = collectRouterRoutesFromDom();
      if (routes.length >= 5) {
        state.toast('At most 5 routes');
        return;
      }
      routes.push({ model: '', when: '' });
      renderRouterConfig({
        enabled: true,
        configPath: state.routerConfigPath,
        threshold: state.routerThreshold,
        routes,
      });
    });
  }

  async function refreshRouterConfig() {
    try {
      const data = await fetchJSON('/api/router/config');
      renderRouterConfig(data);
    } catch (e) {
      const body = $('router-body');
      if (body) {
        body.replaceChildren(el('div', { class: 'empty' }, `Error: ${e.message}`));
      }
    }
  }

  async function saveRouterConfig() {
    if (!state.routerEnabled) {
      state.toast('Router is disabled in proxy config');
      return;
    }
    const routes = collectRouterRoutesFromDom();
    if (routes.length === 0) {
      state.toast('Add at least one model + when pair');
      return;
    }
    if (routes.length > 5) {
      state.toast('At most 5 routes');
      return;
    }
    const saveBtn = $('router-save-btn');
    if (saveBtn) saveBtn.disabled = true;
    try {
      const r = await fetchJSON('/api/router/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ routes }),
      });
      state.toast(`Saved ${r.routes?.length ?? routes.length} route(s)`);
      await refreshRouterConfig();
    } catch (e) {
      state.toast(`Save failed: ${e.message}`);
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  function bindControls() {
    $('router-reload-btn')?.addEventListener('click', () => void refreshRouterConfig());
    $('router-save-btn')?.addEventListener('click', () => void saveRouterConfig());
    $('router-config-close')?.addEventListener('click', () => {
      $('router-config-dialog')?.close();
    });
  }

  function openRouterConfigDialog() {
    const dlg = $('router-config-dialog');
    if (!dlg) return;
    void refreshRouterConfig();
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  }

  window.RouterConfigUI = {
    init(opts = {}) {
      if (typeof opts.toast === 'function') state.toast = opts.toast;
      bindControls();
    },
    open: openRouterConfigDialog,
    refresh: refreshRouterConfig,
  };
})();
