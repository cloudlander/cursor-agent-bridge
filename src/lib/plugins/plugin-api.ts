import * as http from "node:http";

import type { BridgeConfig } from "../config.js";
import { json } from "../http.js";
import { resolvePublicOrigin } from "./public-origin.js";
import {
  addMarketplace,
  getInstalledPlugins,
  getPluginDetail,
  installPlugin,
  listMarketplaces,
  patchPluginConfig,
  redeployAll,
  refreshMarketplace,
  removeMarketplace,
  searchCatalog,
  setPluginEnabled,
  startCatalogMcpLogin,
  startMcpLogin,
  syncCliCachePlugins,
  uninstallPlugin,
  updatePlugin,
} from "./manager.js";
import { ApiError } from "./store.js";

const MAX_BODY = 1024 * 1024;

function readBodyLimited(req: http.IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      data += chunk;
      if (data.length > max) {
        reject(new ApiError(413, "body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function checkMutationOrigin(req: http.IncomingMessage): void {
  const origin = req.headers.origin;
  if (!origin) return;
  const host = req.headers.host;
  if (!host) return;
  try {
    const o = new URL(origin);
    if (o.host !== host) {
      throw new ApiError(403, "origin mismatch");
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(403, "invalid origin");
  }
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

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const raw = await readBodyLimited(req, MAX_BODY);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ApiError(400, "invalid json");
  }
}

function sendError(res: http.ServerResponse, err: unknown): void {
  if (err instanceof ApiError) {
    json(res, err.status, { error: err.message });
    return;
  }
  const msg = err instanceof Error ? err.message : String(err);
  json(res, 500, { error: msg });
}

export function pluginApiMatches(req: http.IncomingMessage): boolean {
  const pathname = (req.url ?? "").split("?")[0] ?? "";
  if (pathname === "/plugins") return req.method === "GET";
  return pathname.startsWith("/api/plugins");
}

export async function handlePluginApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: BridgeConfig,
): Promise<void> {
  const url = req.url ?? "/";
  const pathname = url.split("?")[0] ?? "/";
  const q = parseQuery(url);

  try {
    if (req.method === "GET" && pathname === "/plugins") {
      return;
    }

    const needsWrite =
      req.method === "POST" ||
      req.method === "PUT" ||
      req.method === "PATCH" ||
      req.method === "DELETE";
    if (needsWrite) {
      checkMutationOrigin(req);
      const ct = req.headers["content-type"] ?? "";
      if (req.method !== "DELETE" && !String(ct).includes("application/json")) {
        throw new ApiError(415, "content-type must be application/json");
      }
    }

    if (req.method === "GET" && pathname === "/api/plugins/marketplaces") {
      return json(res, 200, { marketplaces: listMarketplaces(config) });
    }
    if (req.method === "POST" && pathname === "/api/plugins/marketplaces") {
      const body = (await readJsonBody(req)) as { url?: string; name?: string };
      const m = await addMarketplace(config, String(body.url ?? ""), body.name);
      return json(res, 201, { marketplace: m });
    }
    if (req.method === "POST" && pathname === "/api/plugins/marketplaces/refresh") {
      const body = (await readJsonBody(req)) as { id?: string };
      const r = await refreshMarketplace(config, String(body.id ?? ""));
      return json(res, 200, r);
    }
    const mRemove = pathname.match(/^\/api\/plugins\/marketplaces\/([^/]+)$/);
    if (req.method === "DELETE" && mRemove) {
      await removeMarketplace(config, decodeURIComponent(mRemove[1]));
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && pathname === "/api/plugins/catalog") {
      const catalog = await searchCatalog(config, {
        q: q.q,
        marketplaceId: q.marketplace,
        installed: q.installed === "true" ? true : q.installed === "false" ? false : undefined,
      });
      return json(res, 200, { plugins: catalog });
    }

    if (req.method === "GET" && pathname === "/api/plugins/installed") {
      const plugins = getInstalledPlugins(config).map((p) => ({
        ...p,
        config: undefined,
      }));
      return json(res, 200, { plugins });
    }

    if (req.method === "POST" && pathname === "/api/plugins/redeploy") {
      const r = await redeployAll(config);
      return json(res, 200, r);
    }

    if (req.method === "POST" && pathname === "/api/plugins/sync-cli-cache") {
      const r = await syncCliCachePlugins(config);
      return json(res, 200, r);
    }

    if (req.method === "POST" && pathname === "/api/plugins/install") {
      const body = (await readJsonBody(req)) as { marketplaceId?: string; name?: string };
      const plugin = await installPlugin(
        config,
        String(body.marketplaceId ?? ""),
        String(body.name ?? ""),
      );
      return json(res, 201, {
        plugin: { ...plugin, config: undefined },
      });
    }

    const detailMatch = pathname.match(/^\/api\/plugins\/installed\/([^/]+)$/);
    if (detailMatch) {
      const id = decodeURIComponent(detailMatch[1]);
      if (req.method === "GET") {
        return json(res, 200, getPluginDetail(config, id));
      }
      if (req.method === "DELETE") {
        await uninstallPlugin(config, id);
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST") {
        const body = (await readJsonBody(req)) as { action?: string; enabled?: boolean };
        if (body.action === "update") {
          const plugin = await updatePlugin(config, id);
          return json(res, 200, { plugin: { ...plugin, config: undefined } });
        }
        if (body.action === "enable" || body.action === "disable") {
          const plugin = await setPluginEnabled(config, id, body.action === "enable");
          return json(res, 200, { plugin: { ...plugin, config: undefined } });
        }
        throw new ApiError(400, "unknown action");
      }
      if (req.method === "PUT" || req.method === "PATCH") {
        const body = await readJsonBody(req);
        const cfgBody =
          body && typeof body === "object" && "config" in (body as object)
            ? (body as { config: unknown }).config
            : body;
        const plugin = await patchPluginConfig(config, id, cfgBody);
        return json(res, 200, getPluginDetail(config, id));
      }
    }

    if (req.method === "POST" && pathname === "/api/plugins/mcp-login") {
      const body = (await readJsonBody(req)) as {
        marketplaceId?: string;
        name?: string;
        server?: string;
        configDir?: string;
      };
      const result = await startCatalogMcpLogin(
        config,
        String(body.marketplaceId ?? ""),
        String(body.name ?? ""),
        body.server,
        body.configDir,
        resolvePublicOrigin(req),
      );
      return json(res, 200, result);
    }

    const loginMatch = pathname.match(/^\/api\/plugins\/installed\/([^/]+)\/mcp-login$/);
    if (req.method === "POST" && loginMatch) {
      const body = (await readJsonBody(req)) as { server?: string; configDir?: string };
      const result = await startMcpLogin(
        config,
        decodeURIComponent(loginMatch[1]),
        String(body.server ?? ""),
        body.configDir,
        resolvePublicOrigin(req),
      );
      return json(res, 200, result);
    }

    json(res, 404, { error: "not found" });
  } catch (err) {
    sendError(res, err);
  }
}
