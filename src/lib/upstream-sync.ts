import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import type { BridgeConfig } from "./config.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_UPSTREAM_REPO =
  "https://github.com/anyrobert/cursor-api-proxy.git";
export const DEFAULT_SYNC_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_FIRST_RUN_DELAY_MS = 120_000;

const RSYNC_DIRS = ["src", "public", "docs", "examples"] as const;
const RSYNC_EXCLUDES = [
  "plugins",
  "chat-api.ts",
  "chat-store.ts",
  "bridge-api-auth.ts",
  "agent-login.ts",
];

export type UpstreamSyncBannerKind = "success" | "error" | "info";

export type UpstreamSyncBanner = {
  id: string;
  kind: UpstreamSyncBannerKind;
  title: string;
  detail?: string;
  needsRestart?: boolean;
  dismissed?: boolean;
  createdAt: string;
};

export type UpstreamSyncState = {
  enabled: boolean;
  lastCheckAt?: string;
  lastRunAt?: string;
  lastOutcome?: "success" | "failure" | "noop";
  upstreamTag?: string;
  localVersion?: string;
  phase?: string;
  message?: string;
  pushed?: boolean;
  error?: string;
  banner?: UpstreamSyncBanner;
  running?: boolean;
};

export type UpstreamSyncOptions = {
  enabled: boolean;
  intervalMs: number;
  firstRunDelayMs: number;
  pushEnabled: boolean;
  upstreamRepo: string;
};

let schedulerTimer: ReturnType<typeof setTimeout> | undefined;
let intervalTimer: ReturnType<typeof setInterval> | undefined;
let syncRunning = false;

function bridgePackageRoot(): string {
  const fromEnv = process.env.CURSOR_API_PROXY_ROOT?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
  );
}

export function stateFilePath(config: BridgeConfig): string {
  const dir = path.dirname(config.sessionsLogPath);
  return path.join(dir, "upstream-sync.json");
}

export function loadUpstreamSyncOptions(
  env: NodeJS.ProcessEnv = process.env,
): UpstreamSyncOptions {
  const enabled = /^(1|true|yes|on)$/i.test(
    String(env.CURSOR_BRIDGE_UPSTREAM_SYNC ?? "").trim(),
  );
  const pushRaw = env.CURSOR_BRIDGE_UPSTREAM_SYNC_PUSH?.trim();
  const pushEnabled =
    pushRaw === undefined || pushRaw === ""
      ? enabled
      : /^(1|true|yes|on)$/i.test(pushRaw);
  const intervalMs = parsePositiveInt(
    env.CURSOR_BRIDGE_UPSTREAM_SYNC_INTERVAL_MS,
    DEFAULT_SYNC_INTERVAL_MS,
  );
  const firstRunDelayMs = parsePositiveInt(
    env.CURSOR_BRIDGE_UPSTREAM_SYNC_FIRST_DELAY_MS,
    DEFAULT_FIRST_RUN_DELAY_MS,
  );
  const upstreamRepo =
    env.CURSOR_BRIDGE_UPSTREAM_SYNC_REPO?.trim() || DEFAULT_UPSTREAM_REPO;
  return {
    enabled,
    intervalMs,
    firstRunDelayMs,
    pushEnabled,
    upstreamRepo,
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.round(n);
}

export function parseSemver(version: string): [number, number, number] | null {
  const m = version.trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 0; i < 3; i++) {
    if (pa[i]! < pb[i]!) return -1;
    if (pa[i]! > pb[i]!) return 1;
  }
  return 0;
}

export function pickLatestSemverTag(tags: string[]): string | undefined {
  let best: string | undefined;
  for (const tag of tags) {
    if (!parseSemver(tag)) continue;
    if (!best || compareSemver(tag, best) > 0) best = tag;
  }
  return best;
}

