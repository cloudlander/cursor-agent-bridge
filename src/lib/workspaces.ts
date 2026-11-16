import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type * as http from "node:http";

import type { BridgeConfig } from "./config.js";
import { json, readBody } from "./http.js";
import { resolveWorkspace } from "./workspace.js";

export const DEFAULT_WORKSPACE_ID = "default";
const WORKSPACE_ID_RE = /^ws_[0-9a-f]{16}$/;
const NAME_MAX = 64;

export type WorkspaceRecord = {
  id: string;
  name: string;
  dirName: string | null;
  isDefault: boolean;
  createdAt: number;
};

type RegistryFile = {
  version: 1;
  workspaces: WorkspaceRecord[];
};

class RegistryMutex {
  #tail = Promise.resolve();

  run<T>(operation: () => Promise<T> | T): Promise<T> {
    const prior = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return prior.then(async () => {
      try {
        return await operation();
      } finally {
        release();
      }
    });
  }
}

const registryMutex = new RegistryMutex();

export function sessionsStateDir(config: BridgeConfig): string {
  return path.dirname(config.sessionsLogPath);
}

export function workspacesRegistryPath(config: BridgeConfig): string {
  return path.join(sessionsStateDir(config), "workspaces.json");
}

export function chatStoresDir(config: BridgeConfig): string {
  return path.join(sessionsStateDir(config), "chat-stores");
}

export function apiSessionsPath(config: BridgeConfig): string {
  return path.join(sessionsStateDir(config), "api-sessions.json");
}

export function legacyChatStorePath(config: BridgeConfig): string {
  return path.join(sessionsStateDir(config), "chat-store.json");
}

export function userWorkspacesRoot(config: BridgeConfig): string {
  return path.join(sessionsStateDir(config), "workspaces");
}

export function isWorkspaceId(id: string): boolean {
  return id === DEFAULT_WORKSPACE_ID || WORKSPACE_ID_RE.test(id);
}

export function workspaceChatStorePath(config: BridgeConfig, id: string): string {
  if (!isWorkspaceId(id)) throw new Error("Invalid workspace id");
  return path.join(chatStoresDir(config), `${id}.json`);
}

/** Strip surrounding whitespace and control characters. Empty or over 64 chars is rejected. */
export function normalizeWorkspaceName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/[\u0000-\u001F\u007F\u0080-\u009F]/g, "").trim();
  if (!cleaned || cleaned.length > NAME_MAX) return null;
  return cleaned;
}

function defaultRecord(now = Date.now()): WorkspaceRecord {
  return {
    id: DEFAULT_WORKSPACE_ID,
    name: "Default",
    dirName: null,
    isDefault: true,
    createdAt: now,
  };
}

function isRecord(value: unknown): value is WorkspaceRecord {
  if (!value || typeof value !== "object") return false;
  const row = value as WorkspaceRecord;
  if (typeof row.id !== "string" || !isWorkspaceId(row.id)) return false;
  if (typeof row.name !== "string" || !row.name.trim() || row.name.length > NAME_MAX) return false;
  if (row.isDefault) {
    return row.id === DEFAULT_WORKSPACE_ID && row.dirName == null;
  }
  return row.dirName === row.id && WORKSPACE_ID_RE.test(row.id);
}

function sortRecords(records: WorkspaceRecord[]): WorkspaceRecord[] {
  return [...records].sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.createdAt - b.createdAt;
  });
}

