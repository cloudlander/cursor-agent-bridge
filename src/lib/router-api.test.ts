import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { BridgeConfig } from "./config.js";
import { createRequestListener } from "./request-listener.js";
import { loadModelRouterTable } from "./model-router-config.js";
import type { ToolSessionRegistry } from "./tool-session-registry.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function testConfig(dir: string, routerPath: string): BridgeConfig {
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
    routerEnabled: true,
    routerConfigPath: routerPath,
    routerQuotaThreshold: 0.15,
    routerTimeoutMs: 8000,
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

describe("router dashboard API", () => {
  it("GET/PUT /api/router/config round-trips routes without bridge key", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "router-api-"));
    tmpDirs.push(dir);
    const routerPath = path.join(dir, "model-router.json");
    fs.writeFileSync(
      routerPath,
      JSON.stringify({
        routes: [{ model: "composer-2.5", when: "routine edits" }],
      }),
    );
    const config = testConfig(dir, routerPath);
    const toolSessions = {
      closeAll: async () => undefined,
    } as ToolSessionRegistry;
    const server = http.createServer(
      createRequestListener({ version: "test", config }, { toolSessions }),
    );
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const get = await fetchJson(port, "/api/router/config");
      expect(get.status).toBe(200);
      expect(get.body).toMatchObject({
        enabled: true,
        configPath: routerPath,
        threshold: 0.15,
      });
      expect(
        (get.body as { routes: unknown[] }).routes,
      ).toEqual([{ model: "composer-2.5", when: "routine edits" }]);

      const put = await fetchJson(port, "/api/router/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          routes: [
            { model: "claude-3-opus", when: "hard problems" },
            { model: "composer-2.5", when: "small tasks" },
          ],
        }),
      });
      expect(put.status).toBe(200);
      expect(loadModelRouterTable(routerPath).routes).toEqual([
        { model: "claude-3-opus", when: "hard problems" },
        { model: "composer-2.5", when: "small tasks" },
      ]);

      const health = await fetchJson(port, "/health");
      expect(health.status).toBe(200);
      expect(
        (health.body as { router: { enabled: boolean; routes: string[] } })
          .router,
      ).toMatchObject({
        enabled: true,
        routes: ["claude-3-opus", "composer-2.5"],
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  it("PUT /api/router/config rejects more than five routes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "router-api-"));
    tmpDirs.push(dir);
    const routerPath = path.join(dir, "model-router.json");
    const config = testConfig(dir, routerPath);
    const toolSessions = {
      closeAll: async () => undefined,
    } as ToolSessionRegistry;
    const server = http.createServer(
      createRequestListener({ version: "test", config }, { toolSessions }),
    );
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const routes = Array.from({ length: 6 }, (_, i) => ({
        model: `m${i}`,
        when: "x",
      }));
      const put = await fetchJson(port, "/api/router/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ routes }),
      });
      expect(put.status).toBe(400);
      expect(String((put.body as { error: string }).error)).toMatch(
        /At most 5 routes/i,
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  it("PUT /api/router/config requires routes array", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "router-api-"));
    tmpDirs.push(dir);
    const config = testConfig(dir, path.join(dir, "model-router.json"));
    const toolSessions = {
      closeAll: async () => undefined,
    } as ToolSessionRegistry;
    const server = http.createServer(
      createRequestListener({ version: "test", config }, { toolSessions }),
    );
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const put = await fetchJson(port, "/api/router/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(put.status).toBe(400);
      expect((put.body as { error: string }).error).toMatch(/routes/);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
});
