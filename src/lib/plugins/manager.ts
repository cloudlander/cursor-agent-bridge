import * as fs from "node:fs";
import * as path from "node:path";
import type { BridgeConfig } from "../config.js";
import { runMcpLoginSpawn, type McpLoginResult } from "./mcp-login.js";
import { analyzePlugin } from "./manifest.js";
import {
  deployInstalledPlugin,
  listConfigVariables,
  undeployPlugin,
} from "./deploy.js";
import {
  discoverCliCacheCatalog,
  isCliMcpDeployed,
  resolveCliCacheDir,
} from "./cli-cache.js";
import {
  fetchPluginSource,
  loadCatalog,
  marketplaceIdFromUrl,
  parseCatalog,
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

export async function searchCatalog(
  config: BridgeConfig,
  opts: { q?: string; marketplaceId?: string; installed?: boolean },
): Promise<CatalogRow[]> {
  const reg = readRegistry(config);
  const markets = opts.marketplaceId
    ? reg.marketplaces.filter((m) => m.id === opts.marketplaceId)
    : reg.marketplaces;
  const q = opts.q?.trim().toLowerCase();
  const installedMap = new Map(reg.plugins.map((p) => [`${p.marketplaceId}/${p.name}`, p]));

  const byKey = new Map<string, CatalogRow>();
  for (const m of markets) {
    let entries: CatalogEntry[];
    try {
      entries = await loadCatalog(config, m);
    } catch {
      continue;
    }
    for (const e of entries) {
      byKey.set(`${e.marketplaceId}/${e.name}`, { ...e });
    }
  }

  for (const e of discoverCliCacheCatalog(config)) {
    if (opts.marketplaceId && e.marketplaceId !== opts.marketplaceId) continue;
    const key = `${e.marketplaceId}/${e.name}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.source = e.source;
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
      existing.displayName ||= e.displayName;
      existing.description ||= e.description;
      existing.category ||= e.category;
      existing.keywords = [...new Set([...existing.keywords, ...e.keywords])];
      existing.cloudCatalog = true;
    } else {
      byKey.set(key, { ...e });
    }
  }

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
      cliDeployed: isCliMcpDeployed(config, e.name),
    });
  }
  all.sort((a, b) => a.name.localeCompare(b.name));
  return all;
}

/** Install every plugin present in Cursor CLI cache (skips ones already on the proxy). */
export async function syncCliCachePlugins(config: BridgeConfig): Promise<{
  imported: string[];
  skipped: string[];
}> {
  const reg = readRegistry(config);
  const installed = new Set(reg.plugins.map((p) => p.id));
  const imported: string[] = [];
  const skipped: string[] = [];
  for (const entry of discoverCliCacheCatalog(config)) {
    const id = pluginId(entry.marketplaceId, entry.name);
    if (installed.has(id)) {
      skipped.push(id);
      continue;
    }
    await installPlugin(config, entry.marketplaceId, entry.name);
    imported.push(id);
    installed.add(id);
  }
  return { imported, skipped };
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

export async function installPlugin(
  config: BridgeConfig,
  marketplaceId: string,
  name: string,
): Promise<InstalledPlugin> {
  assertSafeName("plugin name", name);
  const id = pluginId(marketplaceId, name);
  return withRegistryLock(async () => {
    const reg = readRegistry(config);
    if (reg.plugins.some((p) => p.id === id)) {
      throw new ApiError(409, "plugin already installed");
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
      plugin.deployed = deployInstalledPlugin(plugin, config);
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
    const reg = readRegistry(config);
    let n = 0;
    for (const plugin of reg.plugins) {
      plugin.deployed = deployInstalledPlugin(plugin, config);
      n++;
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

/** Import CLI-cached plugins on startup so the UI works without manual Sync or any bridge API key. */
export async function maybeAutoSyncCliCache(config: BridgeConfig): Promise<void> {
  const raw = process.env.CURSOR_BRIDGE_PLUGINS_AUTO_SYNC_CLI?.trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return;
  if (process.env.VITEST === "true") return;
  await syncCliCachePlugins(config);
}