export function readLocalPackageVersion(repoRoot: string): string {
  try {
    const raw = fs.readFileSync(
      path.join(repoRoot, "package.json"),
      "utf8",
    );
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

export function changedPathsNeedRestart(paths: string[]): boolean {
  return paths.some(
    (p) =>
      p === "package.json" ||
      p.startsWith("src/") ||
      p.startsWith("src\\"),
  );
}

export function readUpstreamSyncState(config: BridgeConfig): UpstreamSyncState {
  const file = stateFilePath(config);
  const opts = loadUpstreamSyncOptions();
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as UpstreamSyncState;
    return { ...raw, enabled: opts.enabled };
  } catch {
    return { enabled: opts.enabled };
  }
}

export function writeUpstreamSyncState(
  config: BridgeConfig,
  state: UpstreamSyncState,
): void {
  const file = stateFilePath(config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const opts = loadUpstreamSyncOptions();
  fs.writeFileSync(
    file,
    JSON.stringify({ ...state, enabled: opts.enabled }, null, 2),
    "utf8",
  );
}

function newBanner(
  kind: UpstreamSyncBannerKind,
  title: string,
  detail?: string,
  needsRestart?: boolean,
): UpstreamSyncBanner {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    title,
    detail,
    needsRestart,
    dismissed: false,
    createdAt: new Date().toISOString(),
  };
}

async function commandOk(cmd: string, args: string[], cwd?: string): Promise<boolean> {
  try {
    await execFileAsync(cmd, args, { cwd, maxBuffer: 16 * 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

async function runCommand(
  cmd: string,
  args: string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    cwd,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    stdout: String(stdout ?? ""),
    stderr: String(stderr ?? ""),
  };
}

export async function fetchLatestUpstreamTag(
  repoUrl: string,
): Promise<string | undefined> {
  const { stdout } = await runCommand("git", [
    "ls-remote",
    "--tags",
    "--refs",
    repoUrl,
    "v*",
  ]);
  const tags: string[] = [];
  for (const line of stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    const ref = parts[1];
    if (!ref?.startsWith("refs/tags/")) continue;
    const tag = ref.slice("refs/tags/".length);
    if (tag.endsWith("^{}")) continue;
    tags.push(tag);
  }
  return pickLatestSemverTag(tags);
}

function isGitRepo(repoRoot: string): boolean {
  return fs.existsSync(path.join(repoRoot, ".git"));
}

/** Match rsync --exclude patterns (name at any path segment, or full relative path). */
export function upstreamSyncPathExcluded(relativePosix: string): boolean {
  const parts = relativePosix.split("/").filter(Boolean);
  const base = parts[parts.length - 1] ?? "";
  for (const pattern of RSYNC_EXCLUDES) {
    if (pattern.includes("/")) {
      if (
        relativePosix === pattern ||
        relativePosix.startsWith(`${pattern}/`)
      ) {
        return true;
      }
    } else if (parts.some((p) => p === pattern) || base === pattern) {
      return true;
    }
  }
  return false;
}

function collectNonExcludedRelFiles(root: string): Set<string> {
  const rels = new Set<string>();
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (upstreamSyncPathExcluded(rel)) continue;
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile()) {
        rels.add(rel);
      }
    }
  }
  return rels;
}

function pruneEmptyDirsExceptExcluded(destRoot: string, dir = destRoot): void {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const full = path.join(dir, ent.name);
    const rel = path.relative(destRoot, full).split(path.sep).join("/");
    if (upstreamSyncPathExcluded(rel)) continue;
    pruneEmptyDirsExceptExcluded(destRoot, full);
    if (fs.readdirSync(full).length === 0) {
      fs.rmdirSync(full);
    }
  }
}

/** Node mirror of `rsync -a --delete` with AGENTS.md exclude list (for hosts without rsync). */
export function mirrorDirectoryFromUpstream(srcDir: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  const srcFiles = collectNonExcludedRelFiles(srcDir);

  for (const rel of srcFiles) {
    const from = path.join(srcDir, rel);
    const to = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    const st = fs.statSync(from);
    fs.utimesSync(to, st.atime, st.mtime);
  }

  const destStack = [destDir];
  while (destStack.length > 0) {
    const dir = destStack.pop()!;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      const rel = path.relative(destDir, full).split(path.sep).join("/");
      if (upstreamSyncPathExcluded(rel)) continue;
      if (ent.isDirectory()) {
        destStack.push(full);
      } else if (ent.isFile() && !srcFiles.has(rel)) {
        fs.unlinkSync(full);
      }
    }
  }
  pruneEmptyDirsExceptExcluded(destDir);
}

async function rsyncFromUpstream(
  upstreamDir: string,
  destRoot: string,
): Promise<void> {
  const useRsync = await commandOk("rsync", ["--version"]);
  for (const dir of RSYNC_DIRS) {
    const src = path.join(upstreamDir, dir);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(destRoot, dir);
    fs.mkdirSync(dest, { recursive: true });
    if (useRsync) {
      const args = [
        "-a",
        "--delete",
        ...RSYNC_EXCLUDES.flatMap((e) => ["--exclude", e]),
        `${src}/`,
        `${dest}/`,
      ];
      await runCommand("rsync", args);
    } else {
      mirrorDirectoryFromUpstream(src, dest);
    }
  }
}

async function gitPorcelain(repoRoot: string): Promise<string[]> {
  const { stdout } = await runCommand("git", ["status", "--porcelain"], repoRoot);
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.slice(3).trim());
}

