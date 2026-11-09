import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { BridgeConfig } from "./config.js";
import { computeSessionStats, readLastLines } from "./session-log.js";
import {
  fetchCursorAccountSnapshot,
  type CursorAccountDashboardSnapshot,
} from "./cursor-account-snapshot.js";
import { chatApiMatches, handleChatApi } from "./chat-api.js";
import { handlePluginApi, pluginApiMatches } from "./plugins/plugin-api.js";
import {
  handleMcpOAuthCallback,
  mcpOAuthCallbackMatches,
} from "./plugins/mcp-oauth-callback.js";
import {
  handleWorkspaceFile,
  workspaceFileMatches,
} from "./workspace-file.js";
import {
  cancelAgentLoginSession,
  getAgentLoginSession,
  resolveAgentAuthStatus,
  startAgentLoginSession,
} from "./agent-login.js";
import {
  appsDirOf,
  deployAppFromSource,
  dynamicAppsMatches,
  handleDynamicApps,
  listApps,
} from "./dynamic-apps.js";
import {
  handleUpstreamSyncApi,
  upstreamSyncApiMatches,
} from "./upstream-sync.js";
import { getBridgePublicContext } from "./bridge-request-context.js";
import { prepareBridgeHtml } from "./bridge-html.js";
import { publicPath } from "./http-public-path.js";
import { resolvePublicEndpointUrls } from "./plugins/public-origin.js";

const ACCOUNT_USAGE_CACHE_MS = 45_000;
let accountUsageCache:
  | { key: string; snapshot: CursorAccountDashboardSnapshot }
  | undefined;

const PLIST_LABEL = "com.cursor-api-proxy";

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
};

function packageRoot(): string {
  const fromEnv = process.env.CURSOR_API_PROXY_ROOT?.trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

const START_TIME = Date.now();

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": buf.length,
    "cache-control": "no-store",
  });
  res.end(buf);
}

function notFound(res: http.ServerResponse): void {
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found\n");
}

function safeJoin(root: string, rel: string): string | null {
  const target = path.normalize(path.join(root, rel));
  if (!target.startsWith(root)) return null;
  return target;
}

function serveFile(res: http.ServerResponse, filePath: string): void {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return notFound(res);
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] ?? "application/octet-stream";
    res.writeHead(200, {
      "content-type": mime,
      "content-length": stat.size,
      "cache-control": "no-cache",
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function serveBridgeHtml(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  filePath: string,
): void {
  const ctx = getBridgePublicContext(req);
  if (!ctx) return serveFile(res, filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) return notFound(res);
    const body = prepareBridgeHtml(data.toString("utf8"), ctx);
    const buf = Buffer.from(body);
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": buf.length,
      "cache-control": "no-cache",
    });
    res.end(buf);
  });
}

function launchdLoadedSync(): boolean {
  try {
    const out = execSync("launchctl list 2>/dev/null", { encoding: "utf8" });
    return out.split("\n").some((l) => l.trim().endsWith(PLIST_LABEL));
  } catch {
    return false;
  }
}

function storagePaths(config: BridgeConfig) {
  const storageDir = path.dirname(config.sessionsLogPath);
  const pidFile = path.join(storageDir, "proxy.pid");
  const serviceLog = path.join(storageDir, "proxy.log");
  return { storageDir, pidFile, serviceLog };
}

/** Cloudera AI Application worker (app.sh + CDSW env), not macOS ~/.local/bin launcher. */
/** Shell fragment used for CAI in-process restart (keepalive respawns after SIGTERM). */
export function caiRestartKillCommand(pid: number): string {
  return `sleep 0.5 && kill -TERM ${pid} 2>/dev/null || true`;
}

export function isCaiDeployment(): boolean {
  const root = packageRoot();
  if (!fs.existsSync(path.join(root, "app.sh"))) return false;
  const env = process.env;
  return Boolean(
    env.CDSW_API_KEY?.trim() ||
      env.CDSW_APP_PORT?.trim() ||
      env.CDSW_PUBLIC_PORT?.trim() ||
      env.CDSW_READONLY_PORT?.trim(),
  );
}

