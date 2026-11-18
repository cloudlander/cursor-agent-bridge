import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readCatalogEntry, writeCatalogEntry } from "./app-catalog.js";
import { bundleDir, exportAppZip, importAppZip } from "./app-bundle.js";
import {
  startDynamicAppSupervisor,
  stopDynamicApp,
  stopDynamicAppSupervisor,
} from "./dynamic-app-supervisor.js";
import { unzipFiles, zipFiles } from "./zip-store.js";

const LIMITS = {
  maxFiles: 100,
  maxFileBytes: 1024 * 1024,
  maxUncompressed: 8 * 1024 * 1024,
};

describe("app bundles", () => {
  const dirs: string[] = [];
  let dynamicName: string | undefined;
  let dynamicApps: string | undefined;

  afterEach(async () => {
    stopDynamicAppSupervisor({ kill: true });
    if (dynamicApps && dynamicName) {
      await stopDynamicApp(dynamicApps, dynamicName);
    }
    dynamicName = undefined;
    dynamicApps = undefined;
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips zip bytes and unicode names", () => {
    const zip = zipFiles([
      { name: "payload/说明.txt", data: Buffer.from("hello hello hello hello"), mode: 0o755 },
    ]);
    const files = unzipFiles(zip, LIMITS);
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe("payload/说明.txt");
    expect(files[0]?.data.toString("utf8")).toBe("hello hello hello hello");
    expect(files[0]?.mode).toBe(0o755);
  });

  it("imports a dynamic app from a package inside a git checkout and registers it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "app-bundle-"));
    dirs.push(root);
    const repo = path.join(root, "repo");
    const pkg = path.join(repo, "pkg");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repo, "SECRET.txt"), "do-not-export");
    fs.writeFileSync(path.join(repo, "package.json"), '{"name":"repo"}\n');
    fs.mkdirSync(pkg);
    fs.writeFileSync(path.join(pkg, "package.json"), '{"name":"pkg"}\n');
    fs.writeFileSync(path.join(pkg, "server.cjs"), "process.exit(0);\n");

    const src = path.join(root, "src-apps");
    const dst = path.join(root, "dst-apps");
    const now = new Date().toISOString();
    writeCatalogEntry(src, {
      name: "dyn",
      port: 8796,
      title: "Dyn",
      description: "portable",
      ttlMs: 45_000,
      registeredAt: now,
      heartbeatAt: now,
      desired: "stopped",
      launch: {
        command: process.execPath,
        args: [path.join(pkg, "server.cjs")],
        cwd: repo,
      },
    });

    const exported = exportAppZip(src, "dyn");
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const names = unzipFiles(exported.zip, LIMITS).map((file) => file.name);
    expect(names).toContain("payload/server.cjs");
    expect(names).toContain("payload/package.json");
    expect(names.some((name) => name.includes("SECRET"))).toBe(false);
    expect(names.some((name) => name.includes("repo"))).toBe(false);

    dynamicApps = dst;
    dynamicName = "dyn";
    const imported = await importAppZip(dst, exported.zip);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported).toMatchObject({ name: "dyn", kind: "dynamic", started: false });

    const installed = path.join(bundleDir(dst, "dyn"), "server.cjs");
    expect(fs.readFileSync(installed, "utf8")).toContain("process.exit");
    const entry = readCatalogEntry(dst, "dyn");
    expect(entry?.desired).toBe("running");
    expect(Date.parse(entry?.heartbeatAt ?? "")).toBeGreaterThan(Date.now() - 60_000);
    expect(entry?.port).toBe(8796);
    expect(entry?.title).toBe("Dyn");
    expect(entry?.launch?.command).toBe(process.execPath);
    expect(entry?.launch?.args).toEqual([installed]);
    expect(entry?.launch?.cwd).toBe(bundleDir(dst, "dyn"));
    expect(fs.existsSync(path.join(dst, ".catalog", "dyn.log"))).toBe(false);
  });

  it("classifies a bundle by its launch command", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "app-bundle-kind-"));
    dirs.push(root);
    const apps = path.join(root, "apps");

    const staticZip = zipFiles([
      {
        name: "manifest.json",
        data: Buffer.from(
          JSON.stringify({
            format: "cursor-bridge-app",
            version: 1,
            name: "site",
          }),
        ),
      },
      { name: "payload/index.html", data: Buffer.from("<h1>ok</h1>") },
    ]);
    const importedStatic = await importAppZip(apps, staticZip);
    expect(importedStatic).toMatchObject({ ok: true, name: "site", kind: "static", started: false });
    expect(fs.readFileSync(path.join(apps, "site", "index.html"), "utf8")).toContain("ok");

    const dynamicZip = zipFiles([
      {
        name: "manifest.json",
        data: Buffer.from(
          JSON.stringify({
            format: "cursor-bridge-app",
            version: 1,
            name: "dyn",
            port: 8797,
            launch: { runtime: "node", args: ["server.cjs"], cwd: "." },
          }),
        ),
      },
      { name: "payload/server.cjs", data: Buffer.from("process.exit(0);\n") },
    ]);
    dynamicApps = apps;
    dynamicName = "dyn";
    const importedDynamic = await importAppZip(apps, dynamicZip);
    expect(importedDynamic).toMatchObject({ ok: true, name: "dyn", kind: "dynamic", started: false });
    const entry = readCatalogEntry(apps, "dyn");
    expect(entry?.launch?.command).toBe(process.execPath);
    expect(entry?.launch?.args).toEqual([path.join(bundleDir(apps, "dyn"), "server.cjs")]);

    const staticWithLaunch = zipFiles([
      {
        name: "manifest.json",
        data: Buffer.from(
          JSON.stringify({
            format: "cursor-bridge-app",
            version: 1,
            name: "site",
            kind: "static",
            launch: { command: "node", args: [], cwd: "." },
          }),
        ),
      },
      { name: "payload/index.html", data: Buffer.from("<h1>no</h1>") },
    ]);
    const rejectedStatic = await importAppZip(apps, staticWithLaunch);
    expect(rejectedStatic).toMatchObject({
      ok: false,
      error: "static app must not include a launch command",
    });

    const dynamicWithoutLaunch = zipFiles([
      {
        name: "manifest.json",
        data: Buffer.from(
          JSON.stringify({
            format: "cursor-bridge-app",
            version: 1,
            name: "bare",
            kind: "dynamic",
            port: 9,
          }),
        ),
      },
      { name: "payload/index.html", data: Buffer.from("<h1>no</h1>") },
    ]);
    const rejectedDynamic = await importAppZip(apps, dynamicWithoutLaunch);
    expect(rejectedDynamic).toMatchObject({
      ok: false,
      error: "dynamic app must include a launch command",
    });
  });

  it("rejects a zip that escapes the bundle directory", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "app-bundle-slip-"));
    dirs.push(root);
    const apps = path.join(root, "apps");
    const outside = path.join(root, "outside.txt");
    const zip = zipFiles([
      {
        name: "manifest.json",
        data: Buffer.from(
          JSON.stringify({
            format: "cursor-bridge-app",
            version: 1,
            name: "site",
            kind: "static",
          }),
        ),
      },
      { name: "payload/index.html", data: Buffer.from("<h1>ok</h1>") },
      { name: "payload/../../outside.txt", data: Buffer.from("nope") },
    ]);
    const imported = await importAppZip(apps, zip);
    expect(imported.ok).toBe(false);
    expect(fs.existsSync(outside)).toBe(false);
    expect(fs.existsSync(path.join(apps, "site", "index.html"))).toBe(false);
  });

  it("refuses to export a dynamic app whose only directory is a git checkout", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "app-bundle-git-"));
    dirs.push(root);
    const repo = path.join(root, "repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repo, "package.json"), "{}\n");
    fs.writeFileSync(path.join(repo, "server.cjs"), "process.exit(0);\n");
    const apps = path.join(root, "apps");
    const now = new Date().toISOString();
    writeCatalogEntry(apps, {
      name: "wide",
      port: 9,
      ttlMs: 45_000,
      registeredAt: now,
      heartbeatAt: now,
      desired: "running",
      launch: {
        command: process.execPath,
        args: [path.join(repo, "server.cjs")],
        cwd: repo,
      },
    });
    const exported = exportAppZip(apps, "wide");
    expect(exported.ok).toBe(false);
    if (exported.ok) return;
    expect(exported.error).toContain("too broad");
  });

  it("exports an app with no launch command as a static bundle", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "app-bundle-static-"));
    dirs.push(root);
    const apps = path.join(root, "apps");
    const site = path.join(apps, "site");
    fs.mkdirSync(site, { recursive: true });
    fs.writeFileSync(path.join(site, "index.html"), "<h1>static</h1>");
    const now = new Date().toISOString();
    writeCatalogEntry(apps, {
      name: "site",
      port: 9,
      title: "Site",
      ttlMs: 45_000,
      registeredAt: now,
      heartbeatAt: now,
      desired: "running",
    });
    const exported = exportAppZip(apps, "site");
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const files = unzipFiles(exported.zip, LIMITS);
    const manifest = JSON.parse(
      files.find((file) => file.name === "manifest.json")?.data.toString("utf8") ?? "{}",
    ) as { kind?: string; launch?: unknown; title?: string };
    expect(manifest.kind).toBe("static");
    expect(manifest.launch).toBeUndefined();
    expect(manifest.title).toBe("Site");
    expect(files.some((file) => file.name === "payload/index.html")).toBe(true);

    writeCatalogEntry(apps, {
      name: "bare",
      port: 9,
      ttlMs: 45_000,
      registeredAt: now,
      heartbeatAt: now,
      desired: "running",
    });
    const missing = exportAppZip(apps, "bare");
    expect(missing).toMatchObject({ ok: false, error: "static app has no files to export" });
  });

  it("registers a dynamic bundle and the supervisor starts it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "app-bundle-kick-"));
    dirs.push(root);
    const apps = path.join(root, "apps");
    const zip = zipFiles([
      {
        name: "manifest.json",
        data: Buffer.from(
          JSON.stringify({
            format: "cursor-bridge-app",
            version: 1,
            name: "dyn",
            port: 8798,
            launch: { runtime: "node", args: ["server.cjs"], cwd: "." },
          }),
        ),
      },
      { name: "payload/server.cjs", data: Buffer.from("process.exit(0);\n") },
    ]);
    dynamicApps = apps;
    dynamicName = "dyn";
    startDynamicAppSupervisor(apps, { intervalMs: 60_000, startupGraceMs: 2_000 });
    const imported = await importAppZip(apps, zip);
    expect(imported).toMatchObject({ ok: true, kind: "dynamic", started: false });
    const log = path.join(apps, ".catalog", "dyn.log");
    const start = Date.now();
    while (!fs.existsSync(log) && Date.now() - start < 3_000) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    expect(fs.existsSync(log)).toBe(true);
    const entry = readCatalogEntry(apps, "dyn");
    expect(entry?.desired).toBe("running");
    expect(entry?.launch?.command).toBe(process.execPath);
  });
});
