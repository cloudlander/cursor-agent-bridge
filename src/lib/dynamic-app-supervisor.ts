import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import {
  catalogDir,
  catalogEntryPath,
  isCatalogAppName,
  listCatalogEntries,
  probeCatalogHealth,
  readCatalogEntry,
  writeCatalogEntry,
  type AppLaunchSpec,
  type CatalogEntry,
} from "./app-catalog.js";
import { json } from "./http.js";

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_STARTUP_GRACE_MS = 8_000;
const MAX_BACKOFF_MS = 60_000;

export type DynamicAppControlResult =
  | { ok: true; name: string; desired: "running" | "stopped" }
  | { ok: false; status: number; error: string };

type Slot = {
  child?: ChildProcess;
  pid?: number;
  failures: number;
  holdUntil: number;
};

export type SupervisorOptions = {
  intervalMs?: number;
  startupGraceMs?: number;
};

const slots = new Map<string, Slot>();
const tails = new Map<string, Promise<void>>();
let timer: ReturnType<typeof setInterval> | undefined;
let appsDirActive: string | undefined;
let ticking = false;
let startupGraceMs = DEFAULT_STARTUP_GRACE_MS;

function slotFor(name: string): Slot {
  let slot = slots.get(name);
  if (!slot) {
    slot = { failures: 0, holdUntil: 0 };
    slots.set(name, slot);
  }
  return slot;
}

function withAppLock(name: string, fn: () => Promise<void>): Promise<void> {
  const prev = tails.get(name) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  tails.set(
    name,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

function pidAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function pidLooksLikeLaunch(pid: number, launch: AppLaunchSpec | undefined): boolean {
  if (!launch) return true;
  let raw: string;
  try {
    raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return false;
    return true;
  }
  const parts = raw.split("\0").filter(Boolean);
  if (parts.length === 0) return false;
  if (launch.args.length > 0) return launch.args.every((arg) => parts.includes(arg));
  const base = path.basename(launch.command);
  const argv0 = parts[0] ?? "";
  return argv0 === launch.command || argv0 === base || argv0.endsWith(`/${base}`);
}

function signalPid(pid: number | undefined): void {
  if (!pid || !Number.isInteger(pid) || pid <= 1) return;
  try {
    process.kill(-pid, "SIGTERM");
    return;
  } catch {
    /* not a process group */
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already exited */
  }
}

function killSlot(slot: Slot, launch: AppLaunchSpec | undefined): void {
  const pid = slot.pid;
  if (pid && pidLooksLikeLaunch(pid, launch)) signalPid(pid);
  slot.child = undefined;
  slot.pid = undefined;
}

function knownPid(slot: Slot, entry: CatalogEntry): number | undefined {
  if (slot.pid && pidAlive(slot.pid)) return slot.pid;
  if (entry.pid && pidAlive(entry.pid) && pidLooksLikeLaunch(entry.pid, entry.launch)) {
    return entry.pid;
  }
  return undefined;
}

function backoffMs(failures: number): number {
  const base = 2_000;
  return Math.min(MAX_BACKOFF_MS, base * 2 ** Math.min(Math.max(failures, 0), 5));
}

function spawnLaunch(appsDir: string, entry: CatalogEntry): void {
  const launch = entry.launch;
  if (!launch) return;
  const slot = slotFor(entry.name);
  const logPath = path.join(catalogDir(appsDir), `${entry.name}.log`);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = fs.openSync(logPath, "a");
  let child: ChildProcess;
  try {
    child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: process.env,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
  } catch (err) {
    fs.closeSync(logFd);
    slot.failures += 1;
    slot.holdUntil = Date.now() + backoffMs(slot.failures);
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[dynamic-apps] start ${entry.name} failed: ${message}`);
    return;
  }
  fs.closeSync(logFd);
  child.unref();
  slot.child = child;
  slot.pid = child.pid;
  slot.holdUntil = Date.now() + startupGraceMs;
  child.once("exit", (code) => {
    if (slot.child === child) {
      slot.child = undefined;
      slot.pid = undefined;
      slot.failures += 1;
      slot.holdUntil = Date.now() + backoffMs(slot.failures);
    }
    console.error(`[dynamic-apps] ${entry.name} exited (${code ?? "signal"})`);
  });
  child.once("error", (err) => {
    console.error(`[dynamic-apps] ${entry.name} spawn error: ${err.message}`);
  });
  console.error(
    `[dynamic-apps] starting ${entry.name} pid=${child.pid ?? "?"} ${launch.command} ${launch.args.join(" ")}`,
  );
}

async function ensureStopped(appsDir: string, entry: CatalogEntry): Promise<void> {
  const current = readCatalogEntry(appsDir, entry.name);
  if (!current || current.desired !== "stopped" || !current.launch) return;
  const slot = slotFor(current.name);
  const pid = knownPid(slot, current);
  if (!pid) return;
  signalPid(pid);
  if (slot.pid === pid) {
    slot.child = undefined;
    slot.pid = undefined;
  }
}

async function ensureRunning(appsDir: string, entry: CatalogEntry): Promise<void> {
  if (!entry.launch || entry.desired === "stopped") return;
  const slot = slotFor(entry.name);
  if (Date.now() < slot.holdUntil) return;
  const current = readCatalogEntry(appsDir, entry.name) ?? entry;
  if (current.desired === "stopped" || !current.launch) return;
  const healthy = await probeCatalogHealth(current.port, current.name);
  if (healthy) {
    slot.failures = 0;
    return;
  }
  const pid = knownPid(slot, current);
  if (pid) signalPid(pid);
  slot.child = undefined;
  slot.pid = undefined;
  spawnLaunch(appsDir, current);
}

async function tick(): Promise<void> {
  const appsDir = appsDirActive;
  if (!appsDir || ticking) return;
  ticking = true;
  try {
    for (const entry of listCatalogEntries(appsDir)) {
      if (entry.desired === "stopped") {
        await withAppLock(entry.name, () => ensureStopped(appsDir, entry));
        continue;
      }
      if (!entry.launch) continue;
      await withAppLock(entry.name, () => ensureRunning(appsDir, entry));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[dynamic-apps] supervisor: ${message}`);
  } finally {
    ticking = false;
  }
}

export function startDynamicAppSupervisor(appsDir: string, opts: SupervisorOptions = {}): void {
  appsDirActive = appsDir;
  startupGraceMs = opts.startupGraceMs ?? DEFAULT_STARTUP_GRACE_MS;
  if (timer) clearInterval(timer);
  void tick();
  const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  timer = setInterval(() => {
    void tick();
  }, interval);
  timer.unref?.();
  console.error(`[dynamic-apps] supervisor watching ${appsDir}`);
}

export function stopDynamicAppSupervisor(opts: { kill?: boolean } = {}): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  appsDirActive = undefined;
  if (!opts.kill) return;
  for (const slot of slots.values()) signalPid(slot.pid);
  slots.clear();
}

