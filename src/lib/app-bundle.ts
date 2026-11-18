import * as fs from "node:fs";
import * as path from "node:path";

import {
  isCatalogAppName,
  parseLaunchSpec,
  readCatalogEntry,
  writeCatalogEntry,
  type AppLaunchSpec,
  type CatalogEntry,
} from "./app-catalog.js";
import { deleteDynamicApp, kickDynamicAppSupervisor } from "./dynamic-app-supervisor.js";
import { ZipError, unzipFiles, zipFiles, type ZipFile } from "./zip-store.js";

/**
 * Standard app package (`cursor-bridge-app` v1), for static and dynamic apps:
 *   manifest.json
 *   payload/<files>
 * A bundle with no `launch` is static. Deploy copies `payload/` with the same
 * folder copy as `POST /api/apps/deploy` `{ name, sourceDir }`.
 * A bundle with `launch` is dynamic: it extracts to `<appsDir>/.bundles/<name>/`
 * and is registered in the catalog. The supervisor starts it. `kind` may be
 * omitted; when present it must match (static iff there is no launch). A Node binary path is
 * recorded as `runtime: "node"` and becomes `process.execPath` on the destination
 * host. Git checkouts, the home directory, and any directory that contains the
 * apps store are refused as a dynamic bundle root.
 */
export const APP_BUNDLE_FORMAT = "cursor-bridge-app";
export const APP_BUNDLE_VERSION = 1;

export const MAX_APP_ZIP_BYTES = 128 * 1024 * 1024;
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_UNCOMPRESSED = 256 * 1024 * 1024;

const LIMITS = {
  maxFiles: MAX_FILES,
  maxFileBytes: MAX_FILE_BYTES,
  maxUncompressed: MAX_UNCOMPRESSED,
};

type BundleLaunch = {
  runtime?: "node";
  command?: string;
  args: string[];
  cwd: string;
};

type BundleManifest = {
  format: typeof APP_BUNDLE_FORMAT;
  version: typeof APP_BUNDLE_VERSION;
  name: string;
  kind: "static" | "dynamic";
  title?: string;
  description?: string;
  port?: number;
  ttlMs?: number;
  launch?: BundleLaunch;
};

export type AppBundleFailure = { ok: false; status: number; error: string };

export type ExportAppResult = AppBundleFailure | { ok: true; name: string; zip: Buffer };

export type ImportAppResult =
  | AppBundleFailure
  | {
      ok: true;
      name: string;
      kind: "static" | "dynamic";
      url: string;
      shortUrl: string;
      started: boolean;
    };

export function bundleDir(appsDir: string, name: string): string {
  return path.join(appsDir, ".bundles", name);
}

function isInside(root: string, target: string): boolean {
  const base = path.resolve(root);
  const abs = path.resolve(target);
  return abs === base || abs.startsWith(base + path.sep);
}

function containsDir(root: string, name: string): boolean {
  try {
    return fs.statSync(path.join(root, name)).isDirectory();
  } catch {
    return false;
  }
}

function isUnsafeBundleRoot(root: string, appsDir: string): boolean {
  const resolved = path.resolve(root);
  if (containsDir(resolved, ".git") || containsDir(resolved, ".cai")) return true;
  const home = process.env.HOME?.trim();
  if (home && path.resolve(home) === resolved) return true;
  const apps = path.resolve(appsDir);
  return resolved === apps || apps.startsWith(resolved + path.sep);
}

function isNodeBinary(command: string): boolean {
  const base = path.basename(command).toLowerCase();
  return base === "node" || base === "node.exe" || base === "nodejs";
}

function existingFile(value: string | undefined): string | undefined {
  if (!value || !path.isAbsolute(value)) return undefined;
  const abs = path.resolve(value);
  if (isNodeBinary(abs)) return undefined;
  try {
    if (fs.statSync(abs).isFile()) return abs;
  } catch {
    return undefined;
  }
  return undefined;
}

function referencedFiles(launch: AppLaunchSpec): string[] {
  const files: string[] = [];
  const command = existingFile(launch.command);
  if (command) files.push(command);
  for (const arg of launch.args) {
    const file = existingFile(arg);
    if (file) files.push(file);
  }
  return files;
}

