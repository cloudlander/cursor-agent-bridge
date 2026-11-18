function $(id) {
  return document.getElementById(id);
}

async function api(path, opts = {}) {
  const res = await fetch(
    typeof bridgePath === "function" ? bridgePath(path) : path,
    {
    ...opts,
    headers: {
      Accept: "application/json",
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

const PLUGIN_RPC_SPINNER_DELAY_MS = 5000;
let pluginRpcSlowCount = 0;

function syncPluginRpcSpinner() {
  const node = $("plugin-rpc-overlay");
  if (!node) return;
  const show = pluginRpcSlowCount > 0;
  node.hidden = !show;
  node.setAttribute("aria-busy", show ? "true" : "false");
  node.setAttribute("aria-hidden", show ? "false" : "true");
}

function trackSlowPluginRpc(promise) {
  let slow = false;
  const timer = setTimeout(() => {
    slow = true;
    pluginRpcSlowCount += 1;
    syncPluginRpcSpinner();
  }, PLUGIN_RPC_SPINNER_DELAY_MS);
  const done = () => {
    clearTimeout(timer);
    if (!slow) return;
    pluginRpcSlowCount = Math.max(0, pluginRpcSlowCount - 1);
    syncPluginRpcSpinner();
  };
  Promise.resolve(promise).then(done, done);
}

let currentConfigPluginId = null;
let currentConfigPayload = null;
let oauthWatchPluginId = null;
let oauthPopup = null;
let oauthLoginWindow = null;
let oauthPoll = null;
let configAuthHold = false;
const OAUTH_TIMEOUT_DEFAULT_MS = 5 * 60 * 1000;
let firstPageLoad = true;
let catalogPage = 1;
let catalogPageSize = 5;
const CATALOG_PAGE_SIZE_OPTIONS = [5, 10, 24, 50, 100];
const UNCATALOGED_CATEGORY = "__uncategorized__";

const MUTATION_BTN_IDS = [
  "refresh-catalog-btn",
  "sync-cli-btn",
  "redeploy-btn",
  "add-mp-btn",
];

function setMutationButtonsDisabled(disabled) {
  for (const id of MUTATION_BTN_IDS) {
    const b = $(id);
    if (b) b.disabled = disabled;
  }
}

const INIT_POLL_MS = 400;
const INIT_WAIT_MS = 45 * 60 * 1000;

async function waitForRegistryInit() {
  const deadline = Date.now() + INIT_WAIT_MS;
  while (Date.now() < deadline) {
    const st = await api("/api/plugins/init-status");
    if (st.phase === "ready") return;
    if (st.phase === "error") {
      throw new Error(st.error || "Plugin registry initialization failed");
    }
  }
  throw new Error("Plugin registry initialization timed out");
}

async function loadStatus() {
  try {
    const s = await api("/api/status");
    $("status-dot").classList.toggle("down", !s.running);
    $("status-summary").textContent = s.running ? `v${s.version} · :${s.port}` : "down";
  } catch (e) {
    $("status-summary").textContent = "status error";
  }
}

async function loadMarketplaces() {
  const { marketplaces } = await api("/api/plugins/marketplaces");
  const sel = $("marketplace-select");
  sel.innerHTML = `<option value="">All marketplaces</option>`;
  for (const m of marketplaces) {
    const o = document.createElement("option");
    o.value = m.id;
    o.textContent = m.name + (m.builtin ? " (official)" : "");
    sel.appendChild(o);
  }
  const ul = $("mp-list");
  ul.innerHTML = "";
  for (const m of marketplaces) {
    const li = document.createElement("li");
    li.innerHTML = `<strong>${esc(m.name)}</strong> <span class="muted-text">${esc(m.id)}</span> — ${esc(m.url)}`;
    if (!m.builtin) {
      const btn = document.createElement("button");
      btn.className = "btn small";
      btn.textContent = "Remove";
      btn.style.marginLeft = "8px";
      btn.onclick = () => removeMp(m.id);
      li.appendChild(btn);
    }
    ul.appendChild(li);
  }
}

function stripGitRepoSuffix(segment) {
  return String(segment).replace(/\.git$/i, "").replace(/\/$/, "");
}

/** Normalize clone/remotes to an https repo root when possible. */
function gitHttpsRepoRoot(url) {
  if (!url || typeof url !== "string") return null;
  const u = url.trim();
  const scp = u.match(/^git@github\.com:(.+)$/i);
  if (scp) return `https://github.com/${stripGitRepoSuffix(scp[1])}`;
  const ssh = u.match(/^ssh:\/\/git@github\.com\/(.+)$/i);
  if (ssh) return `https://github.com/${stripGitRepoSuffix(ssh[1])}`;
  const httpsGh = u.match(/^https?:\/\/github\.com\/([^/]+)\/([^/?#]+)/i);
  if (httpsGh) {
    return `https://github.com/${httpsGh[1]}/${stripGitRepoSuffix(httpsGh[2])}`;
  }
  if (/^https?:\/\//i.test(u)) return stripGitRepoSuffix(u);
  return null;
}

function gitTreePathSegments(subpath) {
  const raw = String(subpath || "")
    .trim()
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
  if (!raw) return "";
  return raw
    .split("/")
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

/** Web browse URL (matches link target); includes ref/subpath when present. */
function gitBrowseHref(url, ref, subpath) {
  const root = gitHttpsRepoRoot(url);
  const r = ref?.trim();
  const treePath = gitTreePathSegments(subpath);
  if (root && /^https:\/\/github\.com\//i.test(root)) {
    if (r && treePath) return `${root}/tree/${encodeURIComponent(r)}/${treePath}`;
    if (r) return `${root}/tree/${encodeURIComponent(r)}`;
    if (treePath) return `${root}/tree/HEAD/${treePath}`;
    return root;
  }
  if (root) return root;
  if (url && /^https?:\/\//i.test(url.trim())) return url.trim();
  return null;
}

function gitBrowseLabel(href) {
  if (!href) return "";
  try {
    const u = new URL(href);
    if (/github\.com$/i.test(u.hostname)) {
      const path = u.pathname.replace(/^\/+/, "");
      return path ? `github/${path}` : "github.com";
    }
    return href.replace(/^https?:\/\//i, "");
  } catch {
    return href;
  }
}

function formatPluginSource(p) {
  const s = p.source;
  if (!s || !s.kind) return null;
  if (s.kind === "git") {
    const href = gitBrowseHref(s.url, s.ref, s.path);
    const label = href ? gitBrowseLabel(href) : s.url || "";
    const title = [s.url, s.ref, s.path].filter(Boolean).join(" ");
    return { kind: "git", label, title, href };
  }
  if (s.kind === "path") {
    return { kind: "path", label: s.path || "—", title: s.path || "" };
  }
  if (s.kind === "cache") {
    return { kind: "cache", label: "CLI cache", title: s.dir || "" };
  }
  return { kind: String(s.kind), label: "", title: "" };
}

function renderPluginCard(p) {
  const src = formatPluginSource(p);
  const srcLabel =
    src?.kind === "git" && src.href
      ? `<a href="${esc(src.href)}" target="_blank" rel="noopener noreferrer">${esc(src.label)}</a>`
      : esc(src?.label || "");
  const srcHtml = src
    ? `<p class="plugin-source-line muted-text mono" title="${esc(src.title)}"><span class="badge muted">${esc(src.kind)}</span> ${srcLabel}</p>`
    : "";
  return `
    <article class="catalog-plugin-card" style="border: 1px solid var(--border-soft); border-radius: 8px; padding: 12px; margin-bottom: 10px;">
      <div style="display:flex; justify-content: space-between; gap: 8px; align-items: flex-start;">
        <div style="min-width: 0; flex: 1;">
          <strong>${esc(p.displayName || p.name)}</strong>
          ${
            p.displayName && p.displayName !== p.name
              ? `<span class="muted-text mono" style="font-size: 11px;"> (${esc(p.name)})</span>`
              : ""
          }
          <span class="muted-text mono" style="font-size: 11px;"> ${esc(p.marketplaceId)}</span>
          ${p.installed ? '<span class="badge" style="margin-left:6px;">installed</span>' : ""}
          ${p.cloudCatalog && !p.installed ? '<span class="badge" style="margin-left:6px;">IDE marketplace</span>' : ""}
          ${p.cliCache && !p.installed ? '<span class="badge" style="margin-left:6px;">CLI cache</span>' : ""}
          ${p.cliDeployed && !p.installed ? '<span class="badge" style="margin-left:6px;">CLI MCP</span>' : ""}
          ${srcHtml}
          <p class="muted-text" style="margin: 6px 0 0;">${esc(p.description || "—")}</p>
        </div>
        <div style="flex-shrink: 0;">
          ${
            p.installed
              ? `<button class="btn small" data-config="${esc(p.marketplaceId)}/${esc(p.name)}">Configure</button>`
              : `${
                  p.cliDeployed
                    ? `<button class="btn small" data-oauth-mp="${esc(p.marketplaceId)}" data-oauth-name="${esc(p.name)}">OAuth login</button> `
                    : ""
                }<button class="btn small primary" data-install="${esc(p.marketplaceId)}" data-name="${esc(p.name)}">${p.cliCache || p.cliDeployed ? "Import" : "Install"}</button>`
          }
        </div>
      </div>
    </article>`;
}

function syncCategorySelect(categories, selected) {
  const sel = $("category-select");
  if (!sel) return;
  const keep = selected ?? sel.value;
  const hadUncategorized = keep === UNCATALOGED_CATEGORY;
  sel.innerHTML = `<option value="">All categories</option>`;
  for (const c of categories) {
    const o = document.createElement("option");
    o.value = c;
    o.textContent = c;
    sel.appendChild(o);
  }
  const unc = document.createElement("option");
  unc.value = UNCATALOGED_CATEGORY;
  unc.textContent = "Uncategorized";
  sel.appendChild(unc);
  if (keep && (categories.includes(keep) || hadUncategorized)) sel.value = keep;
}

function renderCatalogPagination(meta) {
  const nav = $("catalog-pagination");
  if (!nav) return;
  const { total, page, pageSize } = meta;
  if (!total) {
    nav.classList.add("hidden");
    nav.innerHTML = "";
    return;
  }
  const pages = Math.max(1, Math.ceil(total / pageSize));
  nav.classList.toggle("hidden", pages <= 1 && total <= pageSize);
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  nav.innerHTML = `
    <span class="catalog-page-summary">Page ${page} of ${pages} · showing ${from}–${to} of ${total} plugins</span>
    <div class="catalog-page-actions">
      <button type="button" class="btn small" id="catalog-prev" ${page <= 1 ? "disabled" : ""}>Previous</button>
      <button type="button" class="btn small" id="catalog-next" ${page >= pages ? "disabled" : ""}>Next</button>
    </div>`;
  const prev = $("catalog-prev");
  const next = $("catalog-next");
  if (prev) {
    prev.onclick = () => {
      if (catalogPage > 1) {
        catalogPage -= 1;
        loadCatalog().catch(() => {});
      }
    };
  }
  if (next) {
    next.onclick = () => {
      if (catalogPage < pages) {
        catalogPage += 1;
        loadCatalog().catch(() => {});
      }
    };
  }
}

function wireCatalogListActions(root) {
  root.querySelectorAll("[data-install]").forEach((btn) => {
    btn.addEventListener("click", () =>
      installPlugin(btn.dataset.install, btn.dataset.name),
    );
  });
  root.querySelectorAll("[data-config]").forEach((btn) => {
    btn.addEventListener("click", () => openConfig(btn.dataset.config));
  });
  root.querySelectorAll("[data-oauth-mp]").forEach((btn) => {
    btn.addEventListener("click", () =>
      catalogMcpLogin(btn.dataset.oauthMp, btn.dataset.oauthName),
    );
  });
}

async function loadCatalog() {
  const q = $("search-input").value.trim();
  const marketplace = $("marketplace-select").value;
  const category = $("category-select")?.value ?? "";
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (marketplace) params.set("marketplace", marketplace);
  if (category) params.set("category", category);
  params.set("page", String(catalogPage));
  params.set("pageSize", String(catalogPageSize));
  const data = await api(`/api/plugins/catalog?${params}`);
  const plugins = data.plugins || [];
  const total = data.total ?? plugins.length;
  const page = data.page ?? catalogPage;
  const pageSize = data.pageSize ?? catalogPageSize;
  catalogPage = page;
  syncCategorySelect(data.categories || [], category);

  const el = $("catalog-list");
  if (!plugins.length) {
    el.innerHTML = '<div class="empty">No plugins match your filters.</div>';
    renderCatalogPagination({ total, page, pageSize });
    return;
  }
  let html = "";
  let lastCat = null;
  for (const p of plugins) {
    const cat = (p.category && String(p.category).trim()) || "Uncategorized";
    if (cat !== lastCat) {
      html += `<h3 class="catalog-category">${esc(cat)}</h3>`;
      lastCat = cat;
    }
    html += renderPluginCard(p);
  }
  el.innerHTML = html;
  wireCatalogListActions(el);
  renderCatalogPagination({ total, page, pageSize });
}

async function loadInstalled() {
  const { plugins } = await api("/api/plugins/installed");
  const el = $("installed-list");
  if (!plugins.length) {
    el.innerHTML = '<div class="empty">No plugins installed yet.</div>';
    return;
  }
  el.innerHTML = plugins
    .map(
      (p) => `
    <article style="border: 1px solid var(--border-soft); border-radius: 8px; padding: 12px; margin-bottom: 10px;">
      <div style="display:flex; justify-content: space-between; gap: 8px;">
        <div>
          <strong>${esc(p.name)}</strong>
          <span class="muted-text mono"> ${esc(p.id)}</span>
          <div class="muted-text" style="font-size: 12px; margin-top: 4px;">
            ${p.enabled ? "enabled" : "disabled"} · updated ${esc(p.updatedAt?.slice(0, 19) || "")}
          </div>
        </div>
        <div style="display:flex; flex-wrap: wrap; gap: 6px;">
          <button class="btn small" data-cfg="${esc(p.id)}">Configure</button>
          <button class="btn small" data-upd="${esc(p.id)}">Update</button>
          <button class="btn small" data-toggle="${esc(p.id)}" data-en="${p.enabled ? "0" : "1"}">${p.enabled ? "Disable" : "Enable"}</button>
          <button class="btn small danger" data-un="${esc(p.id)}">Uninstall</button>
        </div>
      </div>
    </article>`,
    )
    .join("");
  el.querySelectorAll("[data-cfg]").forEach((b) =>
    b.addEventListener("click", () => openConfig(b.dataset.cfg)),
  );
  el.querySelectorAll("[data-upd]").forEach((b) =>
    b.addEventListener("click", () => updatePlugin(b.dataset.upd)),
  );
  el.querySelectorAll("[data-toggle]").forEach((b) =>
    b.addEventListener("click", () =>
      togglePlugin(b.dataset.toggle, b.dataset.en === "1"),
    ),
  );
  el.querySelectorAll("[data-un]").forEach((b) =>
    b.addEventListener("click", () => uninstallPlugin(b.dataset.un)),
  );
}

async function installPlugin(marketplaceId, name) {
  const pending = api("/api/plugins/install", {
    method: "POST",
    body: JSON.stringify({ marketplaceId, name }),
  });
  trackSlowPluginRpc(pending);
  try {
    await pending;
    await refreshAll();
  } catch (e) {
    alert(e.message);
  }
}

async function updatePlugin(id) {
  try {
    await api(`/api/plugins/installed/${encodeURIComponent(id)}`, {
      method: "POST",
      body: JSON.stringify({ action: "update" }),
    });
    await refreshAll();
  } catch (e) {
    alert(e.message);
  }
}

async function togglePlugin(id, enable) {
  try {
    await api(`/api/plugins/installed/${encodeURIComponent(id)}`, {
      method: "POST",
      body: JSON.stringify({ action: enable ? "enable" : "disable" }),
    });
    await refreshAll();
  } catch (e) {
    alert(e.message);
  }
}

async function uninstallPlugin(id) {
  if (!confirm(`Uninstall ${id}?`)) return;
  const pending = api(`/api/plugins/installed/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  trackSlowPluginRpc(pending);
  try {
    await pending;
    await refreshAll();
  } catch (e) {
    alert(e.message);
  }
}

async function openConfig(id) {
  currentConfigPluginId = id;
  const detail = await api(`/api/plugins/installed/${encodeURIComponent(id)}`);
  currentConfigPayload = detail.plugin.config;
  $("config-title").textContent = `Configure — ${id}`;
  const vars = detail.variables || [];
  const servers = detail.mcpServerNames || [];
  const envRows = Object.entries(detail.plugin.config.env || {})
    .map(([k, v]) => envRow("env", k, v))
    .join("");
  const hdrRows = Object.entries(detail.plugin.config.headers || {})
    .map(([k, v]) => envRow("headers", k, v))
    .join("");
  $("config-body").innerHTML = `
    <p class="muted-text">Env vars referenced by MCP: ${vars.length ? vars.map(esc).join(", ") : "none"}</p>
    <h4>Global env</h4>
    <div id="env-rows">${envRows || envRow("env", "", "")}</div>
    <button type="button" class="btn small" id="add-env">+ env</button>
    <h4 style="margin-top:16px;">Global headers</h4>
    <div id="hdr-rows">${hdrRows || envRow("headers", "", "")}</div>
    <button type="button" class="btn small" id="add-hdr">+ header</button>
    <h4 style="margin-top:16px;">MCP servers</h4>
    <p class="muted-text mono">${servers.map(esc).join(", ") || "none"}</p>
    <p class="muted-text" style="font-size:11px;">Per-server overrides (JSON, merged on save):</p>
    <textarea id="servers-json" class="mono" rows="8" style="width:100%; background: var(--panel-2); border: 1px solid var(--border); border-radius: 6px; color: var(--text); padding: 8px;">${esc(JSON.stringify(detail.plugin.config.servers || {}, null, 2))}</textarea>
    <div style="margin-top: 12px;">
      <button type="button" class="btn small" id="mcp-login-btn">Start MCP OAuth login</button>
      <p class="muted-text" style="font-size: 11px; margin: 8px 0 0;">After sign-in, paste the localhost callback address into the login dialog. This page opens it on this app so the server can finish login. The login window closes when authentication finishes, or after 5 minutes. Configuration is saved only after success.</p>
      <p id="mcp-auth-status" class="mcp-auth-status" role="status" aria-live="polite" hidden></p>
    </div>`;
  if (oauthPoll && oauthPoll.pluginId === id) {
    setConfigAuthHold(true);
    showAuthStatus(
      $("mcp-auth-status"),
      "pending",
      `Waiting for authentication. The login window closes when authentication finishes, or after ${formatWait(oauthPoll.waitMs)}. Configuration is saved only after success.`,
    );
  } else {
    setConfigAuthHold(false);
  }
  $("add-env").onclick = () => $("env-rows").insertAdjacentHTML("beforeend", envRow("env", "", ""));
  $("add-hdr").onclick = () => $("hdr-rows").insertAdjacentHTML("beforeend", envRow("headers", "", ""));
  $("mcp-login-btn").onclick = () => mcpLogin(id, servers[0]);
  $("config-dialog").showModal();
}

function envRow(kind, k, v) {
  return `<div class="cfg-row" data-kind="${kind}" style="display:flex; gap:6px; margin-bottom:6px;">
    <input class="cfg-key mono" placeholder="name" value="${esc(k)}" style="flex:1; padding:6px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 4px; color: var(--text);" />
    <input class="cfg-val mono" placeholder="value" value="${esc(v)}" style="flex:2; padding:6px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 4px; color: var(--text);" />
  </div>`;
}

function collectMap(container, kind) {
  const out = {};
  container.querySelectorAll(`.cfg-row[data-kind="${kind}"]`).forEach((row) => {
    const k = row.querySelector(".cfg-key").value.trim();
    const v = row.querySelector(".cfg-val").value;
    if (k) out[k] = v;
  });
  return out;
}

function formatWait(ms) {
  const n = Number(ms);
  const value = Number.isFinite(n) && n > 0 ? n : OAUTH_TIMEOUT_DEFAULT_MS;
  if (value % 60000 === 0) {
    const minutes = value / 60000;
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  }
  const seconds = Math.max(1, Math.round(value / 1000));
  return seconds === 1 ? "1 second" : `${seconds} seconds`;
}

function showAuthStatus(el, kind, text) {
  if (!el) return;
  if (!text) {
    el.hidden = true;
    el.textContent = "";
    delete el.dataset.kind;
    return;
  }
  el.hidden = false;
  el.dataset.kind = kind;
  el.textContent = text;
}

function setConfigAuthHold(hold) {
  configAuthHold = hold;
  const btn = $("config-save");
  if (btn) btn.disabled = hold;
}

function configAuthTarget(pluginId) {
  return !!(
    pluginId &&
    $("config-dialog")?.open &&
    currentConfigPluginId === pluginId &&
    $("mcp-auth-status")
  );
}

function closeOwnedWindow(win) {
  if (!win || win.closed) return;
  try {
    win.close();
  } catch {
    /* ignore */
  }
}

function closeOAuthWindow() {
  closeOwnedWindow(oauthPopup);
  closeOwnedWindow(oauthLoginWindow);
  oauthPopup = null;
  oauthLoginWindow = null;
  const dialog = $("oauth-dialog");
  if (dialog?.open) dialog.close();
}

function openOAuthLoginWindow(url) {
  const opened = window.open(url, "_blank");
  oauthLoginWindow = opened || null;
  if (opened) {
    try {
      opened.opener = null;
    } catch {
      /* ignore */
    }
  }
  return opened;
}

function stopOAuthPoll() {
  if (!oauthPoll) return;
  clearInterval(oauthPoll.timer);
  oauthPoll = null;
}

async function finishOAuthWatch(phase, message, pluginId) {
  stopOAuthPoll();
  closeOAuthWindow();
  const ok = phase === "succeeded";
  if (configAuthTarget(pluginId)) {
    if (ok) {
      setConfigAuthHold(false);
      showAuthStatus($("mcp-auth-status"), "ok", "Authentication succeeded. Saving configuration…");
      const saved = await saveConfig({ keepOpen: true, quiet: true });
      showAuthStatus(
        $("mcp-auth-status"),
        saved.ok ? "ok" : "error",
        saved.ok
          ? "Authentication succeeded. Configuration saved."
          : `Authentication succeeded, but the configuration was not saved: ${saved.error}`,
      );
    } else {
      showAuthStatus($("mcp-auth-status"), "error", `${message} Configuration was not saved.`);
      setConfigAuthHold(true);
    }
    showAuthStatus($("mcp-auth-page-status"), "", "");
  } else {
    showAuthStatus($("mcp-auth-page-status"), ok ? "ok" : "error", message);
    setConfigAuthHold(false);
  }
  oauthWatchPluginId = null;
}

function startOAuthWatch(loginId, timeoutMs, pluginId) {
  stopOAuthPoll();
  const waitMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : OAUTH_TIMEOUT_DEFAULT_MS;
  const state = {
    timer: 0,
    pluginId,
    loginId,
    deadline: Date.now() + waitMs + 3000,
    waitMs,
  };
  oauthPoll = state;
  if (configAuthTarget(pluginId)) {
    showAuthStatus(
      $("mcp-auth-status"),
      "pending",
      `Waiting for authentication. The login window closes when authentication finishes, or after ${formatWait(waitMs)}. Configuration is saved only after success.`,
    );
    setConfigAuthHold(true);
    showAuthStatus($("mcp-auth-page-status"), "", "");
  }
  const tick = async () => {
    if (oauthPoll !== state) return;
    if (Date.now() > state.deadline) {
      await finishOAuthWatch(
        "timed_out",
        `Authentication timed out after ${formatWait(state.waitMs)}.`,
        state.pluginId,
      );
      return;
    }
    try {
      const st = await api(
        `/api/plugins/mcp-login-status?id=${encodeURIComponent(state.loginId)}`,
      );
      if (oauthPoll !== state) return;
      if (!st || st.phase === "pending") return;
      await finishOAuthWatch(st.phase, st.message || "Authentication failed.", state.pluginId);
    } catch (e) {
      if (oauthPoll !== state) return;
      if (String(e.message || "").toLowerCase().includes("not found")) {
        finishOAuthWatch("failed", "Authentication failed.", state.pluginId);
      }
    }
  };
  state.timer = setInterval(() => {
    tick().catch(() => {});
  }, 1000);
  tick().catch(() => {});
}

async function saveConfig(opts) {
  const options = opts || {};
  if (configAuthHold) return { ok: false, error: "Authentication has not succeeded." };
  if (!currentConfigPluginId) return { ok: false, error: "No plugin is open." };
  let servers = {};
  try {
    servers = JSON.parse($("servers-json").value || "{}");
  } catch {
    if (!options.quiet) alert("Invalid servers JSON");
    return { ok: false, error: "Invalid servers JSON" };
  }
  const config = {
    env: collectMap($("config-body"), "env"),
    headers: collectMap($("config-body"), "headers"),
    servers,
  };
  try {
    await api(`/api/plugins/installed/${encodeURIComponent(currentConfigPluginId)}`, {
      method: "PUT",
      body: JSON.stringify({ config }),
    });
    if (!options.keepOpen) $("config-dialog").close();
  } catch (e) {
    if (!options.quiet) alert(e.message);
    return { ok: false, error: e.message };
  }
  try {
    await refreshAll();
  } catch {
    /* the configuration is already stored */
  }
  return { ok: true };
}

function appCallbackUrl() {
  const path = typeof bridgePath === "function" ? bridgePath("/callback") : "/callback";
  return new URL(path, location.origin).href;
}

function codeText(text) {
  const el = document.createElement("code");
  el.textContent = text;
  return el;
}

function resetOAuthRewrite() {
  const form = $("oauth-rewrite-form");
  const input = $("oauth-pasted");
  const err = $("oauth-rewrite-error");
  const link = $("oauth-rewrite-link");
  form.hidden = true;
  input.value = "";
  input.setCustomValidity("");
  input.removeAttribute("aria-invalid");
  err.hidden = true;
  err.textContent = "";
  link.hidden = true;
  link.removeAttribute("href");
  link.textContent = "";
  $("oauth-rewrite-help").replaceChildren();
  $("oauth-rewrite-status").textContent = "";
  $("oauth-tunnel").hidden = true;
  $("oauth-tunnel").textContent = "";
}

function showOAuthRewrite(callbackUrl) {
  const form = $("oauth-rewrite-form");
  const input = $("oauth-pasted");
  form.hidden = false;
  input.placeholder = `${callbackUrl || "http://localhost:8787/callback"}?code=…&state=…`;
  const help = $("oauth-rewrite-help");
  help.replaceChildren(
    "After sign-in, copy the full address from the browser bar (",
    codeText(`${callbackUrl || "http://localhost:8787/callback"}?code=…&state=…`),
    "). Paste it here. Open callback loads the same code and state on ",
    codeText(appCallbackUrl()),
    ".",
  );
}

function previewOAuthRewrite() {
  const input = $("oauth-pasted");
  const link = $("oauth-rewrite-link");
  const err = $("oauth-rewrite-error");
  input.setCustomValidity("");
  input.removeAttribute("aria-invalid");
  err.hidden = true;
  err.textContent = "";
  $("oauth-rewrite-status").textContent = "";
  const raw = input.value.trim();
  if (!raw) {
    link.hidden = true;
    link.removeAttribute("href");
    link.textContent = "";
    return;
  }
  try {
    const url = rewriteLoopbackOAuthCallback(raw, appCallbackUrl());
    link.href = url;
    link.textContent = url;
    link.hidden = false;
  } catch {
    link.hidden = true;
    link.removeAttribute("href");
    link.textContent = "";
  }
}

function isLoopbackCallback(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

function showMcpLoginResult(r) {
  $("oauth-hint").textContent = r.hint || "OAuth login started.";
  const cb = r.callbackUrl || "";
  const cbNote = $("oauth-callback-note");
  resetOAuthRewrite();
  const rewrite =
    !!r.loginUrl && !r.callbackViaWeb && (r.callbackHostRewrite || isLoopbackCallback(cb));
  if (r.callbackViaWeb && cb) {
    cbNote.replaceChildren(
      "After sign-in, OAuth redirects to ",
      codeText(cb),
      ". This app forwards the callback to Cursor CLI on the server.",
    );
  } else if (rewrite) {
    $("oauth-hint").textContent =
      "Open the login URL below. After sign-in, paste the localhost callback address into Complete callback. This app forwards code and state to the login process.";
    cbNote.textContent =
      "The provider still redirects to localhost. If that page does not open, paste the address below.";
    showOAuthRewrite(cb);
    if (r.tunnelHint) {
      $("oauth-tunnel").hidden = false;
      $("oauth-tunnel").textContent = r.tunnelHint;
    }
  } else if (cb) {
    cbNote.replaceChildren("After sign-in, OAuth redirects to ", codeText(cb), ".");
  } else {
    cbNote.textContent = "";
  }
  const url = r.loginUrl || "";
  const wrap = $("oauth-url-wrap");
  if (url) {
    wrap.style.display = "block";
    const link = $("oauth-url-link");
    link.href = url;
    link.textContent = url;
    link.onclick = (event) => {
      if (openOAuthLoginWindow(url)) event.preventDefault();
    };
    $("oauth-open").onclick = () => openOAuthLoginWindow(url);
    $("oauth-copy").onclick = async () => {
      try {
        await navigator.clipboard.writeText(url);
        alert("URL copied");
      } catch {
        prompt("Copy this URL:", url);
      }
    };
  } else {
    wrap.style.display = "none";
  }
  $("oauth-manual").textContent = r.manualCommand
    ? `Terminal fallback:\n${r.manualCommand}`
    : "";
  const watchNote = $("oauth-watch-note");
  if (r.loginId) {
    const wait = formatWait(r.timeoutMs || OAUTH_TIMEOUT_DEFAULT_MS);
    const where = configAuthTarget(oauthWatchPluginId)
      ? "The configuration window shows success or failure. Configuration is saved only after success."
      : "The result appears on this page.";
    watchNote.hidden = false;
    watchNote.textContent = `This window closes when authentication finishes, or after ${wait}. ${where}`;
    startOAuthWatch(r.loginId, r.timeoutMs, oauthWatchPluginId);
  } else {
    watchNote.hidden = true;
    watchNote.textContent = "";
    if (configAuthTarget(oauthWatchPluginId)) {
      showAuthStatus($("mcp-auth-status"), "", "");
      setConfigAuthHold(false);
    }
    oauthWatchPluginId = null;
  }
  if (!$("oauth-dialog").open) $("oauth-dialog").showModal();
}

function beginMcpLoginDialog() {
  stopOAuthPoll();
  $("oauth-hint").textContent = "Starting OAuth login…";
  $("oauth-url-wrap").style.display = "none";
  $("oauth-callback-note").textContent = "";
  $("oauth-manual").textContent = "";
  showAuthStatus($("oauth-watch-note"), "", "");
  resetOAuthRewrite();
  if (configAuthTarget(oauthWatchPluginId)) {
    showAuthStatus(
      $("mcp-auth-status"),
      "pending",
      "Starting authentication. The login window closes when authentication finishes, or after 5 minutes. Configuration is saved only after success.",
    );
    setConfigAuthHold(true);
  }
  if (!$("oauth-dialog").open) $("oauth-dialog").showModal();
}

function clearOAuthLoginStart(message) {
  stopOAuthPoll();
  setConfigAuthHold(false);
  showAuthStatus($("mcp-auth-status"), "", "");
  oauthWatchPluginId = null;
  const dialog = $("oauth-dialog");
  if (dialog?.open) dialog.close();
  if (message) alert(message);
}

async function catalogMcpLogin(marketplaceId, name) {
  try {
    oauthWatchPluginId = null;
    beginMcpLoginDialog();
    const r = await api("/api/plugins/mcp-login", {
      method: "POST",
      body: JSON.stringify({ marketplaceId, name }),
    });
    showMcpLoginResult(r);
  } catch (e) {
    clearOAuthLoginStart(e.message);
  }
}

async function mcpLogin(id, server) {
  if (!server) {
    alert("No MCP server in this plugin");
    return;
  }
  try {
    oauthWatchPluginId = id;
    beginMcpLoginDialog();
    const r = await api(
      `/api/plugins/installed/${encodeURIComponent(id)}/mcp-login`,
      { method: "POST", body: JSON.stringify({ server }) },
    );
    showMcpLoginResult(r);
  } catch (e) {
    clearOAuthLoginStart(e.message);
  }
}

async function removeMp(id) {
  if (!confirm(`Remove marketplace ${id}?`)) return;
  await api(`/api/plugins/marketplaces/${encodeURIComponent(id)}`, { method: "DELETE" });
  await refreshAll();
}

let registryInitWatch = null;

function startRegistryInitWatch() {
  if (registryInitWatch) return;
  setMutationButtonsDisabled(true);
  registryInitWatch = (async () => {
    try {
      await waitForRegistryInit();
      firstPageLoad = false;
      setMutationButtonsDisabled(false);
      await Promise.all([loadCatalog(), loadInstalled()]);
    } catch (e) {
      setMutationButtonsDisabled(false);
      const el = $("catalog-list");
      if (el) {
        el.insertAdjacentHTML(
          "afterbegin",
          `<div class="empty" role="alert">${esc(e.message)}</div>`,
        );
      }
    } finally {
      registryInitWatch = null;
    }
  })();
}

async function refreshAll() {
  await loadMarketplaces();
  await Promise.all([loadCatalog(), loadInstalled()]);
  if (firstPageLoad) startRegistryInitWatch();
}

$("refresh-catalog-btn").onclick = async () => {
  try {
    const { marketplaces } = await api("/api/plugins/marketplaces");
    await Promise.all(
      marketplaces.map((m) =>
        api("/api/plugins/marketplaces/refresh", {
          method: "POST",
          body: JSON.stringify({ id: m.id }),
        }).catch(() => {}),
      ),
    );
    await refreshAll();
  } catch (e) {
    alert(e.message);
  }
};
$("sync-cli-btn").onclick = async () => {
  try {
    const r = await api("/api/plugins/sync-cli-cache", { method: "POST", body: "{}" });
    const blockedN = (r.blocked || []).length;
    alert(
      `Imported: ${(r.imported || []).join(", ") || "none"}\nSkipped (already installed): ${(r.skipped || []).length}` +
        (blockedN ? `\nSkipped (you uninstalled): ${blockedN}` : ""),
    );
    await refreshAll();
  } catch (e) {
    alert(e.message);
  }
};
$("search-input").addEventListener("input", () => {
  clearTimeout(window._searchT);
  catalogPage = 1;
  window._searchT = setTimeout(() => loadCatalog().catch(() => {}), 300);
});
$("marketplace-select").onchange = () => {
  catalogPage = 1;
  loadCatalog().catch((e) => alert(e.message));
};
const categorySelect = $("category-select");
if (categorySelect) {
  categorySelect.onchange = () => {
    catalogPage = 1;
    loadCatalog().catch((e) => alert(e.message));
  };
}
const pageSizeSelect = $("catalog-page-size");
if (pageSizeSelect) {
  pageSizeSelect.value = String(catalogPageSize);
  pageSizeSelect.onchange = () => {
    const n = Number(pageSizeSelect.value);
    if (CATALOG_PAGE_SIZE_OPTIONS.includes(n)) {
      catalogPageSize = n;
      catalogPage = 1;
      loadCatalog().catch((e) => alert(e.message));
    }
  };
}
$("redeploy-btn").onclick = async () => {
  try {
    await api("/api/plugins/redeploy", { method: "POST", body: "{}" });
    alert("Redeployed");
  } catch (e) {
    alert(e.message);
  }
};
$("add-mp-btn").onclick = async () => {
  try {
    await api("/api/plugins/marketplaces", {
      method: "POST",
      body: JSON.stringify({ url: $("mp-url").value, name: $("mp-name").value }),
    });
    $("mp-url").value = "";
    await refreshAll();
  } catch (e) {
    alert(e.message);
  }
};
$("config-save").onclick = () => saveConfig();
$("config-cancel").onclick = () => $("config-dialog").close();
$("oauth-close").onclick = () => $("oauth-dialog").close();
$("oauth-pasted").addEventListener("input", () => previewOAuthRewrite());
$("oauth-rewrite-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("oauth-pasted");
  const err = $("oauth-rewrite-error");
  let url;
  try {
    url = rewriteLoopbackOAuthCallback(input.value, appCallbackUrl());
  } catch (rewriteError) {
    input.setAttribute("aria-invalid", "true");
    input.setCustomValidity(rewriteError.message || "Paste the localhost callback address.");
    err.hidden = false;
    err.textContent = rewriteError.message || "Paste the localhost callback address.";
    input.focus();
    return;
  }
  input.setCustomValidity("");
  input.removeAttribute("aria-invalid");
  const link = $("oauth-rewrite-link");
  link.href = url;
  link.textContent = url;
  link.hidden = false;
  if (oauthPopup && !oauthPopup.closed) {
    try {
      oauthPopup.close();
    } catch {
      /* ignore */
    }
  }
  const opened = window.open(url, "_blank");
  oauthPopup = opened;
  if (opened) {
    try {
      opened.opener = null;
    } catch {
      /* ignore */
    }
    $("oauth-rewrite-status").textContent =
      "Opened the callback in a new tab. This window closes when authentication finishes.";
  } else {
    $("oauth-rewrite-status").textContent = "The browser blocked the new tab. Use the link above.";
  }
});

loadStatus();
refreshAll().catch((e) => {
  $("catalog-list").innerHTML = `<div class="empty">${esc(e.message)}</div>`;
});
