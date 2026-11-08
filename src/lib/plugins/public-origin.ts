import type * as http from "node:http";

import type { BridgeConfig } from "../config.js";
import { getBridgePublicContext } from "../bridge-request-context.js";
import { publicBasePath } from "../http-public-path.js";

/** Public browser origin (scheme + host), when not plain localhost. */
export function resolvePublicOrigin(req: http.IncomingMessage): string | undefined {
  const protoHeader =
    headerFirst(req.headers["x-forwarded-proto"]) ??
    headerFirst(req.headers["x-forwarded-protocol"]) ??
    "http";
  const host =
    headerFirst(req.headers["x-forwarded-host"]) ?? req.headers.host?.trim();
  if (!host) return undefined;
  try {
    const origin = new URL(`${protoHeader}://${host}`).origin;
    const h = new URL(origin).hostname.toLowerCase();
    if (h === "localhost" || h === "127.0.0.1" || h === "::1") return undefined;
    return origin;
  } catch {
    return undefined;
  }
}

function headerFirst(value: string | string[] | undefined): string | undefined {
  if (!value) return undefined;
  const s = Array.isArray(value) ? value[0] : value;
  return s?.split(",")[0]?.trim() || undefined;
}

/**
 * Public browser base URL (origin + mount + app segment) for OAuth and plugin callbacks.
 */
export function resolvePublicAppBase(
  req: http.IncomingMessage,
  config: BridgeConfig,
): string | undefined {
  const origin = resolvePublicOrigin(req);
  if (!origin) return undefined;
  const ctx = getBridgePublicContext(req);
  const mount = ctx?.mount ?? "";
  const basePath = ctx?.publicBase ?? publicBasePath(mount, config.appSegment);
  return `${origin.replace(/\/$/, "")}${basePath.startsWith("/") ? basePath : `/${basePath}`}`;
}
