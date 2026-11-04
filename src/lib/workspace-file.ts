import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import type { BridgeConfig } from "./config.js";
import { OUTPUTS_DIR, UPLOADS_DIR } from "./chat-attachments.js";
import { json } from "./http.js";

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
]);

const DOWNLOAD_EXTENSIONS = new Set([
  ".pdf",
  ".zip",
  ".gz",
  ".tar",
  ".csv",
  ".json",
  ".md",
  ".txt",
  ".html",
  ".htm",
  ".xml",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".mp4",
  ".webm",
  ".mp3",
  ".wav",
]);

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".csv": "text/csv",
  ".json": "application/json",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".html": "text/html",
  ".htm": "text/html",
  ".xml": "application/xml",
};

export const MAX_WORKSPACE_FILE_SERVE_BYTES = 100 * 1024 * 1024;

const BLOCKED_BASENAMES = new Set([
  ".env",
  "auth.json",
  "id_rsa",
  "id_dsa",
  "id_ed25519",
]);

const BLOCKED_PATH_SEGMENTS = new Set([".git", "node_modules"]);

export type WorkspaceFileServeMode = "inline-image" | "download";

function realRoot(root: string): string {
  try {
    return fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root);
  } catch {
    return path.resolve(root);
  }
}

function isUnderRoot(resolvedFile: string, root: string): boolean {
  const rootReal = realRoot(root);
  const rel = path.relative(rootReal, resolvedFile);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function pathHasBlockedSegment(resolvedPath: string): boolean {
  const parts = resolvedPath.split(path.sep);
  return parts.some((p) => BLOCKED_PATH_SEGMENTS.has(p));
}

function isBlockedBasename(resolvedPath: string): boolean {
  const base = path.basename(resolvedPath).toLowerCase();
  if (BLOCKED_BASENAMES.has(base)) return true;
  if (base.endsWith(".pem") || base.endsWith(".key")) return true;
  return false;
}

function isUnderManagedDir(resolvedPath: string, workspaceDir: string): boolean {
  for (const rel of [UPLOADS_DIR, OUTPUTS_DIR]) {
    const root = path.join(realRoot(workspaceDir), rel);
    if (isUnderRoot(resolvedPath, root)) return true;
  }
  return false;
}

function isCursorProjectAsset(resolvedPath: string): boolean {
  const home = os.homedir();
  if (!isUnderRoot(resolvedPath, home)) return false;
  const rel = path.relative(realRoot(home), resolvedPath);
  return /^\.cursor\/projects\/[^/]+\/assets\//.test(rel);
}

/** Resolve a client path (absolute, relative, or file://) against the bridge workspace. */
export function resolveWorkspaceFilePath(
  rawPath: string,
  config: BridgeConfig,
): string | null {
  let p = rawPath.trim();
  if (!p) return null;

  if (p.startsWith("file://")) {
    try {
      p = decodeURIComponent(p.slice("file://".length));
    } catch {
      return null;
    }
  }

  const candidate = path.isAbsolute(p)
    ? path.normalize(p)
    : path.resolve(config.workspace, p);

  try {
    return fs.realpathSync(candidate);
  } catch {
    return null;
  }
}

export function classifyWorkspaceFile(
  resolvedPath: string,
  config: BridgeConfig,
): WorkspaceFileServeMode | null {
  const ext = path.extname(resolvedPath).toLowerCase();
  if (isBlockedBasename(resolvedPath) || pathHasBlockedSegment(resolvedPath)) {
    return null;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolvedPath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > MAX_WORKSPACE_FILE_SERVE_BYTES) return null;

  if (IMAGE_EXTENSIONS.has(ext)) {
    if (isUnderRoot(resolvedPath, config.workspace)) return "inline-image";
    if (isUnderManagedDir(resolvedPath, config.workspace)) return "inline-image";
    if (isCursorProjectAsset(resolvedPath)) return "inline-image";
    return null;
  }

  if (isUnderManagedDir(resolvedPath, config.workspace)) return "download";
  if (isCursorProjectAsset(resolvedPath)) return "download";
  if (isUnderRoot(resolvedPath, config.workspace) && DOWNLOAD_EXTENSIONS.has(ext)) {
    return "download";
  }

  return null;
}

/** @deprecated Use classifyWorkspaceFile */
export function isAllowedWorkspaceFile(
  resolvedPath: string,
  config: BridgeConfig,
): boolean {
  return classifyWorkspaceFile(resolvedPath, config) === "inline-image";
}

export function workspaceFileUrlForPath(filePath: string, download = false): string {
  const base = `/api/workspace-file?path=${encodeURIComponent(filePath)}`;
  return download ? `${base}&download=1` : base;
}

export function workspaceFileMatches(req: http.IncomingMessage): boolean {
  const pathname = (req.url ?? "").split("?")[0] ?? "";
  return req.method === "GET" && pathname === "/api/workspace-file";
}

function mimeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}

function serveFile(
  res: http.ServerResponse,
  filePath: string,
  mode: WorkspaceFileServeMode,
  forceDownload: boolean,
): void {
  const ext = path.extname(filePath).toLowerCase();
  const mime = mimeForPath(filePath);
  const asDownload = forceDownload || mode === "download";
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found\n");
      return;
    }
    const headers: http.OutgoingHttpHeaders = {
      "content-type": mime,
      "content-length": stat.size,
      "cache-control": "public, max-age=3600",
    };
    if (asDownload) {
      const name = path.basename(filePath);
      headers["content-disposition"] = `attachment; filename="${name.replace(/"/g, "")}"`;
    } else if (!IMAGE_EXTENSIONS.has(ext)) {
      headers["content-disposition"] = "inline";
    }
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  });
}

export function handleWorkspaceFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: BridgeConfig,
): void {
  const url = req.url ?? "";
  const qIdx = url.indexOf("?");
  const query = qIdx >= 0 ? url.slice(qIdx + 1) : "";
  const params = new URLSearchParams(query);
  const rawPath = params.get("path");
  if (!rawPath) {
    json(res, 400, {
      error: { message: "path query parameter required", code: "invalid_request" },
    });
    return;
  }

  const forceDownload = params.get("download") === "1";
  const resolved = resolveWorkspaceFilePath(rawPath, config);
  if (!resolved) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found\n");
    return;
  }

  const mode = classifyWorkspaceFile(resolved, config);
  if (!mode) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found\n");
    return;
  }
  if (forceDownload && mode === "inline-image") {
    serveFile(res, resolved, "download", true);
    return;
  }
  serveFile(res, resolved, mode, forceDownload);
}
