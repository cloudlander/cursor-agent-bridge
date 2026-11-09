import { describe, expect, it } from "vitest";

import {
  paginateCatalogRows,
  UNCATALOGED_CATEGORY,
  type CatalogRow,
} from "./manager.js";

function row(
  partial: Partial<CatalogRow> & Pick<CatalogRow, "name" | "marketplaceId" | "description" | "source">,
): CatalogRow {
  return {
    keywords: [],
    ...partial,
  };
}

describe("paginateCatalogRows", () => {
  const sample: CatalogRow[] = [
    row({
      name: "b",
      marketplaceId: "m",
      description: "d",
      category: "beta",
      source: { kind: "path", path: "./x" },
    }),
    row({
      name: "a",
      marketplaceId: "m",
      description: "d",
      category: "alpha",
      source: { kind: "git", url: "https://github.com/o/r.git" },
    }),
    row({
      name: "c",
      marketplaceId: "m",
      description: "match-desc-here",
      source: { kind: "git", url: "https://example.com/r.git" },
    }),
  ];

  it("sorts by category then name and paginates", () => {
    const r = paginateCatalogRows(sample, { page: 1, pageSize: 2 });
    expect(r.total).toBe(3);
    expect(r.categories).toEqual(["alpha", "beta"]);
    expect(r.plugins.map((p) => p.name)).toEqual(["a", "b"]);
    const r2 = paginateCatalogRows(sample, { page: 2, pageSize: 2 });
    expect(r2.plugins.map((p) => p.name)).toEqual(["c"]);
  });

  it("filters by category including uncategorized bucket", () => {
    const onlyBeta = paginateCatalogRows(sample, { category: "beta" });
    expect(onlyBeta.plugins.map((p) => p.name)).toEqual(["b", "c"]);
    const uncategorized = paginateCatalogRows(sample, { category: UNCATALOGED_CATEGORY });
    expect(uncategorized.plugins.map((p) => p.name)).toEqual(["c"]);
  });
});
