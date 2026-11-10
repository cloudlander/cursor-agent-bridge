import { describe, expect, it } from "vitest";
import {
  appendVendorAssetVersions,
  cacheControlForPublicStaticRel,
  ifNoneMatchSatisfied,
  isImmutablePublicStatic,
} from "./public-static-cache.js";

describe("public-static-cache", () => {
  it("marks vendor and version-lineage as immutable", () => {
    expect(isImmutablePublicStatic("vendor/mermaid.min.js")).toBe(true);
    expect(isImmutablePublicStatic("version-lineage/01.png")).toBe(true);
    expect(isImmutablePublicStatic("chat-app.js")).toBe(false);
  });

  it("assigns long cache only to immutable paths", () => {
    expect(cacheControlForPublicStaticRel("vendor/marked.min.js")).toContain(
      "immutable",
    );
    expect(cacheControlForPublicStaticRel("styles.css")).toBe("no-cache");
  });

  it("honors If-None-Match", () => {
    const etag = 'W/"abc-123"';
    expect(ifNoneMatchSatisfied(etag, etag)).toBe(true);
    expect(ifNoneMatchSatisfied('"other"', etag)).toBe(false);
  });

  it("appends version query to vendor script src", () => {
    const html =
      '<script src="/static/vendor/marked.min.js"></script>';
    expect(appendVendorAssetVersions(html, "1.7.0")).toBe(
      '<script src="/static/vendor/marked.min.js?v=1.7.0"></script>',
    );
  });
});