export type UpstreamSyncRunResult =
  | { outcome: "noop"; message: string }
  | { outcome: "success"; upstreamTag: string; pushed: boolean; needsRestart: boolean; message: string }
  | { outcome: "failure"; phase: string; message: string };

export async function runUpstreamSync(
  config: BridgeConfig,
  opts: UpstreamSyncOptions = loadUpstreamSyncOptions(),
): Promise<UpstreamSyncRunResult> {
  if (syncRunning) {
    return { outcome: "failure", phase: "busy", message: "Sync already running" };
  }
  syncRunning = true;
  const repoRoot = bridgePackageRoot();
  let state = readUpstreamSyncState(config);
  state = {
    ...state,
    running: true,
    phase: "checking",
    lastCheckAt: new Date().toISOString(),
    error: undefined,
  };
  writeUpstreamSyncState(config, state);

  try {
    if (!opts.enabled) {
      return { outcome: "failure", phase: "disabled", message: "Upstream sync is disabled" };
    }
    if (!(await commandOk("git", ["--version"]))) {
      return {
        outcome: "failure",
        phase: "precheck",
        message: "git is required for upstream sync",
      };
    }
    if (!isGitRepo(repoRoot)) {
      return {
        outcome: "failure",
        phase: "precheck",
        message: "Project root is not a git repository",
      };
    }

    const localVersion = readLocalPackageVersion(repoRoot);
    let upstreamTag: string;
    try {
      const latest = await fetchLatestUpstreamTag(opts.upstreamRepo);
      if (!latest) {
        return {
          outcome: "failure",
          phase: "version",
          message: "Could not resolve upstream semver tag",
        };
      }
      upstreamTag = latest;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { outcome: "failure", phase: "version", message: msg };
    }

    state = {
      ...state,
      localVersion,
      upstreamTag,
      phase: "version",
    };
    writeUpstreamSyncState(config, state);

    if (compareSemver(upstreamTag, localVersion) <= 0) {
      state = {
        ...state,
        running: false,
        lastRunAt: new Date().toISOString(),
        lastOutcome: "noop",
        phase: "done",
        message: `Already at upstream ${upstreamTag} (local ${localVersion})`,
      };
      writeUpstreamSyncState(config, state);
      return {
        outcome: "noop",
        message: state.message!,
      };
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-sync-"));
    state = { ...state, phase: "clone" };
    writeUpstreamSyncState(config, state);

    try {
      await runCommand(
        "git",
        ["clone", "--depth", "1", "--branch", upstreamTag, opts.upstreamRepo, tmpDir],
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { outcome: "failure", phase: "clone", message: msg };
    }

    state = { ...state, phase: "rsync" };
    writeUpstreamSyncState(config, state);
    try {
      await rsyncFromUpstream(tmpDir, repoRoot);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { outcome: "failure", phase: "rsync", message: msg };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    state = { ...state, phase: "test" };
    writeUpstreamSyncState(config, state);
    try {
      await runCommand("npm", ["ci"], repoRoot);
      await runCommand("npm", ["run", "build"], repoRoot);
      await runCommand("npm", ["test"], repoRoot);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      try {
        await runCommand("git", ["checkout", "--", "."], repoRoot);
      } catch {
        /* best effort revert */
      }
      return { outcome: "failure", phase: "test", message: msg };
    }

    const changed = await gitPorcelain(repoRoot);
    const needsRestart = changedPathsNeedRestart(changed);
    if (changed.length === 0) {
      state = {
        ...state,
        running: false,
        lastRunAt: new Date().toISOString(),
        lastOutcome: "noop",
        phase: "done",
        message: `Upstream ${upstreamTag} matched tree after sync (no commit)`,
      };
      writeUpstreamSyncState(config, state);
      return { outcome: "noop", message: state.message! };
    }

    state = { ...state, phase: "commit" };
    writeUpstreamSyncState(config, state);
    try {
      await runCommand("git", ["add", "-A"], repoRoot);
      const commitMsg = `chore: sync cursor-api-proxy @ ${upstreamTag}`;
      await runCommand("git", ["commit", "-m", commitMsg], repoRoot);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { outcome: "failure", phase: "commit", message: msg };
    }

    let pushed = false;
    if (opts.pushEnabled) {
      state = { ...state, phase: "push" };
      writeUpstreamSyncState(config, state);
      try {
        const { stdout } = await runCommand(
          "git",
          ["rev-parse", "--abbrev-ref", "HEAD"],
          repoRoot,
        );
        const branch = stdout.trim();
        if (branch !== "main" && branch !== "master") {
          return {
            outcome: "failure",
            phase: "push",
            message: `Refusing to push from branch ${branch}; checkout main first`,
          };
        }
        await runCommand("git", ["push", "origin", branch], repoRoot);
        pushed = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { outcome: "failure", phase: "push", message: msg };
      }
    }

    const message = pushed
      ? `Synced and pushed upstream ${upstreamTag}`
      : `Synced upstream ${upstreamTag} (commit local; push disabled or skipped)`;

    state = {
      ...state,
      running: false,
      lastRunAt: new Date().toISOString(),
      lastOutcome: "success",
      phase: "done",
      message,
      pushed,
      banner: newBanner(
        "success",
        `Updated to cursor-api-proxy ${upstreamTag}`,
        message,
        needsRestart,
      ),
    };
    writeUpstreamSyncState(config, state);
    console.log(`[upstream-sync] ${message}`);
    return {
      outcome: "success",
      upstreamTag,
      pushed,
      needsRestart,
      message,
    };
  } finally {
    syncRunning = false;
    const final = readUpstreamSyncState(config);
    if (final.running) {
      writeUpstreamSyncState(config, { ...final, running: false });
    }
  }
}

export async function runUpstreamSyncWithState(
  config: BridgeConfig,
): Promise<UpstreamSyncRunResult> {
  const opts = loadUpstreamSyncOptions();
  const result = await runUpstreamSync(config, opts);
  if (result.outcome === "failure") {
    const state = readUpstreamSyncState(config);
    const detail = result.message;
    writeUpstreamSyncState(config, {
      ...state,
      running: false,
      lastRunAt: new Date().toISOString(),
      lastOutcome: "failure",
      phase: result.phase,
      error: detail,
      message: detail,
      banner: newBanner(
        "error",
        `Upstream sync failed (${result.phase})`,
        detail,
      ),
    });
    console.error(`[upstream-sync] ${result.phase}: ${detail}`);
  }
  return result;
}

export function startUpstreamSyncScheduler(config: BridgeConfig): void {
  stopUpstreamSyncScheduler();
  const opts = loadUpstreamSyncOptions();
  if (!opts.enabled || process.env.VITEST === "true") return;

  const tick = () => {
    void runUpstreamSyncWithState(config);
  };

  schedulerTimer = setTimeout(() => {
    tick();
    intervalTimer = setInterval(tick, opts.intervalMs);
  }, opts.firstRunDelayMs);

  console.log(
    `[upstream-sync] scheduled (first in ${Math.round(opts.firstRunDelayMs / 1000)}s, every ${Math.round(opts.intervalMs / 86400000)}d)`,
  );
}

export function stopUpstreamSyncScheduler(): void {
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = undefined;
  }
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = undefined;
  }
}

export function upstreamSyncApiMatches(req: http.IncomingMessage): boolean {
  const pathname = (req.url ?? "/").split("?")[0] ?? "/";
  if (pathname === "/api/upstream-sync" && req.method === "GET") return true;
  if (pathname === "/api/upstream-sync/dismiss" && req.method === "POST") {
    return true;
  }
  if (pathname === "/api/upstream-sync/run" && req.method === "POST") return true;
  return false;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": buf.length,
    "cache-control": "no-store",
  });
  res.end(buf);
}

