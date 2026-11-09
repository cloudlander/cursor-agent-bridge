import { describe, it, expect, afterEach, vi } from "vitest";
import type { BridgeConfig } from "../config.js";
import {
  getPluginsUiInitStatus,
  resetPluginsUiInitForTests,
  startPluginsUiBackgroundInit,
  waitForPluginsUiInitialized,
} from "./manager.js";

function testConfig(): BridgeConfig {
  return {
    agentBin: "agent",
    acpCommand: "agent",
    acpArgs: ["acp"],
    acpEnv: {},
    host: "127.0.0.1",
    port: 0,
    defaultModel: "default",
    mode: "ask",
    force: false,
    approveMcps: false,
    strictModel: true,
    workspace: process.cwd(),
    timeoutMs: 30_000,
    sessionsLogPath: "/tmp/cursor-proxy-manager-init-defer.log",
    chatOnlyWorkspace: true,
    chatOnlyWorkspaceExplicit: false,
    verbose: false,
    verboseFull: false,
    maxMode: false,
    promptViaStdin: false,
    useAcp: false,
    acpSkipAuthenticate: false,
    acpRawDebug: false,
    configDirs: [],
    multiPort: false,
    winCmdlineMax: 30_000,
    contextPreamble: true,
    bridgePackageVersion: "0.0.0-test",
    authKeepalive: {
      enabled: false,
      intervalMs: 240_000,
      skewSec: 300,
      mode: "refresh",
    },
    appSegment: "bridge",
  };
}

describe("startPluginsUiBackgroundInit", () => {
  const prevVitest = process.env.VITEST;
  const prevAutoSync = process.env.CURSOR_BRIDGE_PLUGINS_AUTO_SYNC_CLI;
  const prevEnrichStagger = process.env.CURSOR_BRIDGE_PLUGINS_ENRICH_STAGGER;
  const prevInProcess = process.env.CURSOR_BRIDGE_PLUGINS_INIT_IN_PROCESS;

  afterEach(() => {
    resetPluginsUiInitForTests();
    process.env.VITEST = prevVitest;
    process.env.CURSOR_BRIDGE_PLUGINS_AUTO_SYNC_CLI = prevAutoSync;
    if (prevEnrichStagger === undefined) {
      delete process.env.CURSOR_BRIDGE_PLUGINS_ENRICH_STAGGER;
    } else {
      process.env.CURSOR_BRIDGE_PLUGINS_ENRICH_STAGGER = prevEnrichStagger;
    }
    if (prevInProcess === undefined) {
      delete process.env.CURSOR_BRIDGE_PLUGINS_INIT_IN_PROCESS;
    } else {
      process.env.CURSOR_BRIDGE_PLUGINS_INIT_IN_PROCESS = prevInProcess;
    }
  });

  it("waitForPluginsUiInitialized starts init immediately when scheduled", async () => {
    delete process.env.VITEST;
    process.env.CURSOR_BRIDGE_PLUGINS_INIT_IN_PROCESS = "1";
    process.env.CURSOR_BRIDGE_PLUGINS_ENRICH_STAGGER = "0";
    process.env.CURSOR_BRIDGE_PLUGINS_AUTO_SYNC_CLI = "0";

    const config = testConfig();
    startPluginsUiBackgroundInit(config);

    await waitForPluginsUiInitialized(config);
    expect(getPluginsUiInitStatus().phase).toBe("ready");
  });

  it("does not enter running phase on the same tick as the caller", async () => {
    delete process.env.VITEST;
    process.env.CURSOR_BRIDGE_PLUGINS_INIT_IN_PROCESS = "1";
    process.env.CURSOR_BRIDGE_PLUGINS_ENRICH_STAGGER = "0";
    process.env.CURSOR_BRIDGE_PLUGINS_AUTO_SYNC_CLI = "0";

    const config = testConfig();
    startPluginsUiBackgroundInit(config);
    expect(getPluginsUiInitStatus().phase).toBe("idle");

    for (let i = 0; i < 8 && getPluginsUiInitStatus().phase === "idle"; i++) {
      await new Promise<void>((r) => setImmediate(r));
    }
    expect(getPluginsUiInitStatus().phase).toBe("running");

    await waitForPluginsUiInitialized(config);
    expect(getPluginsUiInitStatus().phase).toBe("ready");
  });
});
