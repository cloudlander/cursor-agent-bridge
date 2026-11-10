import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Long-lived third-party bundles shipped under public/vendor/. */
export function isImmutablePublicStatic(rel: string): boolean {
  const n = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  return (
    n.startsWith("vendor/") ||
    n.startsWith("version-lineage/")
  );
}

export function cacheControlForPublicStaticRel(rel: string): string {
  if (isImmutablePublicStatic(rel)) {
    return "public, max-age=31536000, immutable";
  }
  return "no-cache";
}

export function weakEtagFromStat(stat: fs.Stats): string {
  return `W/"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
}

export function ifNoneMatchSatisfied(
  header: string | string[] | undefined,
  etag: string,
): boolean {
  if (!header) return false;
  const parts = (Array.isArray(header) ? header.join(",") : header)
    .split(",")
    .map((s) => s.trim());
  return parts.some((p) => p === etag || p === `W/${etag}` || etag === p);
}

let cachedBridgeVersion: string | undefined;

/** Package version used as `?v=` on vendor URLs when HTML is served through the bridge. */
export function bridgeAssetVersion(): string {
  if (cachedBridgeVersion) return cachedBridgeVersion;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "../../package.json");
    const raw = fs.readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(raw) as { version?: unknown };
    cachedBridgeVersion =
      typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    cachedBridgeVersion = "unknown";
  }
  return cachedBridgeVersion;
}

/** Append cache-bust query to vendor static URLs in served HTML (safe to call repeatedly). */
export function appendVendorAssetVersions(html: string, version: string): string {
  const v = encodeURIComponent(version);
  return html.replace(
    /((?:href|src)="[^"]*\/static\/vendor\/[^"?]+)(?=")/g,
    `$1?v=${v}`,
  );
}
