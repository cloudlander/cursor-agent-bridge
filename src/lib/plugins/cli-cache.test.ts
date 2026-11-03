import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import type { BridgeConfig } from "../config.js";
import { discoverCliCacheCatalog, resolveCliCacheDir } from "./cli-cache.js";

function minimalConfig(cursorDir: string): BridgeConfig {
  return {
    configDirs: [cursorDir],
    sessionsLogPath: path.join(cursorDir, "sessions.log"),
  } as BridgeConfig;
}

describe("discoverCliCacheCatalog", () => {
  it("finds plugins under Cursor CLI cache layout", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-cache-"));
    const prevHome = process.env.HOME;
    process.env.HOME = root;
    const pluginRoot = path.join(root, "plugins", "cache", "cursor-public", "atlassian", "abc123");
    fs.mkdirSync(path.join(pluginRoot, ".cursor-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, ".cursor-plugin", "plugin.json"),
      JSON.stringify({
        name: "atlassian",
        description: "Atlassian MCP",
        version: "1.0.0",
      }),
    );

    try {
      const found = discoverCliCacheCatalog(minimalConfig(root));
      expect(found).toHaveLength(1);
      expect(found[0].name).toBe("atlassian");
      expect(found[0].marketplaceId).toBe("cursor-public");
      expect(found[0].source).toEqual({ kind: "cache", dir: pluginRoot });
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });

  it("resolveCliCacheDir returns the newest hash directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-cache-res-"));
    const prevHome = process.env.HOME;
    process.env.HOME = root;
    const base = path.join(root, "plugins", "cache", "cursor-public", "atlassian");
    const older = path.join(base, "oldhash");
    const newer = path.join(base, "newhash");
    fs.mkdirSync(older, { recursive: true });
    fs.mkdirSync(newer, { recursive: true });
    const oldTime = new Date("2020-01-01");
    const newTime = new Date("2025-01-01");
    fs.utimesSync(older, oldTime, oldTime);
    fs.utimesSync(newer, newTime, newTime);

    try {
      expect(resolveCliCacheDir(minimalConfig(root), "cursor-public", "atlassian")).toBe(
        newer,
      );
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });
});
