import { fork, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { BridgeConfig } from "../config.js";
import { runMcpLoginSpawn, type McpLoginResult } from "./mcp-login.js";
import { analyzePlugin } from "./manifest.js";
import {
  deployInstalledPlugin,
  deployInstalledPluginAsync,
  listConfigVariables,
  undeployPlugin,
} from "./deploy.js";
import {
  collectCliMcpServerKeys,
  discoverCliCacheCatalog,
  discoverCliCacheCatalogAsync,
  discoverCliCacheLocations,
  discoverCliCacheLocationsAsync,
  isCliMcpDeployed,
  resolveCliCacheDir,
} from "./cli-cache.js";
import {
  fetchPluginSource,
  loadCatalog,
  loadCatalogFromDisk,
  loadCatalogFromDiskAsync,
  marketplaceIdFromUrl,
  parseCatalog,
  parseCatalogAsync,
  syncMarketplace,
  validateGitUrl,
  type CatalogEntry,
} from "./marketplace.js";
import {
  findCloudCatalogEntry,
  loadCursorCloudCatalog,
} from "./cursor-cloud-catalog.js";
import {
  ApiError,
  assertSafeName,
  emptyConfig,
  maskConfig,
  OFFICIAL_MARKETPLACE,
  pluginPaths,
  readRegistry,
  sanitizeConfigInput,
  withRegistryLock,
  writeRegistry,
  type InstalledPlugin,
  type MarketplaceDef,
} from "./store.js";

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Breathing room between marketplace git fetches so HTTP handlers stay responsive. */
function pauseBetweenCatalogEnrichJobs(): Promise<void> {
  if (process.env.CURSOR_BRIDGE_PLUGINS_ENRICH_STAGGER === "0") {
    return Promise.resolve();
  }
  const ms = 1000 + Math.floor(Math.random() * 4000);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Short pause between CPU-heavy plugin jobs (redeploy, bootstrap). */
function pauseForHttpResponsiveness(): Promise<void> {
  if (process.env.CURSOR_BRIDGE_PLUGINS_ENRICH_STAGGER === "0") {
    return yieldToEventLoop();
  }
  const ms = 40 + Math.floor(Math.random() * 120);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pluginId(marketplaceId: string, name: string): string {
  return `${marketplaceId}/${name}`;
}

function installDir(config: BridgeConfig, id: string): string {
  return path.join(pluginPaths(config).installedDir, id.replace(/\//g, "__"));
}

export function listMarketplaces(config: BridgeConfig): MarketplaceDef[] {
  return readRegistry(config).marketplaces;
}

export async function refreshMarketplace(
  config: BridgeConfig,
  id: string,
): Promise<{ count: number }> {
  const reg = readRegistry(config);
  const m = reg.marketplaces.find((x) => x.id === id);
  if (!m) throw new ApiError(404, "marketplace not found");
  const entries = await loadCatalog(config, m, true);
  m.lastRefreshed = new Date().toISOString();
  writeRegistry(config, reg);
  return { count: entries.length };
}

export async function addMarketplace(
  config: BridgeConfig,
  url: string,
  name?: string,
): Promise<MarketplaceDef> {
  const gitUrl = validateGitUrl(url);
  const id = marketplaceIdFromUrl(gitUrl);
  assertSafeName("marketplace id", id);
  return withRegistryLock(async () => {
    const reg = readRegistry(config);
    if (reg.marketplaces.some((m) => m.id === id)) {
      throw new ApiError(409, "marketplace already added");
    }
    const def: MarketplaceDef = {
      id,
      name: name?.trim() || id,
      url: gitUrl,
      addedAt: new Date().toISOString(),
    };
    reg.marketplaces.push(def);
    writeRegistry(config, reg);
    await syncMarketplace(config, def, true);
    return def;
  });
}

export async function removeMarketplace(config: BridgeConfig, id: string): Promise<void> {
  assertSafeName("marketplace id", id);
  if (id === OFFICIAL_MARKETPLACE.id) {
    throw new ApiError(400, "cannot remove built-in marketplace");
  }
  await withRegistryLock(async () => {
    const reg = readRegistry(config);
    reg.marketplaces = reg.marketplaces.filter((m) => m.id !== id);
    reg.plugins = reg.plugins.filter((p) => p.marketplaceId !== id);
    writeRegistry(config, reg);
    fs.rmSync(path.join(pluginPaths(config).marketplacesDir, id), {
      recursive: true,
      force: true,
    });
  });
}

export type CatalogRow = CatalogEntry & {
  installed?: boolean;
  enabled?: boolean;
  /** Present in Cursor CLI plugins/cache but not in the git marketplace index. */
  cliCache?: boolean;
  /** Cursor CLI already wrote MCP entries for this plugin (may differ from proxy install). */
  cliDeployed?: boolean;
};

export type CatalogSearchResult = {
  plugins: CatalogRow[];
  total: number;
  page: number;
  pageSize: number;
  /** Distinct category labels in the current search (before category filter). */
  categories: string[];
};

const DEFAULT_CATALOG_PAGE_SIZE = 5;
const MAX_CATALOG_PAGE_SIZE = 100;
export const UNCATALOGED_CATEGORY = "__uncategorized__";

function catalogCategoryKey(e: CatalogRow): string {
  return e.category?.trim() || "";
}

function compareCatalogRows(a: CatalogRow, b: CatalogRow): number {
  const ca = catalogCategoryKey(a).toLowerCase();
  const cb = catalogCategoryKey(b).toLowerCase();
  if (ca !== cb) {
    if (!ca) return 1;
    if (!cb) return -1;
    return ca.localeCompare(cb);
  }
  const na = (a.displayName || a.name).toLowerCase();
  const nb = (b.displayName || b.name).toLowerCase();
  if (na !== nb) return na.localeCompare(nb);
  return a.name.localeCompare(b.name);
}

/** Sort by category, apply optional category filter, paginate. */
export function paginateCatalogRows(
  rows: CatalogRow[],
  opts: { page?: number; pageSize?: number; category?: string },
): CatalogSearchResult {
  const categories = [
    ...new Set(rows.map((e) => catalogCategoryKey(e)).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  let filtered = rows;
  const catFilter = opts.category?.trim();
  if (catFilter) {
    if (catFilter === UNCATALOGED_CATEGORY) {
      filtered = rows.filter((e) => !catalogCategoryKey(e));
    } else {
      filtered = rows.filter(
        (e) => catalogCategoryKey(e) === catFilter || !catalogCategoryKey(e),
      );
    }
  }

  const sorted = [...filtered].sort(compareCatalogRows);
  const page = Number.isFinite(opts.page) && (opts.page ?? 0) > 0 ? Math.floor(opts.page!) : 1;
  const rawSize =
    Number.isFinite(opts.pageSize) && (opts.pageSize ?? 0) > 0
      ? Math.floor(opts.pageSize!)
      : DEFAULT_CATALOG_PAGE_SIZE;
  const pageSize = Math.min(MAX_CATALOG_PAGE_SIZE, Math.max(1, rawSize));
  const total = sorted.length;
  const start = (page - 1) * pageSize;
  const plugins = sorted.slice(start, start + pageSize);
  return { plugins, total, page, pageSize, categories };
}

type PluginsCatalogIndex = {
  cliCache: CatalogEntry[];
  marketplaces: Map<string, CatalogEntry[]>;
  enriched: boolean;
};

let pluginsCatalogIndex: PluginsCatalogIndex | undefined;

function catalogEntriesForMarketplace(
  config: BridgeConfig,
  m: MarketplaceDef,
): CatalogEntry[] {
  if (pluginsCatalogIndex?.marketplaces.has(m.id)) {
    return pluginsCatalogIndex.marketplaces.get(m.id) ?? [];
  }
  return loadCatalogFromDisk(config, m) ?? [];
}

function catalogEntriesFromCliCache(config: BridgeConfig): CatalogEntry[] {
  if (pluginsCatalogIndex) return pluginsCatalogIndex.cliCache;
  return discoverCliCacheCatalog(config);
}

function ensureEmptyPluginsCatalogIndex(config: BridgeConfig): void {
  if (pluginsCatalogIndex) return;
  const marketplaces = new Map<string, CatalogEntry[]>();
  for (const m of readRegistry(config).marketplaces) {
    marketplaces.set(m.id, []);
  }
  pluginsCatalogIndex = {
    cliCache: [],
    marketplaces,
    enriched: false,
  };
}

/** Fast in-memory index: marketplace paths on disk + CLI cache dirs (no manifest/git). */
export function bootstrapPluginsCatalogIndex(config: BridgeConfig): void {
  const reg = readRegistry(config);
  const marketplaces = new Map<string, CatalogEntry[]>();
  for (const m of reg.marketplaces) {
    const entries = loadCatalogFromDisk(config, m);
    if (entries?.length) marketplaces.set(m.id, entries);
  }
  pluginsCatalogIndex = {
    cliCache: discoverCliCacheLocations(config),
    marketplaces,
    enriched: false,
  };
}

/** Cooperative bootstrap for background init (yields so HTTP stays responsive). */
async function bootstrapPluginsCatalogIndexAsync(config: BridgeConfig): Promise<void> {
  const reg = readRegistry(config);
  const marketplaces = new Map<string, CatalogEntry[]>();
  for (const m of reg.marketplaces) {
    const entries = await loadCatalogFromDiskAsync(config, m);
    marketplaces.set(m.id, entries ?? []);
  }
  const cliCache = await discoverCliCacheLocationsAsync(config);
  pluginsCatalogIndex = {
    cliCache,
    marketplaces,
    enriched: false,
  };
}

async function enrichOneMarketplaceCatalog(
  config: BridgeConfig,
  m: MarketplaceDef,
): Promise<void> {
  await yieldToEventLoop();
  const disk = (await loadCatalogFromDiskAsync(config, m)) ?? [];
  try {
    const dir = await syncMarketplace(config, m);
    await yieldToEventLoop();
    const synced = await parseCatalogAsync(m.id, dir);
    const entries = synced.length ? synced : disk;
    if (pluginsCatalogIndex) pluginsCatalogIndex.marketplaces.set(m.id, entries);
  } catch {
    if (disk.length && pluginsCatalogIndex) {
      pluginsCatalogIndex.marketplaces.set(m.id, disk);
    }
  }
}

async function enrichCliCacheIndex(config: BridgeConfig): Promise<void> {
  await yieldToEventLoop();
  const cliCache = await discoverCliCacheCatalogAsync(config);
  if (pluginsCatalogIndex) pluginsCatalogIndex.cliCache = cliCache;
}

/**
 * Enrich catalog: one marketplace git fetch at a time, 1–5s pause between fetches,
 * then CLI cache scan. Resolves when all work has updated the in-memory index.
 */
async function startPluginsCatalogEnrich(config: BridgeConfig): Promise<void> {
  const reg = readRegistry(config);
  let firstMarketplace = true;
  for (const m of reg.marketplaces) {
    if (!firstMarketplace) {
      await pauseBetweenCatalogEnrichJobs();
    }
    firstMarketplace = false;
    await enrichOneMarketplaceCatalog(config, m);
  }
  await enrichCliCacheIndex(config);
  if (pluginsCatalogIndex) pluginsCatalogIndex.enriched = true;
}

export async function searchCatalog(
  config: BridgeConfig,
  opts: {
    q?: string;
    marketplaceId?: string;
    installed?: boolean;
    page?: number;
    pageSize?: number;
    category?: string;
  },
): Promise<CatalogSearchResult> {
  const reg = readRegistry(config);
  const markets = opts.marketplaceId
    ? reg.marketplaces.filter((m) => m.id === opts.marketplaceId)
    : reg.marketplaces;
  const q = opts.q?.trim().toLowerCase();
  const installedMap = new Map(reg.plugins.map((p) => [`${p.marketplaceId}/${p.name}`, p]));

  const byKey = new Map<string, CatalogRow>();
  for (const m of markets) {
    const entries = catalogEntriesForMarketplace(config, m);
    if (!entries.length) continue;
    for (const e of entries) {
      byKey.set(`${e.marketplaceId}/${e.name}`, { ...e });
    }
  }

  for (const e of catalogEntriesFromCliCache(config)) {
    if (opts.marketplaceId && e.marketplaceId !== opts.marketplaceId) continue;
    const key = `${e.marketplaceId}/${e.name}`;
    const existing = byKey.get(key);
    if (existing) {
      if (existing.source?.kind !== "git") {
        existing.source = e.source;
      }
      existing.description ||= e.description;
      existing.version ||= e.version;
      existing.cliCache = true;
    } else {
      byKey.set(key, { ...e, cliCache: true });
    }
  }

  let cloudEntries: CatalogEntry[] = [];
  try {
    cloudEntries = await loadCursorCloudCatalog(config, {
      search: q || undefined,
      marketplaceId: opts.marketplaceId,
    });
  } catch {
    /* offline / blocked */
  }
  for (const e of cloudEntries) {
    const key = `${e.marketplaceId}/${e.name}`;
    const existing = byKey.get(key);
    if (existing) {
      if (e.source?.kind === "git") {
        existing.source = e.source;
      }
      existing.displayName ||= e.displayName;
      existing.description ||= e.description;
      existing.category ||= e.category;
      existing.keywords = [...new Set([...existing.keywords, ...e.keywords])];
      existing.cloudCatalog = true;
    } else {
      byKey.set(key, { ...e });
    }
  }

  const mcpKeys = collectCliMcpServerKeys(config);
  const all: CatalogRow[] = [];
  for (const e of byKey.values()) {
    const key = `${e.marketplaceId}/${e.name}`;
    const inst = installedMap.get(key);
    if (opts.installed === true && !inst) continue;
    if (opts.installed === false && inst) continue;
    const hay =
      `${e.name} ${e.displayName ?? ""} ${e.description} ${e.category ?? ""} ${e.keywords.join(" ")}`.toLowerCase();
    if (q && !hay.includes(q)) continue;
    all.push({
      ...e,
      installed: Boolean(inst),
      enabled: inst?.enabled,
      cliDeployed: isCliMcpDeployed(config, e.name, mcpKeys),
    });
  }
  return paginateCatalogRows(all, {
    page: opts.page,
    pageSize: opts.pageSize,
    category: opts.category,
  });
}

/** Install every plugin present in Cursor CLI cache (skips ones already on the proxy). */
export async function syncCliCachePlugins(config: BridgeConfig): Promise<{
  imported: string[];
  skipped: string[];
  blocked: string[];
}> {
  await yieldToEventLoop();
  const reg = readRegistry(config);
  const installed = new Set(reg.plugins.map((p) => p.id));
  const blocked = new Set(reg.cliSyncBlocked ?? []);
  const imported: string[] = [];
  const skipped: string[] = [];
  const blockedSkipped: string[] = [];
  const entries = await discoverCliCacheCatalogAsync(config);
  for (const entry of entries) {
    await yieldToEventLoop();
    const id = pluginId(entry.marketplaceId, entry.name);
    if (blocked.has(id)) {
      blockedSkipped.push(id);
      continue;
    }
    if (installed.has(id)) {
      skipped.push(id);
      continue;
    }
    await installPlugin(config, entry.marketplaceId, entry.name, { skipDeploy: true });
    imported.push(id);
    installed.add(id);
  }
  return { imported, skipped, blocked: blockedSkipped };
}

async function resolveCatalogEntry(
  config: BridgeConfig,
  marketplaceId: string,
  name: string,
): Promise<{ marketplace: MarketplaceDef; entry: CatalogEntry }> {
  const reg = readRegistry(config);
  const m = reg.marketplaces.find((x) => x.id === marketplaceId);
  if (!m) throw new ApiError(404, "marketplace not found");
  let entry = (await loadCatalog(config, m).catch(() => [])).find((e) => e.name === name);
  if (!entry) {
    entry = discoverCliCacheCatalog(config).find(
      (e) => e.marketplaceId === marketplaceId && e.name === name,
    );
  }
  if (!entry) {
    const cloud = await loadCursorCloudCatalog(config, {
      search: name,
      marketplaceId,
    });
    entry = findCloudCatalogEntry(cloud, marketplaceId, name);
  }
  if (!entry) throw new ApiError(404, "plugin not found in catalog");
  return { marketplace: m, entry };
}

export type InstallPluginOptions = {
  /** Batch CLI sync — redeploy once after import loop. */
  skipDeploy?: boolean;
};

export async function installPlugin(
  config: BridgeConfig,
  marketplaceId: string,
  name: string,
  opts: InstallPluginOptions = {},
): Promise<InstalledPlugin> {
  assertSafeName("plugin name", name);
  const id = pluginId(marketplaceId, name);
  return withRegistryLock(async () => {
    const reg = readRegistry(config);
    if (reg.plugins.some((p) => p.id === id)) {
      throw new ApiError(409, "plugin already installed");
    }
    if (reg.cliSyncBlocked?.length) {
      reg.cliSyncBlocked = reg.cliSyncBlocked.filter((x) => x !== id);
    }
    const { marketplace, entry } = await resolveCatalogEntry(config, marketplaceId, name);
    const fetched = await fetchPluginSource(config, marketplace, entry.source);
    try {
      const dest = installDir(config, id);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(fetched.dir, dest);
      const now = new Date().toISOString();
      const plugin: InstalledPlugin = {
        id,
        name,
        marketplaceId,
        version: entry.version,
        description: entry.description,
        commit: fetched.commit,
        source: entry.source,
        installedAt: now,
        updatedAt: now,
        enabled: true,
        config: emptyConfig(),
      };
      if (!opts.skipDeploy) {
        plugin.deployed = deployInstalledPlugin(plugin, config);
      } else {
        plugin.deployed = {
          skills: [],
          commands: [],
          agents: [],
          mcpServers: [],
          warnings: [],
        };
      }
      reg.plugins.push(plugin);
      writeRegistry(config, reg);
      return plugin;
    } finally {
      fetched.cleanup();
    }
  });
}

export async function updatePlugin(config: BridgeConfig, id: string): Promise<InstalledPlugin> {
  return withRegistryLock(async () => {
    const reg = readRegistry(config);
    const plugin = reg.plugins.find((p) => p.id === id);
    if (!plugin) throw new ApiError(404, "plugin not installed");
    const { marketplace, entry } = await resolveCatalogEntry(
      config,
      plugin.marketplaceId,
      plugin.name,
    );
    const fetched = await fetchPluginSource(config, marketplace, entry.source);
    try {
      const dest = installDir(config, id);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(fetched.dir, dest);
      plugin.version = entry.version;
      plugin.description = entry.description;
      plugin.commit = fetched.commit;
      plugin.source = entry.source;
      plugin.updatedAt = new Date().toISOString();
      plugin.deployed = deployInstalledPlugin(plugin, config);
      writeRegistry(config, reg);
      return plugin;
    } finally {
      fetched.cleanup();
    }
  });
}

export async function uninstallPlugin(config: BridgeConfig, id: string): Promise<void> {
  await withRegistryLock(async () => {
    const reg = readRegistry(config);
    const plugin = reg.plugins.find((p) => p.id === id);
    if (!plugin) throw new ApiError(404, "plugin not installed");
    undeployPlugin(plugin, config);
    fs.rmSync(installDir(config, id), { recursive: true, force: true });
    reg.plugins = reg.plugins.filter((p) => p.id !== id);
    if (!reg.cliSyncBlocked) reg.cliSyncBlocked = [];
    if (!reg.cliSyncBlocked.includes(id)) reg.cliSyncBlocked.push(id);
    writeRegistry(config, reg);
  });
}

export async function setPluginEnabled(
  config: BridgeConfig,
  id: string,
  enabled: boolean,
): Promise<InstalledPlugin> {
  return withRegistryLock(async () => {
    const reg = readRegistry(config);
    const plugin = reg.plugins.find((p) => p.id === id);
    if (!plugin) throw new ApiError(404, "plugin not installed");
    plugin.enabled = enabled;
    plugin.updatedAt = new Date().toISOString();
    plugin.deployed = deployInstalledPlugin(plugin, config);
    writeRegistry(config, reg);
    return plugin;
  });
}

export async function patchPluginConfig(
  config: BridgeConfig,
  id: string,
  configInput: unknown,
): Promise<InstalledPlugin> {
  return withRegistryLock(async () => {
    const reg = readRegistry(config);
    const plugin = reg.plugins.find((p) => p.id === id);
    if (!plugin) throw new ApiError(404, "plugin not installed");
    plugin.config = sanitizeConfigInput(configInput, plugin.config);
    plugin.updatedAt = new Date().toISOString();
    if (plugin.enabled) plugin.deployed = deployInstalledPlugin(plugin, config);
    writeRegistry(config, reg);
    return plugin;
  });
}

export async function redeployAll(config: BridgeConfig): Promise<{ count: number }> {
  return withRegistryLock(async () => {
    await yieldToEventLoop();
    const reg = readRegistry(config);
    let n = 0;
    let first = true;
    for (const plugin of reg.plugins) {
      if (!first) {
        await pauseForHttpResponsiveness();
      }
      first = false;
      await yieldToEventLoop();
      plugin.deployed = await deployInstalledPluginAsync(plugin, config);
      n++;
      await yieldToEventLoop();
    }
    writeRegistry(config, reg);
    return { count: n };
  });
}

export function getInstalledPlugins(config: BridgeConfig): InstalledPlugin[] {
  return readRegistry(config).plugins;
}

export function getPluginDetail(config: BridgeConfig, id: string) {
  const reg = readRegistry(config);
  const plugin = reg.plugins.find((p) => p.id === id);
  if (!plugin) throw new ApiError(404, "plugin not installed");
  const root = installDir(config, id);
  const contents = fs.existsSync(root) ? analyzePlugin(root) : null;
  return {
    plugin: {
      ...plugin,
      config: maskConfig(plugin.config),
    },
    variables: contents ? listConfigVariables(contents) : [],
    mcpServerNames: contents ? Object.keys(contents.mcpServers) : [],
    skills: contents?.skills.map((s) => ({ name: s.name, dirName: s.dirName })) ?? [],
    hasHooks: contents?.hasHooks ?? false,
  };
}

export type { McpLoginResult } from "./mcp-login.js";

function mcpKey(pluginName: string, serverName: string): string {
  return `plugin-${pluginName}-${serverName}`;
}

export async function startMcpLogin(
  config: BridgeConfig,
  pluginIdStr: string,
  serverName: string,
  configDir?: string,
  publicOrigin?: string,
): Promise<McpLoginResult> {
  const reg = readRegistry(config);
  const plugin = reg.plugins.find((p) => p.id === pluginIdStr);
  if (!plugin) throw new ApiError(404, "plugin not installed");
  return runMcpLoginSpawn(config, mcpKey(plugin.name, serverName), configDir, {
    publicOrigin,
  });
}

/** OAuth login for a plugin still only in Cursor CLI cache (no proxy Import required). */
export async function startCatalogMcpLogin(
  config: BridgeConfig,
  marketplaceId: string,
  name: string,
  serverName?: string,
  configDir?: string,
  publicOrigin?: string,
): Promise<McpLoginResult> {
  assertSafeName("marketplace id", marketplaceId);
  assertSafeName("plugin name", name);
  const cacheDir = resolveCliCacheDir(config, marketplaceId, name);
  if (!cacheDir) throw new ApiError(404, "plugin not found in CLI cache");
  const contents = analyzePlugin(cacheDir);
  const servers = Object.keys(contents.mcpServers);
  if (!servers.length) throw new ApiError(400, "no MCP servers in plugin");
  const server =
    serverName && servers.includes(serverName)
      ? serverName
      : servers[0];
  if (!server) throw new ApiError(400, "no MCP server selected");
  return runMcpLoginSpawn(config, mcpKey(name, server), configDir, {
    publicOrigin,
  });
}

/** Import CLI-cached plugins so the Plugins UI works without manual Sync or any bridge API key. */
export async function maybeAutoSyncCliCache(config: BridgeConfig): Promise<void> {
  const raw = process.env.CURSOR_BRIDGE_PLUGINS_AUTO_SYNC_CLI?.trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return;
  if (process.env.VITEST === "true") return;
  await syncCliCachePlugins(config);
}

export type PluginsUiInitPhase = "idle" | "running" | "ready" | "error";

export type PluginsUiInitStatus = {
  phase: PluginsUiInitPhase;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
};

let pluginsUiInitPromise: Promise<void> | undefined;
let pluginsUiInitWorkStarted = false;
let pluginsInitChild: ChildProcess | undefined;
let pluginsUiInitStatus: PluginsUiInitStatus = {
  phase: "idle",
  startedAt: null,
  finishedAt: null,
  error: null,
};

export function getPluginsUiInitStatus(): PluginsUiInitStatus {
  return { ...pluginsUiInitStatus };
}

/** Run full registry init inside a forked child (same code path as in-process). */
export function executePluginsUiInitChild(config: BridgeConfig): Promise<void> {
  return runPluginsUiInitWork(config);
}

function bridgePackageRoot(): string {
  const fromEnv = process.env.CURSOR_API_PROXY_ROOT?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

function pluginsInitChildEntry(): string {
  return path.join(bridgePackageRoot(), "dist/lib/plugins/init-child.js");
}

export async function refreshPluginsCatalogIndexFromDisk(
  config: BridgeConfig,
): Promise<void> {
  await bootstrapPluginsCatalogIndexAsync(config);
}

function runPluginsUiInitWork(config: BridgeConfig): Promise<void> {
  return (async () => {
    await yieldToEventLoop();
    await yieldToEventLoop();
    pluginsUiInitStatus = {
      phase: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
    };
    console.log("[plugins] Background registry init (catalog git enrich, CLI sync, redeploy)…");
    try {
      await bootstrapPluginsCatalogIndexAsync(config);
      await startPluginsCatalogEnrich(config).catch(() => {
        /* partial index; disk bootstrap remains */
      });
      if (typeof process.send === "function") {
        process.send({ type: "catalog" });
      }
      await pauseForHttpResponsiveness();
      await yieldToEventLoop();
      try {
        await maybeAutoSyncCliCache(config);
      } catch {
        /* empty cache or first run */
      }
      await pauseForHttpResponsiveness();
      await yieldToEventLoop();
      try {
        await redeployAll(config);
      } catch {
        /* first-run or empty registry */
      }
      pluginsUiInitStatus = {
        ...pluginsUiInitStatus,
        phase: "ready",
        finishedAt: new Date().toISOString(),
        error: null,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      pluginsUiInitStatus = {
        ...pluginsUiInitStatus,
        phase: "error",
        finishedAt: new Date().toISOString(),
        error: msg,
      };
      throw err;
    }
  })();
}

function beginPluginsUiInitWorkInProcess(config: BridgeConfig): void {
  ensureEmptyPluginsCatalogIndex(config);
  pluginsUiInitPromise = new Promise<void>((resolve, reject) => {
    setImmediate(() => {
      setImmediate(() => {
        void runPluginsUiInitWork(config).then(resolve, reject);
      });
    });
  }).catch(() => {
    /* status.phase === "error" */
  });
}

function beginPluginsUiInitWorkInChild(config: BridgeConfig): void {
  ensureEmptyPluginsCatalogIndex(config);
  pluginsUiInitStatus = {
    phase: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  };
  const entry = pluginsInitChildEntry();
  pluginsInitChild = fork(entry, [], {
    env: { ...process.env },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  pluginsUiInitPromise = new Promise<void>((resolve, reject) => {
    const child = pluginsInitChild;
    if (!child) {
      reject(new Error("plugins init child missing"));
      return;
    }
    child.on("message", (msg: unknown) => {
      if (
        msg &&
        typeof msg === "object" &&
        (msg as { type?: string }).type === "catalog"
      ) {
        void refreshPluginsCatalogIndexFromDisk(config).catch(() => {
          /* partial catalog */
        });
      }
    });
    child.on("exit", (code, signal) => {
      pluginsInitChild = undefined;
      void (async () => {
        try {
          await refreshPluginsCatalogIndexFromDisk(config);
          if (code === 0) {
            pluginsUiInitStatus = {
              ...pluginsUiInitStatus,
              phase: "ready",
              finishedAt: new Date().toISOString(),
              error: null,
            };
            resolve();
          } else {
            const msg = `plugins init child exited (code=${code ?? "null"}, signal=${signal ?? "null"})`;
            pluginsUiInitStatus = {
              ...pluginsUiInitStatus,
              phase: "error",
              finishedAt: new Date().toISOString(),
              error: msg,
            };
            reject(new Error(msg));
          }
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      })();
    });
    child.on("error", (err) => {
      pluginsInitChild = undefined;
      pluginsUiInitStatus = {
        ...pluginsUiInitStatus,
        phase: "error",
        finishedAt: new Date().toISOString(),
        error: err.message,
      };
      reject(err);
    });
  }).catch(() => {
    /* status.phase === "error" */
  });
}

function beginPluginsUiInitWork(config: BridgeConfig): void {
  if (process.env.VITEST === "true") return;
  if (pluginsUiInitWorkStarted) return;
  pluginsUiInitWorkStarted = true;
  const inProcess =
    process.env.CURSOR_BRIDGE_PLUGINS_INIT_IN_PROCESS === "1" ||
    process.env.CURSOR_BRIDGE_PLUGINS_INIT_IN_PROCESS?.toLowerCase() === "true";
  if (inProcess) {
    beginPluginsUiInitWorkInProcess(config);
  } else {
    beginPluginsUiInitWorkInChild(config);
  }
}

/**
 * Kick off one-time CLI cache import + redeploy without blocking the caller.
 * Safe to call from server listen and from plugin HTTP handlers.
 */
export function startPluginsUiBackgroundInit(config: BridgeConfig): void {
  if (process.env.VITEST === "true") return;
  if (pluginsUiInitWorkStarted) return;
  beginPluginsUiInitWork(config);
}

/** Wait until background registry init finishes (mutations and explicit sync). */
export async function waitForPluginsUiInitialized(
  config: BridgeConfig,
): Promise<void> {
  if (process.env.VITEST === "true") return;
  beginPluginsUiInitWork(config);
  if (pluginsUiInitPromise) await pluginsUiInitPromise;
}

/**
 * @deprecated Prefer {@link startPluginsUiBackgroundInit} + {@link waitForPluginsUiInitialized}.
 */
export async function ensurePluginsUiInitialized(
  config: BridgeConfig,
): Promise<void> {
  await waitForPluginsUiInitialized(config);
}

/** Resets in-process init scheduling (unit tests only). */
export function resetPluginsUiInitForTests(): void {
  pluginsInitChild?.kill("SIGTERM");
  pluginsInitChild = undefined;
  pluginsUiInitPromise = undefined;
  pluginsUiInitWorkStarted = false;
  pluginsCatalogIndex = undefined;
  pluginsUiInitStatus = {
    phase: "idle",
    startedAt: null,
    finishedAt: null,
    error: null,
  };
}
