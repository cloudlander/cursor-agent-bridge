import * as fs from "node:fs";
import * as path from "node:path";

import type { BridgeConfig } from "./config.js";
import {
  defaultCursorHome,
  migrateLocalThreads,
  readChatStore,
  resolveCursorDataRoots,
  writeChatStore,
  type ApiSessionRecord,
  type WebChatThread,
} from "./chat-store.js";

export const SESSION_EXPORT_VERSION = 1 as const;
export const MS_PER_DAY = 86_400_000;

export type SessionExportManifest = {
  version: typeof SESSION_EXPORT_VERSION;
  exportedAt: number;
  sinceMs: number;
  days: number;
  sourceRoots: string[];
  counts: {
    webThreads: number;
    apiSessions: number;
    agentTranscripts: number;
    acpSessions: number;
  };
};

export type SessionExportSummary = SessionExportManifest["counts"] & {
  outDir: string;
  manifestPath: string;
};

export type SessionImportSummary = {
  webThreadsMerged: number;
  apiSessionsMerged: number;
  agentTranscriptFiles: number;
  acpSessionDirs: number;
};

function sessionActiveSince(
  updatedAt: number,
  createdAt: number,
  sinceMs: number,
): boolean {
  return Math.max(updatedAt, createdAt) >= sinceMs;
}