function nearestPackageDir(scriptFile: string, limitDir: string | undefined): string | undefined {
  let dir = path.dirname(path.resolve(scriptFile));
  const limit = limitDir ? path.resolve(limitDir) : undefined;
  for (;;) {
    const pkg = path.join(dir, "package.json");
    try {
      if (fs.statSync(pkg).isFile()) return dir;
    } catch {
      /* keep walking */
    }
    if (limit && (dir === limit || !isInside(limit, dir))) return undefined;
    if (!limit && containsDir(dir, ".git")) return undefined;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function existingDir(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const abs = path.resolve(value);
  try {
    if (fs.statSync(abs).isDirectory()) return abs;
  } catch {
    return undefined;
  }
  return undefined;
}

function chooseBundleRoot(
  launch: AppLaunchSpec,
  appsDir: string,
): { ok: true; root: string } | AppBundleFailure {
  const cwd = existingDir(launch.cwd);
  const files = referencedFiles(launch);
  const script = files[0];
  const candidates: string[] = [];
  if (script) {
    const pkg = nearestPackageDir(script, cwd);
    if (pkg) candidates.push(pkg);
    candidates.push(path.dirname(script));
  }
  if (cwd) candidates.push(cwd);

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const root = path.resolve(candidate);
    if (seen.has(root)) continue;
    seen.add(root);
    if (isUnsafeBundleRoot(root, appsDir)) continue;
    if (files.some((file) => !isInside(root, file))) continue;
    return { ok: true, root };
  }
  return {
    ok: false,
    status: 400,
    error:
      "app directory is too broad to export; the launch working directory must be the app itself, not the home directory or a git checkout",
  };
}

type Walked = { rel: string; data: Buffer; mode: number };

function classify(
  abs: string,
  root: string,
): { kind: "file" | "dir" | "skip"; mode: number; size: number } {
  let lst: fs.Stats;
  try {
    lst = fs.lstatSync(abs);
  } catch {
    return { kind: "skip", mode: 0, size: 0 };
  }
  if (lst.isSymbolicLink()) {
    let real: string;
    try {
      real = fs.realpathSync(abs);
    } catch {
      return { kind: "skip", mode: 0, size: 0 };
    }
    if (!isInside(root, real)) return { kind: "skip", mode: 0, size: 0 };
    let st: fs.Stats;
    try {
      st = fs.statSync(real);
    } catch {
      return { kind: "skip", mode: 0, size: 0 };
    }
    if (st.isDirectory()) return { kind: "dir", mode: st.mode, size: 0 };
    if (st.isFile()) return { kind: "file", mode: st.mode, size: st.size };
    return { kind: "skip", mode: 0, size: 0 };
  }
  if (lst.isDirectory()) return { kind: "dir", mode: lst.mode, size: 0 };
  if (lst.isFile()) return { kind: "file", mode: lst.mode, size: lst.size };
  return { kind: "skip", mode: 0, size: 0 };
}

function readTree(root: string): { ok: true; files: Walked[] } | AppBundleFailure {
  const files: Walked[] = [];
  let total = 0;
  const seen = new Set<string>();
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let real: string;
    try {
      real = fs.realpathSync(dir);
    } catch {
      return { ok: false, status: 400, error: "app directory is not readable" };
    }
    if (seen.has(real)) continue;
    seen.add(real);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return { ok: false, status: 400, error: "app directory is not readable" };
    }
    for (const ent of entries) {
      if (ent.name === ".git" || ent.name === ".cai") continue;
      const abs = path.join(dir, ent.name);
      const info = classify(abs, root);
      if (info.kind === "skip") continue;
      if (info.kind === "dir") {
        stack.push(abs);
        continue;
      }
      if (info.size > MAX_FILE_BYTES) {
        return { ok: false, status: 400, error: "app is too large to export" };
      }
      total += info.size;
      if (total > MAX_UNCOMPRESSED || files.length >= MAX_FILES) {
        return { ok: false, status: 400, error: "app is too large to export" };
      }
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (!rel || rel.split("/").includes("..")) {
        return { ok: false, status: 400, error: "app path is not portable" };
      }
      files.push({
        rel,
        data: fs.readFileSync(abs),
        mode: info.mode & 0o777,
      });
    }
  }
  if (files.length === 0) {
    return { ok: false, status: 400, error: "app directory is empty" };
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return { ok: true, files };
}

