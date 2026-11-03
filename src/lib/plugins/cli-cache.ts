import * as fs from "node:fs";
import * as path from "node:path";

import type { BridgeConfig } from "../config.js";
import { defaultCursorConfigDir } from "./deploy.js";
import { analyzePlugin, findManifestFile, readJsonFile } from "./manifest.js";
import type { CatalogEntry } from "./marketplace.js";
import { parseSource } from "./marketplace.js";
import { assertSafeName, type PluginSourceDescriptor } from "./store.js";

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Skip the operator's real ~/.cursor cache during vitest (server tests use empty configDirs). */
function includeDefaultCliCacheRoot(): boolean {
  return process.env.VITEST !== "true";
}

/** Cursor CLI materializes downloaded plugins under `<configDir>/plugins/cache/`. */
export function cliCacheRoots(config: BridgeConfig): string[] {
  const roots = new Set<string>();
  for (const d of config.configDirs) {
    const trimmed = d.trim();
    if (!trimmed) continue;
    roots.add(path.join(path.resolve(trimmed), "plugins", "cache"));
  }
  if (includeDefaultCliCacheRoot()) {
    roots.add(path.join(defaultCursorConfigDir(), "plugins", "cache"));
  }
  return [...roots].filter((r) => fs.existsSync(r));
}

