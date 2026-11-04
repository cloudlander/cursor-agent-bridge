import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import type { AcpPromptBlock } from "./acp-client.js";

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const UPLOADS_DIR = ".cursor-api-proxy/uploads";
/** Agent / model artifacts saved for chat download links. */
export const OUTPUTS_DIR = ".cursor-api-proxy/outputs";
export const DEFAULT_UPLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_UPLOAD_DIR_QUOTA_BYTES = 500 * 1024 * 1024;

let cachedMaxUploadBytes: number | undefined;

/** Upper bound for user uploads (override with CURSOR_BRIDGE_MAX_UPLOAD_BYTES). */
export function getMaxUploadBytes(): number {
  if (cachedMaxUploadBytes !== undefined) return cachedMaxUploadBytes;
  const raw = process.env.CURSOR_BRIDGE_MAX_UPLOAD_BYTES?.trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) {
      cachedMaxUploadBytes = n;
      return n;
    }
  }
  cachedMaxUploadBytes = MAX_UPLOAD_BYTES;
  return cachedMaxUploadBytes;
}

/** @internal Vitest only — env overrides are read once per process otherwise. */
export function resetMaxUploadBytesCacheForTests(): void {
  cachedMaxUploadBytes = undefined;
}

/** Max JSON upload body (base64 expands ~4/3). */
export function maxJsonUploadBodyChars(): number {
  return Math.ceil(getMaxUploadBytes() * 1.37) + 65_536;
}

export type ChatAttachmentRef = {
  name: string;
  mimeType: string;
  path: string;
  size?: number;
};

const IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".json",
  ".yaml",
  ".yml",
  ".csv",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".sh",
  ".html",
  ".css",
  ".xml",
  ".sql",
  ".toml",
  ".ini",
  ".log",
]);

const EXT_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
};

export function uploadsRoot(workspaceDir: string): string {
  return path.join(workspaceDir, UPLOADS_DIR);
}

export function outputsRoot(workspaceDir: string): string {
  return path.join(workspaceDir, OUTPUTS_DIR);
}

export function managedStorageRoots(workspaceDir: string): string[] {
  return [uploadsRoot(workspaceDir), outputsRoot(workspaceDir)];
}

function sanitizeFilename(name: string): string {
  const base = path.basename(name).replace(/[^\w.\-+() ]+/g, "_").trim();
  return base || "upload";
}

export function mimeFromFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return EXT_MIME[ext] ?? "application/octet-stream";
}

function newStoredUploadPath(workspaceDir: string, safeName: string): string {
  const dir = uploadsRoot(workspaceDir);
  fs.mkdirSync(dir, { recursive: true });
  const id = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const stored = `${id}-${safeName}`;
  return path.join(dir, stored);
}

export function saveChatUpload(
  workspaceDir: string,
  filename: string,
  mimeType: string,
  data: Buffer,
): ChatAttachmentRef {
  const max = getMaxUploadBytes();
  if (data.length > max) {
    throw new Error(`File exceeds ${max} byte limit`);
  }
  const safeName = sanitizeFilename(filename);
  const filePath = newStoredUploadPath(workspaceDir, safeName);
  fs.writeFileSync(filePath, data);
  return {
    name: safeName,
    mimeType: mimeType || mimeFromFilename(safeName),
    path: filePath,
    size: data.length,
  };
}

/** Path for a streaming multipart upload (caller writes bytes, then finalizeChatUpload). */
export function tempChatUploadPath(workspaceDir: string, filename: string): string {
  const safeName = sanitizeFilename(filename);
  return newStoredUploadPath(workspaceDir, safeName);
}

export function finalizeChatUpload(
  filePath: string,
  filename: string,
  mimeType: string,
  size: number,
): ChatAttachmentRef {
  const safeName = sanitizeFilename(filename);
  return {
    name: safeName,
    mimeType: mimeType || mimeFromFilename(safeName),
    path: filePath,
    size,
  };
}

/**
 * Remove stale files from uploads/outputs and enforce a soft quota (oldest mtime first).
 */
function normalizeKeepPath(filePath: string, workspaceDir: string): string | null {
  try {
    const resolved = fs.realpathSync(
      path.isAbsolute(filePath)
        ? path.normalize(filePath)
        : path.resolve(workspaceDir, filePath),
    );
    if (!fs.statSync(resolved).isFile()) return null;
    return resolved;
  } catch {
    return null;
  }
}

