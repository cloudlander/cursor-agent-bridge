import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import {
  catalogEntryOnline,
  handleCatalogApi,
  listCatalogEntries,
  matchCatalogApi,
  proxyCatalogApp,
  readCatalogEntry,
  type CatalogEntry,
} from "./app-catalog.js";
import type { BridgeConfig } from "./config.js";
import { getBridgePublicContext } from "./bridge-request-context.js";
import { handleDynamicAppControl } from "./dynamic-app-supervisor.js";
import { publicPath } from "./http-public-path.js";
import { json } from "./http.js";

/** Safe app directory name (alphanumeric, dot, dash, underscore). */
export const APP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** Top-level path segments reserved for the bridge (not app short URLs). */
export const RESERVED_APP_SEGMENTS = new Set([
  "api",
  "apps",
  "static",
  "v1",
  "health",
  "healthz",
  "wiki",
  "chat",
  "plugins",
  "callback",
  "cursor-agent",
]);

/** Reserve this instance’s public path segment so user apps cannot use the same short name. */
export function registerBridgeAppSegment(segment: string): void {
  RESERVED_APP_SEGMENTS.add(segment);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export function appsDirOf(config: BridgeConfig): string {
  const explicit = process.env.CURSOR_BRIDGE_APPS_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  return path.join(path.dirname(config.sessionsLogPath), "apps");
}

function ensureAppsDir(appsDir: string): void {
  try {
    fs.mkdirSync(appsDir, { recursive: true });
  } catch {
    /* ignore */
  }
}

function safeJoin(root: string, rel: string): string | null {
  const target = path.normalize(path.join(root, rel));
  const rootNorm = path.normalize(root);
  if (target !== rootNorm && !target.startsWith(rootNorm + path.sep)) return null;
  return target;
}

function notFound(res: http.ServerResponse): void {
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found\n");
}

function mapAppsPublic(
  apps: AppSummary[],
  req: http.IncomingMessage,
  config: BridgeConfig,
): AppSummary[] {
  const ctx = getBridgePublicContext(req);
  const mount = ctx?.mount ?? "";
  return apps.map((a) => ({
    ...a,
    url: publicPath(a.url, mount, config.appSegment),
    shortUrl: publicPath(a.shortUrl, mount, config.appSegment),
  }));
}

function serveFile(res: http.ServerResponse, filePath: string): void {
  fs.readFile(filePath, (err, data) => {
    if (err) return notFound(res);
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] ?? "application/octet-stream";
    res.writeHead(200, {
      "content-type": mime,
      "content-length": data.length,
      "cache-control": "no-cache",
    });
    res.end(data);
  });
}

export type AppSummary = {
  name: string;
  url: string;
  shortUrl: string;
  hasIndex: boolean;
  updatedAt?: string;
  /** `static` is a folder with files; `proxy` is a process registered in the catalog. */
  kind: "static" | "proxy";
  title?: string;
  online?: boolean;
  description?: string;
  /** Proxy only. `stopped` means the supervisor will not relaunch it. */
  desired?: "running" | "stopped";
  /** Proxy published a launch command the bridge can start. */
  managed?: boolean;
  pid?: number;
};

