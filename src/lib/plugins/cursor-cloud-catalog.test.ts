import { describe, expect, it } from "vitest";

import { mapCloudPluginToEntry } from "./cursor-cloud-catalog.js";

describe("mapCloudPluginToEntry", () => {
  it("maps Browserbase cloud listing to a git catalog entry", () => {
    const entry = mapCloudPluginToEntry({
      name: "browse",
      displayName: "Browserbase",
      description: "Browser automation for AI agents.",
      tags: ["browserbase"],
      marketplace: { name: "cursor-public" },
      gitUrl: "https://github.com/browserbase/browse-plugin",
      releaseTag: "v0.3.0",
      gitPath: ".",
    });
    expect(entry).toMatchObject({
      marketplaceId: "cursor-public",
      name: "browse",
      displayName: "Browserbase",
      description: "Browser automation for AI agents.",
      cloudCatalog: true,
      keywords: ["browserbase", "Browserbase"],
      source: {
        kind: "git",
        url: "https://github.com/browserbase/browse-plugin",
        ref: "v0.3.0",
      },
    });
  });

  it("returns null when no installable git URL", () => {
    expect(mapCloudPluginToEntry({ name: "x", description: "y" })).toBeNull();
  });
});
