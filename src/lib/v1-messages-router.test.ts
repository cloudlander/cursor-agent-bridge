import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startBridgeServer } from "./server.js";
import type { BridgeConfig } from "./config.js";

vi.mock("./cursor-cli.js", () => ({
  listCursorCliModels: vi.fn().mockResolvedValue([
    { id: "claude-3-opus", name: "Claude 3 Opus" },
    { id: "composer-2.5", name: "Composer 2.5" },
  ]),
}));

vi.mock("./process.js", () => ({
  killAllChildProcesses: vi.fn(),
  run: vi.fn().mockResolvedValue({
    code: 0,
    stdout: "Hello from agent",
    stderr: "",
  }),
  runStreaming: vi.fn().mockResolvedValue({ code: 0, stderr: "" }),
}));

vi.mock("./request-log.js", () => ({
  logIncoming: vi.fn(),
  logTrafficRequest: vi.fn(),
  logTrafficResponse: vi.fn(),
  logModelResolution: vi.fn(),
  logModelRoute: vi.fn(),
  logAgentError: vi.fn().mockReturnValue("agent error"),
  appendSessionLine: vi.fn(),
  logAccountAssigned: vi.fn(),
  logAccountStats: vi.fn(),
}));

vi.mock("./model-router.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./model-router.js")>();
  return {
    ...actual,
    routeModel: vi.fn(async () => ({
      model: "claude-3-opus",
      routed: true,
      reason: "classified",
      remainingRatio: 0.42,
    })),
  };
});

const tmpDirs: string[] = [];
let servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
        }),
    ),
  );
  servers = [];
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createRouterConfig(dir: string): BridgeConfig {
  const routerPath = path.join(dir, "model-router.json");
  fs.writeFileSync(
    routerPath,
    JSON.stringify({
      routes: [{ model: "claude-3-opus", when: "complex work" }],
    }),
  );
  return {
    agentBin: "agent",
    acpCommand: "agent",
    acpArgs: ["acp"],
    acpEnv: {},
    host: "127.0.0.1",
    port: 0,
    defaultModel: "composer-2.5",
    mode: "ask",
    force: false,
    approveMcps: false,
    strictModel: true,
    workspace: process.cwd(),
    timeoutMs: 30_000,
    sessionsLogPath: path.join(dir, "sessions.log"),
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
    contextPreamble: false,
    bridgePackageVersion: "0.0.0-test",
    routerEnabled: true,
    routerConfigPath: routerPath,
    routerQuotaThreshold: 0.1,
    routerTimeoutMs: 8000,
    authKeepalive: {
      enabled: false,
      intervalMs: 240_000,
      skewSec: 300,
      mode: "refresh",
    },
  };
}

async function postMessages(
  server: http.Server,
  body: unknown,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const port = (server.address() as { port: number }).port;
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    body: await res.text(),
  };
}

describe("POST /v1/messages model routing", () => {
  it("sets X-Bridge route headers when router is enabled and model is auto", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v1-msg-router-"));
    tmpDirs.push(dir);
    servers = startBridgeServer({
      version: "1.0.0-test",
      config: createRouterConfig(dir),
    });
    await new Promise<void>((resolve) =>
      servers[0].on("listening", () => resolve()),
    );

    const { status, headers, body } = await postMessages(servers[0], {
      model: "auto",
      max_tokens: 32,
      messages: [{ role: "user", content: "Refactor this module" }],
    });

    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.type).toBe("message");
    expect(headers["x-bridge-routed-model"]).toBe("claude-3-opus");
    expect(headers["x-bridge-route-reason"]).toBe("classified");
    expect(headers["x-bridge-quota-remaining"]).toBe("0.42");
  });
});