/** Paths under uploads/outputs still referenced by chat threads (skip TTL/quota eviction). */
export function collectReferencedManagedPaths(
  threads: Array<{ messages?: Array<any> }>,
  workspaceDir: string,
): Set<string> {
  const keep = new Set<string>();
  const managedMarker = `${path.sep}.cursor-api-proxy${path.sep}`;
  const addPath = (raw: string) => {
    const normalized = normalizeKeepPath(raw, workspaceDir);
    if (normalized) keep.add(normalized);
  };

  for (const thread of threads ?? []) {
    for (const msg of thread.messages ?? []) {
      if (Array.isArray(msg?.attachments)) {
        for (const att of msg.attachments) {
          if (typeof att?.path === "string") addPath(att.path);
        }
      }
      const content = msg?.content;
      if (typeof content !== "string" || !content.includes(".cursor-api-proxy")) continue;
      for (const m of content.matchAll(/\.cursor-api-proxy\/(?:uploads|outputs)\/[^\s)\]"']+/g)) {
        addPath(m[0].replace(/\//g, path.sep));
      }
      for (const m of content.matchAll(/\/api\/workspace-file\?path=([^&\s)\]"']+)/g)) {
        try {
          addPath(decodeURIComponent(m[1]));
        } catch {
          /* skip */
        }
      }
      if (content.includes(managedMarker)) {
        for (const m of content.matchAll(
          /(?:^|[\s('"`])([^\s)\]"']*\.cursor-api-proxy(?:\/uploads|\/outputs)\/[^\s)\]"']+)/g,
        )) {
          addPath(m[1]);
        }
      }
    }
  }
  return keep;
}

export function ensureOutputsDir(workspaceDir: string): string {
  const dir = outputsRoot(workspaceDir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function pruneManagedStorage(
  workspaceDir: string,
  opts?: { maxAgeMs?: number; quotaBytes?: number; keepPaths?: Set<string> },
): void {
  const maxAgeMs = opts?.maxAgeMs ?? DEFAULT_UPLOAD_TTL_MS;
  const quotaBytes = opts?.quotaBytes ?? DEFAULT_UPLOAD_DIR_QUOTA_BYTES;
  const keepPaths = opts?.keepPaths;
  const cutoff = Date.now() - maxAgeMs;
  const files: Array<{ path: string; mtime: number; size: number; pinned: boolean }> =
    [];

  for (const root of managedStorageRoots(workspaceDir)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      const p = path.join(root, ent.name);
      try {
        const real = fs.realpathSync(p);
        const pinned = keepPaths?.has(real) ?? false;
        const st = fs.statSync(real);
        if (st.mtimeMs < cutoff && !pinned) {
          fs.unlinkSync(real);
          continue;
        }
        files.push({ path: real, mtime: st.mtimeMs, size: st.size, pinned });
      } catch {
        /* skip */
      }
    }
  }

  let total = files.reduce((n, f) => n + f.size, 0);
  if (total <= quotaBytes) return;
  const byPriority = [...files].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? 1 : -1;
    return a.mtime - b.mtime;
  });
  for (const f of byPriority) {
    if (total <= quotaBytes) break;
    if (f.pinned) continue;
    try {
      fs.unlinkSync(f.path);
      total -= f.size;
    } catch {
      /* skip */
    }
  }
}

function isImageMime(mime: string): boolean {
  return IMAGE_MIMES.has(mime) || mime.startsWith("image/");
}

function isTextLike(mime: string, filename: string): boolean {
  if (mime.startsWith("text/")) return true;
  return TEXT_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

function parseDataUrl(url: string): { mimeType: string; data: string } | null {
  const m = /^data:([^;,]+);base64,(.+)$/i.exec(url.trim());
  if (!m) return null;
  return { mimeType: m[1], data: m[2] };
}

function resolveAttachmentPath(
  raw: string,
  workspaceDir: string,
): string | null {
  let p = raw.trim();
  if (!p) return null;
  if (p.startsWith("/api/workspace-file?")) {
    try {
      const q = p.slice(p.indexOf("?") + 1);
      const pathParam = new URLSearchParams(q).get("path");
      if (pathParam) p = pathParam;
    } catch {
      return null;
    }
  }
  if (p.startsWith("file://")) {
    try {
      p = decodeURIComponent(p.slice("file://".length));
    } catch {
      return null;
    }
  }
  const candidate = path.isAbsolute(p)
    ? path.normalize(p)
    : path.resolve(workspaceDir, p);
  try {
    const real = fs.realpathSync(candidate);
    if (!fs.statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

function fileUriForPath(filePath: string): string {
  return pathToFileURL(filePath).href;
}

function readImageBlock(filePath: string, mimeType: string): AcpPromptBlock | null {
  try {
    const buf = fs.readFileSync(filePath);
    return {
      type: "image",
      mimeType: mimeType || mimeFromFilename(filePath),
      data: buf.toString("base64"),
      uri: fileUriForPath(filePath),
    };
  } catch {
    return null;
  }
}

function readResourceBlock(
  filePath: string,
  name: string,
  mimeType: string,
): AcpPromptBlock | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    const uri = fileUriForPath(filePath);
    if (isTextLike(mimeType, name) && stat.size <= 512 * 1024) {
      const text = fs.readFileSync(filePath, "utf8");
      return {
        type: "resource",
        resource: { uri, mimeType, text },
      };
    }
    if (isTextLike(mimeType, name) && stat.size > 512 * 1024) {
      return {
        type: "resource_link",
        uri,
        name,
        mimeType,
        size: stat.size,
      };
    }
    if (isImageMime(mimeType)) {
      const buf = fs.readFileSync(filePath);
      return {
        type: "image",
        mimeType,
        data: buf.toString("base64"),
        uri,
      };
    }
    return {
      type: "resource_link",
      uri,
      name,
      mimeType,
      size: stat.size,
    };
  } catch {
    return null;
  }
}

function attachmentToBlock(
  att: ChatAttachmentRef,
  workspaceDir: string,
): AcpPromptBlock | null {
  const filePath = resolveAttachmentPath(att.path, workspaceDir);
  if (!filePath) return null;
  const mime = att.mimeType || mimeFromFilename(att.name);
  if (isImageMime(mime)) return readImageBlock(filePath, mime);
  return readResourceBlock(filePath, att.name, mime);
}

function imageUrlPartToBlock(
  part: any,
  workspaceDir: string,
): AcpPromptBlock | null {
  const raw =
    typeof part?.image_url === "string"
      ? part.image_url
      : typeof part?.image_url?.url === "string"
        ? part.image_url.url
        : typeof part?.url === "string"
          ? part.url
          : typeof part?.source?.data === "string"
            ? `data:${part.source.media_type ?? "image/png"};base64,${part.source.data}`
            : "";
  if (!raw) return null;

  const dataUrl = parseDataUrl(raw);
  if (dataUrl) {
    return {
      type: "image",
      mimeType: dataUrl.mimeType,
      data: dataUrl.data,
    };
  }

  const filePath = resolveAttachmentPath(raw, workspaceDir);
  if (!filePath) return null;
  return readImageBlock(filePath, mimeFromFilename(filePath));
}

function collectMessageBlocks(
  msg: any,
  workspaceDir: string,
  out: AcpPromptBlock[],
): void {
  const attachments = Array.isArray(msg?.attachments)
    ? (msg.attachments as ChatAttachmentRef[])
    : [];
  for (const att of attachments) {
    const block = attachmentToBlock(att, workspaceDir);
    if (block) out.push(block);
  }

  if (!Array.isArray(msg?.content)) return;
  for (const part of msg.content) {
    if (!part) continue;
    if (part.type === "image_url" || part.type === "image" || part.type === "input_image") {
      const block = imageUrlPartToBlock(part, workspaceDir);
      if (block) out.push(block);
    }
  }
}

/** Whether any message carries images or file attachments for multimodal ACP. */
export function messagesHaveMultimodalContent(messages: any[]): boolean {
  for (const m of messages ?? []) {
    if (Array.isArray(m?.attachments) && m.attachments.length > 0) return true;
    if (Array.isArray(m?.content)) {
      for (const p of m.content) {
        if (
          p?.type === "image_url" ||
          p?.type === "image" ||
          p?.type === "input_image"
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Build ACP prompt blocks: full text transcript plus media from the latest user turn.
 */
export function buildMultimodalAcpPrompt(
  messages: any[],
  textPrompt: string,
  workspaceDir: string,
): AcpPromptBlock[] {
  const blocks: AcpPromptBlock[] = [{ type: "text", text: textPrompt }];
  const lastUser = [...(messages ?? [])].reverse().find((m) => m?.role === "user");
  if (!lastUser) return blocks;

  const media: AcpPromptBlock[] = [];
  collectMessageBlocks(lastUser, workspaceDir, media);
  return blocks.concat(media);
}

/** Summarize attachments for plain-text prompts (CLI fallback). */
export function attachmentSummary(msg: any, workspaceDir?: string): string {
  const parts: string[] = [];
  if (Array.isArray(msg?.attachments)) {
    for (const a of msg.attachments as ChatAttachmentRef[]) {
      let loc = a.path;
      if (workspaceDir && loc.startsWith(workspaceDir)) {
        loc = path.relative(workspaceDir, loc) || loc;
      }
      parts.push(`${a.name} (${loc})`);
    }
  }
  return parts.length ? `[Attachments: ${parts.join(", ")}]` : "";
}
