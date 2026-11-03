import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import type { BridgeConfig } from "./config.js";
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
]);

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

function redirect(res: http.ServerResponse, location: string): void {
  res.writeHead(302, { location, "cache-control": "no-store" });
  res.end();
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
    });
  }
  apps.sort((a, b) => a.name.localeCompare(b.name));
  return apps;
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
  if (method !== "GET" && method !== "HEAD") return false;
  if (pathname === "/apps" || pathname.startsWith("/apps/")) return true;
  if (pathname.startsWith("/static/")) return true;
  const short = parseShortAppRoute(pathname);
  if (short === null) return false;
  if (!config) return false;
  return isRegisteredAppName(appsDirOf(config), short.name);
}

function pathnameOf(req: http.IncomingMessage): string {
  return (req.url ?? "/").split("?")[0] ?? "/";
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

function renderAppsIndexHtml(apps: AppSummary[]): string {
  const rows =
    apps.length === 0
      ? "<p class=\"empty\">No apps yet. Copy a site folder into the apps directory (must include <code>index.html</code>).</p>"
      : `<ul>${apps
          .map(
            (a) =>
              `<li><a href="${a.shortUrl}">${escapeHtml(a.name)}</a> <span class="muted">(${escapeHtml(a.url)})</span>${a.hasIndex ? "" : " <em>(missing index.html)</em>"}</li>`,
          )
          .join("")}</ul>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>User apps</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; }
    h1 { font-size: 1.25rem; }
    ul { line-height: 1.8; }
    .muted { color: #666; font-size: 0.9em; }
    .empty { color: #555; }
    code { background: #f4f4f4; padding: 0.1em 0.35em; border-radius: 3px; }
  </style>
</head>
<body>
  <h1>Deployed apps</h1>
  <p>Served dynamically from the apps storage directory — no bridge restart required.</p>
  ${rows}
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

  if (req.method === "GET" && pathname === "/api/apps") {
    json(res, 200, { appsDir, apps: listApps(appsDir) });
    return true;
  }

  const appsRoute = parseAppsRoute(pathname);
  if (appsRoute) {
    if (appsRoute.kind === "list") {
      if (req.method === "HEAD") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end();
        return true;
      }
      const html = renderAppsIndexHtml(listApps(appsDir));
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(html);
      return true;
    }

    if (appsRoute.rel === "" && pathname.endsWith(`/apps/${appsRoute.name}`)) {
      redirect(res, `/apps/${appsRoute.name}/`);
      return true;
    }

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
    const registered = isRegisteredAppName(appsDir, shortRoute.name);
    if (!registered) {
      if (shortRoute.rel === "" && pathname === `/${shortRoute.name}`) {
        return false;
      }
      notFound(res);
      return true;
    }
    if (shortRoute.rel === "" && pathname === `/${shortRoute.name}`) {
      redirect(res, `/${shortRoute.name}/`);
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