export function newestHashDir(pluginDir: string): string | null {
  let best: { dir: string; mtime: number } | null = null;
  for (const e of fs.readdirSync(pluginDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const full = path.join(pluginDir, e.name);
    let mtime = 0;
    try {
      mtime = fs.statSync(full).mtimeMs;
    } catch {
      continue;
    }
    if (!best || mtime > best.mtime) best = { dir: full, mtime };
  }
  return best?.dir ?? null;
}

type PluginMeta = {
  name: string;
  description: string;
  version?: string;
  category?: string;
  keywords: string[];
  author?: string;
  homepage?: string;
};

function readPluginMeta(root: string): PluginMeta | null {
  const merge = (a: PluginMeta, b: PluginMeta): PluginMeta => ({
    name: a.name || b.name,
    description: a.description || b.description,
    version: a.version || b.version,
    category: a.category || b.category,
    keywords: a.keywords.length ? a.keywords : b.keywords,
    author: a.author || b.author,
    homepage: a.homepage || b.homepage,
  });

  let fromPlugin: PluginMeta | null = null;
  const manifestFile = findManifestFile(root, "plugin.json");
  const manifest = manifestFile ? readJsonFile(manifestFile) : null;
  const pluginName = str(manifest?.name) ?? str(manifest?.displayName);
  if (pluginName) {
    const author =
      manifest?.author && typeof manifest.author === "object"
        ? str((manifest.author as Record<string, unknown>).name)
        : str(manifest?.author);
    fromPlugin = {
      name: pluginName,
      description: str(manifest?.description) ?? "",
      version: str(manifest?.version),
      category: str(manifest?.category),
      keywords: Array.isArray(manifest?.keywords)
        ? manifest.keywords.filter((k): k is string => typeof k === "string")
        : [],
      author,
      homepage: str(manifest?.homepage) ?? str(manifest?.repository),
    };
  }

  const nestedMarketplace = findManifestFile(root, "marketplace.json");
  if (nestedMarketplace) {
    const data = readJsonFile(nestedMarketplace);
    const plugins = data?.plugins;
    if (Array.isArray(plugins) && plugins.length === 1 && plugins[0] && typeof plugins[0] === "object") {
      const o = plugins[0] as Record<string, unknown>;
      const name = str(o.name) ?? str(o.displayName);
      if (name) {
        const author =
          o.author && typeof o.author === "object"
            ? str((o.author as Record<string, unknown>).name)
            : str(o.author);
        const fromMarketplace: PluginMeta = {
          name,
          description: str(o.description) ?? "",
          version: str(o.version),
          category: str(o.category),
          keywords: Array.isArray(o.keywords)
            ? o.keywords.filter((k): k is string => typeof k === "string")
            : [],
          author,
          homepage: str(o.homepage),
        };
        return fromPlugin ? merge(fromPlugin, fromMarketplace) : fromMarketplace;
      }
    }
  }

  return fromPlugin;
}

function cacheSource(dir: string): PluginSourceDescriptor {
  return { kind: "cache", dir };
}

/** Plugins already downloaded by Cursor CLI but absent from git marketplace.json. */
export function discoverCliCacheCatalog(config: BridgeConfig): CatalogEntry[] {
  const seen = new Set<string>();
  const out: CatalogEntry[] = [];

  for (const cacheRoot of cliCacheRoots(config)) {
    let marketplaces: fs.Dirent[];
    try {
      marketplaces = fs.readdirSync(cacheRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const mp of marketplaces) {
      if (!mp.isDirectory()) continue;
      let marketplaceId: string;
      try {
        marketplaceId = assertSafeName("marketplace id", mp.name);
      } catch {
        continue;
      }
      const mpDir = path.join(cacheRoot, mp.name);
      let plugins: fs.Dirent[];
      try {
        plugins = fs.readdirSync(mpDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const pl of plugins) {
        if (!pl.isDirectory()) continue;
        let name: string;
        try {
          name = assertSafeName("plugin name", pl.name);
        } catch {
          continue;
        }
        const key = `${marketplaceId}/${name}`;
        if (seen.has(key)) continue;
        const hashDir = newestHashDir(path.join(mpDir, pl.name));
        if (!hashDir) continue;
        const meta = readPluginMeta(hashDir);
        if (!meta) continue;
        seen.add(key);
        out.push({
          marketplaceId,
          name: meta.name === name ? meta.name : name,
          description: meta.description,
          version: meta.version,
          category: meta.category,
          keywords: meta.keywords,
          author: meta.author,
          homepage: meta.homepage,
          source: cacheSource(hashDir),
        });
      }
    }
  }
  return out;
}

/** Newest materialized tree for a plugin in Cursor CLI cache, if present. */
export function resolveCliCacheDir(
  config: BridgeConfig,
  marketplaceId: string,
  name: string,
): string | null {
  for (const cacheRoot of cliCacheRoots(config)) {
    const hashDir = newestHashDir(path.join(cacheRoot, marketplaceId, name));
    if (hashDir) return hashDir;
  }
  return null;
}

/** True when Cursor CLI already exposes this plugin's MCP servers in mcp.json. */
export function isCliMcpDeployed(
  config: BridgeConfig,
  pluginName: string,
): boolean {
  const prefix = `plugin-${pluginName}-`;
  for (const dir of [defaultCursorConfigDir(), ...config.configDirs.map((d) => path.resolve(d.trim()))]) {
    const file = path.join(dir, "mcp.json");
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
        mcpServers?: Record<string, unknown>;
      };
      const map = raw.mcpServers ?? raw;
      if (map && typeof map === "object") {
        for (const k of Object.keys(map)) {
          if (k.startsWith(prefix)) return true;
        }
      }
    } catch {
      /* no mcp.json */
    }
  }
  return false;
}

/** Best-effort: read MCP variable names from a cached plugin tree. */
export function cachePluginVariables(cacheDir: string): string[] {
  if (!fs.existsSync(cacheDir)) return [];
  try {
    return analyzePlugin(cacheDir).variables;
  } catch {
    return [];
  }
}

export function parseNestedMarketplaceSource(
  root: string,
  raw: unknown,
  pluginRoot?: string,
): PluginSourceDescriptor | null {
  const parsed = parseSource(raw, pluginRoot);
  if (parsed?.kind === "path" && parsed.path === "") {
    return cacheSource(root);
  }
  if (parsed?.kind === "path" && parsed.path) {
    const sub = path.join(root, parsed.path);
    if (fs.existsSync(sub)) return cacheSource(sub);
    return cacheSource(root);
  }
  return parsed;
}
