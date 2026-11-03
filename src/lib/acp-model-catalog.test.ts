import { describe, expect, it } from "vitest";

import {
  filterCliModelsForAcpCatalog,
} from "./acp-model-catalog.js";

const SAMPLE_ACP = [
  {
    modelId: "claude-sonnet-5[thinking=true,context=300k,effort=high]",
    name: "Claude Sonnet 5",
  },
  {
    modelId: "composer-2.5[fast=true]",
    name: "Composer 2.5",
  },
] as const;

describe("filterCliModelsForAcpCatalog", () => {
  it("keeps CLI rows that map to the ACP catalog", () => {
    const cli = [
      { id: "claude-sonnet-5-thinking-xhigh", name: "Claude Sonnet 5 1M Extra High Thinking" },
      { id: "composer-2.5-fast", name: "Composer 2.5 Fast" },
      { id: "unknown-model", name: "Unknown" },
    ];
    expect(filterCliModelsForAcpCatalog(cli, SAMPLE_ACP).map((m) => m.id)).toEqual([
      "claude-sonnet-5-thinking-xhigh",
      "composer-2.5-fast",
    ]);
  });

  it("returns the full CLI list when the ACP catalog is empty", () => {
    const cli = [{ id: "a", name: "A" }];
    expect(filterCliModelsForAcpCatalog(cli, [])).toEqual(cli);
  });
});
