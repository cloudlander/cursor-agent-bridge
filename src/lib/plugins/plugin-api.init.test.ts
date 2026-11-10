import * as http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BridgeConfig } from "../config.js";
import { handlePluginApi } from "./plugin-api.js";

const initGate = vi.hoisted(() => {
  let release: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release: () => release?.() };
});

vi.mock("./manager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./manager.js")>();
  return {
    ...actual,
    startPluginsUiBackgroundInit: vi.fn((config: BridgeConfig) => {
      void actual.startPluginsUiBackgroundInit(config);
    }),
    waitForPluginsUiInitialized: vi.fn(async () => {
      await initGate.ready;
    }),
    getPluginsUiInitStatus: vi.fn(() => ({
      phase: "running" as const,
      startedAt: "2020-01-01T00:00:00.000Z",
      finishedAt: null,
      error: null,
    })),
  };
});

function createTestConfig(): BridgeConfig {
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
    sessionsLogPath: "/tmp/plugin-api-init.log",
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
    cdswBypassAuthentication: true,
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

function listen(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("no address"));
        return;
      }
      resolve({ server, port: addr.port });
    });
  });
}

describe("plugin API init-status", () => {
  let server: http.Server | undefined;

  afterEach(async () => {
    initGate.release();
    if (server) {
      await new Promise((r) => server!.close(r));
      server = undefined;
    }
  });

  it("GET init-status does not wait for registry init", async () => {
    const config = createTestConfig();
    const { server: s, port } = await listen((req, res) => {
      void handlePluginApi(req, res, config);
    });
    server = s;

    const res = await fetch(`http://127.0.0.1:${port}/api/plugins/init-status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { phase: string };
    expect(body.phase).toBe("running");
  });

  it("GET marketplaces returns before registry init completes", async () => {
    const config = createTestConfig();
    const { server: s, port } = await listen((req, res) => {
      void handlePluginApi(req, res, config);
    });
    server = s;

    const pending = fetch(`http://127.0.0.1:${port}/api/plugins/marketplaces`);
    await new Promise((r) => setTimeout(r, 40));
    initGate.release();
    const res = await pending;
    expect(res.status).toBe(200);
  });
});
