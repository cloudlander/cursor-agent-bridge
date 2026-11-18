import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import {
  catalogEntryOnline,
  listCatalogEntries,
  proxyCatalogApp,
  readCatalogEntry,
  registerRunningApp,
  type CatalogEntry,
  type RunningAppBody,
} from "./app-catalog.js";
import type { BridgeConfig } from "./config.js";
import { getBridgePublicContext } from "./bridge-request-context.js";
import {
  bundleDir,
  copyStaticAppFiles,
  exportAppZip,
  importAppZip,
  MAX_APP_ZIP_BYTES,
} from "./app-bundle.js";
import {
  deleteDynamicApp,
  kickDynamicAppSupervisor,
  restartDynamicApp,
  stopDynamicApp,
} from "./dynamic-app-supervisor.js";
import { publicPath } from "./http-public-path.js";
import { BodyTooLargeError, json } from "./http.js";

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
  /** `static` is a folder of files; `dynamic` is a process the bridge proxies to. */
  kind: "static" | "dynamic";
  title?: string;
  online?: boolean;
  description?: string;
  /** Dynamic only. `stopped` means the supervisor will not relaunch it. */
  desired?: "running" | "stopped";
  /** Dynamic app has a launch command the bridge can start. */
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
    kind: "dynamic",
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
  if (matchAppsApi(method, pathname)) return true;
  if (config && catalogOwns(appsDirOf(config), pathname)) return true;
  if (method !== "GET" && method !== "HEAD") return false;
  if (pathname === "/apps" || pathname.startsWith("/apps/")) return true;
  if (pathname.startsWith("/static/")) return true;
  const short = parseShortAppRoute(pathname);
  if (short === null) return false;
  if (!config) return false;
  return isRegisteredAppName(appsDirOf(config), short.name);
}

type AppsApiMatch =
  | { op: "list" }
  | { op: "deploy" }
  | { op: "export" | "restart" | "stop" | "delete"; name: string };

function matchAppsApi(method: string, pathname: string): AppsApiMatch | null {
  if (pathname === "/api/apps") return method === "GET" ? { op: "list" } : null;
  if (pathname === "/api/apps/deploy" && method === "POST") return { op: "deploy" };
  const action = pathname.match(/^\/api\/apps\/([^/]+)\/(export|restart|stop)$/);
  if (action) {
    const op = action[2] as "export" | "restart" | "stop";
    if ((op === "export") !== (method === "GET")) return null;
    if (op !== "export" && method !== "POST") return null;
    return { op, name: decodeURIComponent(action[1] ?? "") };
  }
  const del = pathname.match(/^\/api\/apps\/([^/]+)$/);
  if (del && method === "DELETE") return { op: "delete", name: decodeURIComponent(del[1] ?? "") };
  return null;
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
  const copied = copyStaticAppFiles(appsDir, name, sourceNorm);
  if (!copied.ok) return { ok: false, error: copied.error };
  return {
    ok: true,
    name,
    url: `/apps/${name}/`,
    shortUrl: `/${name}/`,
    appsDir,
  };
}

export type AppControlResult =
  | { ok: true; name: string; kind: "static" | "dynamic"; desired?: "running" | "stopped" }
  | { ok: false; status: number; error: string };

function staticAppDir(appsDir: string, name: string): string | null {
  const root = path.resolve(appsDir);
  const dest = path.resolve(root, name);
  if (dest !== path.join(root, name)) return null;
  try {
    return fs.lstatSync(dest).isDirectory() ? dest : null;
  } catch {
    return null;
  }
}

/** Delete a static or dynamic app. A dynamic app is stopped and its installed bundle removed. */
export async function deleteApp(appsDir: string, name: string): Promise<AppControlResult> {
  if (!APP_NAME_PATTERN.test(name)) {
    return { ok: false, status: 400, error: "invalid app name" };
  }
  const dir = staticAppDir(appsDir, name);
  if (readCatalogEntry(appsDir, name)) {
    await deleteDynamicApp(appsDir, name);
    fs.rmSync(bundleDir(appsDir, name), { recursive: true, force: true });
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true, name, kind: "dynamic", desired: "stopped" };
  }
  if (!dir) return { ok: false, status: 404, error: "app not found" };
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true, name, kind: "static" };
}

/** Restart or stop a dynamic app. A static app has no process. */
export async function controlApp(
  appsDir: string,
  name: string,
  op: "restart" | "stop",
): Promise<AppControlResult> {
  if (!APP_NAME_PATTERN.test(name)) {
    return { ok: false, status: 400, error: "invalid app name" };
  }
  if (!readCatalogEntry(appsDir, name)) {
    return staticAppDir(appsDir, name)
      ? { ok: false, status: 400, error: `static app has no process to ${op}` }
      : { ok: false, status: 404, error: "app not found" };
  }
  const result =
    op === "restart" ? await restartDynamicApp(appsDir, name) : await stopDynamicApp(appsDir, name);
  if (!result.ok) return result;
  return { ok: true, name, kind: "dynamic", desired: result.desired };
}

