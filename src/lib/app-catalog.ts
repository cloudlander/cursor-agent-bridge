import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import type { BridgeConfig } from "./config.js";
import { BodyTooLargeError, json, readBodyLimited } from "./http.js";

/** Same shape as dynamic-apps APP_NAME_PATTERN. */
const APP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export const CATALOG_PROVE_PATH = "/__bridge/catalog-prove";
export const CATALOG_HEALTH_PATH = "/__bridge/catalog-health";

const DEFAULT_TTL_MS = 45_000;
const MIN_TTL_MS = 5_000;
const MAX_TTL_MS = 600_000;
/** Drop registrations that have not heartbeated for this long. */
const PURGE_AFTER_MS = 60 * 60 * 1000;
const PROVE_TIMEOUT_MS = 2_000;
const REGISTER_BODY_MAX = 8_192;

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

export type AppLaunchSpec = {
  command: string;
  args: string[];
  cwd?: string;
};

export type CatalogDesired = "running" | "stopped";

export type CatalogEntry = {
  name: string;
  port: number;
  title?: string;
  description?: string;
  ttlMs: number;
  registeredAt: string;
  heartbeatAt: string;
  /** Listener pid, when the process reported one. */
  pid?: number;
  /** `stopped` survives restarts so the supervisor does not relaunch the process. */
  desired: CatalogDesired;
  /** How the bridge starts this process. Absent for proxies that only registered a port. */
  launch?: AppLaunchSpec;
};

export type CatalogHost = {
  appsDir: string;
  reservedNames: ReadonlySet<string>;
};

export function catalogDir(appsDir: string): string {
  return path.join(appsDir, ".catalog");
}

export function catalogEntryPath(appsDir: string, name: string): string {
  return path.join(catalogDir(appsDir), `${name}.json`);
}

function bridgeEndpointPath(appsDir: string): string {
  return path.join(catalogDir(appsDir), "bridge.json");
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export function isCatalogAppName(name: string): boolean {
  return APP_NAME_PATTERN.test(name);
}

function clampTtl(ttlSec: unknown): number {
  const n = typeof ttlSec === "number" ? ttlSec : DEFAULT_TTL_MS / 1000;
  if (!Number.isFinite(n)) return DEFAULT_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Math.round(n * 1000)));
}

const COMMAND_NAME = /^[A-Za-z0-9._+-]+$/;
const MAX_LAUNCH_ARGS = 40;
const MAX_LAUNCH_ARG = 1024;

export function parsePid(value: unknown): number | undefined | "invalid" {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > 2_147_483_647
  ) {
    return "invalid";
  }
  return value;
}

export function parseLaunchSpec(
  value: unknown,
  opts: { checkExists?: boolean } = {},
): { ok: true; launch: AppLaunchSpec } | { ok: false; error: string } {
  const checkExists = opts.checkExists !== false;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "launch must be an object" };
  }
  const row = value as { command?: unknown; args?: unknown; cwd?: unknown };
  if (typeof row.command !== "string") {
    return { ok: false, error: "launch.command is required" };
  }
  const command = row.command.trim();
  if (!command || command.length > 512 || command.includes("\0") || /[\r\n]/.test(command)) {
    return { ok: false, error: "launch.command is invalid" };
  }
  if (command.includes("/") || command.includes("\\")) {
    if (!path.isAbsolute(command)) {
      return { ok: false, error: "launch.command path must be absolute" };
    }
    if (checkExists) {
      try {
        if (!fs.statSync(command).isFile()) {
          return { ok: false, error: "launch.command is not a file" };
        }
      } catch {
        return { ok: false, error: "launch.command not found" };
      }
    }
  } else if (!COMMAND_NAME.test(command)) {
    return { ok: false, error: "launch.command is invalid" };
  }
  const args: string[] = [];
  if (row.args !== undefined) {
    if (!Array.isArray(row.args) || row.args.length > MAX_LAUNCH_ARGS) {
      return { ok: false, error: "launch.args must be an array of strings" };
    }
    for (const arg of row.args) {
      if (typeof arg !== "string" || arg.length > MAX_LAUNCH_ARG || arg.includes("\0")) {
        return { ok: false, error: "launch.args must be an array of strings" };
      }
      args.push(arg);
    }
  }
  let cwd: string | undefined;
  if (row.cwd !== undefined && row.cwd !== null && row.cwd !== "") {
    if (typeof row.cwd !== "string" || !path.isAbsolute(row.cwd)) {
      return { ok: false, error: "launch.cwd must be an absolute path" };
    }
    if (checkExists) {
      try {
        if (!fs.statSync(row.cwd).isDirectory()) {
          return { ok: false, error: "launch.cwd is not a directory" };
        }
      } catch {
        return { ok: false, error: "launch.cwd not found" };
      }
    }
    cwd = row.cwd;
  }
  return { ok: true, launch: cwd ? { command, args, cwd } : { command, args } };
}

