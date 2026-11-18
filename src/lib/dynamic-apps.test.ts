import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BridgeConfig } from "./config.js";
import {
  appsDirOf,
  deployAppFromSource,
  dynamicAppsMatches,
  handleDynamicApps,
  listApps,
} from "./dynamic-apps.js";

function baseConfig(sessionsLogPath: string): BridgeConfig {
  return {
    sessionsLogPath,
    appSegment: "cursor-agent",
  } as BridgeConfig;
}

function mockReq(url: string, method = "GET"): http.IncomingMessage {
  return { method, url, headers: {} } as http.IncomingMessage;
}

function invoke(
  url: string,
  config: BridgeConfig,
  method = "GET",
): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve) => {
    let status = 0;
    let body = "";
    let headers: Record<string, unknown> = {};
    const res = {
      writeHead(code: number, h?: Record<string, unknown>) {
        status = code;
        headers = h ?? {};
      },
      end(chunk?: string) {
        if (chunk) body += chunk;
        resolve({ status, body, headers });
      },
    } as unknown as http.ServerResponse;

    const handled = handleDynamicApps(mockReq(url, method), res, config);
    if (!handled) {
      resolve({ status: 0, body: "", headers: {} });
    }
  });
}

describe("dynamic-apps", () => {
  let tmp: string;
  let config: BridgeConfig;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dynamic-apps-"));
    const logPath = path.join(tmp, "sessions.log");
    fs.writeFileSync(logPath, "");
    config = baseConfig(logPath);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.CURSOR_BRIDGE_APPS_DIR;
  });

  it("resolves apps dir next to sessions log", () => {
    expect(appsDirOf(config)).toBe(path.join(tmp, "apps"));
  });

  it("lists apps after deploy without restart", () => {
    const appsDir = appsDirOf(config);
    const demo = path.join(appsDir, "demo");
    fs.mkdirSync(demo, { recursive: true });
    fs.writeFileSync(path.join(demo, "index.html"), "<h1>Demo</h1>");

    expect(listApps(appsDir).map((a) => a.name)).toEqual(["demo"]);
  });

  it("serves app index and static assets", async () => {
    const appsDir = appsDirOf(config);
    const app = path.join(appsDir, "hello");
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, "index.html"), "<title>Hello</title>");
    fs.writeFileSync(path.join(app, "app.css"), "body{}");

    const index = await invoke("/apps/hello/", config);
    expect(index.status).toBe(200);
    expect(index.body).toContain("Hello");

    const css = await invoke("/static/hello/app.css", config);
    expect(css.status).toBe(200);
    expect(css.body).toBe("body{}");
  });

  it("returns api/apps json", async () => {
    const appsDir = appsDirOf(config);
    fs.mkdirSync(path.join(appsDir, "x"), { recursive: true });
    fs.writeFileSync(path.join(appsDir, "x", "index.html"), "ok");

    const res = await invoke("/api/apps", config);
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body) as { apps: { name: string }[] };
    expect(data.apps.map((a) => a.name)).toEqual(["x"]);
  });

  it("serves app index without trailing-slash redirect loop", async () => {
    const appsDir = appsDirOf(config);
    fs.mkdirSync(path.join(appsDir, "r"), { recursive: true });
    fs.writeFileSync(path.join(appsDir, "r", "index.html"), "r");

    const res = await invoke("/apps/r", config);
    expect(res.status).toBe(200);
    expect(res.body).toBe("r");
  });

  it("serves registered apps at short top-level paths", async () => {
    const appsDir = appsDirOf(config);
    const app = path.join(appsDir, "aigc-course");
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, "index.html"), "<title>Course</title>");

    const res = await invoke("/aigc-course/", config);
    expect(res.status).toBe(200);
    expect(res.body).toContain("Course");
  });

  it("404s unknown short app paths without falling through", async () => {
    const res = await invoke("/missing-app/", config);
    expect(res.status).toBe(404);
  });

  it("deploys from workspace source without restart", () => {
    const source = path.join(tmp, "src-site");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "index.html"), "<h1>Deployed</h1>");

    const result = deployAppFromSource(
      appsDirOf(config),
      "my-app",
      source,
      tmp,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.shortUrl).toBe("/my-app/");

    const apps = listApps(appsDirOf(config));
    expect(apps.map((a) => a.name)).toContain("my-app");
  });

  it("rejects deploy sources outside workspace", () => {
    const result = deployAppFromSource(
      appsDirOf(config),
      "x",
      "/etc",
      tmp,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("workspace");
  });

  it("falls through unknown /static/ paths", () => {
    const res = {
      writeHead: vi.fn(),
      end: vi.fn(),
    } as unknown as http.ServerResponse;
    const handled = handleDynamicApps(
      mockReq("/static/not-an-app/style.css"),
      res,
      config,
    );
    expect(handled).toBe(false);
  });

  it("deploys a running localhost process and proxies it beside static apps", async () => {
    const seen: { prefix?: string; host?: string; proto?: string; body?: string } = {};
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
      seen.host = req.headers["x-forwarded-host"] as string | undefined;
      seen.proto = req.headers["x-forwarded-proto"] as string | undefined;
      if (req.method === "POST") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          seen.body = Buffer.concat(chunks).toString("utf8");
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("pong");
    });
    await listen(upstream);

    const bridge = http.createServer((req, res) => {
      if (!handleDynamicApps(req, res, config)) {
        res.writeHead(404);
        res.end("unhandled");
      }
    });
    await listen(bridge);
    const base = baseUrl(bridge);
    const port = (upstream.address() as AddressInfo).port;

    try {
      const appsDir = appsDirOf(config);
      fs.mkdirSync(path.join(appsDir, "demo"), { recursive: true });
      fs.writeFileSync(path.join(appsDir, "demo", "index.html"), "<h1>Demo</h1>");

      const registered = await fetch(`${base}/api/apps/deploy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "ccv",
          port,
          title: "CCV",
          ttlSec: 45,
        }),
      });
      expect(registered.status).toBe(200);

      const denied = await fetch(`${base}/api/apps/deploy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "chat", port }),
      });
      expect(denied.status).toBe(400);

      const unproved = await fetch(`${base}/api/apps/deploy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "other", port: 1 }),
      });
      expect(unproved.status).toBe(400);

      const listed = await fetch(`${base}/api/apps`);
      const data = (await listed.json()) as {
        apps: { name: string; kind: string; online?: boolean }[];
      };
      expect(data.apps.map((a) => `${a.name}:${a.kind}`).sort()).toEqual([
        "ccv:dynamic",
        "demo:static",
      ]);
      expect(data.apps.find((a) => a.name === "ccv")?.online).toBe(true);

      const page = await fetch(`${base}/apps`, { redirect: "manual" });
      expect(page.status).toBe(302);
      expect(page.headers.get("location")).toBe("/#apps");

      const proxied = await fetch(`${base}/apps/ccv/ping`, {
        headers: {
          "x-forwarded-host": "cai.example",
          "x-forwarded-proto": "https",
        },
      });
      expect(await proxied.text()).toBe("pong");
      expect(seen.prefix).toBe("/apps/ccv");
      expect(seen.host).toBe("cai.example");
      expect(seen.proto).toBe("https");

      const short = await fetch(`${base}/ccv/ping`);
      expect(await short.text()).toBe("pong");

      const posted = await fetch(`${base}/apps/ccv/api/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "a.b.c" }),
      });
      expect(posted.status).toBe(200);
      expect(seen.body).toContain("a.b.c");

      const catalogGone = await fetch(`${base}/api/apps/catalog/ccv/heartbeat`, {
        method: "POST",
      });
      expect(catalogGone.status).toBe(404);

      const staticStop = await fetch(`${base}/api/apps/demo/stop`, { method: "POST" });
      expect(staticStop.status).toBe(400);
      const staticRestart = await fetch(`${base}/api/apps/demo/restart`, { method: "POST" });
      expect(staticRestart.status).toBe(400);

      const stopped = await fetch(`${base}/api/apps/ccv/stop`, { method: "POST" });
      expect(stopped.status).toBe(400);
      const stillRunning = (await (await fetch(`${base}/api/apps`)).json()) as {
        apps: { name: string; desired?: string }[];
      };
      expect(stillRunning.apps.find((a) => a.name === "ccv")?.desired).toBe("running");

      await closeServer(upstream);
      const down = await fetch(`${base}/apps/ccv/ping`);
      expect(down.status).toBe(502);

      const removed = await fetch(`${base}/api/apps/ccv`, { method: "DELETE" });
      expect(removed.status).toBe(200);
      const after = (await (await fetch(`${base}/api/apps`)).json()) as {
        apps: { name: string }[];
      };
      expect(after.apps.map((a) => a.name)).toEqual(["demo"]);
    } finally {
      await closeServer(upstream);
      await closeServer(bridge);
    }
  });

  it("shows stale dynamic apps as offline and drops ancient ones", () => {
    const appsDir = appsDirOf(config);
    const dir = path.join(appsDir, ".catalog");
    fs.mkdirSync(dir, { recursive: true });
    const stale = new Date(Date.now() - 120_000).toISOString();
    const ancient = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const row = (name: string, heartbeatAt: string) =>
      JSON.stringify({
        name,
        port: 9,
        ttlMs: 1000,
        registeredAt: heartbeatAt,
        heartbeatAt,
      });
    fs.writeFileSync(path.join(dir, "fresh.json"), row("fresh", stale));
    fs.writeFileSync(path.join(dir, "gone.json"), row("gone", ancient));
    fs.writeFileSync(
      path.join(dir, "kept.json"),
      JSON.stringify({
        name: "kept",
        port: 9,
        ttlMs: 1000,
        registeredAt: ancient,
        heartbeatAt: ancient,
        desired: "running",
        launch: { command: "node", args: ["daemon.js"] },
      }),
    );
    fs.writeFileSync(
      path.join(dir, "paused.json"),
      JSON.stringify({
        name: "paused",
        port: 9,
        ttlMs: 1000,
        registeredAt: ancient,
        heartbeatAt: ancient,
        desired: "stopped",
      }),
    );

    const apps = listApps(appsDir);
    expect(apps.find((a) => a.name === "fresh")).toMatchObject({
      kind: "dynamic",
      online: false,
    });
    expect(apps.find((a) => a.name === "gone")).toBeUndefined();
    expect(apps.find((a) => a.name === "kept")).toMatchObject({
      kind: "dynamic",
      online: false,
      managed: true,
      desired: "running",
    });
    expect(apps.find((a) => a.name === "paused")).toMatchObject({
      kind: "dynamic",
      desired: "stopped",
      online: false,
    });
  });

  it("stops and deregisters a dynamic app from the apps API", async () => {
    const appsDir = appsDirOf(config);
    const dir = path.join(appsDir, ".catalog");
    fs.mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    fs.writeFileSync(
      path.join(dir, "demo-dyn.json"),
      JSON.stringify({
        name: "demo-dyn",
        port: 9,
        ttlMs: 45_000,
        registeredAt: now,
        heartbeatAt: now,
        desired: "running",
        launch: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      }),
    );

    const stopped = await invoke("/api/apps/demo-dyn/stop", config, "POST");
    expect(stopped.status).toBe(200);
    const listed = JSON.parse((await invoke("/api/apps", config)).body) as {
      apps: { name: string; desired?: string; managed?: boolean; kind: string }[];
    };
    expect(listed.apps.find((a) => a.name === "demo-dyn")).toMatchObject({
      kind: "dynamic",
      desired: "stopped",
      managed: true,
    });

    fs.writeFileSync(
      path.join(dir, "nolaunch.json"),
      JSON.stringify({
        name: "nolaunch",
        port: 9,
        ttlMs: 45_000,
        registeredAt: now,
        heartbeatAt: now,
        desired: "running",
      }),
    );
    const rejected = await invoke("/api/apps/nolaunch/restart", config, "POST");
    expect(rejected.status).toBe(400);

    const removed = await invoke("/api/apps/demo-dyn", config, "DELETE");
    expect(removed.status).toBe(200);
    const after = JSON.parse((await invoke("/api/apps", config)).body) as {
      apps: { name: string }[];
    };
    expect(after.apps.find((a) => a.name === "demo-dyn")).toBeUndefined();
  });

  it("exports and imports a static app over HTTP", async () => {
    expect(dynamicAppsMatches(mockReq("/api/apps/site/export"), config)).toBe(true);
    expect(dynamicAppsMatches(mockReq("/api/apps/deploy", "POST"), config)).toBe(true);
    expect(dynamicAppsMatches(mockReq("/api/apps/site", "DELETE"), config)).toBe(true);
    expect(dynamicAppsMatches(mockReq("/api/apps/site/restart", "POST"), config)).toBe(true);
    expect(dynamicAppsMatches(mockReq("/api/apps/site/stop", "POST"), config)).toBe(true);
    expect(dynamicAppsMatches(mockReq("/api/apps/import", "POST"), config)).toBe(false);
    expect(dynamicAppsMatches(mockReq("/api/apps/catalog", "POST"), config)).toBe(false);

    const bridge = http.createServer((req, res) => {
      if (!handleDynamicApps(req, res, config)) {
        res.writeHead(404);
        res.end("unhandled");
      }
    });
    await listen(bridge);
    const base = baseUrl(bridge);
    try {
      const appsDir = appsDirOf(config);
      const site = path.join(appsDir, "site");
      fs.mkdirSync(path.join(site, "notes"), { recursive: true });
      fs.writeFileSync(path.join(site, "index.html"), "<h1>Zip</h1>");
      fs.writeFileSync(path.join(site, "notes", "说明.txt"), "hello");

      const exported = await fetch(`${base}/api/apps/site/export`);
      expect(exported.status).toBe(200);
      expect(exported.headers.get("content-type")).toContain("application/zip");
      expect(exported.headers.get("content-disposition")).toContain("site.zip");
      const zip = Buffer.from(await exported.arrayBuffer());

      fs.rmSync(site, { recursive: true, force: true });
      const imported = await fetch(`${base}/api/apps/deploy`, {
        method: "POST",
        headers: { "content-type": "application/zip" },
        body: zip,
      });
      expect(imported.status).toBe(200);
      const body = (await imported.json()) as { name: string; started: boolean; kind: string };
      expect(body).toMatchObject({ name: "site", kind: "static", started: false });
      expect(fs.readFileSync(path.join(site, "notes", "说明.txt"), "utf8")).toBe("hello");
      const page = await fetch(`${base}/apps/site/`);
      expect(await page.text()).toContain("Zip");

      const removed = await fetch(`${base}/api/apps/site`, { method: "DELETE" });
      expect(removed.status).toBe(200);
      expect(fs.existsSync(site)).toBe(false);
      const gone = await fetch(`${base}/apps/site/`);
      expect(gone.status).toBe(404);
      const listed = (await (await fetch(`${base}/api/apps`)).json()) as {
        apps: { name: string }[];
      };
      expect(listed.apps.find((app) => app.name === "site")).toBeUndefined();
    } finally {
      await closeServer(bridge);
    }
  });

  it("deletes a dynamic app and its installed bundle through the same route", async () => {
    const appsDir = appsDirOf(config);
    const site = path.join(appsDir, "site");
    fs.mkdirSync(site, { recursive: true });
    fs.writeFileSync(path.join(site, "index.html"), "stay");
    const now = new Date().toISOString();
    fs.mkdirSync(path.join(appsDir, ".catalog"), { recursive: true });
    fs.writeFileSync(
      path.join(appsDir, ".catalog", "site.json"),
      JSON.stringify({
        name: "site",
        port: 9,
        ttlMs: 45_000,
        registeredAt: now,
        heartbeatAt: now,
        desired: "running",
        launch: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      }),
    );

    const missing = await invoke("/api/apps/missing", config, "DELETE");
    expect(missing.status).toBe(404);

    const bundle = path.join(appsDir, ".bundles", "site");
    fs.mkdirSync(bundle, { recursive: true });
    fs.writeFileSync(path.join(bundle, "server.js"), "");

    const removed = await invoke("/api/apps/site", config, "DELETE");
    expect(removed.status).toBe(200);
    expect(JSON.parse(removed.body)).toMatchObject({ name: "site", kind: "dynamic" });
    expect(fs.existsSync(path.join(appsDir, ".catalog", "site.json"))).toBe(false);
    expect(fs.existsSync(bundle)).toBe(false);
    expect(fs.existsSync(site)).toBe(false);
  });
});

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

function baseUrl(server: http.Server): string {
  const addr = server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}
