/**
 * Split and compose public URL paths: {mount}/{appSegment}{internal}.
 */

import type * as http from "node:http";

export const APP_SEGMENT_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** Built-in segments that must not be used as CURSOR_BRIDGE_APP_SEGMENT. */
export const BUILTIN_RESERVED_APP_SEGMENTS = new Set([
  "api",
  "apps",
  "static",
  "v1",
  "health",
  "healthz",
  "wiki",
  "chat",
  "plugins",
  "callback",
]);

export function validateAppSegment(segment: string): void {
  if (!segment || !APP_SEGMENT_PATTERN.test(segment)) {
    throw new Error(
      `Invalid CURSOR_BRIDGE_APP_SEGMENT "${segment}": must match ${APP_SEGMENT_PATTERN.source}`,
    );
  }
  if (BUILTIN_RESERVED_APP_SEGMENTS.has(segment)) {
    throw new Error(
      `CURSOR_BRIDGE_APP_SEGMENT "${segment}" conflicts with a reserved bridge route`,
    );
  }
}

/** Validate mount prefix (path before app segment). Rejects traversal and empty segments with dots. */
export function normalizeMount(mount: string): string {
  if (!mount) return "";
  const trimmed = mount.replace(/\/+$/, "") || "";
  if (!trimmed.startsWith("/")) {
    throw new Error("invalid mount");
  }
  const parts = trimmed.split("/").filter(Boolean);
  for (const p of parts) {
    if (p === "." || p === "..") throw new Error("invalid mount");
  }
  return trimmed;
}

export type SplitPublicPathResult =
  | { kind: "found"; mount: string; internal: string }
  | { kind: "missing" };

/**
 * Locate /{appSegment}/ or /{appSegment} at a path segment boundary (first match).
 */
export function splitPublicPath(
  pathname: string,
  appSegment: string,
): SplitPublicPathResult {
  let path = pathname || "/";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) {
    try {
      path = new URL(path).pathname || "/";
    } catch {
      return { kind: "missing" };
    }
  }
  if (!path.startsWith("/")) path = `/${path}`;
  if (path.includes("/../") || path.endsWith("/..") || path === "/..") {
    return { kind: "missing" };
  }
  try {
    path = new URL(path, "http://local").pathname;
  } catch {
    return { kind: "missing" };
  }

  const needle = `/${appSegment}`;
  let searchFrom = 0;
  while (searchFrom < path.length) {
    const i = path.indexOf(needle, searchFrom);
    if (i < 0) break;
    const afterIdx = i + needle.length;
    const after = path[afterIdx];
    const segmentOk =
      path[i] === "/" &&
      (after === undefined || after === "/" || after === "");
    if (segmentOk) {
      let mountRaw = i === 0 ? "" : path.slice(0, i);
      if (mountRaw.endsWith("/") && mountRaw.length > 1) {
        mountRaw = mountRaw.replace(/\/+$/, "");
      }
      let mount = "";
      try {
        mount = mountRaw ? normalizeMount(mountRaw) : "";
      } catch {
        return { kind: "missing" };
      }
      let internal = path.slice(afterIdx) || "/";
      if (!internal.startsWith("/")) internal = `/${internal}`;
      return { kind: "found", mount, internal };
    }
    searchFrom = i + 1;
  }
  return { kind: "missing" };
}

export function publicBasePath(mount: string, appSegment: string): string {
  const m = mount || "";
  return `${m}/${appSegment}`.replace(/\/{2,}/g, "/");
}

function headerFirst(value: string | string[] | undefined): string | undefined {
  if (!value) return undefined;
  const s = Array.isArray(value) ? value[0] : value;
  return s?.split(",")[0]?.trim() || undefined;
}

/**
 * Pathname the bridge treats as the external URL (before strip to internal routes).
 * Handles origin-form (`/proxy/8100/...`) and absolute-form (`https://host/proxy/8100/...`)
 * request targets from reverse proxies.
 */
export function externalPathnameFromRequest(
  req: Pick<http.IncomingMessage, "url" | "headers">,
): string {
  const raw = req.url ?? "/";
  const q = raw.indexOf("?");
  const withoutQuery = (q >= 0 ? raw.slice(0, q) : raw) || "/";
  if (withoutQuery.startsWith("/")) {
    return withoutQuery;
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(withoutQuery)) {
    try {
      return new URL(withoutQuery).pathname || "/";
    } catch {
      return "/";
    }
  }
  const proto =
    headerFirst(req.headers["x-forwarded-proto"])?.toLowerCase() === "https"
      ? "https"
      : "http";
  const host = headerFirst(req.headers.host) || "localhost";
  try {
    return new URL(withoutQuery, `${proto}://${host}`).pathname || "/";
  } catch {
    return withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
  }
}