function launchFromDisk(value: unknown): AppLaunchSpec | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = parseLaunchSpec(value, { checkExists: false });
  return parsed.ok ? parsed.launch : undefined;
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function asEntry(value: unknown): CatalogEntry | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<CatalogEntry>;
  if (typeof row.name !== "string" || !isCatalogAppName(row.name)) return null;
  if (typeof row.port !== "number" || !Number.isInteger(row.port)) return null;
  if (row.port < 1 || row.port > 65535) return null;
  if (typeof row.ttlMs !== "number" || typeof row.heartbeatAt !== "string") return null;
  if (typeof row.registeredAt !== "string") return null;
  const launch = launchFromDisk(row.launch);
  const pid = parsePid(row.pid);
  return {
    name: row.name,
    port: row.port,
    title: typeof row.title === "string" ? row.title : undefined,
    description: typeof row.description === "string" ? row.description : undefined,
    ttlMs: row.ttlMs,
    registeredAt: row.registeredAt,
    heartbeatAt: row.heartbeatAt,
    pid: pid === "invalid" ? undefined : pid,
    desired: row.desired === "stopped" ? "stopped" : "running",
    launch,
  };
}

export function catalogEntryOnline(entry: CatalogEntry, now = Date.now()): boolean {
  const beat = Date.parse(entry.heartbeatAt);
  if (!Number.isFinite(beat)) return false;
  return now - beat <= entry.ttlMs;
}

function expired(entry: CatalogEntry, now = Date.now()): boolean {
  const beat = Date.parse(entry.heartbeatAt);
  if (!Number.isFinite(beat)) return true;
  return now - beat > entry.ttlMs + PURGE_AFTER_MS;
}

