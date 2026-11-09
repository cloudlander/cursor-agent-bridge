import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { BridgeConfig } from "../config.js";
import { findManifestFile, isInside, readJsonFile } from "./manifest.js";
import {
  ApiError,
  assertSafeName,
  pluginPaths,
  type MarketplaceDef,
  type PluginSourceDescriptor,
} from "./store.js";

const GIT_TIMEOUT_MS = 120_000;
const CATALOG_TTL_MS = 10 * 60_000;
const PARSE_CATALOG_YIELD_EVERY = 48;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export type CatalogEntry = {
  marketplaceId: string;
  name: string;
  description: string;
  /** Human title from cursor.com marketplace (when different from `name`). */
  displayName?: string;
  version?: string;
  category?: string;
  keywords: string[];
  author?: string;
  homepage?: string;
  source: PluginSourceDescriptor;
  /** Listed on cursor.com / IDE Customize but missing from git marketplace.json. */
  cloudCatalog?: boolean;
};

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

/** True when `ref` is a git object id (commit SHA), not a branch or tag name. */
export function isGitCommitRef(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref.trim());
}

export function validateGitUrl(url: unknown): string {
  if (typeof url !== "string") throw new ApiError(400, "url is required");
  const u = url.trim();
  // Only network transports; no local paths / file:// / ext:: helpers, no option injection.
  if (!/^(https?:\/\/|ssh:\/\/|git@[\w.-]+:)/i.test(u) || /[\s\0]/.test(u) || u.startsWith("-")) {
    throw new ApiError(400, "url must be an https://, ssh:// or git@host:path git URL");
  }
  return u;
}

export function git(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never", ...args],
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" },
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || err.message).trim().split("\n").slice(-3).join(" ");
          reject(new ApiError(502, `git ${args[0]} failed: ${detail}`));
        } else resolve(stdout.trim());
      },
    );
  });
}

export function marketplaceIdFromUrl(url: string): string {
  const base = url
    .replace(/\.git$/i, "")
    .split(/[/:]/)
    .filter(Boolean)
    .slice(-2)
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "");
  const id = base || "marketplace";
  return id.slice(0, 60);
}

function safeRelPath(rel: string): string {
  const clean = rel.replace(/^\.\//, "").replace(/\/+$/, "");
  const parts = clean.split("/");
  if (path.isAbsolute(clean) || parts.some((p) => p === ".." || p === ".git")) {
    throw new ApiError(400, `unsafe plugin path: ${rel}`);
  }
  return clean;
}

const lastSync = new Map<string, number>();

/** Shallow, sparse, blob-less clone of the marketplace repo (cheap even for big repos). */
export async function syncMarketplace(
  config: BridgeConfig,
  m: MarketplaceDef,
  force = false,
): Promise<string> {
  assertSafeName("marketplace id", m.id);
  const dir = path.join(pluginPaths(config).marketplacesDir, m.id);
  const fresh = Date.now() - (lastSync.get(m.id) ?? 0) < CATALOG_TTL_MS;
  if (fs.existsSync(path.join(dir, ".git"))) {
    if (fresh && !force) return dir;
    try {
      await git(["fetch", "--depth", "1", "origin", "HEAD"], dir);
      await git(["reset", "--hard", "FETCH_HEAD"], dir);
      lastSync.set(m.id, Date.now());
      return dir;
    } catch (err) {
      if (!force) return dir; // stay usable offline
      throw err;
    }
  }
  await fs.promises.rm(dir, { recursive: true, force: true });
  await yieldToEventLoop();
  await fs.promises.mkdir(path.dirname(dir), { recursive: true });
  await git(["clone", "--depth", "1", "--filter=blob:none", "--sparse", "--", validateGitUrl(m.url), dir]);
  await git(
    ["sparse-checkout", "set", ".cursor-plugin", ".claude-plugin", ".agents/plugins"],
    dir,
  );
  lastSync.set(m.id, Date.now());
  return dir;
}

export function removeMarketplaceClone(config: BridgeConfig, id: string): void {
  assertSafeName("marketplace id", id);
  fs.rmSync(path.join(pluginPaths(config).marketplacesDir, id), { recursive: true, force: true });
  lastSync.delete(id);
}

// ---------------------------------------------------------------------------
// catalog
// ---------------------------------------------------------------------------

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export function parseSource(
  raw: unknown,
  pluginRoot: string | undefined,
): PluginSourceDescriptor | null {
  if (typeof raw === "string") {
    const rel = pluginRoot && !raw.startsWith("./") && !raw.startsWith("/") ? path.posix.join(pluginRoot, raw) : raw;
    try {
      return { kind: "path", path: safeRelPath(pluginRoot && raw.startsWith("./") ? path.posix.join(pluginRoot, raw) : rel) };
    } catch {
      return null;
    }
  }
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const kind = str(o.source)?.toLowerCase();
    if (kind === "local" || kind === "path") {
      const rel = str(o.path) ?? ".";
      try {
        const joined =
          pluginRoot && rel.startsWith("./")
            ? path.posix.join(pluginRoot, rel)
            : pluginRoot && !rel.startsWith("/")
              ? path.posix.join(pluginRoot, rel)
              : rel;
        return { kind: "path", path: safeRelPath(joined) };
      } catch {
        return null;
      }
    }
    let url = str(o.url);
    if (kind === "github" && str(o.repo)) url = `https://github.com/${str(o.repo)}`;
    if (!url) return null;
    try {
      return {
        kind: "git",
        url: validateGitUrl(url),
        ref: str(o.ref) ?? str(o.branch) ?? str(o.tag),
        path: str(o.path) ? safeRelPath(str(o.path) as string) : undefined,
      };
    } catch {
      return null;
    }
  }
  return null;
}

