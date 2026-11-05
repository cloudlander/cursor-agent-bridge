import { afterEach, describe, expect, it, vi } from "vitest";

import type { BridgeConfig } from "./config.js";
import {
  isModelRoutingEligible,
  routeModel,
  extractLastUserPromptText,
} from "./model-router.js";
import { clearQuotaMonitorCacheForTests } from "./quota-monitor.js";

vi.mock("./agent-runner.js", () => ({
  runAgentSync: vi.fn(),
}));

vi.mock("./quota-monitor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./quota-monitor.js")>();
  return {
    ...actual,
    getAccountQuotaRemainingRatio: vi.fn(async () => 0.5),
  };
});

import { runAgentSync } from "./agent-runner.js";
import { getAccountQuotaRemainingRatio } from "./quota-monitor.js";

function baseConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    agentBin: "agent",
    acpCommand: "agent",
    acpArgs: ["acp"],
    acpEnv: {},
    host: "127.0.0.1",
    port: 8765,
    defaultModel: "composer-2.5",
    mode: "ask",
    force: false,
    approveMcps: false,
    strictModel: true,
    workspace: process.cwd(),
    timeoutMs: 30_000,
    sessionsLogPath: "/tmp/sessions.log",
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
    routerEnabled: true,
    routerConfigPath: "/tmp/model-router.json",
    routerQuotaThreshold: 0.1,
    routerTimeoutMs: 8000,
    ...overrides,
  };
}

describe("isModelRoutingEligible", () => {
  it("treats unset and auto as eligible, not default or explicit ids", () => {
    expect(isModelRoutingEligible(undefined)).toBe(true);
    expect(isModelRoutingEligible("auto")).toBe(true);
    expect(isModelRoutingEligible("default")).toBe(false);
    expect(isModelRoutingEligible("opus-4.6")).toBe(false);
  });
});

describe("extractLastUserPromptText", () => {
  it("uses the last user message", () => {
    expect(
      extractLastUserPromptText([
        { role: "user", content: "first" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "second" },
      ]),
    ).toBe("second");
  });
});

describe("routeModel", () => {
  afterEach(() => {
    clearQuotaMonitorCacheForTests();
    vi.clearAllMocks();
  });

  const ids = ["composer-2.5", "opus-4.6"];

  it("returns explicit model without routing", async () => {
    const decision = await routeModel({
      requested: "opus-4.6",
      promptText: "hard task",
      config: baseConfig(),
      availableCursorIds: ids,
      routerTable: { routes: [] },
    });
    expect(decision.reason).toBe("explicit");
    expect(decision.routed).toBe(false);
    expect(runAgentSync).not.toHaveBeenCalled();
  });

  it("skips routing when disabled", async () => {
    const decision = await routeModel({
      requested: undefined,
      promptText: "task",
      config: baseConfig({ routerEnabled: false }),
      availableCursorIds: ids,
      routerTable: {
        routes: [{ model: "opus-4.6", when: "hard" }],
      },
    });
    expect(decision.reason).toBe("disabled");
    expect(decision.model).toBe("composer-2.5");
  });

  it("uses default when quota unknown (conservative)", async () => {
    vi.mocked(getAccountQuotaRemainingRatio).mockResolvedValueOnce("unknown");
    const decision = await routeModel({
      requested: "auto",
      promptText: "task",
      config: baseConfig(),
      availableCursorIds: ids,
      routerTable: {
        routes: [{ model: "opus-4.6", when: "hard" }],
      },
    });
    expect(decision.reason).toBe("quota-unknown");
    expect(decision.model).toBe("composer-2.5");
    expect(runAgentSync).not.toHaveBeenCalled();
  });

  it("uses default when quota below threshold", async () => {
    vi.mocked(getAccountQuotaRemainingRatio).mockResolvedValueOnce(0.05);
    const decision = await routeModel({
      requested: undefined,
      promptText: "task",
      config: baseConfig({ routerQuotaThreshold: 0.1 }),
      availableCursorIds: ids,
      routerTable: {
        routes: [{ model: "opus-4.6", when: "hard" }],
      },
    });
    expect(decision.reason).toBe("quota-low");
    expect(runAgentSync).not.toHaveBeenCalled();
  });

  it("classifies to route index", async () => {
    vi.mocked(runAgentSync).mockResolvedValue({
      code: 0,
      stdout: '{"route":"0","why":"architecture"}',
      stderr: "",
    });
    const decision = await routeModel({
      requested: undefined,
      promptText: "design a system",
      config: baseConfig(),
      availableCursorIds: ids,
      routerTable: {
        routes: [{ model: "opus-4.6", when: "architecture" }],
      },
    });
    expect(decision.reason).toBe("classified");
    expect(decision.model).toBe("opus-4.6");
    expect(decision.routed).toBe(true);
  });

  it("falls back on classifier error", async () => {
    vi.mocked(runAgentSync).mockResolvedValue({
      code: 0,
      stdout: "not json",
      stderr: "",
    });
    const decision = await routeModel({
      requested: "auto",
      promptText: "task",
      config: baseConfig(),
      availableCursorIds: ids,
      routerTable: {
        routes: [{ model: "opus-4.6", when: "hard" }],
      },
    });
    expect(decision.reason).toBe("classifier-error");
    expect(decision.model).toBe("composer-2.5");
  });

  it("continues tool turn on same model", async () => {
    const decision = await routeModel({
      requested: undefined,
      promptText: "tool output",
      toolContinuationModel: "opus-4.6",
      config: baseConfig(),
      availableCursorIds: ids,
      routerTable: {
        routes: [{ model: "opus-4.6", when: "hard" }],
      },
    });
    expect(decision.reason).toBe("tool-continuation");
    expect(decision.model).toBe("opus-4.6");
    expect(runAgentSync).not.toHaveBeenCalled();
  });
});