export function handleUpstreamSyncApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: BridgeConfig,
): void {
  const pathname = (req.url ?? "/").split("?")[0] ?? "/";
  const opts = loadUpstreamSyncOptions();

  if (req.method === "GET" && pathname === "/api/upstream-sync") {
    const state = readUpstreamSyncState(config);
    const banner =
      state.banner && !state.banner.dismissed ? state.banner : undefined;
    return json(res, 200, {
      options: {
        enabled: opts.enabled,
        pushEnabled: opts.pushEnabled,
        intervalMs: opts.intervalMs,
      },
      state: { ...state, banner: undefined },
      banner,
    });
  }

  if (req.method === "POST" && pathname === "/api/upstream-sync/dismiss") {
    const state = readUpstreamSyncState(config);
    if (state.banner) {
      state.banner = { ...state.banner, dismissed: true };
      writeUpstreamSyncState(config, state);
    }
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && pathname === "/api/upstream-sync/run") {
    if (!opts.enabled) {
      return json(res, 400, { error: "upstream sync is disabled" });
    }
    if (syncRunning) {
      return json(res, 409, { error: "sync already running" });
    }
    void runUpstreamSyncWithState(config).then((result) => {
      json(res, 200, { result });
    });
    return;
  }

  json(res, 404, { error: "not found" });
}
