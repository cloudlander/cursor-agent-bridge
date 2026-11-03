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
  if (bridgeApiKeyMatches(req, key)) return true;
  rejectBridgeApiKey(req, res);
  return false;
}
