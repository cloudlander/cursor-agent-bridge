import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BridgeConfig } from "./config.js";
import {
  appsDirOf,
  deployAppFromSource,
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
});