/** Scan appsDir for subdirectories containing index.html (no caching — hot deploy). */
export function listApps(appsDir: string): AppSummary[] {
  ensureAppsDir(appsDir);
  let entries: string[];
  try {
    entries = fs.readdirSync(appsDir);
  } catch {
    return [];
  }

  const apps: AppSummary[] = [];
  for (const name of entries) {
    if (!APP_NAME_PATTERN.test(name)) continue;
    const appRoot = path.join(appsDir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(appRoot);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const indexPath = path.join(appRoot, "index.html");
    let hasIndex = false;
    let updatedAt: string | undefined;
    try {
      const indexStat = fs.statSync(indexPath);
      hasIndex = indexStat.isFile();
      updatedAt = indexStat.mtime.toISOString();
    } catch {
      hasIndex = false;
    }
    apps.push({
      name,
      url: `/apps/${name}/`,
      shortUrl: `/${name}/`,
      hasIndex,
      updatedAt,
      kind: "static",
    });
  }
  return mergeCatalogApps(appsDir, apps);
}

function mergeCatalogApps(appsDir: string, apps: AppSummary[]): AppSummary[] {
  const byName = new Map(apps.map((app) => [app.name, app]));
  for (const entry of listCatalogEntries(appsDir)) {
    const existing = byName.get(entry.name);
    byName.set(entry.name, catalogSummary(entry, existing?.hasIndex ?? false));
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function catalogSummary(entry: CatalogEntry, hasIndex: boolean): AppSummary {
  return {
    name: entry.name,
    url: `/apps/${entry.name}/`,
    shortUrl: `/${entry.name}/`,
    hasIndex,
    updatedAt: entry.heartbeatAt,
    kind: "proxy",
    title: entry.title,
    online: entry.desired === "stopped" ? false : catalogEntryOnline(entry),
    description: entry.description,
    desired: entry.desired,
    managed: Boolean(entry.launch),
    pid: entry.pid,
  };
}

export function isRegisteredAppName(appsDir: string, name: string): boolean {
  if (!APP_NAME_PATTERN.test(name)) return false;
  const indexPath = path.join(appsDir, name, "index.html");
  try {
    return fs.statSync(indexPath).isFile();
  } catch {
    return false;
  }
}

function parseAppsRoute(pathname: string): { kind: "list" } | { kind: "app"; name: string; rel: string } | null {
  if (pathname === "/apps" || pathname === "/apps/") {
    return { kind: "list" };
  }
  const m = pathname.match(/^\/apps\/([^/]+)(?:\/(.*))?$/);
  if (!m) return null;
  const name = decodeURIComponent(m[1] ?? "");
  if (!APP_NAME_PATTERN.test(name)) return null;
  const rel = m[2] ?? "";
  return { kind: "app", name, rel };
}

function parseShortAppRoute(pathname: string): { name: string; rel: string } | null {
  const m = pathname.match(/^\/([^/]+)(?:\/(.*))?$/);
  if (!m) return null;
  const name = decodeURIComponent(m[1] ?? "");
  if (RESERVED_APP_SEGMENTS.has(name)) return null;
  if (!APP_NAME_PATTERN.test(name)) return null;
  return { name, rel: m[2] ?? "" };
}

function parseStaticAppRoute(pathname: string): { name: string; rel: string } | null {
  if (!pathname.startsWith("/static/")) return null;
  const rest = pathname.slice("/static/".length);
  const slash = rest.indexOf("/");
  if (slash < 0) return null;
  const name = decodeURIComponent(rest.slice(0, slash));
  if (!APP_NAME_PATTERN.test(name)) return null;
  return { name, rel: rest.slice(slash + 1) };
}

export function dynamicAppsMatches(
  req: http.IncomingMessage,
  config?: BridgeConfig,
): boolean {
  const method = req.method ?? "GET";
  const pathname = pathnameOf(req);
  if (pathname === "/api/apps") return method === "GET";
  if (pathname === "/api/apps/deploy") return method === "POST";
  if (matchCatalogApi(method, pathname)) return true;
  if (config && catalogOwns(appsDirOf(config), pathname)) return true;
  if (method !== "GET" && method !== "HEAD") return false;
  if (pathname === "/apps" || pathname.startsWith("/apps/")) return true;
  if (pathname.startsWith("/static/")) return true;
  const short = parseShortAppRoute(pathname);
  if (short === null) return false;
  if (!config) return false;
  return isRegisteredAppName(appsDirOf(config), short.name);
}

function catalogOwns(appsDir: string, pathname: string): boolean {
  const appsRoute = parseAppsRoute(pathname);
  if (appsRoute?.kind === "app" && readCatalogEntry(appsDir, appsRoute.name)) return true;
  const short = parseShortAppRoute(pathname);
  if (short && readCatalogEntry(appsDir, short.name)) return true;
  return false;
}

function pathnameOf(req: http.IncomingMessage): string {
  return (req.url ?? "/").split("?")[0] ?? "/";
}

function searchOf(req: http.IncomingMessage): string {
  const raw = req.url ?? "/";
  const q = raw.indexOf("?");
  return q < 0 ? "" : raw.slice(q);
}

function upstreamPath(rel: string, search: string): string {
  const path = rel ? `/${rel}` : "/";
  return `${path}${search}`;
}

function forwardedPrefix(
  req: http.IncomingMessage,
  config: BridgeConfig,
  internal: string,
): string {
  const ctx = getBridgePublicContext(req);
  const stripped = internal.replace(/\/$/, "") || "/";
  if (!ctx) return stripped;
  return publicPath(stripped, ctx.mount, config.appSegment).replace(/\/$/, "") || stripped;
}

function serveAppFile(
  res: http.ServerResponse,
  appsDir: string,
  name: string,
  rel: string,
): boolean {
  if (!isRegisteredAppName(appsDir, name)) return false;
  const appRoot = path.join(appsDir, name);
  const relPath = rel || "index.html";
  const target = safeJoin(appRoot, relPath);
  if (!target) {
    notFound(res);
    return true;
  }
  serveFile(res, target);
  return true;
}

function handleAppAssetRoute(
  res: http.ServerResponse,
  appsDir: string,
  name: string,
  rel: string,
  method: string,
): boolean {
  if (!isRegisteredAppName(appsDir, name)) {
    notFound(res);
    return true;
  }
  if (method === "HEAD") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end();
    return true;
  }
  return serveAppFile(res, appsDir, name, rel);
}

export type DeployAppResult =
  | { ok: true; name: string; url: string; shortUrl: string; appsDir: string }
  | { ok: false; error: string };

/** Copy a workspace folder into apps storage (hot deploy, no restart). */
export function deployAppFromSource(
  appsDir: string,
  name: string,
  sourceDir: string,
  workspace: string,
): DeployAppResult {
  if (!APP_NAME_PATTERN.test(name)) {
    return { ok: false, error: "invalid app name" };
  }
  const resolvedSource = path.isAbsolute(sourceDir)
    ? path.resolve(sourceDir)
    : path.resolve(workspace, sourceDir);
  const workspaceNorm = path.normalize(path.resolve(workspace));
  const sourceNorm = path.normalize(resolvedSource);
  if (
    sourceNorm !== workspaceNorm &&
    !sourceNorm.startsWith(workspaceNorm + path.sep)
  ) {
    return { ok: false, error: "source must be under workspace" };
  }
  try {
    if (!fs.statSync(sourceNorm).isDirectory()) {
      return { ok: false, error: "source is not a directory" };
    }
  } catch {
    return { ok: false, error: "source not found" };
  }
  const indexPath = path.join(sourceNorm, "index.html");
  try {
    if (!fs.statSync(indexPath).isFile()) {
      return { ok: false, error: "source must contain index.html" };
    }
  } catch {
    return { ok: false, error: "source must contain index.html" };
  }
  ensureAppsDir(appsDir);
  const dest = path.join(appsDir, name);
  fs.cpSync(sourceNorm, dest, { recursive: true, force: true });
  return {
    ok: true,
    name,
    url: `/apps/${name}/`,
    shortUrl: `/${name}/`,
    appsDir,
  };
}

function appKindLabel(app: AppSummary): string {
  if (app.kind === "proxy") {
    if (app.desired === "stopped") return "proxy · stopped";
    const state = app.online === false ? "proxy · offline" : "proxy · online";
    return app.managed === false ? `${state} · no launch command` : state;
  }
  return app.hasIndex ? "static" : "static · missing index.html";
}

function proxyActions(app: AppSummary): string {
  if (app.kind !== "proxy") return "";
  const name = escapeHtml(app.name);
  const unmanaged = app.managed === false;
  const restartDisabled =
    unmanaged && app.desired !== "stopped"
      ? ' disabled title="No launch command registered"'
      : "";
  const stopDisabled = unmanaged ? ' disabled title="No launch command registered"' : "";
  return `<span class="actions">
    <button type="button" data-app-action="restart" data-app-name="${name}"${restartDisabled}>Restart</button>
    <button type="button" data-app-action="stop" data-app-name="${name}"${stopDisabled}>Stop</button>
    <button type="button" class="danger" data-app-action="delete" data-app-name="${name}">Delete</button>
  </span>`;
}

function renderAppsIndexHtml(apps: AppSummary[], catalogApi: string): string {
  const rows =
    apps.length === 0
      ? "<p class=\"empty\">No apps yet. Add a static folder with <code>index.html</code>, or register a local process with <code>POST /api/apps/catalog</code>.</p>"
      : `<ul>${apps
          .map(
            (a) =>
              `<li><div><a href="${a.shortUrl}">${escapeHtml(a.title || a.name)}</a> <span class="muted">${escapeHtml(a.name)} · ${escapeHtml(appKindLabel(a))}${a.pid ? ` · pid ${a.pid}` : ""} · ${escapeHtml(a.url)}</span></div>${proxyActions(a)}</li>`,
          )
          .join("")}</ul>`;
  const api = JSON.stringify(catalogApi);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>User apps</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 46rem; margin: 2rem auto; padding: 0 1rem; }
    h1 { font-size: 1.25rem; }
    ul { list-style: none; padding: 0; margin: 0; }
    li { display: flex; gap: 0.75rem; align-items: center; justify-content: space-between; border-top: 1px solid #e6e6e6; padding: 0.65rem 0; }
    .muted { color: #666; font-size: 0.9em; }
    .empty { color: #555; }
    .actions { display: flex; gap: 0.35rem; flex-shrink: 0; }
    button { font: inherit; font-size: 0.8rem; padding: 0.2rem 0.55rem; cursor: pointer; }
    button.danger { color: #a40000; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    code { background: #f4f4f4; padding: 0.1em 0.35em; border-radius: 3px; }
    #app-action-status { min-height: 1.2em; color: #a40000; }
  </style>
</head>
<body>
  <h1>Deployed apps</h1>
  <p>Static sites and dynamic apps are listed together. A dynamic app that registers a launch command is started with the bridge and restarted if it exits. Restart, Stop, and Delete apply to dynamic apps.</p>
  ${rows}
  <p id="app-action-status" role="status"></p>
  <script>
    const catalogApi = ${api};
    const status = document.getElementById("app-action-status");
    document.body.addEventListener("click", async (event) => {
      const button = event.target instanceof Element ? event.target.closest("[data-app-action]") : null;
      if (!(button instanceof HTMLButtonElement)) return;
      const action = button.getAttribute("data-app-action");
      const name = button.getAttribute("data-app-name");
      if (!action || !name) return;
      if (action === "stop" && !confirm("Stop " + name + "? It stays stopped until you restart it.")) return;
      if (action === "delete" && !confirm("Deregister " + name + " and stop its process?")) return;
      if (action === "restart" && !confirm("Restart " + name + "?")) return;
      button.disabled = true;
      status.textContent = "";
      const method = action === "delete" ? "DELETE" : "POST";
      const path = action === "delete"
        ? catalogApi + "/" + encodeURIComponent(name)
        : catalogApi + "/" + encodeURIComponent(name) + "/" + action;
      try {
        const res = await fetch(path, { method });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || res.statusText || String(res.status));
        location.reload();
      } catch (err) {
        status.textContent = err instanceof Error ? err.message : String(err);
        button.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Serve user-deployed static sites. Returns true when the request was handled
 * (including 404 for unknown app names under /apps/).
 */
export function handleDynamicApps(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: BridgeConfig,
): boolean {
  const pathname = pathnameOf(req);
  const appsDir = appsDirOf(config);
  const catalogMatch = matchCatalogApi(req.method ?? "GET", pathname);
  if (
    catalogMatch &&
    (catalogMatch.op === "stop" ||
      catalogMatch.op === "restart" ||
      catalogMatch.op === "delete")
  ) {
    handleDynamicAppControl(req, res, appsDir, catalogMatch);
    return true;
  }

  if (req.method === "GET" && pathname === "/api/apps") {
    json(res, 200, {
      appsDir,
      apps: mapAppsPublic(listApps(appsDir), req, config),
    });
    return true;
  }

  if (
    handleCatalogApi(req, res, {
      appsDir,
      reservedNames: RESERVED_APP_SEGMENTS,
    })
  ) {
    return true;
  }

  const search = searchOf(req);
  const appsRoute = parseAppsRoute(pathname);
  if (appsRoute) {
    if (appsRoute.kind === "list") {
      if (req.method !== "GET" && req.method !== "HEAD") return false;
      if (req.method === "HEAD") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end();
        return true;
      }
      const ctx = getBridgePublicContext(req);
      const catalogApi = publicPath(
        "/api/apps/catalog",
        ctx?.mount ?? "",
        config.appSegment,
      );
      const html = renderAppsIndexHtml(
        mapAppsPublic(listApps(appsDir), req, config),
        catalogApi,
      );
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(html);
      return true;
    }

    const catalogApp = readCatalogEntry(appsDir, appsRoute.name);
    if (catalogApp) {
      proxyCatalogApp(
        req,
        res,
        catalogApp,
        upstreamPath(appsRoute.rel, search),
        forwardedPrefix(req, config, `/apps/${appsRoute.name}`),
      );
      return true;
    }
    if ((req.method ?? "GET") !== "GET" && (req.method ?? "GET") !== "HEAD") return false;

    return handleAppAssetRoute(
      res,
      appsDir,
      appsRoute.name,
      appsRoute.rel,
      req.method ?? "GET",
    );
  }

  const shortRoute = parseShortAppRoute(pathname);
  if (shortRoute) {
    const catalogApp = readCatalogEntry(appsDir, shortRoute.name);
    if (catalogApp) {
      proxyCatalogApp(
        req,
        res,
        catalogApp,
        upstreamPath(shortRoute.rel, search),
        forwardedPrefix(req, config, `/${shortRoute.name}`),
      );
      return true;
    }
    if ((req.method ?? "GET") !== "GET" && (req.method ?? "GET") !== "HEAD") return false;
    const registered = isRegisteredAppName(appsDir, shortRoute.name);
    if (!registered) {
      if (shortRoute.rel === "" && pathname === `/${shortRoute.name}`) {
        return false;
      }
      notFound(res);
      return true;
    }
    return handleAppAssetRoute(
      res,
      appsDir,
      shortRoute.name,
      shortRoute.rel,
      req.method ?? "GET",
    );
  }

  const staticRoute = parseStaticAppRoute(pathname);
  if (staticRoute && req.method === "GET") {
    if (serveAppFile(res, appsDir, staticRoute.name, staticRoute.rel)) {
      return true;
    }
    return false;
  }

  if (staticRoute && req.method === "HEAD") {
    if (!isRegisteredAppName(appsDir, staticRoute.name)) return false;
    res.writeHead(200);
    res.end();
    return true;
  }

  return false;
}