function relativePosix(root: string, target: string): string | null {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (!rel) return ".";
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

function safeRel(value: string): string | null {
  if (!value || path.isAbsolute(value)) return null;
  const parts = value.split(/[/\\]+/).filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) return null;
  return parts.join("/");
}

function clip(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

function clampTtl(ttlMs: number | undefined): number {
  if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs)) return 45_000;
  return Math.min(600_000, Math.max(5_000, Math.round(ttlMs)));
}

function rewriteLaunch(
  launch: AppLaunchSpec,
  root: string,
): { ok: true; launch: BundleLaunch } | AppBundleFailure {
  const cwdRel = launch.cwd ? relativePosix(root, launch.cwd) : ".";
  const cwd = cwdRel ?? ".";
  const args: string[] = [];
  for (const arg of launch.args) {
    if (!path.isAbsolute(arg)) {
      args.push(arg);
      continue;
    }
    const rel = relativePosix(root, arg);
    if (!rel || rel === ".") {
      return {
        ok: false,
        status: 400,
        error: "launch command references a file outside the app directory",
      };
    }
    args.push(rel);
  }

  const commandAbs = path.isAbsolute(launch.command) ? path.resolve(launch.command) : undefined;
  if (commandAbs && isInside(root, commandAbs)) {
    const command = relativePosix(root, commandAbs);
    if (!command || command === ".") {
      return { ok: false, status: 400, error: "launch command is not portable" };
    }
    return { ok: true, launch: { command, args, cwd } };
  }
  if (isNodeBinary(launch.command)) {
    return { ok: true, launch: { runtime: "node", args, cwd } };
  }
  if (!launch.command.includes("/") && !launch.command.includes("\\")) {
    return { ok: true, launch: { command: launch.command, args, cwd } };
  }
  return {
    ok: false,
    status: 400,
    error: "launch command is outside the app directory",
  };
}

function pack(manifest: BundleManifest, files: Walked[]): Buffer {
  const entries: ZipFile[] = [
    {
      name: "manifest.json",
      data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
      mode: 0o644,
    },
    ...files.map((file) => ({
      name: `payload/${file.rel}`,
      data: file.data,
      mode: file.mode || 0o644,
    })),
  ];
  return zipFiles(entries);
}

/** Folder copy used by static deploy (`POST /api/apps/deploy` and a static zip). */
export function copyStaticAppFiles(
  appsDir: string,
  name: string,
  sourceDir: string,
): { ok: true } | AppBundleFailure {
  if (!isCatalogAppName(name)) return { ok: false, status: 400, error: "invalid app name" };
  try {
    if (!fs.statSync(sourceDir).isDirectory()) {
      return { ok: false, status: 400, error: "source is not a directory" };
    }
  } catch {
    return { ok: false, status: 400, error: "source not found" };
  }
  try {
    if (!fs.statSync(path.join(sourceDir, "index.html")).isFile()) {
      return { ok: false, status: 400, error: "source must contain index.html" };
    }
  } catch {
    return { ok: false, status: 400, error: "source must contain index.html" };
  }
  fs.mkdirSync(appsDir, { recursive: true });
  fs.cpSync(sourceDir, path.join(appsDir, name), { recursive: true, force: true });
  return { ok: true };
}

function exportStatic(appsDir: string, name: string, entry: CatalogEntry | undefined): ExportAppResult {
  const appRoot = path.join(appsDir, name);
  let index = false;
  try {
    index = fs.statSync(path.join(appRoot, "index.html")).isFile();
  } catch {
    index = false;
  }
  if (!index) {
    return {
      ok: false,
      status: entry ? 400 : 404,
      error: entry ? "static app has no files to export" : "app not found",
    };
  }
  const tree = readTree(appRoot);
  if (!tree.ok) return tree;
  const manifest: BundleManifest = {
    format: APP_BUNDLE_FORMAT,
    version: APP_BUNDLE_VERSION,
    name,
    kind: "static",
    title: entry?.title,
    description: entry?.description,
  };
  return { ok: true, name, zip: pack(manifest, tree.files) };
}

