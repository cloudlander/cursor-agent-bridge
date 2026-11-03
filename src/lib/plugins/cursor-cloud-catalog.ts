import * as https from "node:https";

import type { BridgeConfig } from "../config.js";
import { candidateAuthConfigDirs } from "../agent-login.js";
import { resolveTokenForConfigDir } from "../cursor-account-snapshot.js";
import { validateGitUrl, type CatalogEntry } from "./marketplace.js";

const CONNECT_HOST = "api2.cursor.sh";
const LIST_PLUGINS_PATH = "/aiserver.v1.DashboardService/ListMarketplacePlugins";
const DEFAULT_TTL_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

type CloudMarketplaceRef = {
  name?: string;
};

type CloudPlugin = {
  name?: string;
  displayName?: string;
  description?: string;
  tags?: string[];
  curatedCategoryKeys?: string[];
  marketplace?: CloudMarketplaceRef;
  gitUrl?: string;
  gitRef?: string;
  gitPath?: string;
  releaseTag?: string;
  repositoryUrl?: string;
};

type ListPluginsResponse = {
  plugins?: CloudPlugin[];
  nextPageToken?: string;
  hasMore?: boolean;
};

let cachedAt = 0;
let cachedEntries: CatalogEntry[] | null = null;
let inflight: Promise<CatalogEntry[]> | null = null;

function cloudCatalogDisabled(): boolean {
  const raw = process.env.CURSOR_BRIDGE_PLUGINS_CLOUD_CATALOG?.trim().toLowerCase();
  return raw === "0" || raw === "false" || raw === "no" || raw === "off";
}

function optionalAuthToken(config: BridgeConfig): string | undefined {
  const fromEnv =
    process.env.CURSOR_API_KEY?.trim() || process.env.CURSOR_AUTH_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  for (const dir of candidateAuthConfigDirs(config)) {
    const token = resolveTokenForConfigDir(dir);
    if (token) return token;
  }
  return undefined;
}

function connectPost<T>(path: string, body: Record<string, unknown>, token?: string): Promise<T> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
      "Content-Length": String(Buffer.byteLength(payload)),
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const req = https.request(
      {
        hostname: CONNECT_HOST,
        path,
        method: "POST",
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`cursor cloud catalog HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(data) as T);
          } catch {
            reject(new Error("cursor cloud catalog returned invalid JSON"));
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error("cursor cloud catalog request timeout"));
    });
    req.end(payload);
  });
}

/** Map Cursor IDE / Customize marketplace listing into proxy catalog rows. */
export function mapCloudPluginToEntry(plugin: CloudPlugin): CatalogEntry | null {
  const name = typeof plugin.name === "string" ? plugin.name.trim() : "";
  if (!name) return null;

  const marketplaceId =
    typeof plugin.marketplace?.name === "string" && plugin.marketplace.name.trim()
      ? plugin.marketplace.name.trim()
      : "cursor-public";

  const gitRaw = plugin.gitUrl?.trim() || plugin.repositoryUrl?.trim();
  if (!gitRaw) return null;

  let url: string;
  try {
    url = validateGitUrl(gitRaw);
  } catch {
    return null;
  }

  const ref = plugin.releaseTag?.trim() || plugin.gitRef?.trim() || undefined;
  const rel = plugin.gitPath?.trim();
  const path = rel && rel !== "." ? rel : undefined;

  const displayName = plugin.displayName?.trim();
  const desc = plugin.description?.trim() ?? "";
  const showDisplay =
    displayName && displayName.toLowerCase() !== name.toLowerCase()
      ? displayName
      : undefined;

  const keywords = [
    ...(Array.isArray(plugin.tags)
      ? plugin.tags.filter((t): t is string => typeof t === "string")
      : []),
    ...(displayName ? [displayName] : []),
  ];

  return {
    marketplaceId,
    name,
    displayName: showDisplay,
    description: desc,
    category: plugin.curatedCategoryKeys?.[0],
    keywords,
    source: { kind: "git", url, ref, path },
    cloudCatalog: true,
  };
}

async function drainCloudPlugins(
  config: BridgeConfig,
  opts: { search?: string; marketplaceId?: string },
): Promise<CatalogEntry[]> {
  const token = optionalAuthToken(config);
  const byKey = new Map<string, CatalogEntry>();
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;

  for (;;) {
    const body: Record<string, unknown> = { pageSize: 100 };
    if (opts.search) body.search = opts.search;
    if (pageToken) body.pageToken = pageToken;

    const res = await connectPost<ListPluginsResponse>(LIST_PLUGINS_PATH, body, token);
    for (const raw of res.plugins ?? []) {
      const entry = mapCloudPluginToEntry(raw);
      if (!entry) continue;
      if (opts.marketplaceId && entry.marketplaceId !== opts.marketplaceId) continue;
      byKey.set(`${entry.marketplaceId}/${entry.name}`, entry);
    }

    const next = res.nextPageToken?.trim();
    if (!res.hasMore || !next || seenTokens.has(next)) break;
    seenTokens.add(next);
    pageToken = next;
  }

  return [...byKey.values()];
}

/**
 * Plugins listed on cursor.com/marketplace (IDE Customize) but absent from git
 * marketplace.json — e.g. Browserbase (`browse` @ cursor-public).
 */
export async function loadCursorCloudCatalog(
  config: BridgeConfig,
  opts: { search?: string; marketplaceId?: string; force?: boolean } = {},
): Promise<CatalogEntry[]> {
  if (cloudCatalogDisabled()) return [];

  const q = opts.search?.trim();
  if (q || opts.force) {
    try {
      return await drainCloudPlugins(config, {
        search: q || undefined,
        marketplaceId: opts.marketplaceId,
      });
    } catch {
      return [];
    }
  }

  const ttl =
    Number(process.env.CURSOR_BRIDGE_PLUGINS_CLOUD_CATALOG_TTL_MS) || DEFAULT_TTL_MS;
  const fresh = cachedEntries && Date.now() - cachedAt < ttl;
  if (fresh && cachedEntries) {
    return opts.marketplaceId
      ? cachedEntries.filter((e) => e.marketplaceId === opts.marketplaceId)
      : cachedEntries;
  }

  if (!inflight) {
    inflight = drainCloudPlugins(config, {})
      .then((entries) => {
        cachedEntries = entries;
        cachedAt = Date.now();
        return entries;
      })
      .finally(() => {
        inflight = null;
      });
  }

  try {
    const entries = await inflight;
    return opts.marketplaceId
      ? entries.filter((e) => e.marketplaceId === opts.marketplaceId)
      : entries;
  } catch {
    return cachedEntries ?? [];
  }
}

export function findCloudCatalogEntry(
  entries: CatalogEntry[],
  marketplaceId: string,
  name: string,
): CatalogEntry | undefined {
  return entries.find((e) => e.marketplaceId === marketplaceId && e.name === name);
}

/** Test helper */
export function resetCloudCatalogCacheForTests(): void {
  cachedAt = 0;
  cachedEntries = null;
  inflight = null;
}
