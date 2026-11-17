import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
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
        `http://127.0.0.1:${port}/proxy/1080/cursor-agent/api/status`,
        {
          headers: {
            "X-Forwarded-Host": "example.test",
            "X-Forwarded-Proto": "https",
          },
        },
      );
      expect(status.status).toBe(200);
      const body = (await status.json()) as { publicOpenAiApiBase?: string };
      expect(body.publicOpenAiApiBase).toBe(
        "https://example.test/proxy/1080/cursor-agent/v1",
      );

      const configRes = await fetch(
        `http://127.0.0.1:${port}/proxy/1080/cursor-agent/api/config`,
      );
      expect(configRes.status).toBe(200);
      const cfg = (await configRes.json()) as Record<string, unknown>;
      expect(cfg).not.toHaveProperty("appSegment");
      expect(cfg).not.toHaveProperty("mount");
      expect(cfg).not.toHaveProperty("publicBase");
      expect(cfg).not.toHaveProperty("externalPathname");
    } finally {
      server.close();
    }
  });

  it("injects stable public base when Referer is chat under app segment", async () => {
    const config = loadBridgeConfig({
      env: {
        CURSOR_BRIDGE_APP_SEGMENT: "agent-0435a2",
        CURSOR_BRIDGE_SESSIONS_LOG: "/tmp/bridge-dashboard-referer-test.log",
      },
      cwd: process.cwd(),
    });
    const listener = createRequestListener(
      { version: "test", config },
      { toolSessions: new ToolSessionRegistry() },
    );
    const { server, port } = await listen(listener);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/agent-0435a2/`, {
        headers: {
          referer: `http://127.0.0.1:${port}/agent-0435a2/chat`,
        },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('__BRIDGE_MOUNT__=""');
      expect(html).toContain('__BRIDGE_PUBLIC_BASE__="/agent-0435a2"');
      expect(html).not.toContain("/agent-0435a2/chat/agent-0435a2");
    } finally {
      server.close();
    }
  });

  it("injects mount on dashboard HTML for full public path", async () => {
    const config = loadBridgeConfig({
      env: {
        CURSOR_BRIDGE_APP_SEGMENT: "agent-0435a2",
        CURSOR_BRIDGE_SESSIONS_LOG: "/tmp/bridge-dashboard-mount-test.log",
      },
      cwd: process.cwd(),
    });
    const listener = createRequestListener(
      { version: "test", config },
      { toolSessions: new ToolSessionRegistry() },
    );
    const { server, port } = await listen(listener);
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/proxy/8100/agent-0435a2/`,
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('__BRIDGE_MOUNT__="/proxy/8100"');
      expect(html).toContain(
        '__BRIDGE_PUBLIC_BASE__="/proxy/8100/agent-0435a2"',
      );
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
      const res = await fetch(`http://127.0.0.1:${port}/agent-x/api/status`, {
        headers: {
          "X-Forwarded-Prefix": "/proxy/8080",
          "X-Forwarded-Host": "example.test",
          "X-Forwarded-Proto": "https",
        },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { publicCursorApiBase?: string };
      expect(body.publicCursorApiBase).toBe(
        "https://example.test/proxy/8080/agent-x/v1",
      );
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

  it("proxies a catalog app under the public path without a bridge restart", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-public-"));
    const sessionsLog = path.join(root, "sessions.log");
    fs.writeFileSync(sessionsLog, "");
    const seen: { prefix?: string; path?: string } = {};
    const upstream = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/__bridge/catalog-prove") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            nonce: url.searchParams.get("nonce"),
            name: url.searchParams.get("name"),
          }),
        );
        return;
      }
      if (url.pathname === "/__bridge/catalog-health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, name: "ccv" }));
        return;
      }
      seen.prefix = req.headers["x-forwarded-prefix"] as string | undefined;
      seen.path = url.pathname;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("pong");
    });
    await new Promise<void>((resolve) => {
      upstream.listen(0, "127.0.0.1", () => resolve());
    });
    const upstreamPort = (upstream.address() as AddressInfo).port;

    const config = loadBridgeConfig({
      env: {
        CURSOR_BRIDGE_APP_SEGMENT: "cursor-agent",
        CURSOR_BRIDGE_SESSIONS_LOG: sessionsLog,
      },
      cwd: process.cwd(),
    });
    const listener = createRequestListener(
      { version: "test", config },
      { toolSessions: new ToolSessionRegistry() },
    );
    const { server, port } = await listen(listener);
    const base = `http://127.0.0.1:${port}/proxy/8100/cursor-agent`;
    try {
      const registered = await fetch(`${base}/api/apps/catalog`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "ccv", port: upstreamPort, title: "CCV" }),
      });
      expect(registered.status).toBe(200);

      const page = await fetch(`${base}/apps`);
      expect(await page.text()).toContain("CCV");

      const proxied = await fetch(`${base}/apps/ccv/api/auth-setup`, {
        headers: {
          "x-forwarded-host": "cai.example",
          "x-forwarded-proto": "https",
        },
      });
      expect(await proxied.text()).toBe("pong");
      expect(seen.path).toBe("/api/auth-setup");
      expect(seen.prefix).toBe("/proxy/8100/cursor-agent/apps/ccv");

      const short = await fetch(`${base}/ccv/ping`);
      expect(await short.text()).toBe("pong");
      expect(seen.prefix).toBe("/proxy/8100/cursor-agent/ccv");
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
