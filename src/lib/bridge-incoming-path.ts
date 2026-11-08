import type * as http from "node:http";

import type { BridgeConfig } from "./config.js";
import {
  bridgeContextFrom,
  setBridgePublicContext,
} from "./bridge-request-context.js";
import { bootstrapRedirectHtml } from "./bridge-html.js";
import {
  externalPathnameFromRequest,
  isBootstrapPath,
  isDirectInternalRoute,
  mountFromBootstrapPathname,
  resolveEffectiveMount,
  splitPublicPath,
} from "./http-public-path.js";

export type IncomingPathResult =
  | { kind: "healthz" }
  | { kind: "bootstrap"; body: string }
  | { kind: "routed" }
  | { kind: "not_found" };

function queryOfUrl(url: string): string {
  const i = url.indexOf("?");
  return i >= 0 ? url.slice(i) : "";
}

/** Single-segment user app short URL `/{name}/`, not nested paths like `/proxy/8100/…`. */
function isLegacyUserAppShortPath(pathname: string): boolean {
  const short = pathname.match(/^\/([^/]+)\/?$/);
  if (!short?.[1] || short[1].includes(".")) return false;
  return true;
}

/**
 * Normalize req.url to internal paths and attach public-path context.
 * Returns whether the listener should handle healthz/bootstrap/not_found immediately.
 */
export function applyBridgeIncomingPath(
  req: http.IncomingMessage,
  config: BridgeConfig,
  res: http.ServerResponse,
): IncomingPathResult {
  const rawUrl = req.url ?? "/";
  const externalPathname = externalPathnameFromRequest(req);
  const query = queryOfUrl(rawUrl);

  if (externalPathname === "/healthz") {
    return { kind: "healthz" };
  }

  if (isBootstrapPath(externalPathname, config.appSegment)) {
    const pathMount = mountFromBootstrapPathname(externalPathname);
    const mount = resolveEffectiveMount(
      pathMount,
      req.headers,
      config.appSegment,
    );
    const html = bootstrapRedirectHtml({
      appSegment: config.appSegment,
      mount,
    });
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(html);
    return { kind: "bootstrap", body: html };
  }

  const split = splitPublicPath(externalPathname, config.appSegment);
  if (split.kind === "missing") {
    if (
      isDirectInternalRoute(externalPathname) ||
      isLegacyUserAppShortPath(externalPathname)
    ) {
      const ctx = bridgeContextFrom("", config, externalPathname);
      setBridgePublicContext(req, ctx);
      req.url = `${externalPathname}${query}`;
      return { kind: "routed" };
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found\n");
    return { kind: "not_found" };
  }

  const mount = resolveEffectiveMount(
    split.mount,
    req.headers,
    config.appSegment,
  );
  const ctx = bridgeContextFrom(mount, config, externalPathname);
  setBridgePublicContext(req, ctx);

  let internalPath = split.internal;
  if (internalPath.length > 1 && internalPath.endsWith("/")) {
    internalPath = internalPath.replace(/\/+$/, "") || "/";
  }
  req.url = `${internalPath}${query}`;

  return { kind: "routed" };
}
