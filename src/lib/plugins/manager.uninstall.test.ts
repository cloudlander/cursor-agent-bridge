import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { BridgeConfig } from "../config.js";
import { syncCliCachePlugins, uninstallPlugin } from "./manager.js";
import {
  emptyConfig,
  pluginPaths,
  readRegistry,
  writeRegistry,
  type InstalledPlugin,
} from "./store.js";

function testConfig(root: string): BridgeConfig {
  return {
    configDirs: [root],
    sessionsLogPath: path.join(root, "sessions.log"),
    workspace: root,
  } as BridgeConfig;
}

function seedCliCachePlugin(root: string, marketplaceId: string, name: string): void {
  const pluginRoot = path.join(root, "plugins", "cache", marketplaceId, name, "deadbeef");
  fs.mkdirSync(path.join(pluginRoot, ".cursor-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(pluginRoot, ".cursor-plugin", "plugin.json"),
    JSON.stringify({ name, description: "test", version: "1.0.0" }),
  );
}

describe("uninstall and CLI cache sync", () => {
  const homeSnapshots: Array<string | undefined> = [];

  afterEach(() => {
    const prev = homeSnapshots.pop();
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
  });

  it("records uninstall block list and syncCliCachePlugins skips blocked ids", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugins-uninstall-"));
    homeSnapshots.push(process.env.HOME);
    process.env.HOME = root;
    seedCliCachePlugin(root, "cursor-public", "slack");

    const config = testConfig(root);
    const id = "cursor-public/slack";
    const reg = readRegistry(config);
    reg.plugins.push({
      id,
      name: "slack",
      marketplaceId: "cursor-public",
      version: "1",
      description: "",
      source: { kind: "cache", dir: "/tmp" },
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      enabled: true,
      config: emptyConfig(),
      deployed: { skills: [], commands: [], agents: [], mcpServers: [], warnings: [] },
    } as InstalledPlugin);
    const installRoot = path.join(pluginPaths(config).installedDir, "cursor-public__slack");
    fs.mkdirSync(installRoot, { recursive: true });
    writeRegistry(config, reg);

    await uninstallPlugin(config, id);
    const after = readRegistry(config);
    expect(after.plugins.some((p) => p.id === id)).toBe(false);
    expect(after.cliSyncBlocked).toContain(id);
    expect(fs.existsSync(installRoot)).toBe(false);

    const sync = await syncCliCachePlugins(config);
    expect(sync.imported).toEqual([]);
    expect(sync.blocked).toContain(id);
    expect(readRegistry(config).plugins.some((p) => p.id === id)).toBe(false);
  });

  it("restores default registry fields when missing cliSyncBlocked", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugins-reg-"));
    const config = testConfig(root);
    const p = pluginPaths(config);
    fs.mkdirSync(path.dirname(p.registryFile), { recursive: true });
    fs.writeFileSync(p.registryFile, JSON.stringify({ version: 1, marketplaces: [], plugins: [] }));
    const reg = readRegistry(config);
    expect(reg.cliSyncBlocked).toEqual([]);
  });
});
