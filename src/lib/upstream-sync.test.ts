import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import type { BridgeConfig } from "./config.js";
import {
  changedPathsNeedRestart,
  compareSemver,
  loadUpstreamSyncOptions,
  mirrorDirectoryFromUpstream,
  parseSemver,
  pickLatestSemverTag,
  readUpstreamSyncState,
  stateFilePath,
  upstreamSyncPathExcluded,
  writeUpstreamSyncState,
} from "./upstream-sync.js";

function minimalConfig(sessionsLogPath: string): BridgeConfig {
  return {
    sessionsLogPath,
  } as BridgeConfig;
}

describe("upstream-sync semver", () => {
  it("parses and compares semver tags", () => {
    expect(parseSemver("v1.7.0")).toEqual([1, 7, 0]);
    expect(compareSemver("v1.8.0", "v1.7.0")).toBe(1);
    expect(compareSemver("1.7.0", "1.7.0")).toBe(0);
    expect(pickLatestSemverTag(["v1.6.0", "v1.7.0", "v1.6.9"])).toBe("v1.7.0");
  });
});

describe("upstream-sync restart detection", () => {
  it("flags src and package.json changes", () => {
    expect(changedPathsNeedRestart(["package.json"])).toBe(true);
    expect(changedPathsNeedRestart(["src/lib/foo.ts"])).toBe(true);
    expect(changedPathsNeedRestart(["docs/WIKI.md"])).toBe(false);
  });
});

describe("upstream-sync options", () => {
  it("defaults push to enabled when sync is on", () => {
    const opts = loadUpstreamSyncOptions({
      CURSOR_BRIDGE_UPSTREAM_SYNC: "true",
    });
    expect(opts.enabled).toBe(true);
    expect(opts.pushEnabled).toBe(true);
  });

  it("honors push disable", () => {
    const opts = loadUpstreamSyncOptions({
      CURSOR_BRIDGE_UPSTREAM_SYNC: "true",
      CURSOR_BRIDGE_UPSTREAM_SYNC_PUSH: "false",
    });
    expect(opts.pushEnabled).toBe(false);
  });
});

describe("upstream-sync mirror (no rsync)", () => {
  it("excludes bridge-only path segments like rsync", () => {
    expect(upstreamSyncPathExcluded("lib/chat-api.ts")).toBe(true);
    expect(upstreamSyncPathExcluded("lib/plugins/foo.ts")).toBe(true);
    expect(upstreamSyncPathExcluded("lib/handlers/foo.ts")).toBe(false);
  });

  it("copies upstream files, deletes extras, keeps excluded dest files", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-mirror-"));
    const src = path.join(base, "src-up");
    const dest = path.join(base, "src-dst");
    fs.mkdirSync(path.join(src, "lib"), { recursive: true });
    fs.mkdirSync(path.join(dest, "lib"), { recursive: true });
    fs.writeFileSync(path.join(src, "lib", "new.ts"), "upstream");
    fs.writeFileSync(path.join(dest, "lib", "stale.ts"), "remove-me");
    fs.writeFileSync(path.join(dest, "lib", "chat-api.ts"), "bridge");

    mirrorDirectoryFromUpstream(src, dest);

    expect(fs.readFileSync(path.join(dest, "lib", "new.ts"), "utf8")).toBe(
      "upstream",
    );
    expect(fs.existsSync(path.join(dest, "lib", "stale.ts"))).toBe(false);
    expect(fs.readFileSync(path.join(dest, "lib", "chat-api.ts"), "utf8")).toBe(
      "bridge",
    );
  });
});

describe("upstream-sync state file", () => {
  it("persists banner and dismiss flag", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-sync-state-"));
    const logPath = path.join(dir, "sessions.log");
    const config = minimalConfig(logPath);
    expect(stateFilePath(config)).toBe(path.join(dir, "upstream-sync.json"));

    writeUpstreamSyncState(config, {
      enabled: true,
      lastOutcome: "success",
      banner: {
        id: "b1",
        kind: "success",
        title: "Updated",
        needsRestart: true,
        dismissed: false,
        createdAt: new Date().toISOString(),
      },
    });

    const loaded = readUpstreamSyncState(config);
    expect(loaded.banner?.title).toBe("Updated");
    expect(loaded.banner?.needsRestart).toBe(true);

    writeUpstreamSyncState(config, {
      ...loaded,
      banner: { ...loaded.banner!, dismissed: true },
    });
    expect(readUpstreamSyncState(config).banner?.dismissed).toBe(true);
  });
});