function writeRegistrySync(filePath: string, records: WorkspaceRecord[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload: RegistryFile = { version: 1, workspaces: sortRecords(records) };
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

function readRegistrySync(config: BridgeConfig): WorkspaceRecord[] {
  const filePath = workspacesRegistryPath(config);
  let records: WorkspaceRecord[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<RegistryFile>;
    if (Array.isArray(parsed.workspaces)) {
      records = parsed.workspaces.filter(isRecord);
    }
  } catch {
    records = [];
  }
  if (!records.some((row) => row.isDefault)) {
    records.unshift(defaultRecord());
    writeRegistrySync(filePath, records);
  }
  return sortRecords(records);
}

export async function listWorkspaces(config: BridgeConfig): Promise<WorkspaceRecord[]> {
  return registryMutex.run(() => readRegistrySync(config));
}

export async function getWorkspace(
  config: BridgeConfig,
  id: string,
): Promise<WorkspaceRecord | null> {
  if (!isWorkspaceId(id)) return null;
  const records = await listWorkspaces(config);
  return records.find((row) => row.id === id) ?? null;
}

/** Missing or unknown ids resolve to the default workspace. */
export async function resolveWorkspaceRecord(
  config: BridgeConfig,
  id: string | null | undefined,
): Promise<WorkspaceRecord> {
  const records = await listWorkspaces(config);
  const wanted = typeof id === "string" ? id.trim() : "";
  if (!wanted) return records.find((row) => row.isDefault) ?? defaultRecord();
  return records.find((row) => row.id === wanted) ?? records.find((row) => row.isDefault) ?? defaultRecord();
}

function containedPath(root: string, target: string): string {
  const realRoot = fs.realpathSync(root);
  const realTarget = fs.realpathSync(target);
  const rel = path.relative(realRoot, realTarget);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Workspace directory escapes the workspaces root");
  }
  return realTarget;
}

export function ensureUserWorkspaceDir(
  config: BridgeConfig,
  record: WorkspaceRecord,
): string {
  if (!record.dirName || record.dirName !== record.id || !WORKSPACE_ID_RE.test(record.dirName)) {
    throw new Error("Invalid workspace directory");
  }
  const root = userWorkspacesRoot(config);
  fs.mkdirSync(root, { recursive: true });
  const dir = path.join(root, record.dirName);
  fs.mkdirSync(dir, { recursive: true });
  return containedPath(root, dir);
}

export function workspaceIdForAgentCwd(
  config: BridgeConfig,
  cwd: string | undefined,
  records: WorkspaceRecord[],
): string {
  if (!cwd?.trim()) return DEFAULT_WORKSPACE_ID;
  let real: string;
  try {
    const resolved = path.resolve(cwd);
    real = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
  } catch {
    return DEFAULT_WORKSPACE_ID;
  }
  const root = userWorkspacesRoot(config);
  for (const record of records) {
    if (!record.dirName || record.isDefault) continue;
    const dir = path.join(root, record.dirName);
    let realDir = dir;
    try {
      if (!fs.existsSync(dir)) continue;
      realDir = fs.realpathSync(dir);
    } catch {
      continue;
    }
    const rel = path.relative(realDir, real);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return record.id;
  }
  return DEFAULT_WORKSPACE_ID;
}

export type ResolvedAgentWorkspace = {
  record: WorkspaceRecord;
  workspaceDir: string;
  tempDir?: string;
};

/**
 * Web chat resolves cwd from a workspace id. API clients keep using
 * `X-Cursor-Workspace`, which must stay under `config.workspace`.
 * Chat-only mode still uses a temp directory.
 */
export async function resolveAgentWorkspace(
  config: BridgeConfig,
  opts: {
    workspaceId?: string | null;
    headerWs?: string | string[] | null;
    chatOnly: boolean;
    fromWebChat: boolean;
  },
): Promise<ResolvedAgentWorkspace> {
  if (opts.chatOnly) {
    const record = opts.fromWebChat
      ? await resolveWorkspaceRecord(config, opts.workspaceId)
      : await resolveWorkspaceRecord(config, undefined);
    const ws = resolveWorkspace(
      config,
      opts.fromWebChat ? undefined : opts.headerWs,
      true,
    );
    return { record, workspaceDir: ws.workspaceDir, tempDir: ws.tempDir };
  }
  if (!opts.fromWebChat) {
    const record = await resolveWorkspaceRecord(config, undefined);
    const ws = resolveWorkspace(config, opts.headerWs, false);
    return { record, workspaceDir: ws.workspaceDir };
  }
  const record = await resolveWorkspaceRecord(config, opts.workspaceId);
  if (record.isDefault || !record.dirName) {
    return { record, workspaceDir: path.resolve(config.workspace) };
  }
  return { record, workspaceDir: ensureUserWorkspaceDir(config, record) };
}

export async function createWorkspace(
  config: BridgeConfig,
  name: unknown,
): Promise<WorkspaceRecord> {
  const cleaned = normalizeWorkspaceName(name);
  if (!cleaned) throw new Error("Workspace name must be 1–64 characters");
  return registryMutex.run(() => {
    const records = readRegistrySync(config);
    const id = `ws_${crypto.randomBytes(8).toString("hex")}`;
    const record: WorkspaceRecord = {
      id,
      name: cleaned,
      dirName: id,
      isDefault: false,
      createdAt: Date.now(),
    };
    ensureUserWorkspaceDir(config, record);
    records.push(record);
    writeRegistrySync(workspacesRegistryPath(config), records);
    return record;
  });
}

export async function renameWorkspace(
  config: BridgeConfig,
  id: string,
  name: unknown,
): Promise<WorkspaceRecord> {
  const cleaned = normalizeWorkspaceName(name);
  if (!cleaned) throw new Error("Workspace name must be 1–64 characters");
  if (!isWorkspaceId(id)) throw new Error("Workspace not found");
  return registryMutex.run(() => {
    const records = readRegistrySync(config);
    const record = records.find((row) => row.id === id);
    if (!record) throw new Error("Workspace not found");
    record.name = cleaned;
    writeRegistrySync(workspacesRegistryPath(config), records);
    return record;
  });
}

export async function deleteWorkspace(
  config: BridgeConfig,
  id: string,
): Promise<void> {
  if (id === DEFAULT_WORKSPACE_ID) throw new Error("The default workspace cannot be deleted");
  if (!isWorkspaceId(id)) throw new Error("Workspace not found");
  return registryMutex.run(() => {
    const records = readRegistrySync(config);
    const record = records.find((row) => row.id === id);
    if (!record || record.isDefault) throw new Error("Workspace not found");
    const storePath = workspaceChatStorePath(config, id);
    if (fs.existsSync(storePath)) fs.rmSync(storePath, { force: true });
    if (record.dirName) {
      const root = userWorkspacesRoot(config);
      const dir = path.join(root, record.dirName);
      if (fs.existsSync(dir)) {
        const real = containedPath(root, dir);
        fs.rmSync(real, { recursive: true, force: true });
      }
    }
    writeRegistrySync(
      workspacesRegistryPath(config),
      records.filter((row) => row.id !== id),
    );
  });
}

export function workspaceApiMatches(req: http.IncomingMessage): boolean {
  const pathname = (req.url ?? "").split("?")[0] ?? "";
  if (pathname !== "/api/workspaces" && !pathname.startsWith("/api/workspaces/")) return false;
  return (
    req.method === "GET" ||
    req.method === "POST" ||
    req.method === "PATCH" ||
    req.method === "DELETE"
  );
}

function workspaceIdFromPath(pathname: string): string | null {
  const prefix = "/api/workspaces/";
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  if (!rest || rest.includes("/")) return null;
  return decodeURIComponent(rest);
}

export async function handleWorkspaceApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: BridgeConfig,
): Promise<void> {
  const pathname = (req.url ?? "").split("?")[0] ?? "";

  if (req.method === "GET" && pathname === "/api/workspaces") {
    const workspaces = await listWorkspaces(config);
    json(res, 200, { workspaces });
    return;
  }

  if (req.method === "POST" && pathname === "/api/workspaces") {
    let body: { name?: unknown };
    try {
      body = JSON.parse(await readBody(req)) as { name?: unknown };
    } catch {
      json(res, 400, { error: { message: "Invalid JSON", code: "invalid_json" } });
      return;
    }
    try {
      const workspace = await createWorkspace(config, body.name);
      json(res, 200, { workspace });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid workspace";
      json(res, 400, { error: { message, code: "invalid_request" } });
      return;
    }
  }

  const id = workspaceIdFromPath(pathname);
  if (!id) {
    json(res, 404, { error: { message: "Not found", code: "not_found" } });
    return;
  }

  if (req.method === "PATCH") {
    let body: { name?: unknown };
    try {
      body = JSON.parse(await readBody(req)) as { name?: unknown };
    } catch {
      json(res, 400, { error: { message: "Invalid JSON", code: "invalid_json" } });
      return;
    }
    try {
      const workspace = await renameWorkspace(config, id, body.name);
      json(res, 200, { workspace });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid workspace";
      const status = message === "Workspace not found" ? 404 : 400;
      json(res, status, { error: { message, code: status === 404 ? "not_found" : "invalid_request" } });
    }
    return;
  }

  if (req.method === "DELETE") {
    try {
      await deleteWorkspace(config, id);
      json(res, 200, { ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid workspace";
      const status = message === "Workspace not found" ? 404 : 400;
      json(res, status, { error: { message, code: status === 404 ? "not_found" : "invalid_request" } });
    }
    return;
  }

  json(res, 404, { error: { message: "Not found", code: "not_found" } });
}