function cursorRelPath(root: string, absPath: string): string | null {
  const rel = path.relative(root, absPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

function copyFileSafe(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDirFiles(srcDir: string, destDir: string, filter?: (name: string) => boolean): number {
  let copied = 0;
  fs.mkdirSync(destDir, { recursive: true });
  let entries: string[];
  try {
    entries = fs.readdirSync(srcDir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (filter && !filter(name)) continue;
    const src = path.join(srcDir, name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(src);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    copyFileSafe(src, path.join(destDir, name));
    copied++;
  }
  return copied;
}

function shouldCopyAcpFile(name: string): boolean {
  if (name.endsWith("-wal") || name.endsWith("-shm")) return false;
  return true;
}

function bundleCursorDir(outDir: string): string {
  return path.join(outDir, "cursor");
}

function collectAgentTranscripts(
  config: BridgeConfig,
  sinceMs: number,
): Array<{ relPath: string; absPath: string; mtimeMs: number }> {
  const out: Array<{ relPath: string; absPath: string; mtimeMs: number }> = [];
  const seen = new Set<string>();

  for (const root of resolveCursorDataRoots(config)) {
    const projectsDir = path.join(root, "projects");
    if (!fs.existsSync(projectsDir)) continue;
    let projects: string[];
    try {
      projects = fs.readdirSync(projectsDir);
    } catch {
      continue;
    }
    for (const project of projects) {
      const transcriptsDir = path.join(projectsDir, project, "agent-transcripts");
      if (!fs.existsSync(transcriptsDir)) continue;
      let sessionDirs: string[];
      try {
        sessionDirs = fs.readdirSync(transcriptsDir);
      } catch {
        continue;
      }
      for (const sessionId of sessionDirs) {
        if (seen.has(sessionId)) continue;
        const jsonlPath = path.join(transcriptsDir, sessionId, `${sessionId}.jsonl`);
        if (!fs.existsSync(jsonlPath)) continue;
        let stat: fs.Stats;
        try {
          stat = fs.statSync(jsonlPath);
        } catch {
          continue;
        }
        if (stat.mtimeMs < sinceMs) continue;
        const relPath = cursorRelPath(root, jsonlPath);
        if (!relPath) continue;
        seen.add(sessionId);
        out.push({ relPath, absPath: jsonlPath, mtimeMs: stat.mtimeMs });
      }
    }
  }
  return out;
}

function collectAcpSessions(
  config: BridgeConfig,
  sinceMs: number,
): Array<{ relDir: string; absDir: string; mtimeMs: number }> {
  const out: Array<{ relDir: string; absDir: string; mtimeMs: number }> = [];
  const seen = new Set<string>();

  for (const root of resolveCursorDataRoots(config)) {
    const acpDir = path.join(root, "acp-sessions");
    if (!fs.existsSync(acpDir)) continue;
    let sessionDirs: string[];
    try {
      sessionDirs = fs.readdirSync(acpDir);
    } catch {
      continue;
    }
    for (const sessionId of sessionDirs) {
      if (seen.has(sessionId)) continue;
      const sessionDir = path.join(acpDir, sessionId);
      const metaPath = path.join(sessionDir, "meta.json");
      if (!fs.existsSync(metaPath)) continue;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(metaPath);
      } catch {
        continue;
      }
      if (stat.mtimeMs < sinceMs) continue;
      const relDir = cursorRelPath(root, sessionDir);
      if (!relDir) continue;
      seen.add(sessionId);
      out.push({ relDir, absDir: sessionDir, mtimeMs: stat.mtimeMs });
    }
  }
  return out;
}

export async function exportSessionBundle(
  config: BridgeConfig,
  opts: { outDir: string; days: number; sinceMs?: number },
): Promise<SessionExportSummary> {
  const days = opts.days;
  if (!Number.isFinite(days) || days <= 0 || days > 365) {
    throw new Error("--days must be a number between 1 and 365");
  }
  const sinceMs = opts.sinceMs ?? Date.now() - days * MS_PER_DAY;
  const outDir = path.resolve(opts.outDir);
  fs.mkdirSync(outDir, { recursive: true });

  const store = await readChatStore(config);
  const threads = store.threads.filter((t) =>
    sessionActiveSince(t.updatedAt, t.createdAt, sinceMs),
  );
  const apiSessions = store.apiSessions.filter((s) =>
    sessionActiveSince(s.updatedAt, s.createdAt, sinceMs),
  );

  const chatPartial = { version: 1 as const, threads, apiSessions };
  fs.writeFileSync(
    path.join(outDir, "chat-store.partial.json"),
    JSON.stringify(chatPartial, null, 2),
    "utf8",
  );

  const cursorOut = bundleCursorDir(outDir);
  const transcripts = collectAgentTranscripts(config, sinceMs);
  for (const item of transcripts) {
    const dest = path.join(cursorOut, ...item.relPath.split("/"));
    copyFileSafe(item.absPath, dest);
  }

  const acpSessions = collectAcpSessions(config, sinceMs);
  for (const item of acpSessions) {
    const destDir = path.join(cursorOut, ...item.relDir.split("/"));
    copyDirFiles(item.absDir, destDir, shouldCopyAcpFile);
  }

  const manifest: SessionExportManifest = {
    version: SESSION_EXPORT_VERSION,
    exportedAt: Date.now(),
    sinceMs,
    days,
    sourceRoots: resolveCursorDataRoots(config),
    counts: {
      webThreads: threads.length,
      apiSessions: apiSessions.length,
      agentTranscripts: transcripts.length,
      acpSessions: acpSessions.length,
    },
  };
  const manifestPath = path.join(outDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  return { outDir, manifestPath, ...manifest.counts };
}

async function mergeApiSessions(
  config: BridgeConfig,
  imported: ApiSessionRecord[],
): Promise<number> {
  if (imported.length === 0) return 0;
  const store = await readChatStore(config);
  const byId = new Map(store.apiSessions.map((s) => [s.id, s]));
  let merged = 0;
  for (const record of imported) {
    const prev = byId.get(record.id);
    if (!prev) {
      byId.set(record.id, record);
      merged++;
      continue;
    }
    if (record.updatedAt >= prev.updatedAt) {
      byId.set(record.id, { ...prev, ...record });
    }
  }
  store.apiSessions = [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  await writeChatStore(config, store);
  return merged;
}

function importCursorTargetRoot(config: BridgeConfig): string {
  const roots = resolveCursorDataRoots(config);
  if (roots.length > 0) return roots[0]!;
  return path.join(defaultCursorHome(), ".cursor");
}

function walkFiles(dir: string, prefix = ""): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const ent of entries) {
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      files.push(...walkFiles(abs, rel));
    } else if (ent.isFile()) {
      files.push(rel);
    }
  }
  return files;
}

export async function importSessionBundle(
  config: BridgeConfig,
  opts: { bundleDir: string; merge?: boolean },
): Promise<SessionImportSummary> {
  const bundleDir = path.resolve(opts.bundleDir);
  const manifestPath = path.join(bundleDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing manifest.json in ${bundleDir}`);
  }
  let manifest: SessionExportManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as SessionExportManifest;
  } catch {
    throw new Error("Invalid manifest.json");
  }
  if (manifest.version !== SESSION_EXPORT_VERSION) {
    throw new Error(`Unsupported export version: ${manifest.version}`);
  }

  const chatPath = path.join(bundleDir, "chat-store.partial.json");
  let webThreadsMerged = 0;
  let apiSessionsMerged = 0;
  if (fs.existsSync(chatPath)) {
    const partial = JSON.parse(fs.readFileSync(chatPath, "utf8")) as {
      threads?: WebChatThread[];
      apiSessions?: ApiSessionRecord[];
    };
    if (Array.isArray(partial.threads) && partial.threads.length > 0) {
      const { merged } = await migrateLocalThreads(config, partial.threads);
      webThreadsMerged = merged;
    }
    if (Array.isArray(partial.apiSessions) && partial.apiSessions.length > 0) {
      apiSessionsMerged = await mergeApiSessions(config, partial.apiSessions);
    }
  }

  const cursorBundle = bundleCursorDir(bundleDir);
  let agentTranscriptFiles = 0;
  const acpDirsTouched = new Set<string>();
  if (fs.existsSync(cursorBundle)) {
    const targetRoot = importCursorTargetRoot(config);
    const relFiles = walkFiles(cursorBundle);
    for (const rel of relFiles) {
      const src = path.join(cursorBundle, rel);
      const dest = path.join(targetRoot, ...rel.split("/"));
      if (opts.merge !== false && fs.existsSync(dest)) {
        const srcStat = fs.statSync(src);
        const destStat = fs.statSync(dest);
        if (destStat.mtimeMs >= srcStat.mtimeMs) continue;
      }
      copyFileSafe(src, dest);
      if (rel.includes("/agent-transcripts/") && rel.endsWith(".jsonl")) {
        agentTranscriptFiles++;
      }
      const acpMatch = rel.match(/acp-sessions\/([^/]+)\//);
      if (acpMatch) acpDirsTouched.add(acpMatch[1]!);
    }
  }
  const acpSessionDirs = acpDirsTouched.size;

  return {
    webThreadsMerged,
    apiSessionsMerged,
    agentTranscriptFiles,
    acpSessionDirs,
  };
}
