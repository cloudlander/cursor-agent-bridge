import * as crypto from "node:crypto";
import type * as http from "node:http";

import { anthropicErrorBody, isAnthropicApiPath } from "./claude-code-api.js";
import type { BridgeConfig } from "./config.js";
import { extractBridgeApiKey, json } from "./http.js";

/** Paths that require `CURSOR_BRIDGE_API_KEY` when configured. Dashboard, chat, and plugins are excluded. */
export function pathRequiresBridgeApiKey(pathname: string): boolean {
  if (pathname === "/health") return true;
  return pathname.startsWith("/v1/");
}

function trimmedHeader(
  req: http.IncomingMessage,
  name: string,
): string | undefined {
  const h = req.headers[name];
  if (!h) return undefined;
  const val = Array.isArray(h) ? h[0] : h;
  const trimmed = val.trim();
  return trimmed || undefined;
}

/**
 * CDSW / edge proxy may attach `Remote-user` and `Remote-user-perm` (Node lowercases to
 * `remote-user`, `remote-user-perm`). When both are present and perm is `Unauthorized`,
 * inbound `/v1` and `/health` are rejected (even when CAI bypass auth is enabled).
 */
export function remoteUserPermIsUnauthorized(
  req: http.IncomingMessage,
): boolean {
  const user = trimmedHeader(req, "remote-user");
  const perm = trimmedHeader(req, "remote-user-perm");
  if (!user || !perm) return false;
  return perm.toLowerCase() === "unauthorized";
}

/**
 * When `cdswBypassAuthentication` is false the CAI application requires interactive
 * auth; requests that reach the bridge are treated as already authorized (no API key).
 */
export function passesCaiApplicationInboundAuth(
  cdswBypassAuthentication: boolean,
): boolean {
  return !cdswBypassAuthentication;
}

export function bridgeApiKeyMatches(
  req: http.IncomingMessage,
  expected: string,
): boolean {
  const token = extractBridgeApiKey(req) ?? "";
  const a = Buffer.from(token, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function rejectBridgeApiKey(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const pathname = (req.url ?? "/").split("?")[0] ?? "/";
  if (isAnthropicApiPath(pathname)) {
    json(res, 401, anthropicErrorBody("authentication_error", "invalid x-api-key"));
    return;
  }
  json(res, 401, {
    error: { message: "Invalid API key", code: "unauthorized" },
  });
}

export function enforceBridgeApiKeyIfRequired(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: BridgeConfig,
  pathname: string,
): boolean {
  const key = config.requiredKey;
  if (!key || !pathRequiresBridgeApiKey(pathname)) return true;
  if (remoteUserPermIsUnauthorized(req)) {
    rejectBridgeApiKey(req, res);
    return false;
  }
  if (passesCaiApplicationInboundAuth(config.cdswBypassAuthentication)) {
    return true;
  }
  if (bridgeApiKeyMatches(req, key)) return true;
  rejectBridgeApiKey(req, res);
  return false;
}
