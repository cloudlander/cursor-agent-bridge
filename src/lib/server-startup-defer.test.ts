import * as http from "node:http";
import { describe, it, expect, vi, afterEach } from "vitest";
import type { BridgeConfig } from "./config.js";

const syncStarted = vi.hoisted(() => ({ value: false }));
const syncGate = vi.hoisted(() => {
  let release: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release: () => release?.() };
});

vi.mock("./plugins/manager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./plugins/manager.js")>();
  return {
    ...actual,
    startPluginsUiBackgroundInit: vi.fn(() => {
      syncStarted.value = true;
      void syncGate.ready;
    }),
    waitForPluginsUiInitialized: vi.fn(async () => {
      syncStarted.value = true;
      await syncGate.ready;
    }),
  };
});

vi.mock("./upstream-sync.js", () => ({
  startUpstreamSyncScheduler: vi.fn(),
}));

import { startBridgeServer } from "./server.js";

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
    sessionsLogPath: "/tmp/cursor-proxy-startup-defer.log",
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

describe("lazy plugin UI init", () => {
  let servers: http.Server[] = [];
  const prevVitest = process.env.VITEST;

  afterEach(async () => {
    syncStarted.value = false;
    syncGate.release();
    process.env.VITEST = prevVitest;
    for (const s of servers) {
      await new Promise((r) => s.close(r));
    }
    servers = [];
  });

  it("listens immediately while plugin registry init runs in the background", async () => {
    delete process.env.VITEST;
    const port = 43124;
    servers = await startBridgeServer({
      version: "1.0.0",
      config: { ...createTestConfig(), port },
    });

    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok\n");

    for (let i = 0; i < 4 && !syncStarted.value; i++) {
      await new Promise<void>((r) => setImmediate(r));
    }
    expect(syncStarted.value).toBe(true);
  });

  it("serves GET /plugins without waiting for plugin init", async () => {
    delete process.env.VITEST;
    const port = 43126;
    servers = await startBridgeServer({
      version: "1.0.0",
      config: { ...createTestConfig(), port },
    });

    const pageRes = await fetch(`http://127.0.0.1:${port}/plugins`);
    expect(pageRes.status).toBe(200);
    expect(await pageRes.text()).toContain("plugins-app.js");
  });

  it("GET plugins marketplaces does not block on background registry init", async () => {
    delete process.env.VITEST;
    const port = 43125;
    servers = await startBridgeServer({
      version: "1.0.0",
      config: { ...createTestConfig(), port },
    });

    const pending = fetch(`http://127.0.0.1:${port}/api/plugins/marketplaces`);
    await new Promise((r) => setTimeout(r, 40));
    syncGate.release();
    const res = await pending;
    expect(res.status).toBe(200);
  });
});
