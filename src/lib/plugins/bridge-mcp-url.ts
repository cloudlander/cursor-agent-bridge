import * as fs from "node:fs";
import * as path from "node:path";

import type { BridgeConfig } from "../config.js";
import type { McpServerDef } from "./manifest.js";
import { pluginPaths, writeFileAtomic } from "./store.js";

/**
 * Cursor IDE routes some official MCP plugins through api.cursor.com/rest-mcp.
 * That proxy only accepts requests carrying the IDE's x-cursor-auth header, so
 * the CLI gets "401 after successful authentication" there. The provider's own
 * endpoint accepts the same OAuth token, but its authorization server has no
 * dynamic client registration. The bridge registers once against Cursor's
 * registration endpoint and deploys the provider URL with that static client.
 */
type DirectMcp = {
  url: string;
  registrationEndpoint: string;
  scopes: string[];
};

const CURSOR_REST_MCP_DIRECT: Record<string, DirectMcp> = {
  "https://api.cursor.com/rest-mcp/google-drive/mcp": {
    url: "https://drivemcp.googleapis.com/mcp/v1",
    registrationEndpoint: "https://api.cursor.com/rest-mcp/google-drive/dcr/register",
    scopes: [
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/drive.file",
    ],
  },
};

export type RemoteMcpClient = { clientId: string; clientSecret?: string };
export type RemoteMcpClients = Record<string, RemoteMcpClient>;

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function directFor(url: string): [string, DirectMcp] | undefined {
  const norm = normalizeUrl(url);
  for (const [from, to] of Object.entries(CURSOR_REST_MCP_DIRECT)) {
    if (normalizeUrl(from) === norm) return [from, to];
  }
  return undefined;
}

function clientsFile(config: BridgeConfig): string {
  return path.join(pluginPaths(config).root, "remote-mcp-clients.json");
}

export function readRemoteMcpClients(config: BridgeConfig): RemoteMcpClients {
  try {
    const raw = JSON.parse(fs.readFileSync(clientsFile(config), "utf8"));
    return raw && typeof raw === "object" ? (raw as RemoteMcpClients) : {};
  } catch {
    return {};
  }
}

/**
 * Point a Cursor rest-mcp entry at the provider endpoint when a registered
 * client is known. Without one the entry keeps the Cursor URL.
 */
export function applyRemoteMcpDirect(
  entry: McpServerDef,
  clients: RemoteMcpClients,
): McpServerDef {
  if (typeof entry.url !== "string") return entry;
  const hit = directFor(entry.url);
  if (!hit) return entry;
  const [from, direct] = hit;
  const client = clients[from];
  if (!client?.clientId) return entry;
  const auth: Record<string, unknown> = {
    CLIENT_ID: client.clientId,
    scopes: direct.scopes,
  };
  if (client.clientSecret) auth.CLIENT_SECRET = client.clientSecret;
  const prev =
    entry.auth && typeof entry.auth === "object" ? (entry.auth as Record<string, unknown>) : {};
  return { ...entry, url: direct.url, auth: { ...auth, ...prev } };
}

/** Register a static OAuth client for every Cursor rest-mcp URL that lacks one. */
export async function ensureRemoteMcpClients(
  config: BridgeConfig,
  servers: McpServerDef[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ registered: string[]; errors: string[] }> {
  const clients = readRemoteMcpClients(config);
  const registered: string[] = [];
  const errors: string[] = [];
  for (const def of servers) {
    if (typeof def.url !== "string") continue;
    const hit = directFor(def.url);
    if (!hit || clients[hit[0]]?.clientId) continue;
    const [from, direct] = hit;
    try {
      const res = await fetchImpl(direct.registrationEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Cursor",
          redirect_uris: ["http://localhost:8787/callback"],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "client_secret_post",
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json().catch(() => ({}))) as {
        client_id?: string;
        client_secret?: string;
      };
      if (!res.ok || !body.client_id) {
        errors.push(`${from}: client registration failed (HTTP ${res.status})`);
        continue;
      }
      clients[from] = { clientId: body.client_id, clientSecret: body.client_secret };
      registered.push(from);
    } catch (err) {
      errors.push(`${from}: client registration failed (${(err as Error).message})`);
    }
  }
  if (registered.length) {
    writeFileAtomic(clientsFile(config), JSON.stringify(clients, null, 2), 0o600);
  }
  return { registered, errors };
}
