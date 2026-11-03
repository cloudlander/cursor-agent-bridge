import * as fs from "node:fs";
import * as path from "node:path";

import type { BridgeConfig } from "../config.js";

/** Per-MCP-server overrides (auth, endpoint, extra env/headers). */
export type ServerOverride = {
  url?: string;
  disabled?: boolean;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  /** OAuth-style auth block merged into the server's `auth` (CLIENT_ID, CLIENT_SECRET, scopes…). */
  auth?: Record<string, unknown>;
};

/** User supplied plugin configuration (credentials etc.). Never leaves the host unmasked. */
export type PluginConfig = {
  /** Variables substituted for `${env:NAME}` and injected into every stdio MCP server's env. */
  env: Record<string, string>;
  /** Headers injected into every remote (url) MCP server. */
  headers: Record<string, string>;
  /** Overrides keyed by the plugin's own MCP server name. */
  servers: Record<string, ServerOverride>;
};

export type DeployedItems = {
  skills: string[];
  commands: string[];
  agents: string[];
  mcpServers: string[];
  warnings: string[];
};

export type PluginSourceDescriptor =
  | { kind: "path"; path: string }
  | { kind: "git"; url: string; ref?: string; path?: string }
  /** Materialized tree under Cursor CLI's plugins/cache (already on disk). */
  | { kind: "cache"; dir: string };

export type InstalledPlugin = {
  /** `<marketplaceId>/<name>` */
  id: string;
  name: string;
  marketplaceId: string;
  version?: string;
  description?: string;
  commit?: string;
  source: PluginSourceDescriptor;
  installedAt: string;
  updatedAt: string;
  enabled: boolean;
  config: PluginConfig;
  deployed?: DeployedItems;
};

export type MarketplaceDef = {
  id: string;
  name: string;
  url: string;
  builtin?: boolean;
  addedAt: string;
  lastRefreshed?: string;
};

export type Registry = {
  version: 1;
  marketplaces: MarketplaceDef[];
  plugins: InstalledPlugin[];
};

export const OFFICIAL_MARKETPLACE: MarketplaceDef = {
  id: "cursor-public",
  name: "Cursor (official)",
  url: "https://github.com/cursor/plugins",
  builtin: true,
  addedAt: "1970-01-01T00:00:00.000Z",
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function assertSafeName(kind: string, value: unknown): string {
  if (typeof value !== "string" || !SAFE_NAME.test(value) || value.includes("..")) {
    throw new ApiError(400, `invalid ${kind}: ${String(value)}`);
  }
  return value;
}

export function emptyConfig(): PluginConfig {
  return { env: {}, headers: {}, servers: {} };
}

export function storageDirOf(config: BridgeConfig): string {
  return path.dirname(config.sessionsLogPath);
}

export type PluginPaths = {
  root: string;
  registryFile: string;
  marketplacesDir: string;
  installedDir: string;
  /** Materialized cursor config (skills/commands/agents/mcp.json) used to seed chat-only workspaces. */
  runtimeDir: string;
};

export function pluginPaths(config: BridgeConfig): PluginPaths {
  const root =
    process.env.CURSOR_BRIDGE_PLUGINS_DIR?.trim() ||
    path.join(storageDirOf(config), "plugins");
  return {
    root,
    registryFile: path.join(root, "registry.json"),
    marketplacesDir: path.join(root, "marketplaces"),
    installedDir: path.join(root, "installed"),
    runtimeDir: path.join(root, "runtime"),
  };
}

export function writeFileAtomic(file: string, data: string, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
}

export function readRegistry(config: BridgeConfig): Registry {
  const p = pluginPaths(config);
  let reg: Registry = { version: 1, marketplaces: [], plugins: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(p.registryFile, "utf8")) as Partial<Registry>;
    reg = {
      version: 1,
      marketplaces: Array.isArray(raw.marketplaces) ? raw.marketplaces : [],
      plugins: Array.isArray(raw.plugins) ? raw.plugins : [],
    };
  } catch {
    /* fresh registry */
  }
  if (!reg.marketplaces.some((m) => m.id === OFFICIAL_MARKETPLACE.id)) {
    reg.marketplaces.unshift({ ...OFFICIAL_MARKETPLACE });
  }
  for (const pl of reg.plugins) pl.config = { ...emptyConfig(), ...pl.config };
  return reg;
}