export function parseCatalog(marketplaceId: string, dir: string): CatalogEntry[] {
  const file = findManifestFile(dir, "marketplace.json");
  if (!file) throw new ApiError(422, "no .cursor-plugin/marketplace.json (or .claude-plugin) in repository");
  const data = readJsonFile(file);
  const plugins = data?.plugins;
  if (!Array.isArray(plugins)) throw new ApiError(422, "marketplace.json has no plugins array");
  const meta = (data?.metadata ?? {}) as Record<string, unknown>;
  const pluginRoot = str(meta.pluginRoot)?.replace(/^\.\//, "");

  const out: CatalogEntry[] = [];
  for (const p of plugins) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    const name = str(o.name);
    const source = parseSource(o.source, pluginRoot);
    if (!name || !source || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) continue;
    const author = o.author && typeof o.author === "object" ? str((o.author as Record<string, unknown>).name) : str(o.author);
    out.push({
      marketplaceId,
      name,
      description: str(o.description) ?? "",
      version: str(o.version),
      category: str(o.category),
      keywords: Array.isArray(o.keywords) ? o.keywords.filter((k): k is string => typeof k === "string") : [],
      author,
      homepage: str(o.homepage),
      source,
    });
  }
  return out;
}

/** Same as {@link parseCatalog} but yields during large manifests. */
async function readJsonFileAsync(file: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.promises.readFile(file, "utf8");
    await yieldToEventLoop();
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function parseCatalogAsync(
  marketplaceId: string,
  dir: string,
): Promise<CatalogEntry[]> {
  const file = findManifestFile(dir, "marketplace.json");
  if (!file) throw new ApiError(422, "no .cursor-plugin/marketplace.json (or .claude-plugin) in repository");
  const data = await readJsonFileAsync(file);
  const plugins = data?.plugins;
  if (!Array.isArray(plugins)) throw new ApiError(422, "marketplace.json has no plugins array");
  const meta = (data?.metadata ?? {}) as Record<string, unknown>;
  const pluginRoot = str(meta.pluginRoot)?.replace(/^\.\//, "");

  const out: CatalogEntry[] = [];
  let n = 0;
  for (const p of plugins) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    const name = str(o.name);
    const source = parseSource(o.source, pluginRoot);
    if (!name || !source || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) continue;
    const author = o.author && typeof o.author === "object" ? str((o.author as Record<string, unknown>).name) : str(o.author);
    out.push({
      marketplaceId,
      name,
      description: str(o.description) ?? "",
      version: str(o.version),
      category: str(o.category),
      keywords: Array.isArray(o.keywords) ? o.keywords.filter((k): k is string => typeof k === "string") : [],
      author,
      homepage: str(o.homepage),
      source,
    });
    n++;
    if (n % PARSE_CATALOG_YIELD_EVERY === 0) {
      await yieldToEventLoop();
    }
  }
  return out;
}

/** Parse marketplace.json from an on-disk clone without git network I/O. */
export function loadCatalogFromDisk(
  config: BridgeConfig,
  m: MarketplaceDef,
): CatalogEntry[] | null {
  const dir = path.join(pluginPaths(config).marketplacesDir, m.id);
  if (!fs.existsSync(dir)) return null;
  try {
    return parseCatalog(m.id, dir);
  } catch {
    return null;
  }
}

export async function loadCatalog(
  config: BridgeConfig,
  m: MarketplaceDef,
  force = false,
): Promise<CatalogEntry[]> {
  const dir = await syncMarketplace(config, m, force);
  return parseCatalogAsync(m.id, dir);
}

export async function loadCatalogFromDiskAsync(
  config: BridgeConfig,
  m: MarketplaceDef,
): Promise<CatalogEntry[] | null> {
  await yieldToEventLoop();
  const dir = path.join(pluginPaths(config).marketplacesDir, m.id);
  if (!fs.existsSync(dir)) return null;
  try {
    return await parseCatalogAsync(m.id, dir);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// fetch plugin files
// ---------------------------------------------------------------------------

function copyTree(from: string, to: string): void {
  fs.cpSync(from, to, {
    recursive: true,
    dereference: false,
    filter: (src) => path.basename(src) !== ".git",
  });
}

export type FetchedPlugin = { dir: string; commit?: string; cleanup: () => void };

async function cloneGitRepo(url: string, ref: string | undefined, dest: string): Promise<void> {
  const safeUrl = validateGitUrl(url);
  if (ref && isGitCommitRef(ref)) {
    await git(["clone", "--depth", "1", "--no-checkout", "--", safeUrl, dest]);
    await git(["fetch", "--depth", "1", "origin", ref], dest);
    await git(["checkout", ref], dest);
    return;
  }
  const args = ["clone", "--depth", "1"];
  if (ref) args.push("--branch", ref);
  await git([...args, "--", safeUrl, dest]);
}

/** Materialize a plugin's source tree into a fresh staging directory. */
export async function fetchPluginSource(
  config: BridgeConfig,
  m: MarketplaceDef,
  source: PluginSourceDescriptor,
): Promise<FetchedPlugin> {
  const paths = pluginPaths(config);
  fs.mkdirSync(paths.installedDir, { recursive: true });
  const staging = path.join(paths.installedDir, `.staging-${crypto.randomBytes(6).toString("hex")}`);
  const cleanups: (() => void)[] = [() => fs.rmSync(staging, { recursive: true, force: true })];
  const cleanup = () => cleanups.forEach((c) => c());
  try {
    if (source.kind === "cache") {
      const src = path.resolve(source.dir);
      if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
        throw new ApiError(404, `CLI cache plugin dir missing: ${source.dir}`);
      }
      copyTree(src, staging);
      let commit: string | undefined;
      try {
        commit = path.basename(src);
      } catch {
        /* ignore */
      }
      return { dir: staging, commit, cleanup };
    }
    if (source.kind === "path") {
      const repo = await syncMarketplace(config, m);
      const rel = safeRelPath(source.path);
      if (rel) await git(["sparse-checkout", "add", "--", rel], repo);
      const src = path.join(repo, rel);
      if (!fs.existsSync(src) || !isInside(repo, src)) {
        throw new ApiError(404, `plugin path not found in marketplace: ${source.path}`);
      }
      copyTree(src, staging);
      return { dir: staging, commit: await git(["rev-parse", "HEAD"], repo), cleanup };
    }
    const tmp = `${staging}-clone`;
    cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
    await cloneGitRepo(source.url, source.ref, tmp);
    const commit = await git(["rev-parse", "HEAD"], tmp);
    const sub = source.path ? path.join(tmp, safeRelPath(source.path)) : tmp;
    if (!fs.existsSync(sub) || !isInside(tmp, sub)) throw new ApiError(404, `path not found in repo: ${source.path}`);
    copyTree(sub, staging);
    return { dir: staging, commit, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}