export function exportAppZip(appsDir: string, name: string): ExportAppResult {
  if (!isCatalogAppName(name)) return { ok: false, status: 400, error: "invalid app name" };
  const entry = readCatalogEntry(appsDir, name);
  if (entry?.launch) return exportDynamic(appsDir, entry);
  return exportStatic(appsDir, name, entry ?? undefined);
}

function exportDynamic(appsDir: string, entry: CatalogEntry): ExportAppResult {
  if (!entry.launch) return exportStatic(appsDir, entry.name, entry);
  const root = chooseBundleRoot(entry.launch, appsDir);
  if (!root.ok) return root;
  const launch = rewriteLaunch(entry.launch, root.root);
  if (!launch.ok) return launch;
  const tree = readTree(root.root);
  if (!tree.ok) return tree;
  const manifest: BundleManifest = {
    format: APP_BUNDLE_FORMAT,
    version: APP_BUNDLE_VERSION,
    name: entry.name,
    kind: "dynamic",
    title: entry.title,
    description: entry.description,
    port: entry.port,
    ttlMs: entry.ttlMs,
    launch: launch.launch,
  };
  return { ok: true, name: entry.name, zip: pack(manifest, tree.files) };
}

function zipEntryName(name: string): string | null {
  const norm = name.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!norm || norm.includes("\0")) return null;
  const parts = norm.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  return parts.join("/");
}

function parseManifest(raw: Buffer): BundleManifest | AppBundleFailure {
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    return { ok: false, status: 400, error: "manifest.json is not valid json" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, status: 400, error: "manifest.json is invalid" };
  }
  const row = value as Partial<BundleManifest>;
  if (row.format !== APP_BUNDLE_FORMAT || row.version !== APP_BUNDLE_VERSION) {
    return { ok: false, status: 400, error: "unsupported app bundle" };
  }
  if (typeof row.name !== "string" || !isCatalogAppName(row.name)) {
    return { ok: false, status: 400, error: "invalid app name" };
  }
  const hasLaunch = row.launch != null;
  if (row.kind !== undefined && row.kind !== "static" && row.kind !== "dynamic") {
    return { ok: false, status: 400, error: "manifest kind is invalid" };
  }
  const kind: "static" | "dynamic" =
    row.kind === "static" || row.kind === "dynamic" ? row.kind : hasLaunch ? "dynamic" : "static";
  if (kind === "static" && hasLaunch) {
    return { ok: false, status: 400, error: "static app must not include a launch command" };
  }
  if (kind === "dynamic" && !hasLaunch) {
    return { ok: false, status: 400, error: "dynamic app must include a launch command" };
  }
  const manifest: BundleManifest = {
    format: APP_BUNDLE_FORMAT,
    version: APP_BUNDLE_VERSION,
    name: row.name,
    kind,
    title: clip(row.title, 120),
    description: clip(row.description, 400),
  };
  if (kind === "static") return manifest;
  if (typeof row.port !== "number" || !Number.isInteger(row.port) || row.port < 1 || row.port > 65535) {
    return { ok: false, status: 400, error: "manifest port is invalid" };
  }
  manifest.port = row.port;
  manifest.ttlMs = clampTtl(row.ttlMs);
  const launch = parseBundleLaunch(row.launch);
  if (!launch.ok) return launch;
  manifest.launch = launch.launch;
  return manifest;
}

function parseBundleLaunch(value: unknown): { ok: true; launch: BundleLaunch } | AppBundleFailure {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, status: 400, error: "manifest launch is invalid" };
  }
  const row = value as Partial<BundleLaunch>;
  const cwd = row.cwd === undefined || row.cwd === "." ? "." : safeRel(String(row.cwd));
  if (!cwd) return { ok: false, status: 400, error: "manifest launch cwd is invalid" };
  if (!Array.isArray(row.args) || row.args.length > 40) {
    return { ok: false, status: 400, error: "manifest launch args are invalid" };
  }
  const args: string[] = [];
  for (const arg of row.args) {
    if (typeof arg !== "string" || arg.length > 1024 || arg.includes("\0")) {
      return { ok: false, status: 400, error: "manifest launch args are invalid" };
    }
    if (path.isAbsolute(arg) || arg.split(/[/\\]+/).includes("..")) {
      return { ok: false, status: 400, error: "manifest launch args are invalid" };
    }
    args.push(arg);
  }
  if (row.runtime !== undefined && row.runtime !== "node") {
    return { ok: false, status: 400, error: "manifest launch runtime is invalid" };
  }
  if (row.runtime === "node") return { ok: true, launch: { runtime: "node", args, cwd } };
  if (typeof row.command !== "string" || !row.command.trim()) {
    return { ok: false, status: 400, error: "manifest launch command is missing" };
  }
  const command = row.command.trim();
  if (command.includes("\0") || /[\r\n]/.test(command)) {
    return { ok: false, status: 400, error: "manifest launch command is invalid" };
  }
  if (command.includes("/") || command.includes("\\")) {
    const rel = safeRel(command);
    if (!rel) return { ok: false, status: 400, error: "manifest launch command is invalid" };
    return { ok: true, launch: { command: rel, args, cwd } };
  }
  if (!/^[A-Za-z0-9._+-]+$/.test(command)) {
    return { ok: false, status: 400, error: "manifest launch command is invalid" };
  }
  return { ok: true, launch: { command, args, cwd } };
}