function getStatus(
  config: BridgeConfig,
  version: string,
  cb: (s: Record<string, unknown>) => void,
  req?: http.IncomingMessage,
): void {
  const ctx = req ? getBridgePublicContext(req) : undefined;
  const mount = ctx?.mount ?? "";
  const root = packageRoot();
  const publicDir = path.join(root, "public");
  const docsDir = path.join(root, "docs");
  const { storageDir, pidFile, serviceLog } = storagePaths(config);

  let pid: number | null = null;
  try {
    const raw = fs.readFileSync(pidFile, "utf8").trim();
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) pid = n;
  } catch {
    /* no pid file */
  }

  let running = pid === process.pid;
  if (!running && pid) {
    try {
      process.kill(pid, 0);
      running = true;
    } catch {
      running = false;
    }
  }

  const ownPidIsCurrent = pid === process.pid;
  if (!ownPidIsCurrent) {
    try {
      fs.mkdirSync(storageDir, { recursive: true });
      fs.writeFileSync(pidFile, String(process.pid));
      pid = process.pid;
      running = true;
    } catch {
      /* ignore */
    }
  }

  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const plistPath = path.join(home, "Library/LaunchAgents", `${PLIST_LABEL}.plist`);
  const launchdLoaded = process.platform === "darwin" ? launchdLoadedSync() : false;

  const env = process.env;
  const publicEndpoints = req
    ? resolvePublicEndpointUrls(req, config)
    : undefined;
  cb({
    running,
    pid,
    port: config.port,
    host: config.host,
    version,
    publicOpenAiApiBase: publicEndpoints?.openAiApiBase,
    publicCursorApiBase: publicEndpoints?.cursorApiBase,
    uptimeSeconds: Math.floor((Date.now() - START_TIME) / 1000),
    launchdLoaded,
    plistPath,
    packageRoot: root,
    publicDir,
    docsDir,
    storageDir,
    sessionsLogPath: config.sessionsLogPath,
    appsDir: appsDirOf(config),
    deployedApps: listApps(appsDirOf(config)).map((a) => ({
      ...a,
      url: publicPath(a.url, mount, config.appSegment),
      shortUrl: publicPath(a.shortUrl, mount, config.appSegment),
    })),
    serviceLog,
    pidFile,
    apiKeyConfigured: Boolean(env.CURSOR_API_KEY ?? env.CURSOR_AUTH_TOKEN),
    bridgeApiKeyRequired: Boolean(config.requiredKey),
    /** Plugins UI and `/api/plugins/*` never require a bridge API key. */
    pluginsRequireBridgeKey: false,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    startedAt: new Date(START_TIME).toISOString(),
  });
}

function sanitizedBridgeConfig(
  config: BridgeConfig,
  _req?: http.IncomingMessage,
): Record<string, unknown> {
  return {
    agentBin: config.agentBin,
    useAcp: config.useAcp,
    host: config.host,
    port: config.port,
    defaultModel: config.defaultModel,
    mode: config.mode,
    force: config.force,
    approveMcps: config.approveMcps,
    strictModel: config.strictModel,
    workspace: config.workspace,
    timeoutMs: config.timeoutMs,
    sessionsLogPath: config.sessionsLogPath,
    chatOnlyWorkspace: config.chatOnlyWorkspace,
    verbose: config.verbose,
    maxMode: config.maxMode,
    requiredKey: Boolean(config.requiredKey),
    tlsEnabled: Boolean(config.tlsCertPath && config.tlsKeyPath),
    configDirsCount: config.configDirs.length,
    multiPort: config.multiPort,
    contextPreamble: config.contextPreamble,
    bridgePackageVersion: config.bridgePackageVersion,
    contextExtraConfigured: Boolean(config.contextExtra),
  };
}

