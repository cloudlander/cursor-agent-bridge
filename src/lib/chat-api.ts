import type * as http from "node:http";

import type { BridgeConfig } from "./config.js";
import { MAX_UPLOAD_BYTES, saveChatUpload } from "./chat-attachments.js";
import {
  deleteWebThread,
  getChatSession,
  listChatSessions,
  migrateLocalThreads,
  saveWebThreads,
  type WebChatThread,
} from "./chat-store.js";
import { json, readBody } from "./http.js";
import { resolveWorkspace } from "./workspace.js";
import {
  abortWebGeneration,
  getGeneration,
  listActiveGenerations,
  writeGenerationSse,
} from "./web-chat-generation.js";

export function chatApiMatches(req: http.IncomingMessage): boolean {
  const pathname = (req.url ?? "").split("?")[0] ?? "";
  if (!pathname.startsWith("/api/chat/")) return false;
  return (
    req.method === "GET" ||
    req.method === "PUT" ||
    req.method === "POST" ||
    req.method === "DELETE"
  );
}

function attachmentPublicUrl(filePath: string): string {
  return `/api/workspace-file?path=${encodeURIComponent(filePath)}`;
}

function sessionIdFromPath(pathname: string): string | null {
  const prefix = "/api/chat/threads/";
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  if (!rest || rest.includes("/")) return null;
  return decodeURIComponent(rest);
}

function generationIdFromPath(pathname: string): string | null {
  const prefix = "/api/chat/generations/";
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  if (!rest) return null;
  const [id, action] = rest.split("/");
  if (!id || id.includes("..")) return null;
  if (action && action !== "stream") return null;
  return decodeURIComponent(id);
}

export async function handleChatApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: BridgeConfig,
): Promise<void> {
  const pathname = (req.url ?? "").split("?")[0] ?? "";

  if (req.method === "GET" && pathname === "/api/chat/generations") {
    json(res, 200, { active: listActiveGenerations() });
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/api/chat/generations/")) {
    const threadId = generationIdFromPath(pathname);
    if (!threadId) {
      json(res, 404, { error: { message: "Not found", code: "not_found" } });
      return;
    }
    const isStream = pathname.endsWith("/stream");
    if (isStream) {
      writeGenerationSse(res, threadId);
      return;
    }
    const gen = getGeneration(threadId);
    if (!gen) {
      json(res, 404, { error: { message: "Generation not found", code: "not_found" } });
      return;
    }
    json(res, 200, { generation: gen });
    return;
  }

  if (req.method === "DELETE" && pathname.startsWith("/api/chat/generations/")) {
    const threadId = generationIdFromPath(pathname);
    if (!threadId || pathname.endsWith("/stream")) {
      json(res, 404, { error: { message: "Not found", code: "not_found" } });
      return;
    }
    const stopped = abortWebGeneration(threadId);
    json(res, 200, { ok: true, stopped });
    return;
  }

  if (req.method === "GET" && pathname === "/api/chat/threads") {
    const data = await listChatSessions(config);
    json(res, 200, data);
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/api/chat/threads/")) {
    const id = sessionIdFromPath(pathname);
    if (!id) {
      json(res, 404, { error: { message: "Not found", code: "not_found" } });
      return;
    }
    const session = await getChatSession(config, id);
    if (!session) {
      json(res, 404, { error: { message: "Session not found", code: "not_found" } });
      return;
    }
    json(res, 200, { session });
    return;
  }

  if (req.method === "PUT" && pathname === "/api/chat/threads") {
    let body: { activeId?: string | null; threads?: WebChatThread[] };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      json(res, 400, { error: { message: "Invalid JSON", code: "invalid_json" } });
      return;
    }
    if (!Array.isArray(body.threads)) {
      json(res, 400, {
        error: { message: "threads array required", code: "invalid_request" },
      });
      return;
    }
    await saveWebThreads(config, {
      activeId: body.activeId ?? null,
      threads: body.threads,
    });
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && pathname === "/api/chat/upload") {
    let body: { filename?: string; mimeType?: string; data?: string };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      json(res, 400, { error: { message: "Invalid JSON", code: "invalid_json" } });
      return;
    }
    const filename = typeof body.filename === "string" ? body.filename.trim() : "";
    const dataB64 = typeof body.data === "string" ? body.data.trim() : "";
    if (!filename || !dataB64) {
      json(res, 400, {
        error: {
          message: "filename and base64 data required",
          code: "invalid_request",
        },
      });
      return;
    }
    let data: Buffer;
    try {
      data = Buffer.from(dataB64, "base64");
    } catch {
      json(res, 400, {
        error: { message: "Invalid base64 data", code: "invalid_request" },
      });
      return;
    }
    if (data.length === 0) {
      json(res, 400, {
        error: { message: "Empty file", code: "invalid_request" },
      });
      return;
    }
    if (data.length > MAX_UPLOAD_BYTES) {
      json(res, 413, {
        error: {
          message: `File exceeds ${MAX_UPLOAD_BYTES} byte limit`,
          code: "payload_too_large",
        },
      });
      return;
    }
    let workspaceDir: string;
    try {
      workspaceDir = resolveWorkspace(config, undefined, false).workspaceDir;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Invalid workspace";
      json(res, 400, { error: { message: msg, code: "invalid_workspace" } });
      return;
    }
    try {
      const saved = saveChatUpload(
        workspaceDir,
        filename,
        typeof body.mimeType === "string" ? body.mimeType : "",
        data,
      );
      json(res, 200, {
        attachment: {
          ...saved,
          url: attachmentPublicUrl(saved.path),
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      json(res, 500, { error: { message: msg, code: "upload_failed" } });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/chat/migrate") {
    let body: { threads?: WebChatThread[] };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      json(res, 400, { error: { message: "Invalid JSON", code: "invalid_json" } });
      return;
    }
    if (!Array.isArray(body.threads)) {
      json(res, 400, {
        error: { message: "threads array required", code: "invalid_request" },
      });
      return;
    }
    const result = await migrateLocalThreads(config, body.threads);
    json(res, 200, result);
    return;
  }

  if (req.method === "DELETE" && pathname.startsWith("/api/chat/threads/")) {
    const id = sessionIdFromPath(pathname);
    if (!id) {
      json(res, 404, { error: { message: "Not found", code: "not_found" } });
      return;
    }
    const removed = await deleteWebThread(config, id);
    if (!removed) {
      json(res, 404, {
        error: {
          message: "Web thread not found (external sessions are read-only)",
          code: "not_found",
        },
      });
      return;
    }
    json(res, 200, { ok: true });
    return;
  }

  json(res, 404, { error: { message: "Not found", code: "not_found" } });
}