export function readCatalogEntry(appsDir: string, name: string): CatalogEntry | null {
  if (!isCatalogAppName(name)) return null;
  try {
    const raw = fs.readFileSync(catalogEntryPath(appsDir, name), "utf8");
    return asEntry(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function listCatalogEntries(appsDir: string): CatalogEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(catalogDir(appsDir));
  } catch {
    return [];
  }
  const now = Date.now();
  const entries: CatalogEntry[] = [];
  for (const file of names) {
    if (!file.endsWith(".json") || file === "bridge.json") continue;
    const name = file.slice(0, -".json".length);
    const entry = readCatalogEntry(appsDir, name);
    if (!entry) continue;
    if (expired(entry, now) && !keepExpiredCatalogEntry(entry)) {
      try {
        fs.unlinkSync(catalogEntryPath(appsDir, name));
      } catch {
        /* ignore */
      }
      continue;
    }
    entries.push(entry);
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

function saveEntry(
  appsDir: string,
  entry: CatalogEntry,
  opts: { updateDesired?: boolean } = {},
): void {
  if (!opts.updateDesired) {
    const disk = readCatalogEntry(appsDir, entry.name);
    if (disk) entry.desired = disk.desired;
  }
  writeJsonAtomic(catalogEntryPath(appsDir, entry.name), entry);
}

/** Persists `desired`. Register and heartbeat keep the value already on disk. */
export function writeCatalogEntry(appsDir: string, entry: CatalogEntry): void {
  saveEntry(appsDir, entry, { updateDesired: true });
}

/** Launch-backed and explicitly stopped apps stay registered until deregister. */
function keepExpiredCatalogEntry(entry: CatalogEntry): boolean {
  return Boolean(entry.launch) || entry.desired === "stopped";
}

function connectHost(listenHost: string): string {
  const host = listenHost.trim();
  if (host === "0.0.0.0" || host === "::" || host === "[::]") return "127.0.0.1";
  return host || "127.0.0.1";
}

/** Written on listen so local MCP processes can find the catalog without extra env. */
export function writeBridgeCatalogEndpoint(config: BridgeConfig, appsDir: string): void {
  try {
    writeJsonAtomic(bridgeEndpointPath(appsDir), {
      listenHost: config.host,
      connectHost: connectHost(config.host),
      port: config.port,
      catalogPath: "/api/apps/catalog",
      pid: process.pid,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[catalog] could not write bridge endpoint: ${message}`);
  }
}

export type CatalogApiMatch =
  | { op: "register" }
  | { op: "delete"; name: string }
  | { op: "heartbeat"; name: string }
  | { op: "stop"; name: string }
  | { op: "restart"; name: string };

export function matchCatalogApi(method: string, pathname: string): CatalogApiMatch | null {
  if (pathname === "/api/apps/catalog" && method === "POST") return { op: "register" };
  const beat = pathname.match(/^\/api\/apps\/catalog\/([^/]+)\/heartbeat$/);
  if (beat && method === "POST") {
    return { op: "heartbeat", name: decodeURIComponent(beat[1] ?? "") };
  }
  const stop = pathname.match(/^\/api\/apps\/catalog\/([^/]+)\/stop$/);
  if (stop && method === "POST") {
    return { op: "stop", name: decodeURIComponent(stop[1] ?? "") };
  }
  const restart = pathname.match(/^\/api\/apps\/catalog\/([^/]+)\/restart$/);
  if (restart && method === "POST") {
    return { op: "restart", name: decodeURIComponent(restart[1] ?? "") };
  }
  const del = pathname.match(/^\/api\/apps\/catalog\/([^/]+)$/);
  if (del && method === "DELETE") {
    return { op: "delete", name: decodeURIComponent(del[1] ?? "") };
  }
  return null;
}

function pathnameOf(req: http.IncomingMessage): string {
  return (req.url ?? "/").split("?")[0] ?? "/";
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (!value) return undefined;
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.split(",")[0]?.trim();
  return trimmed || undefined;
}

async function proveLocalPort(port: number, name: string, nonce: string): Promise<boolean> {
  const url =
    `http://127.0.0.1:${port}${CATALOG_PROVE_PATH}` +
    `?nonce=${encodeURIComponent(nonce)}&name=${encodeURIComponent(name)}`;
  try {
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(PROVE_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean; nonce?: string; name?: string };
    return body.ok === true && body.nonce === nonce && body.name === name;
  } catch {
    return false;
  }
}

export async function probeCatalogHealth(port: number, name: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${CATALOG_HEALTH_PATH}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(PROVE_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean; name?: string };
    return body.ok === true && body.name === name;
  } catch {
    return false;
  }
}

function applyProcessReport(
  req: http.IncomingMessage,
  body: { pid?: unknown; launch?: unknown },
):
  | { ok: true; pid?: number; launch?: AppLaunchSpec }
  | { ok: false; status: number; error: string } {
  const pid = parsePid(body.pid);
  if (pid === "invalid") {
    return { ok: false, status: 400, error: "pid must be a positive integer" };
  }
  if (body.launch === undefined) return { ok: true, pid };
  if (!isLoopbackAddress(req.socket?.remoteAddress)) {
    return { ok: false, status: 403, error: "launch spec is accepted only from loopback" };
  }
  const parsed = parseLaunchSpec(body.launch);
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
  return { ok: true, pid, launch: parsed.launch };
}

function clip(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

async function registerCatalogApp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  host: CatalogHost,
): Promise<void> {
  let raw: string;
  try {
    raw = await readBodyLimited(req, REGISTER_BODY_MAX);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      json(res, 413, { error: "body too large" });
      return;
    }
    throw err;
  }
  let body: {
    name?: string;
    port?: number;
    title?: string;
    description?: string;
    ttlSec?: number;
    pid?: number;
    launch?: unknown;
  };
  try {
    body = JSON.parse(raw || "{}") as typeof body;
  } catch {
    json(res, 400, { error: "invalid json" });
    return;
  }
  const name = String(body.name ?? "").trim();
  const port = body.port;
  if (!isCatalogAppName(name) || host.reservedNames.has(name)) {
    json(res, 400, { error: "invalid app name" });
    return;
  }
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    json(res, 400, { error: "port must be an integer from 1 to 65535" });
    return;
  }
  const nonce = crypto.randomBytes(16).toString("hex");
  const proved = await proveLocalPort(port, name, nonce);
  if (!proved) {
    json(res, 400, {
      error:
        "listener on 127.0.0.1 did not prove ownership (GET /__bridge/catalog-prove)",
    });
    return;
  }
  const reported = applyProcessReport(req, body);
  if (!reported.ok) {
    json(res, reported.status, { error: reported.error });
    return;
  }
  const now = new Date().toISOString();
  const previous = readCatalogEntry(host.appsDir, name);
  const entry: CatalogEntry = {
    name,
    port,
    title: clip(body.title, 120),
    description: clip(body.description, 400),
    ttlMs: clampTtl(body.ttlSec),
    registeredAt: previous?.registeredAt ?? now,
    heartbeatAt: now,
    pid: reported.pid ?? previous?.pid,
    desired: "running",
    launch: reported.launch ?? previous?.launch,
  };
  saveEntry(host.appsDir, entry);
  json(res, 200, {
    ok: true,
    name,
    port,
    url: `/apps/${name}/`,
    shortUrl: `/${name}/`,
    ttlMs: entry.ttlMs,
  });
}

async function heartbeatCatalogApp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  host: CatalogHost,
  name: string,
): Promise<void> {
  const entry = readCatalogEntry(host.appsDir, name);
  if (!entry) {
    json(res, 404, { error: "not registered" });
    return;
  }
  const healthy = await probeCatalogHealth(entry.port, entry.name);
  if (!healthy) {
    json(res, 502, { error: "upstream health check failed", name });
    return;
  }
  let raw = "";
  try {
    raw = await readBodyLimited(req, REGISTER_BODY_MAX);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      json(res, 413, { error: "body too large" });
      return;
    }
    throw err;
  }
  if (raw.trim()) {
    let body: { pid?: number; launch?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      json(res, 400, { error: "invalid json" });
      return;
    }
    const reported = applyProcessReport(req, body);
    if (!reported.ok) {
      json(res, reported.status, { error: reported.error });
      return;
    }
    if (reported.pid !== undefined) entry.pid = reported.pid;
    if (reported.launch) entry.launch = reported.launch;
  }
  entry.heartbeatAt = new Date().toISOString();
  saveEntry(host.appsDir, entry);
  json(res, 200, { ok: true, name, online: true, desired: entry.desired });
}

export function handleCatalogApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  host: CatalogHost,
): boolean {
  const match = matchCatalogApi(req.method ?? "GET", pathnameOf(req));
  if (!match || match.op === "stop" || match.op === "restart" || match.op === "delete") {
    return false;
  }
  void (async () => {
    try {
      if (match.op === "register") {
        await registerCatalogApp(req, res, host);
        return;
      }
      await heartbeatCatalogApp(req, res, host, match.name);
    } catch (err) {
      if (res.headersSent) return;
      const message = err instanceof Error ? err.message : String(err);
      json(res, 500, { error: message });
    }
  })();
  return true;
}