export async function stopDynamicApp(
  appsDir: string,
  name: string,
): Promise<DynamicAppControlResult> {
  if (!isCatalogAppName(name)) return { ok: false, status: 400, error: "invalid app name" };
  const entry = readCatalogEntry(appsDir, name);
  if (!entry) return { ok: false, status: 404, error: "not registered" };
  if (!entry.launch) {
    return { ok: false, status: 400, error: "dynamic app has no launch command; it cannot be stopped here" };
  }
  let result: DynamicAppControlResult = { ok: true, name, desired: "stopped" };
  await withAppLock(name, async () => {
    const current = readCatalogEntry(appsDir, name);
    if (!current) {
      result = { ok: false, status: 404, error: "not registered" };
      return;
    }
    if (!current.launch) {
      result = { ok: false, status: 400, error: "dynamic app has no launch command; it cannot be stopped here" };
      return;
    }
    current.desired = "stopped";
    writeCatalogEntry(appsDir, current);
    const slot = slotFor(name);
    const pid = knownPid(slot, current);
    if (pid) signalPid(pid);
    slot.child = undefined;
    slot.pid = undefined;
    slot.holdUntil = Date.now() + 60_000;
    console.error(`[dynamic-apps] stopped ${name}`);
  });
  return result;
}

export async function restartDynamicApp(
  appsDir: string,
  name: string,
): Promise<DynamicAppControlResult> {
  if (!isCatalogAppName(name)) return { ok: false, status: 400, error: "invalid app name" };
  const entry = readCatalogEntry(appsDir, name);
  if (!entry) return { ok: false, status: 404, error: "not registered" };
  if (!entry.launch && entry.desired !== "stopped") {
    return { ok: false, status: 400, error: "dynamic app has no launch command" };
  }
  let result: DynamicAppControlResult = { ok: true, name, desired: "running" };
  await withAppLock(name, async () => {
    const current = readCatalogEntry(appsDir, name);
    if (!current) {
      result = { ok: false, status: 404, error: "not registered" };
      return;
    }
    if (!current.launch && current.desired !== "stopped") {
      result = { ok: false, status: 400, error: "dynamic app has no launch command" };
      return;
    }
    current.desired = "running";
    writeCatalogEntry(appsDir, current);
    if (!current.launch) return; // only clears a stale Stop; the app re-registers itself
    const slot = slotFor(name);
    const pid = knownPid(slot, current);
    if (pid) signalPid(pid);
    slot.child = undefined;
    slot.pid = undefined;
    slot.failures = 0;
    slot.holdUntil = 0;
    spawnLaunch(appsDir, current);
  });
  return result;
}

export async function deleteDynamicApp(
  appsDir: string,
  name: string,
): Promise<DynamicAppControlResult> {
  if (!isCatalogAppName(name)) return { ok: false, status: 400, error: "invalid app name" };
  await withAppLock(name, async () => {
    const entry = readCatalogEntry(appsDir, name);
    const slot = slots.get(name);
    const pid = entry ? knownPid(slot ?? { failures: 0, holdUntil: 0 }, entry) : slot?.pid;
    if (pid && (!entry?.launch || pidLooksLikeLaunch(pid, entry.launch))) signalPid(pid);
    slots.delete(name);
    try {
      fs.unlinkSync(catalogEntryPath(appsDir, name));
    } catch {
      /* already absent */
    }
    console.error(`[dynamic-apps] deregistered ${name}`);
  });
  return { ok: true, name, desired: "stopped" };
}

export function handleDynamicAppControl(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  appsDir: string,
  match: { op: "stop" | "restart" | "delete"; name: string },
): void {
  void (async () => {
    try {
      const result =
        match.op === "stop"
          ? await stopDynamicApp(appsDir, match.name)
          : match.op === "restart"
            ? await restartDynamicApp(appsDir, match.name)
            : await deleteDynamicApp(appsDir, match.name);
      if (res.headersSent) return;
      if (!result.ok) {
        json(res, result.status, { error: result.error });
        return;
      }
      json(res, 200, { ok: true, name: result.name, desired: result.desired });
    } catch (err) {
      if (res.headersSent) return;
      const message = err instanceof Error ? err.message : String(err);
      json(res, 500, { error: message });
    }
  })();
}
