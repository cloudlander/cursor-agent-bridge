import * as fs from "node:fs";
import type * as http from "node:http";
import * as path from "node:path";

import { BodyTooLargeError } from "./http.js";

export class MultipartUploadError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "MultipartUploadError";
  }
}

export type MultipartSavedFile = {
  filename: string;
  mimeType: string;
  bytesWritten: number;
};

function parseBoundary(contentType: string | undefined): string | null {
  if (!contentType) return null;
  const ct = Array.isArray(contentType) ? contentType[0] : contentType;
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(ct);
  return m ? (m[1] ?? m[2]).trim() : null;
}

function parsePartHeaders(headerText: string): {
  disposition: Record<string, string>;
  contentType: string;
} {
  const lines = headerText.split(/\r\n/);
  let contentType = "application/octet-stream";
  const disposition: Record<string, string> = {};
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (name === "content-type") contentType = val.split(";")[0].trim();
    if (name === "content-disposition") {
      const parts = val.split(";").map((p) => p.trim());
      const type = parts[0]?.toLowerCase();
      if (type) disposition.type = type;
      for (const p of parts.slice(1)) {
        const eq = p.indexOf("=");
        if (eq < 0) continue;
        const key = p.slice(0, eq).trim().toLowerCase();
        let v = p.slice(eq + 1).trim();
        if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
        disposition[key] = v;
      }
    }
  }
  return { disposition, contentType };
}

async function readRequestBuffer(
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    total += chunk.length;
    if (total > maxBytes) {
      req.destroy();
      throw new BodyTooLargeError("Request body too large", "payload_too_large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function extractMultipartField(
  body: Buffer,
  boundary: string,
  fieldName: string,
): { filename: string; mimeType: string; data: Buffer } | null {
  const text = body.toString("latin1");
  const sections = text.split(`--${boundary}`);
  for (let i = 1; i < sections.length; i++) {
    let section = sections[i];
    if (!section || section.startsWith("--")) break;
    if (section.startsWith("\r\n")) section = section.slice(2);
    const headerEnd = section.indexOf("\r\n\r\n");
    if (headerEnd < 0) continue;
    const headerText = section.slice(0, headerEnd);
    let dataStr = section.slice(headerEnd + 4);
    if (dataStr.endsWith("\r\n")) dataStr = dataStr.slice(0, -2);
    const parsed = parsePartHeaders(headerText);
    if (parsed.disposition.name !== fieldName) continue;
    return {
      filename: parsed.disposition.filename ?? "upload",
      mimeType: parsed.contentType,
      data: Buffer.from(dataStr, "latin1"),
    };
  }
  return null;
}

/**
 * Read one multipart field and persist it to disk (raw bytes, no base64).
 */
export async function saveMultipartFieldToFile(
  req: http.IncomingMessage,
  fieldName: string,
  destPath: string,
  maxBytes: number,
): Promise<MultipartSavedFile> {
  const boundary = parseBoundary(req.headers["content-type"]);
  if (!boundary) {
    throw new MultipartUploadError(
      "multipart/form-data with boundary required",
      400,
      "invalid_request",
    );
  }

  const body = await readRequestBuffer(req, maxBytes + 256 * 1024);
  const field = extractMultipartField(body, boundary, fieldName);
  if (!field || field.data.length === 0) {
    throw new MultipartUploadError(
      `multipart field "${fieldName}" required`,
      400,
      "invalid_request",
    );
  }
  if (field.data.length > maxBytes) {
    throw new BodyTooLargeError(
      `File exceeds ${maxBytes} byte limit`,
      "payload_too_large",
    );
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, field.data);
  return {
    filename: field.filename,
    mimeType: field.mimeType,
    bytesWritten: field.data.length,
  };
}
