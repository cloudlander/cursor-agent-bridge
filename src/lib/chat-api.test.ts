import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { BridgeConfig } from "./config.js";
import { createRequestListener } from "./request-listener.js";
import type { ToolSessionRegistry } from "./tool-session-registry.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function testConfig(dir: string): BridgeConfig {
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
    workspace: dir,
    timeoutMs: 30_000,
    sessionsLogPath: path.join(dir, "sessions.log"),
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
    contextPreamble: false,
    bridgePackageVersion: "test",
  };
}

async function fetchJson(
  port: number,
  pathname: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, init);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe("chat API", () => {
  it("GET/PUT /api/chat/threads round-trips web threads", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-api-"));
    tmpDirs.push(dir);
    const isolatedHome = path.join(dir, "home");
    fs.mkdirSync(isolatedHome, { recursive: true });
    const prevHome = process.env.HOME;
    process.env.HOME = isolatedHome;
    const config = testConfig(dir);
    const toolSessions = { closeAll: async () => undefined } as ToolSessionRegistry;
    const server = http.createServer(
      createRequestListener({ version: "test", config }, { toolSessions }),
    );
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    try {
    const empty = await fetchJson(port, "/api/chat/threads");
    expect(empty.status).toBe(200);
    expect(Array.isArray((empty.body as { sessions: unknown[] }).sessions)).toBe(
      true,
    );
    expect(
      (empty.body as { threads: unknown[] }).threads,
    ).toEqual([]);

    const put = await fetchJson(port, "/api/chat/threads", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        activeId: "abc",
        threads: [
          {
            id: "abc",
            source: "web",
            title: null,
            pinned: false,
            createdAt: 1,
            updatedAt: 2,
            model: "",
            mode: "agent",
            messages: [{ role: "user", content: "hi" }],
          },
        ],
      }),
    });
    expect(put.status).toBe(200);

    const listed = await fetchJson(port, "/api/chat/threads");
    const body = listed.body as {
      activeId: string;
      threads: Array<{ messages: Array<{ content: string }> }>;
    };
    expect(body.activeId).toBe("abc");
    expect(body.threads[0]?.messages[0]?.content).toBe("hi");
    } finally {
      process.env.HOME = prevHome;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
