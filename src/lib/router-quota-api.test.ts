import { afterEach, describe, expect, it, vi } from "vitest";

import { initAccountPool } from "./account-pool.js";
import type { BridgeConfig } from "./config.js";
import { buildRouterQuotaResponse } from "./router-quota-api.js";
import { clearQuotaMonitorCacheForTests } from "./quota-monitor.js";

vi.mock("./quota-monitor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./quota-monitor.js")>();
  return {
    ...actual,
    getAccountQuotaRemainingRatio: vi.fn(async () => 0.42),
  };
});

import { getAccountQuotaRemainingRatio } from "./quota-monitor.js";

function cfg(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    agentBin: "agent",
    acpCommand: "agent",
    acpArgs: ["acp"],
    acpEnv: {},
    host: "127.0.0.1",
    port: 8765,
    defaultModel: "default",
    mode: "agent",
    force: false,
    approveMcps: false,
    strictModel: true,
    workspace: "/w",
    timeoutMs: 30_000,
    sessionsLogPath: "/tmp/s.log",
    chatOnlyWorkspace: true,
    chatOnlyWorkspaceExplicit: false,
    verbose: false,
    verboseFull: false,
    maxMode: false,
    promptViaStdin: false,
    useAcp: false,
    acpSkipAuthenticate: true,
    acpRawDebug: false,
    configDirs: ["/pool/a"],
    multiPort: false,
    winCmdlineMax: 30_000,
    contextPreamble: false,
    bridgePackageVersion: "test",
    routerEnabled: true,
    routerConfigPath: "/w/model-router.json",
    routerQuotaThreshold: 0.15,
    routerMonthlyBudgetUsd: 300,
    routerTimeoutMs: 8000,
    ...overrides,
  };
}

afterEach(() => {
  initAccountPool([]);
  clearQuotaMonitorCacheForTests();
  vi.mocked(getAccountQuotaRemainingRatio).mockReset();
  vi.mocked(getAccountQuotaRemainingRatio).mockResolvedValue(0.42);
});

describe("buildRouterQuotaResponse", () => {
  it("returns disabled payload when router is off", async () => {
    const body = await buildRouterQuotaResponse(cfg({ routerEnabled: false }));
    expect(body.enabled).toBe(false);
    expect(body.accounts).toEqual([]);
  });

  it("marks account ok when remaining is above threshold", async () => {
    initAccountPool(["/pool/a"]);
    const body = await buildRouterQuotaResponse(cfg());
    expect(body.enabled).toBe(true);
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]).toMatchObject({
      configDir: "/pool/a",
      label: "a",
      remainingRatio: 0.42,
      remainingPercent: 42,
      status: "ok",
    });
  });

  it("marks account low when remaining is at or below threshold", async () => {
    vi.mocked(getAccountQuotaRemainingRatio).mockResolvedValueOnce(0.05);
    initAccountPool(["/pool/a"]);
    const body = await buildRouterQuotaResponse(cfg({ routerQuotaThreshold: 0.1 }));
    expect(body.accounts[0]?.status).toBe("low");
  });
});
