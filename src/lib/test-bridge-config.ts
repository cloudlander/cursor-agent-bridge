import type { BridgeConfig } from "./config.js";

/** Minimal valid BridgeConfig for unit tests. */
export function testBridgeConfig(
  overrides: Partial<BridgeConfig> = {},
): BridgeConfig {
  return {
    agentBin: "agent",
    acpCommand: "agent",
    acpArgs: ["acp"],
    acpEnv: {},
    host: "127.0.0.1",
    port: 8765,
    defaultModel: "default",
    mode: "ask",
    force: false,
    approveMcps: false,
    strictModel: true,
    workspace: process.cwd(),
    timeoutMs: 30_000,
    sessionsLogPath: "/tmp/test-sessions.log",
    chatOnlyWorkspace: true,
    chatOnlyWorkspaceExplicit: false,
    verbose: false,
    verboseFull: false,
    maxMode: false,
    promptViaStdin: false,
    useAcp: false,
    acpSkipAuthenticate: true,
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
