import { describe, expect, it } from "vitest";

import { rememberResolvedModel, resolveModel } from "./resolve-model.js";
import type { BridgeConfig } from "./config.js";

function config(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    agentBin: "agent",
    acpCommand: "agent",
    acpArgs: ["acp"],
    acpEnv: {},
    host: "127.0.0.1",
    port: 8765,
    defaultModel: "auto",
    mode: "ask",
    force: false,
    approveMcps: false,
    strictModel: true,
    workspace: process.cwd(),
    timeoutMs: 30_000,
    sessionsLogPath: "/tmp/test.log",
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
    routerEnabled: false,
    routerConfigPath: "/tmp/model-router.json",
    routerQuotaThreshold: 0.1,
    routerTimeoutMs: 8000,
    ...overrides,
  };
}

describe("resolveModel memory behavior", () => {
  it("does not persist explicit model before validation", () => {
    const ref: { current?: string } = {};
    const resolved = resolveModel("claude-sonnet-4-5-20250929", ref, config());
    expect(resolved).toBe("claude-sonnet-4-5-20250929");
    expect(ref.current).toBeUndefined();
  });

  it("stores only final validated model", () => {
    const ref: { current?: string } = {};
    rememberResolvedModel("sonnet-4.5", ref);
    expect(ref.current).toBe("sonnet-4.5");
  });

  it("does not store default sentinel", () => {
    const ref: { current?: string } = {};
    rememberResolvedModel("default", ref);
    expect(ref.current).toBeUndefined();
  });

  it("skipSessionMemory ignores sticky model", () => {
    const ref: { current?: string } = { current: "opus-4.6" };
    const resolved = resolveModel(undefined, ref, config(), {
      skipSessionMemory: true,
    });
    expect(resolved).toBe("auto");
    expect(ref.current).toBe("opus-4.6");
  });
});