/**
 * Mount prefix from reverse proxies that strip the path before upstream (CAI).
 * Trusted when the edge overwrites these headers (not from browsers directly).
 */
export function forwardedMountFromHeaders(
  headers: Record<string, string | string[] | undefined>,
  appSegment: string,
): string {
  const prefix = headerFirst(headers["x-forwarded-prefix"]);
  if (prefix) {
    try {
      const trimmed = prefix.replace(/\/+$/, "") || "";
      if (!trimmed) return "";
      return normalizeMount(trimmed.startsWith("/") ? trimmed : `/${trimmed}`);
    } catch {
      return "";
    }
  }
  for (const name of [
    "x-forwarded-uri",
    "x-original-uri",
    "x-original-url",
    "x-request-uri",
    "x-envoy-original-path",
  ]) {
    const raw = headerFirst(headers[name]);
    if (!raw) continue;
    try {
      const pathname = new URL(raw, "http://local").pathname;
      const split = splitPublicPath(pathname, appSegment);
      if (split.kind === "found" && split.mount) return split.mount;
    } catch {
      /* ignore */
    }
  }
  return "";
}

function mountFromReferer(
  referer: string | undefined,
  appSegment: string,
): string {
  if (!referer?.trim()) return "";
  try {
    const pathname = new URL(referer).pathname;
    const split = splitPublicPath(pathname, appSegment);
    if (split.kind === "found" && split.mount) return split.mount;
    const bootstrap = mountFromBootstrapPathname(pathname);
    if (bootstrap && bootstrap !== `/${appSegment}`) return bootstrap;
  } catch {
    /* ignore */
  }
  return "";
}

/** Prefer mount in the request path; else forwarding headers; else Referer; otherwise none. */
export function resolveEffectiveMount(
  pathMount: string,
  headers: Record<string, string | string[] | undefined>,
  appSegment: string,
): string {
  if (pathMount) return pathMount;
  const fromHeader = forwardedMountFromHeaders(headers, appSegment);
  if (fromHeader) return fromHeader;
  return mountFromReferer(headerFirst(headers.referer), appSegment);
}

/** Mount prefix on virtual-path bootstrap URLs (path still includes mount at the edge). */
export function mountFromBootstrapPathname(pathname: string): string {
  let path = pathname || "/";
  if (!path.startsWith("/")) path = `/${path}`;
  path = path.replace(/\/index\.html$/i, "");
  path = path.replace(/\/+$/, "") || "";
  if (!path || path === "/") return "";
  try {
    return normalizeMount(path);
  } catch {
    return "";
  }
}

export function publicPath(
  internal: string,
  mount: string,
  appSegment: string,
): string {
  const base = publicBasePath(mount, appSegment);
  const p = internal.startsWith("/") ? internal : `/${internal}`;
  if (p === "/") return `${base}/`;
  return `${base}${p}`;
}

/** Paths served without app segment (localhost SDK and legacy URLs). */
export function isDirectInternalRoute(pathname: string): boolean {
  if (pathname === "/health") return true;
  if (pathname === "/v1" || pathname.startsWith("/v1/")) return true;
  if (pathname.startsWith("/api/")) return true;
  if (
    pathname === "/wiki" ||
    pathname === "/chat" ||
    pathname === "/plugins" ||
    pathname === "/apps" ||
    pathname.startsWith("/apps/") ||
    pathname.startsWith("/static/") ||
    pathname === "/callback"
  ) {
    return true;
  }
  return false;
}

/** True for virtual-path roots that should bootstrap into {mount}/{appSegment}/. */
export function isBootstrapPath(pathname: string, appSegment: string): boolean {
  let path = pathname || "/";
  if (!path.startsWith("/")) path = `/${path}`;
  if (path === "/healthz") return false;
  if (splitPublicPath(path, appSegment).kind === "found") return false;
  if (isDirectInternalRoute(path)) return false;
  if (path === "/" || path === "/index.html") return true;
  if (/\/index\.html$/i.test(path)) return true;
  if (path.endsWith("/") && path !== "/") return true;
  return false;
}
