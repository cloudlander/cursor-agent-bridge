import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import type { AcpPromptBlock } from "./acp-client.js";

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const UPLOADS_DIR = ".cursor-api-proxy/uploads";

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

function sanitizeFilename(name: string): string {
  const base = path.basename(name).replace(/[^\w.\-+() ]+/g, "_").trim();
  return base || "upload";
}

export function mimeFromFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return EXT_MIME[ext] ?? "application/octet-stream";
}

export function saveChatUpload(
  workspaceDir: string,
  filename: string,
  mimeType: string,
  data: Buffer,
): ChatAttachmentRef {
  if (data.length > MAX_UPLOAD_BYTES) {
    throw new Error(`File exceeds ${MAX_UPLOAD_BYTES} byte limit`);
  }
  const safeName = sanitizeFilename(filename);
  const dir = uploadsRoot(workspaceDir);
  fs.mkdirSync(dir, { recursive: true });
  const id = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const stored = `${id}-${safeName}`;
  const filePath = path.join(dir, stored);
  fs.writeFileSync(filePath, data);
  return {
    name: safeName,
    mimeType: mimeType || mimeFromFilename(safeName),
    path: filePath,
    size: data.length,
  };
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
export function attachmentSummary(msg: any): string {
  const parts: string[] = [];
  if (Array.isArray(msg?.attachments)) {
    for (const a of msg.attachments as ChatAttachmentRef[]) {
      parts.push(`${a.name} (${a.path})`);
    }
  }
  return parts.length ? `[Attachments: ${parts.join(", ")}]` : "";
}