export function proxyCatalogApp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  entry: CatalogEntry,
  upstreamPath: string,
  forwardedPrefix: string,
): void {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(key) || key === "host") continue;
    headers[key] = value;
  }
  headers.host = `127.0.0.1:${entry.port}`;
  headers["x-forwarded-prefix"] = forwardedPrefix;
  const publicHost = firstHeader(req.headers["x-forwarded-host"]) || firstHeader(req.headers.host);
  if (publicHost) headers["x-forwarded-host"] = publicHost;
  const proto = firstHeader(req.headers["x-forwarded-proto"]);
  headers["x-forwarded-proto"] = proto || "http";

  const preq = http.request(
    {
      hostname: "127.0.0.1",
      port: entry.port,
      method: req.method,
      path: upstreamPath.startsWith("/") ? upstreamPath : `/${upstreamPath}`,
      headers,
      timeout: 60_000,
    },
    (pres) => {
      const out: http.OutgoingHttpHeaders = {};
      for (const [key, value] of Object.entries(pres.headers)) {
        if (HOP_BY_HOP.has(key)) continue;
        out[key] = value;
      }
      res.writeHead(pres.statusCode ?? 502, out);
      pres.pipe(res);
    },
  );
  preq.on("timeout", () => preq.destroy());
  preq.on("error", () => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    json(res, 502, { error: "upstream unavailable", app: entry.name });
  });
  req.pipe(preq);
}