function restoreLaunch(
  launch: BundleLaunch,
  root: string,
): { ok: true; launch: AppLaunchSpec } | AppBundleFailure {
  const cwd = launch.cwd === "." ? root : path.resolve(root, launch.cwd);
  if (!isInside(root, cwd)) {
    return { ok: false, status: 400, error: "manifest launch cwd is invalid" };
  }
  const args: string[] = [];
  for (const arg of launch.args) {
    if (!arg.includes("/") && !arg.includes("\\")) {
      const direct = path.resolve(root, arg);
      if (isInside(root, direct) && fs.existsSync(direct)) args.push(direct);
      else args.push(arg);
      continue;
    }
    const abs = path.resolve(root, arg);
    if (!isInside(root, abs)) {
      return { ok: false, status: 400, error: "manifest launch args are invalid" };
    }
    args.push(abs);
  }
  let command: string;
  if (launch.runtime === "node") command = process.execPath;
  else if (launch.command && (launch.command.includes("/") || launch.command.includes("\\"))) {
    command = path.resolve(root, launch.command);
    if (!isInside(root, command)) {
      return { ok: false, status: 400, error: "manifest launch command is invalid" };
    }
  } else {
    command = launch.command ?? "";
  }
  const parsed = parseLaunchSpec({ command, args, cwd }, { checkExists: true });
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
  return parsed;
}

/** Rewrite paths validated against the staging dir onto the final install dir. */
function retargetLaunch(launch: AppLaunchSpec, from: string, to: string): AppLaunchSpec {
  const mapPath = (value: string): string => {
    const abs = path.resolve(value);
    if (abs !== path.resolve(from) && !isInside(from, abs)) return value;
    const rel = path.relative(from, abs);
    return rel ? path.join(to, rel) : to;
  };
  return {
    command: path.isAbsolute(launch.command) ? mapPath(launch.command) : launch.command,
    args: launch.args.map((arg) => (path.isAbsolute(arg) ? mapPath(arg) : arg)),
    cwd: launch.cwd ? mapPath(launch.cwd) : undefined,
  };
}

function swapDir(staging: string, dest: string): void {
  const backup = `${dest}.bak-import`;
  fs.rmSync(backup, { recursive: true, force: true });
  if (fs.existsSync(dest)) fs.renameSync(dest, backup);
  try {
    fs.renameSync(staging, dest);
    fs.rmSync(backup, { recursive: true, force: true });
  } catch (err) {
    if (!fs.existsSync(dest) && fs.existsSync(backup)) fs.renameSync(backup, dest);
    throw err;
  }
}

function writePayload(files: ZipFile[], dest: string): AppBundleFailure | null {
  fs.mkdirSync(dest, { recursive: true });
  for (const file of files) {
    const name = zipEntryName(file.name);
    if (!name || !name.startsWith("payload/")) continue;
    const rel = name.slice("payload/".length);
    if (!rel || !safeRel(rel)) return { ok: false, status: 400, error: "invalid path in zip" };
    const target = path.join(dest, rel);
    if (!isInside(dest, target)) return { ok: false, status: 400, error: "invalid path in zip" };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.data, { mode: file.mode && file.mode & 0o777 ? file.mode & 0o777 : 0o644 });
  }
  return null;
}

