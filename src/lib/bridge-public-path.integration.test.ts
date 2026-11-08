import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { loadBridgeConfig } from "./config.js";
import { appsDirOf } from "./dynamic-apps.js";
import { createRequestListener } from "./request-listener.js";
import { ToolSessionRegistry } from "./tool-session-registry.js";

function listen(
  handler: http.RequestListener,
): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      const port = typeof a === "object" && a ? a.port : 0;
      resolve({ server, port });
    });
  });
}

describe("public path routing", () => {
  it("serves healthz at root and api under mount+segment", async () => {
    const config = loadBridgeConfig({
      env: {
        CURSOR_BRIDGE_APP_SEGMENT: "cursor-agent",
        CURSOR_BRIDGE_SESSIONS_LOG: "/tmp/bridge-public-path-test.log",
      },
      cwd: process.cwd(),
    });
    const listener = createRequestListener(
      { version: "test", config },
      { toolSessions: new ToolSessionRegistry() },
    );
    const { server, port } = await listen(listener);
    try {
      const health = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(await health.text()).toContain("ok");

      const status = await fetch(
        `http://127.0.0.1:${port}/proxy/1080/cursor-agent/api/config`,
      );
      expect(status.status).toBe(200);
      const body = (await status.json()) as { appSegment?: string };
      expect(body.appSegment).toBe("cursor-agent");
    } finally {
      server.close();
    }
  });

  it("uses X-Forwarded-Prefix when upstream pathname is stripped", async () => {
    const config = loadBridgeConfig({
      env: {
        CURSOR_BRIDGE_APP_SEGMENT: "agent-x",
        CURSOR_BRIDGE_SESSIONS_LOG: "/tmp/bridge-stripped-mount-test.log",
      },
      cwd: process.cwd(),
    });
    const listener = createRequestListener(
      { version: "test", config },
      { toolSessions: new ToolSessionRegistry() },
    );
    const { server, port } = await listen(listener);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/agent-x/api/config`, {
        headers: { "X-Forwarded-Prefix": "/proxy/8080" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        publicBase?: string;
        mount?: string;
      };
      expect(body.mount).toBe("/proxy/8080");
      expect(body.publicBase).toBe("/proxy/8080/agent-x");
    } finally {
      server.close();
    }
  });

  it("serves a user app under mount+segment without redirect loop", async () => {
    const config = loadBridgeConfig({
      env: {
        CURSOR_BRIDGE_APP_SEGMENT: "agent-0435a2",
        CURSOR_BRIDGE_SESSIONS_LOG:
          "/tmp/bridge-public-path-dynamic-app-test.log",
      },
      cwd: process.cwd(),
    });
    const appsDir = appsDirOf(config);
    const appRoot = path.join(appsDir, "math-extension-16-18");
    fs.mkdirSync(appRoot, { recursive: true });
    fs.writeFileSync(
      path.join(appRoot, "index.html"),
      "<title>math</title>",
    );
    const listener = createRequestListener(
      { version: "test", config },
      { toolSessions: new ToolSessionRegistry() },
    );
    const { server, port } = await listen(listener);
    try {
      const url = `http://127.0.0.1:${port}/proxy/8100/agent-0435a2/math-extension-16-18/`;
      const res = await fetch(url, { redirect: "manual" });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("math");
    } finally {
      server.close();
    }
  });
});
