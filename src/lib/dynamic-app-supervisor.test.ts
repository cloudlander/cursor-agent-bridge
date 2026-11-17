import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readCatalogEntry } from "./app-catalog.js";
import {
  deleteDynamicApp,
  restartDynamicApp,
  startDynamicAppSupervisor,
  stopDynamicApp,
  stopDynamicAppSupervisor,
} from "./dynamic-app-supervisor.js";

const SCRIPT = `
import http from "node:http";
import fs from "node:fs";
const name = process.argv[2];
const portFile = process.argv[3];
const catalogFile = process.argv[4];
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/__bridge/catalog-health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, name }));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const entry = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
  entry.port = port;
  entry.pid = process.pid;
  entry.heartbeatAt = new Date().toISOString();
  fs.writeFileSync(catalogFile, JSON.stringify(entry));
  fs.writeFileSync(portFile, String(port));
});
`;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitFor(file: string, timeoutMs: number): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const text = fs.readFileSync(file, "utf8").trim();
      if (text) return text;
    } catch {
      /* not written yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${file}`);
}

describe("dynamic-app-supervisor", () => {
  let tmp: string;

  afterEach(() => {
    stopDynamicAppSupervisor({ kill: true });
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("starts a registered dynamic app, relaunches it, keeps a stop, and deregisters it", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dyn-supervisor-"));
    const appsDir = path.join(tmp, "apps");
    const catalogDir = path.join(appsDir, ".catalog");
    fs.mkdirSync(catalogDir, { recursive: true });
    const script = path.join(tmp, "app.mjs");
    const portFile = path.join(tmp, "port");
    const catalogFile = path.join(catalogDir, "dyn.json");
    fs.writeFileSync(script, SCRIPT);
    const now = new Date().toISOString();
    fs.writeFileSync(
      catalogFile,
      JSON.stringify({
        name: "dyn",
        port: 9,
        ttlMs: 60_000,
        registeredAt: now,
        heartbeatAt: now,
        desired: "running",
        launch: {
          command: process.execPath,
          args: [script, "dyn", portFile, catalogFile],
          cwd: tmp,
        },
      }),
    );

    startDynamicAppSupervisor(appsDir, { intervalMs: 200, startupGraceMs: 1_500 });
    const port = Number(await waitFor(portFile, 8_000));
    expect(port).toBeGreaterThan(0);
    const started = readCatalogEntry(appsDir, "dyn");
    expect(started?.port).toBe(port);
    expect(started?.pid && pidAlive(started.pid)).toBe(true);
    const pid = started?.pid ?? 0;

    const health = await fetch(`http://127.0.0.1:${port}/__bridge/catalog-health`);
    expect(await health.json()).toMatchObject({ ok: true, name: "dyn" });

    fs.rmSync(portFile, { force: true });
    process.kill(pid, "SIGKILL");
    const relaunchedPort = Number(await waitFor(portFile, 10_000));
    expect(relaunchedPort).toBeGreaterThan(0);
    const kept = readCatalogEntry(appsDir, "dyn");
    expect(kept?.pid && kept.pid !== pid && pidAlive(kept.pid)).toBe(true);
    const keptPid = kept?.pid ?? 0;

    const stopped = await stopDynamicApp(appsDir, "dyn");
    expect(stopped).toMatchObject({ ok: true, desired: "stopped" });
    const deadline = Date.now() + 3_000;
    while (pidAlive(keptPid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(pidAlive(keptPid)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(readCatalogEntry(appsDir, "dyn")?.desired).toBe("stopped");
    expect(pidAlive(pid)).toBe(false);

    const restarted = await restartDynamicApp(appsDir, "dyn");
    expect(restarted).toMatchObject({ ok: true, desired: "running" });
    fs.rmSync(portFile, { force: true });
    const again = Number(await waitFor(portFile, 8_000));
    expect(again).toBeGreaterThan(0);
    const next = readCatalogEntry(appsDir, "dyn");
    expect(next?.pid && next.pid !== keptPid && pidAlive(next.pid)).toBe(true);

    const removed = await deleteDynamicApp(appsDir, "dyn");
    expect(removed.ok).toBe(true);
    expect(readCatalogEntry(appsDir, "dyn")).toBeNull();
    if (next?.pid) {
      const end = Date.now() + 3_000;
      while (pidAlive(next.pid) && Date.now() < end) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(pidAlive(next.pid)).toBe(false);
    }
  }, 30_000);

  it("refuses Stop without a launch command and lets Restart clear a stale Stop", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dyn-supervisor-"));
    const appsDir = path.join(tmp, "apps");
    const catalogDir = path.join(appsDir, ".catalog");
    fs.mkdirSync(catalogDir, { recursive: true });
    const catalogFile = path.join(catalogDir, "plain.json");
    const now = new Date().toISOString();
    const entry = { name: "plain", port: 9, ttlMs: 60_000, registeredAt: now, heartbeatAt: now };
    fs.writeFileSync(catalogFile, JSON.stringify({ ...entry, desired: "running" }));

    expect(await stopDynamicApp(appsDir, "plain")).toMatchObject({ ok: false, status: 400 });
    expect(await restartDynamicApp(appsDir, "plain")).toMatchObject({ ok: false, status: 400 });

    fs.writeFileSync(catalogFile, JSON.stringify({ ...entry, desired: "stopped" }));
    expect(await restartDynamicApp(appsDir, "plain")).toMatchObject({ ok: true, desired: "running" });
    expect(readCatalogEntry(appsDir, "plain")?.desired).toBe("running");
  });
});