function runControl(
  action: string,
  config: BridgeConfig,
  cb: (err: Error | null, result?: { ok: boolean; action: string; scheduled: boolean }) => void,
): void {
  const allowed = ["start", "stop", "restart", "enable", "disable"];
  if (!allowed.includes(action)) {
    return cb(new Error(`invalid action: ${action}`));
  }
  const { serviceLog } = storagePaths(config);
  try {
    fs.mkdirSync(path.dirname(serviceLog), { recursive: true });
  } catch {
    /* ignore */
  }

  let shellCmd: string;
  if (action === "restart" && isCaiDeployment()) {
    // app.sh stop requires /healthz; exit directly so app.py keepalive restarts the CLI.
    shellCmd = caiRestartKillCommand(process.pid);
  } else if (action === "stop" && isCaiDeployment()) {
    const appSh = path.join(packageRoot(), "app.sh");
    if (!fs.existsSync(appSh)) {
      return cb(new Error(`CAI app.sh not found at ${appSh}`));
    }
    shellCmd = `sleep 0.4 && bash '${appSh.replace(/'/g, "'\\''")}' stop >> '${serviceLog.replace(/'/g, "'\\''")}' 2>&1`;
  } else {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    const cliPath = path.join(home, ".local", "bin", "cursor-api-proxy");
    if (!fs.existsSync(cliPath)) {
      return cb(new Error(`CLI not found at ${cliPath} (see docs/WIKI.md)`));
    }
    shellCmd = `sleep 0.4 && '${cliPath.replace(/'/g, "'\\''")}' ${action} >> '${serviceLog.replace(/'/g, "'\\''")}' 2>&1`;
  }

  const child = spawn("sh", ["-c", shellCmd], {
    detached: true,
    stdio: "ignore",
    cwd: packageRoot(),
    env: process.env,
  });
  child.unref();
  cb(null, { ok: true, action, scheduled: true });
}

function parseQuery(url: string): Record<string, string> {
  const i = url.indexOf("?");
  const out: Record<string, string> = {};
  if (i < 0) return out;
  for (const kv of url.slice(i + 1).split("&")) {
    const [k, v = ""] = kv.split("=");
    if (k) out[decodeURIComponent(k)] = decodeURIComponent(v);
  }
  return out;
}

export type AdminDashboardOpts = {
  version: string;
  config: BridgeConfig;
};

export function adminDashboardMatches(
  req: http.IncomingMessage,
  config?: BridgeConfig,
): boolean {
  const url = req.url ?? "";
  const pathname = url.split("?")[0] ?? "";
  if (
    req.method === "GET" &&
    (pathname === "/" ||
      pathname === "/wiki" ||
      pathname === "/chat" ||
      pathname === "/plugins")
  )
    return true;
  if (dynamicAppsMatches(req, config)) return true;
  if (mcpOAuthCallbackMatches(req)) return true;
  if (pluginApiMatches(req)) return true;
  if (req.method === "GET" && pathname.startsWith("/static/")) return true;
  if (workspaceFileMatches(req)) return true;
  if (req.method === "GET" && pathname.startsWith("/api/")) return true;
  if (req.method === "POST" && pathname === "/api/control") return true;
  if (req.method === "POST" && pathname === "/api/log/clear") return true;
  if (req.method === "POST" && pathname === "/api/agent/chat") return true;
  if (req.method === "GET" && pathname === "/api/agent-auth") return true;
  if (req.method === "GET" && pathname === "/api/agent-login/status") return true;
  if (req.method === "POST" && pathname === "/api/agent-login") return true;
  if (req.method === "POST" && pathname === "/api/agent-login/cancel") return true;
  if (req.method === "POST" && pathname === "/api/apps/deploy") return true;
  if (upstreamSyncApiMatches(req)) return true;
  if (chatApiMatches(req)) return true;
  return false;
}