async function readRequestBuffer(
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    total += chunk.length;
    if (total > maxBytes) {
      req.destroy();
      throw new BodyTooLargeError("zip is too large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function handleAppExport(res: http.ServerResponse, appsDir: string, name: string): void {
  let result: ReturnType<typeof exportAppZip>;
  try {
    result = exportAppZip(appsDir, name);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    json(res, 500, { error: message });
    return;
  }
  if (!result.ok) {
    json(res, result.status, { error: result.error });
    return;
  }
  res.writeHead(200, {
    "content-type": "application/zip",
    "content-length": result.zip.length,
    "content-disposition": `attachment; filename="${result.name}.zip"`,
    "cache-control": "no-store",
  });
  res.end(result.zip);
}

const JSON_DEPLOY_MAX_BYTES = 1024 * 1024;

function isZipContentType(req: http.IncomingMessage): boolean {
  const type = String(req.headers["content-type"] ?? "").toLowerCase();
  return type.includes("application/zip") || type.includes("application/x-zip");
}

function handleAppDeploy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  appsDir: string,
  config: BridgeConfig,
): void {
  const zipBody = isZipContentType(req);
  void (async () => {
    try {
      const raw = await readRequestBuffer(req, zipBody ? MAX_APP_ZIP_BYTES : JSON_DEPLOY_MAX_BYTES);
      if (res.headersSent) return;
      const ctx = getBridgePublicContext(req);
      const mount = ctx?.mount ?? "";
      if (zipBody) {
        const result = await importAppZip(appsDir, raw, {
          reservedNames: RESERVED_APP_SEGMENTS,
        });
        if (res.headersSent) return;
        if (!result.ok) {
          json(res, result.status, { error: result.error });
          return;
        }
        json(res, 200, {
          ok: true,
          name: result.name,
          kind: result.kind,
          url: publicPath(result.url, mount, config.appSegment),
          shortUrl: publicPath(result.shortUrl, mount, config.appSegment),
          started: result.started,
        });
        return;
      }
      let body: RunningAppBody & { sourceDir?: unknown } = {};
      try {
        body = JSON.parse(raw.length === 0 ? "{}" : raw.toString("utf8")) as typeof body;
      } catch {
        json(res, 400, { error: "invalid json" });
        return;
      }
      if (body.port !== undefined || body.launch !== undefined) {
        const result = await registerRunningApp(req, body, {
          appsDir,
          reservedNames: RESERVED_APP_SEGMENTS,
        });
        if (res.headersSent) return;
        if (!result.ok) {
          json(res, result.status, { error: result.error });
          return;
        }
        kickDynamicAppSupervisor();
        json(res, 200, {
          ok: true,
          name: result.name,
          kind: "dynamic",
          port: result.port,
          ttlMs: result.ttlMs,
          url: publicPath(`/apps/${result.name}/`, mount, config.appSegment),
          shortUrl: publicPath(`/${result.name}/`, mount, config.appSegment),
          started: false,
        });
        return;
      }
      const name = String(body.name ?? "").trim();
      const sourceDir = String(body.sourceDir ?? "").trim();
      if (!name || !sourceDir) {
        json(res, 400, { error: "name and sourceDir are required" });
        return;
      }
      const result = deployAppFromSource(appsDir, name, sourceDir, config.workspace);
      if (!result.ok) {
        json(res, 400, { error: result.error });
        return;
      }
      json(res, 200, {
        ...result,
        kind: "static",
        url: publicPath(result.url, mount, config.appSegment),
        shortUrl: publicPath(result.shortUrl, mount, config.appSegment),
      });
    } catch (err) {
      if (res.headersSent) return;
      if (err instanceof BodyTooLargeError) {
        json(res, 413, { error: zipBody ? "zip is too large" : "request body is too large" });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      json(res, 500, { error: message });
    }
  })();
}

function handleAppsApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  appsDir: string,
  config: BridgeConfig,
  api: AppsApiMatch,
): void {
  if (api.op === "list") {
    json(res, 200, { appsDir, apps: mapAppsPublic(listApps(appsDir), req, config) });
    return;
  }
  if (api.op === "deploy") {
    handleAppDeploy(req, res, appsDir, config);
    return;
  }
  if (api.op === "export") {
    handleAppExport(res, appsDir, api.name);
    return;
  }
  const op = api.op;
  const name = api.name;
  void (async () => {
    try {
      const result = op === "delete" ? await deleteApp(appsDir, name) : await controlApp(appsDir, name, op);
      if (res.headersSent) return;
      if (!result.ok) {
        json(res, result.status, { error: result.error });
        return;
      }
      json(res, 200, { ...result });
    } catch (err) {
      if (res.headersSent) return;
      const message = err instanceof Error ? err.message : String(err);
      json(res, 500, { error: message });
    }
  })();
}

/**
 * Apps API, static app files, and the proxy to dynamic apps. Returns true when the request was handled
 * (including 404 for unknown app names under /apps/).
 */
export function handleDynamicApps(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: BridgeConfig,
): boolean {
  const pathname = pathnameOf(req);
  const appsDir = appsDirOf(config);
  const api = matchAppsApi(req.method ?? "GET", pathname);
  if (api) {
    handleAppsApi(req, res, appsDir, config, api);
    return true;
  }

  const search = searchOf(req);
  const appsRoute = parseAppsRoute(pathname);
  if (appsRoute) {
    if (appsRoute.kind === "list") {
      if (req.method !== "GET" && req.method !== "HEAD") return false;
      const ctx = getBridgePublicContext(req);
      res.writeHead(302, {
        location: `${ctx ? publicPath("/", ctx.mount, config.appSegment) : "/"}#apps`,
        "cache-control": "no-store",
      });
      res.end();
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