export function writeRegistry(config: BridgeConfig, reg: Registry): void {
  writeFileAtomic(pluginPaths(config).registryFile, JSON.stringify(reg, null, 2));
}

// Serialize registry mutations so concurrent API calls cannot clobber each other.
let queue: Promise<unknown> = Promise.resolve();
export function withRegistryLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
}

// ---------------------------------------------------------------------------
// Secret masking
// ---------------------------------------------------------------------------

export const MASK = "********";
const SECRET_KEY = /key|token|secret|password|passwd|auth|bearer|credential|cookie/i;

export function looksSecret(key: string): boolean {
  return SECRET_KEY.test(key);
}

function maskDeep(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, key));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskDeep(v, k);
    return out;
  }
  if (typeof value === "string" && value && looksSecret(key)) return MASK;
  return value;
}

export function maskConfig(cfg: PluginConfig): PluginConfig {
  return maskDeep(cfg) as PluginConfig;
}

/** Replace MASK placeholders in `incoming` with the stored value at the same path. */
export function unmaskDeep(existing: unknown, incoming: unknown): unknown {
  if (incoming === MASK) return existing;
  if (Array.isArray(incoming)) {
    return incoming.map((v, i) =>
      unmaskDeep(Array.isArray(existing) ? existing[i] : undefined, v),
    );
  }
  if (incoming && typeof incoming === "object") {
    const ex =
      existing && typeof existing === "object" && !Array.isArray(existing)
        ? (existing as Record<string, unknown>)
        : {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(incoming)) out[k] = unmaskDeep(ex[k], v);
    return out;
  }
  return incoming;
}

function stringMap(v: unknown, what: string): Record<string, string> {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) {
    throw new ApiError(400, `${what} must be an object`);
  }
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (!k.trim()) continue;
    if (typeof val !== "string") throw new ApiError(400, `${what}.${k} must be a string`);
    out[k.trim()] = val;
  }
  return out;
}

/** Validate user-submitted config and restore masked secrets from `existing`. */
export function sanitizeConfigInput(input: unknown, existing: PluginConfig): PluginConfig {
  if (!input || typeof input !== "object") throw new ApiError(400, "config must be an object");
  const raw = unmaskDeep(existing, input) as Record<string, unknown>;
  const servers: Record<string, ServerOverride> = {};
  const rawServers = raw.servers ?? {};
  if (typeof rawServers !== "object" || Array.isArray(rawServers)) {
    throw new ApiError(400, "servers must be an object");
  }
  for (const [name, ov] of Object.entries(rawServers as Record<string, unknown>)) {
    if (!ov || typeof ov !== "object" || Array.isArray(ov)) {
      throw new ApiError(400, `servers.${name} must be an object`);
    }
    const o = ov as Record<string, unknown>;
    const clean: ServerOverride = {};
    if (o.url !== undefined && o.url !== "") {
      if (typeof o.url !== "string") throw new ApiError(400, `servers.${name}.url must be a string`);
      clean.url = o.url;
    }
    if (o.disabled === true) clean.disabled = true;
    const env = stringMap(o.env, `servers.${name}.env`);
    const headers = stringMap(o.headers, `servers.${name}.headers`);
    if (Object.keys(env).length) clean.env = env;
    if (Object.keys(headers).length) clean.headers = headers;
    if (o.auth !== undefined) {
      if (typeof o.auth !== "object" || o.auth === null || Array.isArray(o.auth)) {
        throw new ApiError(400, `servers.${name}.auth must be an object`);
      }
      if (Object.keys(o.auth).length) clean.auth = o.auth as Record<string, unknown>;
    }
    servers[name] = clean;
  }
  return {
    env: stringMap(raw.env, "env"),
    headers: stringMap(raw.headers, "headers"),
    servers,
  };
}