export function handleAdminDashboard(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: AdminDashboardOpts,
): void {
  const { config, version } = opts;
  const root = packageRoot();
  const publicDir = path.join(root, "public");
  const wikiFile = path.join(root, "docs", "WIKI.md");
  const url = req.url ?? "/";
  const pathname = url.split("?")[0] ?? "/";
  const q = parseQuery(url);
  const protocol =
    config.tlsCertPath && config.tlsKeyPath ? "https" : "http";
  const reqUrl = new URL(url, `${protocol}://${req.headers.host || "localhost"}`);

  if (mcpOAuthCallbackMatches(req)) {
    handleMcpOAuthCallback(req, res, reqUrl);
    return;
  }

  if (req.method === "GET" && pathname === "/") {
    return serveBridgeHtml(req, res, path.join(publicDir, "index.html"));
  }
  if (req.method === "GET" && pathname === "/wiki") {
    return serveBridgeHtml(req, res, path.join(publicDir, "wiki.html"));
  }
  if (req.method === "GET" && pathname === "/chat") {
    return serveBridgeHtml(req, res, path.join(publicDir, "chat.html"));
  }
  if (req.method === "GET" && pathname === "/plugins") {
    return serveBridgeHtml(req, res, path.join(publicDir, "plugins.html"));
  }
  if (req.method === "POST" && pathname === "/api/apps/deploy") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: { name?: string; sourceDir?: string } = {};
      try {
        body = JSON.parse(raw || "{}") as typeof body;
      } catch {
        return json(res, 400, { error: "invalid json" });
      }
      const name = String(body.name ?? "").trim();
      const sourceDir = String(body.sourceDir ?? "").trim();
      if (!name || !sourceDir) {
        return json(res, 400, { error: "name and sourceDir are required" });
      }
      const result = deployAppFromSource(
        appsDirOf(config),
        name,
        sourceDir,
        config.workspace,
      );
      if (!result.ok) return json(res, 400, { error: result.error });
      const ctx = getBridgePublicContext(req);
      const mount = ctx?.mount ?? "";
      json(res, 200, {
        ...result,
        url: publicPath(result.url, mount, config.appSegment),
        shortUrl: publicPath(result.shortUrl, mount, config.appSegment),
      });
    });
    return;
  }
  if (dynamicAppsMatches(req, config) && handleDynamicApps(req, res, config)) {
    return;
  }
  if (pluginApiMatches(req)) {
    void handlePluginApi(req, res, config);
    return;
  }
  if (chatApiMatches(req)) {
    void handleChatApi(req, res, config);
    return;
  }
  if (upstreamSyncApiMatches(req)) {
    handleUpstreamSyncApi(req, res, config);
    return;
  }
  if (req.method === "GET" && pathname.startsWith("/static/")) {
    const rel = pathname.slice("/static/".length);
    const target = safeJoin(publicDir, rel);
    if (!target) return notFound(res);
    return serveFile(res, target);
  }
  if (workspaceFileMatches(req)) {
    return handleWorkspaceFile(req, res, config);
  }

  if (req.method === "GET" && pathname === "/api/agent-auth") {
    return json(res, 200, resolveAgentAuthStatus(config));
  }
  if (req.method === "GET" && pathname === "/api/agent-login/status") {
    const sessionId = q.session ?? q.id;
    const session = getAgentLoginSession(sessionId);
    if (!session) {
      return json(res, 404, { error: "no active login session" });
    }
    if (session.status === "success") {
      accountUsageCache = undefined;
    }
    return json(res, 200, session);
  }
  if (req.method === "POST" && pathname === "/api/agent-login/cancel") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: { sessionId?: string } = {};
      try {
        body = JSON.parse(raw || "{}") as { sessionId?: string };
      } catch {
        return json(res, 400, { error: "invalid json" });
      }
      cancelAgentLoginSession(body.sessionId);
      json(res, 200, { ok: true });
    });
    return;
  }
  if (req.method === "POST" && pathname === "/api/agent-login") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: { accountName?: string } = {};
      try {
        body = JSON.parse(raw || "{}") as { accountName?: string };
      } catch {
        return json(res, 400, { error: "invalid json" });
      }
      void startAgentLoginSession(config, body.accountName).then((result) => {
        if (!result.ok) {
          json(res, 500, {
            error: result.error,
            session: result.session,
          });
          return;
        }
        json(res, 200, result.session);
      });
    });
    return;
  }
  if (req.method === "GET" && pathname === "/api/status") {
    return getStatus(config, version, (s) => json(res, 200, s), req);
  }
  if (req.method === "GET" && pathname === "/api/config") {
    return json(res, 200, sanitizedBridgeConfig(config, req));
  }
  if (req.method === "GET" && pathname === "/api/log") {
    const n = Math.min(5000, Math.max(1, Number(q.lines) || 100));
    return readLastLines(config.sessionsLogPath, n, (err, lines) => {
      if (err) return json(res, 500, { error: String(err) });
      json(res, 200, { path: config.sessionsLogPath, lines });
    });
  }
  if (req.method === "POST" && pathname === "/api/log/clear") {
    // Archive+truncate the sessions log.
    const logPath = config.sessionsLogPath;
    const dir = path.dirname(logPath);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* ignore */
    }

    const archivedAt = new Date().toISOString().replace(/[:.]/g, "-");
    const archivePath = `${logPath}.${archivedAt}.archive`;

    try {
      if (fs.existsSync(logPath)) {
        const st = fs.statSync(logPath);
        if (st.size > 0) fs.renameSync(logPath, archivePath);
        else fs.writeFileSync(archivePath, "", "utf8");
      } else {
        fs.writeFileSync(archivePath, "", "utf8");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return json(res, 500, { error: msg });
    }

    // Ensure dashboard polling continues to work immediately.
    try {
      fs.writeFileSync(logPath, "", "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return json(res, 500, { error: msg });
    }

    return json(res, 200, { archivePath });
  }
  if (req.method === "GET" && pathname === "/api/stats") {
    const hours = Math.min(168, Math.max(1, Number(q.hours) || 24));
    return readLastLines(config.sessionsLogPath, 20_000, (err, lines) => {
      if (err) return json(res, 500, { error: String(err) });
      json(res, 200, computeSessionStats(lines, hours));
    });
  }
  if (req.method === "GET" && pathname === "/api/cursor-account") {
    const cacheKey = config.configDirs.join("\0");
    const now = Date.now();
    if (
      accountUsageCache &&
      accountUsageCache.key === cacheKey &&
      now - Date.parse(accountUsageCache.snapshot.fetchedAt) <
        ACCOUNT_USAGE_CACHE_MS
    ) {
      return json(res, 200, accountUsageCache.snapshot);
    }
    void fetchCursorAccountSnapshot(
      config.configDirs,
      Math.round(ACCOUNT_USAGE_CACHE_MS / 1000),
    )
      .then((snapshot) => {
        accountUsageCache = { key: cacheKey, snapshot };
        json(res, 200, snapshot);
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        json(res, 500, { error: msg });
      });
    return;
  }
  if (req.method === "GET" && pathname === "/api/wiki") {
    fs.readFile(wikiFile, "utf8", (err, data) => {
      if (err) return json(res, 500, { error: "wiki not readable" });
      res.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": "no-cache",
      });
      res.end(data);
    });
    return;
  }
  if (req.method === "POST" && pathname === "/api/control") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: { action?: string } = {};
      try {
        body = JSON.parse(raw || "{}") as { action?: string };
      } catch {
        return json(res, 400, { error: "invalid json" });
      }
      runControl(String(body.action ?? ""), config, (err, result) => {
        if (err) return json(res, 400, { error: err.message });
        json(res, 200, result);
      });
    });
    return;
  }

  notFound(res);
}