export async function importAppZip(
  appsDir: string,
  zip: Buffer,
  opts: { reservedNames?: ReadonlySet<string> } = {},
): Promise<ImportAppResult> {
  if (zip.length === 0 || zip.length > MAX_APP_ZIP_BYTES) {
    return { ok: false, status: 400, error: "zip is empty or too large" };
  }
  let files: ZipFile[];
  try {
    files = unzipFiles(zip, LIMITS);
  } catch (err) {
    const message = err instanceof ZipError ? err.message : "invalid zip";
    return { ok: false, status: 400, error: message };
  }
  for (const file of files) {
    if (!zipEntryName(file.name)) {
      return { ok: false, status: 400, error: "invalid path in zip" };
    }
  }
  const manifestFile = files.find((file) => zipEntryName(file.name) === "manifest.json");
  if (!manifestFile) return { ok: false, status: 400, error: "zip is not an app bundle" };
  const manifest = parseManifest(manifestFile.data);
  if ("error" in manifest) return manifest;
  if (opts.reservedNames?.has(manifest.name)) {
    return { ok: false, status: 400, error: "invalid app name" };
  }
  const payload = files.filter((file) => zipEntryName(file.name)?.startsWith("payload/"));
  if (payload.length === 0) return { ok: false, status: 400, error: "app bundle has no files" };
  if (manifest.kind === "static") {
    const hasIndex = payload.some((file) => zipEntryName(file.name) === "payload/index.html");
    if (!hasIndex) return { ok: false, status: 400, error: "static app must contain index.html" };
  }

  fs.mkdirSync(appsDir, { recursive: true });
  const staging = path.join(appsDir, ".import-tmp", `${manifest.name}-${process.pid}-${Date.now()}`);
  const dest = manifest.kind === "static"
    ? path.join(appsDir, manifest.name)
    : bundleDir(appsDir, manifest.name);
  fs.rmSync(staging, { recursive: true, force: true });
  const written = writePayload(payload, staging);
  if (written) {
    fs.rmSync(staging, { recursive: true, force: true });
    return written;
  }

  let prepared: AppLaunchSpec | undefined;
  if (manifest.kind === "dynamic") {
    const checked = restoreLaunch(manifest.launch!, staging);
    if (!checked.ok) {
      fs.rmSync(staging, { recursive: true, force: true });
      return checked;
    }
    prepared = retargetLaunch(checked.launch, staging, dest);
  }

  try {
    await deleteDynamicApp(appsDir, manifest.name);
    if (manifest.kind === "static") {
      const staticDest = path.join(appsDir, manifest.name);
      fs.rmSync(staticDest, { recursive: true, force: true });
      fs.rmSync(bundleDir(appsDir, manifest.name), { recursive: true, force: true });
      const copied = copyStaticAppFiles(appsDir, manifest.name, staging);
      if (!copied.ok) return copied;
    } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      swapDir(staging, dest);
      if (path.resolve(dest) !== path.resolve(appsDir, manifest.name)) {
        fs.rmSync(path.join(appsDir, manifest.name), { recursive: true, force: true });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 500, error: message };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }

  if (manifest.kind === "static") {
    return {
      ok: true,
      name: manifest.name,
      kind: "static",
      url: `/apps/${manifest.name}/`,
      shortUrl: `/${manifest.name}/`,
      started: false,
    };
  }

  if (!prepared) return { ok: false, status: 500, error: "launch was not prepared" };
  const confirmed = parseLaunchSpec(prepared, { checkExists: true });
  if (!confirmed.ok) return { ok: false, status: 400, error: confirmed.error };
  const now = new Date().toISOString();
  const entry: CatalogEntry = {
    name: manifest.name,
    port: manifest.port!,
    title: manifest.title,
    description: manifest.description,
    ttlMs: manifest.ttlMs ?? 45_000,
    registeredAt: now,
    heartbeatAt: now,
    desired: "running",
    launch: confirmed.launch,
  };
  writeCatalogEntry(appsDir, entry);
  kickDynamicAppSupervisor();
  return {
    ok: true,
    name: manifest.name,
    kind: "dynamic",
    url: `/apps/${manifest.name}/`,
    shortUrl: `/${manifest.name}/`,
    started: false,
  };
}
