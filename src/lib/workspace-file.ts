import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import type { BridgeConfig } from "./config.js";
import { UPLOADS_DIR } from "./chat-attachments.js";
import { json } from "./http.js";

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
]);

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

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

/** Whether the resolved path may be served (image under workspace or Cursor project assets). */
export function isAllowedWorkspaceFile(
  resolvedPath: string,
  config: BridgeConfig,
): boolean {
  const ext = path.extname(resolvedPath).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) return false;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolvedPath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  if (isUnderRoot(resolvedPath, config.workspace)) return true;

  const uploadsSuffix = `${path.sep}${UPLOADS_DIR}${path.sep}`;
  if (resolvedPath.includes(uploadsSuffix)) {
    const uploadsRoot = path.join(realRoot(config.workspace), UPLOADS_DIR);
    if (isUnderRoot(resolvedPath, uploadsRoot)) return true;
  }

  const home = os.homedir();
  if (isUnderRoot(resolvedPath, home)) {
    const rel = path.relative(realRoot(home), resolvedPath);
    if (/^\.cursor\/projects\/[^/]+\/assets\//.test(rel)) return true;
  }

  return false;
}

export function workspaceFileUrlForPath(filePath: string): string {
  return `/api/workspace-file?path=${encodeURIComponent(filePath)}`;
}

export function workspaceFileMatches(req: http.IncomingMessage): boolean {
  const pathname = (req.url ?? "").split("?")[0] ?? "";
  return req.method === "GET" && pathname === "/api/workspace-file";
}

function serveImageFile(res: http.ServerResponse, filePath: string): void {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] ?? "application/octet-stream";
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found\n");
      return;
    }
    res.writeHead(200, {
      "content-type": mime,
      "content-length": stat.size,
      "cache-control": "public, max-age=3600",
    });
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
    json(res, 400, { error: { message: "path query parameter required", code: "invalid_request" } });
    return;
  }

  const resolved = resolveWorkspaceFilePath(rawPath, config);
  if (!resolved || !isAllowedWorkspaceFile(resolved, config)) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found\n");
    return;
  }

  serveImageFile(res, resolved);
}
