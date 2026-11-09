import { describe, expect, it } from "vitest";

import { parseInstalledPluginId } from "./store.js";

describe("parseInstalledPluginId", () => {
  it("accepts encoded and raw slash ids", () => {
    expect(parseInstalledPluginId("cursor-public%2Fslack")).toBe("cursor-public/slack");
    expect(parseInstalledPluginId("cursor-public/slack")).toBe("cursor-public/slack");
  });

  it("rejects incomplete ids", () => {
    expect(() => parseInstalledPluginId("only-marketplace")).toThrow(/invalid plugin id/);
    expect(() => parseInstalledPluginId("a/b/c")).toThrow();
  });
});
