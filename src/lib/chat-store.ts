import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { BridgeConfig } from "./config.js";
import { configDirsForAccountUsage } from "./cursor-account-snapshot.js";

export type ChatAttachment = {
  name: string;
  mimeType: string;
  path: string;
  url?: string;
  size?: number;
};

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  attachments?: ChatAttachment[];
  reasoning?: string;
  ts?: number;
  error?: boolean;
  /** Human-readable failure reason when `error` is set (content may still hold a partial reply). */
  errorDetail?: string;
  streaming?: boolean;
};

function messageHasPayload(m: ChatMessage): boolean {
  return !!(m.content?.trim() || m.attachments?.length);
}

export type ChatSessionSource = "web" | "api" | "cli" | "acp";

export type WebChatThread = {
  id: string;
  source: "web";
  title: string | null;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  model: string;
  mode: string;
  messages: ChatMessage[];
};

export type ChatSessionSummary = {
  id: string;
  source: ChatSessionSource;
  title: string;
  pinned?: boolean;
  createdAt: number;
  updatedAt: number;
  model?: string;
  mode?: string;
  messageCount: number;
  readOnly: boolean;
  cwd?: string;
  apiPath?: string;
};

export type ChatStoreFile = {
  version: 1;
  activeId: string | null;
  threads: WebChatThread[];
  apiSessions: ApiSessionRecord[];
};

export type ApiSessionRecord = {
  id: string;
  source: "api";
  api: "chat" | "responses" | "anthropic" | "web";
  apiPath: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model?: string;
  mode?: string;
  messages: ChatMessage[];
};

const STORE_VERSION = 1 as const;
const MAX_API_SESSIONS = 500;
const MAX_STORED_MESSAGES = 200;

class StoreMutex {
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

const storeMutex = new StoreMutex();

export function chatStorePath(config: BridgeConfig): string {
  return path.join(path.dirname(config.sessionsLogPath), "chat-store.json");
}

function defaultStore(): ChatStoreFile {
  return { version: STORE_VERSION, activeId: null, threads: [], apiSessions: [] };
}

function readStoreSync(storePath: string): ChatStoreFile {
  try {
    const raw = fs.readFileSync(storePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<ChatStoreFile>;
    if (parsed.version !== STORE_VERSION) return defaultStore();
    return {
      version: STORE_VERSION,
      activeId: typeof parsed.activeId === "string" ? parsed.activeId : null,
      threads: Array.isArray(parsed.threads) ? parsed.threads : [],
      apiSessions: Array.isArray(parsed.apiSessions) ? parsed.apiSessions : [],
    };
  } catch {
    return defaultStore();
  }
}

function writeStoreSync(storePath: string, store: ChatStoreFile): void {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const tmp = `${storePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
  fs.renameSync(tmp, storePath);
}

export async function readChatStore(config: BridgeConfig): Promise<ChatStoreFile> {
  return storeMutex.run(() => readStoreSync(chatStorePath(config)));
}

export async function writeChatStore(
  config: BridgeConfig,
  store: ChatStoreFile,
): Promise<void> {
  return storeMutex.run(() => {
    writeStoreSync(chatStorePath(config), store);
  });
}

function truncateTitle(text: string, max = 48): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return "New chat";
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function extractUserQuery(text: string): string {
  const match = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  if (match) return match[1].trim();
  const viaIdx = text.indexOf("User:");
  if (viaIdx >= 0) {
    const tail = text.slice(viaIdx + 5).trim();
    const nextUser = tail.indexOf("\n\nUser:");
    return (nextUser >= 0 ? tail.slice(0, nextUser) : tail).trim();
  }
  return text.trim();
}

function messageTextFromTranscriptPart(
  part: { type?: string; text?: string },
): string {
  if (part.type === "text" && typeof part.text === "string") return part.text;
  return "";
}

function parseTranscriptLine(line: string): ChatMessage | null {
  let row: {
    role?: string;
    type?: string;
    message?: { content?: Array<{ type?: string; text?: string }> };
  };
  try {
    row = JSON.parse(line);
  } catch {
    return null;
  }
  if (row.type === "turn_ended") return null;
  const role = row.role;
  if (role !== "user" && role !== "assistant") return null;
  const parts = row.message?.content;
  if (!Array.isArray(parts)) return null;
  const textParts = parts
    .map(messageTextFromTranscriptPart)
    .filter((t) => t.length > 0);
  if (!textParts.length) return null;
  let content = textParts.join("\n\n");
  if (role === "user") content = extractUserQuery(content);
  if (!content.trim()) return null;
  return { role, content: content.trim() };
}

export function parseAgentTranscript(content: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const msg = parseTranscriptLine(trimmed);
    if (!msg) continue;
    const prev = messages[messages.length - 1];
    if (prev && prev.role === msg.role) {
      prev.content = `${prev.content}\n\n${msg.content}`;
    } else {
      messages.push(msg);
    }
  }
  return messages;
}

function inferSessionSource(
  firstUserText: string,
  apiPath?: string,
): ChatSessionSource {
  if (apiPath?.startsWith("/v1/") || apiPath === "/api/agent/chat") return "api";
  if (/via cursor-api-proxy|cursor-api-proxy →/i.test(firstUserText)) return "api";
  return "cli";
}

function webThreadSummary(thread: WebChatThread): ChatSessionSummary {
  const firstUserMsg = thread.messages.find((m) => m.role === "user");
  const firstUser =
    firstUserMsg?.content?.trim() ||
    firstUserMsg?.attachments?.[0]?.name ||
    "";
  const title =
    thread.title ||
    (firstUser ? truncateTitle(firstUser) : "New chat");
  return {
    id: thread.id,
    source: "web",
    title,
    pinned: thread.pinned,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    model: thread.model || undefined,
    mode: thread.mode || undefined,
    messageCount: thread.messages.filter((m) => !m.streaming && messageHasPayload(m)).length,
    readOnly: false,
  };
}

function apiSessionSummary(record: ApiSessionRecord): ChatSessionSummary {
  return {
    id: record.id,
    source: "api",
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    model: record.model,
    mode: record.mode,
    messageCount: record.messages.length,
    readOnly: true,
    apiPath: record.apiPath,
  };
}

type DiscoveredSession = ChatSessionSummary & {
  messages?: ChatMessage[];
  transcriptPath?: string;
};

function cursorRoots(config: BridgeConfig): string[] {
  return configDirsForAccountUsage(config.configDirs);
}

function discoverAgentTranscripts(config: BridgeConfig): DiscoveredSession[] {
  const out: DiscoveredSession[] = [];
  const seen = new Set<string>();

  for (const root of cursorRoots(config)) {
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
        seen.add(sessionId);
        let stat: fs.Stats;
        let raw: string;
        try {
          stat = fs.statSync(jsonlPath);
          raw = fs.readFileSync(jsonlPath, "utf8");
        } catch {
          continue;
        }
        const messages = parseAgentTranscript(raw);
        const firstUser = messages.find((m) => m.role === "user")?.content ?? "";
        const source = inferSessionSource(firstUser);
        out.push({
          id: sessionId,
          source,
          title: truncateTitle(firstUser || sessionId.slice(0, 8)),
          createdAt: stat.birthtimeMs || stat.mtimeMs,
          updatedAt: stat.mtimeMs,
          messageCount: messages.length,
          readOnly: true,
          messages,
          transcriptPath: jsonlPath,
        });
      }
    }
  }
  return out;
}

function discoverAcpSessions(config: BridgeConfig): DiscoveredSession[] {
  const out: DiscoveredSession[] = [];
  const seen = new Set<string>();

  for (const root of cursorRoots(config)) {
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
      seen.add(sessionId);
      let stat: fs.Stats;
      let meta: { title?: string; cwd?: string };
      try {
        stat = fs.statSync(metaPath);
        meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as {
          title?: string;
          cwd?: string;
        };
      } catch {
        continue;
      }
      out.push({
        id: sessionId,
        source: "acp",
        title: meta.title?.trim() || sessionId.slice(0, 8),
        createdAt: stat.birthtimeMs || stat.mtimeMs,
        updatedAt: stat.mtimeMs,
        messageCount: 0,
        readOnly: true,
        cwd: meta.cwd,
      });
    }
  }
  return out;
}

function mergeDiscoveredSessions(discovered: DiscoveredSession[]): DiscoveredSession[] {
  const byId = new Map<string, DiscoveredSession>();
  for (const item of discovered) {
    const prev = byId.get(item.id);
    if (!prev) {
      byId.set(item.id, item);
      continue;
    }
    // Prefer transcript-backed entry (has messages).
    if ((item.messages?.length ?? 0) > (prev.messages?.length ?? 0)) {
      byId.set(item.id, { ...prev, ...item, title: item.title || prev.title });
    } else {
      byId.set(item.id, { ...item, ...prev, title: prev.title || item.title });
    }
  }
  return [...byId.values()];
}

export async function listChatSessions(
  config: BridgeConfig,
): Promise<{
  activeId: string | null;
  threads: WebChatThread[];
  sessions: ChatSessionSummary[];
}> {
  const store = await readChatStore(config);
  const webSummaries = store.threads.map(webThreadSummary);
  const webIds = new Set(webSummaries.map((s) => s.id));

  const discovered = mergeDiscoveredSessions([
    ...discoverAgentTranscripts(config),
    ...discoverAcpSessions(config),
  ]).filter((s) => !webIds.has(s.id));

  const apiSummaries = store.apiSessions
    .filter((s) => !webIds.has(s.id))
    .map(apiSessionSummary);

  const discoveredSummaries = discovered.map(({ messages: _m, transcriptPath: _p, ...rest }) => rest);

  const sessions = [...webSummaries, ...apiSummaries, ...discoveredSummaries]
    .filter((s) => s.messageCount > 0)
    .sort((a, b) => b.createdAt - a.createdAt);

  return { activeId: store.activeId, threads: store.threads, sessions };
}

export async function getChatSession(
  config: BridgeConfig,
  id: string,
): Promise<(WebChatThread | ApiSessionRecord | DiscoveredSession) | null> {
  const store = await readChatStore(config);
  const web = store.threads.find((t) => t.id === id);
  if (web) return web;

  const api = store.apiSessions.find((s) => s.id === id);
  if (api) return api;

  const discovered = mergeDiscoveredSessions([
    ...discoverAgentTranscripts(config),
    ...discoverAcpSessions(config),
  ]);
  return discovered.find((s) => s.id === id) ?? null;
}

function findWebThread(store: ChatStoreFile, threadId: string): WebChatThread | undefined {
  return store.threads.find((t) => t.id === threadId);
}

function lastAssistantMessage(thread: WebChatThread): ChatMessage | undefined {
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    if (thread.messages[i].role === "assistant") return thread.messages[i];
  }
  return undefined;
}

export async function updateWebThreadAssistantProgress(
  config: BridgeConfig,
  threadId: string,
  update: {
    content?: string;
    reasoning?: string;
    streaming?: boolean;
    error?: boolean;
  },
): Promise<void> {
  await storeMutex.run(() => {
    const storePath = chatStorePath(config);
    const store = readStoreSync(storePath);
    const thread = findWebThread(store, threadId);
    if (!thread) return;
    let msg = lastAssistantMessage(thread);
    if (!msg || !msg.streaming) {
      msg = { role: "assistant", content: "", streaming: true };
      thread.messages.push(msg);
    }
    if (update.content !== undefined) msg.content = update.content;
    if (update.reasoning !== undefined) msg.reasoning = update.reasoning;
    if (update.streaming !== undefined) msg.streaming = update.streaming;
    if (update.error !== undefined) msg.error = update.error;
    thread.updatedAt = Date.now();
    writeStoreSync(storePath, store);
  });
}

export async function finalizeWebThreadAssistant(
  config: BridgeConfig,
  threadId: string,
  update: {
    content: string;
    reasoning?: string;
    error?: string;
  },
): Promise<void> {
  await storeMutex.run(() => {
    const storePath = chatStorePath(config);
    const store = readStoreSync(storePath);
    const thread = findWebThread(store, threadId);
    if (!thread) return;
    let msg = lastAssistantMessage(thread);
    if (!msg) {
      msg = { role: "assistant", content: "", streaming: false, ts: Date.now() };
      thread.messages.push(msg);
    }
    msg.content = update.content || (update.error ? update.error : "(empty reply)");
    if (update.reasoning) msg.reasoning = update.reasoning;
    msg.streaming = false;
    msg.error = !!update.error;
    if (update.error) msg.errorDetail = update.error;
    else delete msg.errorDetail;
    msg.ts = Date.now();
    thread.updatedAt = Date.now();
    writeStoreSync(storePath, store);
  });
}

function normalizeWebThread(t: WebChatThread): WebChatThread {
  return {
    ...t,
    source: "web" as const,
    messages: (t.messages ?? []).slice(-MAX_STORED_MESSAGES),
  };
}

function stableMessageCount(messages: ChatMessage[]): number {
  return messages.filter((m) => !m.streaming && messageHasPayload(m)).length;
}

/** Prefer the copy with newer metadata or more durable message history. */
export function mergeWebThreadPair(
  existing: WebChatThread,
  incoming: WebChatThread,
): WebChatThread {
  const a = normalizeWebThread(existing);
  const b = normalizeWebThread(incoming);
  const aUpdated = a.updatedAt ?? 0;
  const bUpdated = b.updatedAt ?? 0;
  if (bUpdated !== aUpdated) return bUpdated > aUpdated ? b : a;
  const aStable = stableMessageCount(a.messages);
  const bStable = stableMessageCount(b.messages);
  if (bStable !== aStable) return bStable > aStable ? b : a;
  return (b.messages?.length ?? 0) >= (a.messages?.length ?? 0) ? b : a;
}

export async function saveWebThreads(
  config: BridgeConfig,
  payload: { activeId?: string | null; threads: WebChatThread[] },
): Promise<void> {
  const store = await readChatStore(config);
  const byId = new Map(store.threads.map((t) => [t.id, t]));
  for (const raw of payload.threads) {
    const incoming = normalizeWebThread(raw);
    const prev = byId.get(incoming.id);
    byId.set(incoming.id, prev ? mergeWebThreadPair(prev, incoming) : incoming);
  }
  store.threads = [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  if (payload.activeId !== undefined) store.activeId = payload.activeId;
  await writeChatStore(config, store);
}

/** Persist user/assistant history from a web `/api/agent/chat` request (server source of truth). */
export async function syncWebThreadFromChatRequest(
  config: BridgeConfig,
  threadId: string,
  opts: {
    model?: string;
    mode?: string;
    messages: Array<{ role: string; content: string }>;
  },
): Promise<void> {
  const chatMessages: ChatMessage[] = opts.messages
    .filter(
      (m) =>
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim(),
    )
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content.trim(),
      ts: Date.now(),
    }));

  await storeMutex.run(() => {
    const storePath = chatStorePath(config);
    const store = readStoreSync(storePath);
    let thread = findWebThread(store, threadId);
    const now = Date.now();
    if (!thread) {
      thread = {
        id: threadId,
        source: "web",
        title: null,
        pinned: false,
        createdAt: now,
        updatedAt: now,
        model: opts.model ?? "",
        mode: opts.mode ?? "agent",
        messages: [],
      };
      store.threads.unshift(thread);
    }
    if (opts.model !== undefined) thread.model = opts.model;
    if (opts.mode !== undefined) thread.mode = opts.mode;

    const streamingAssistant = [...(thread.messages ?? [])]
      .reverse()
      .find((m) => m.role === "assistant" && m.streaming);

    thread.messages = chatMessages.slice(-MAX_STORED_MESSAGES);
    if (streamingAssistant) {
      const last = thread.messages[thread.messages.length - 1];
      if (last?.role !== "assistant" || !last.streaming) {
        thread.messages.push(streamingAssistant);
      }
    }
    thread.updatedAt = now;
    writeStoreSync(storePath, store);
  });
}

export async function deleteWebThread(
  config: BridgeConfig,
  id: string,
): Promise<boolean> {
  const store = await readChatStore(config);
  const before = store.threads.length;
  store.threads = store.threads.filter((t) => t.id !== id);
  if (store.activeId === id) {
    store.activeId = store.threads[0]?.id ?? null;
  }
  if (store.threads.length === before) return false;
  await writeChatStore(config, store);
  return true;
}

export async function migrateLocalThreads(
  config: BridgeConfig,
  imported: WebChatThread[],
): Promise<{ merged: number }> {
  const store = await readChatStore(config);
  const existingIds = new Set(store.threads.map((t) => t.id));
  let merged = 0;
  for (const thread of imported) {
    if (existingIds.has(thread.id)) continue;
    store.threads.push({ ...thread, source: "web" });
    existingIds.add(thread.id);
    merged++;
  }
  store.threads.sort((a, b) => b.updatedAt - a.updatedAt);
  await writeChatStore(config, store);
  return { merged };
}

export async function recordApiSession(
  config: BridgeConfig,
  opts: {
    api: ApiSessionRecord["api"];
    apiPath: string;
    model?: string;
    mode?: string;
    messages: Array<{ role: string; content: string }>;
    assistantText: string;
    sessionId?: string;
  },
): Promise<void> {
  const userMessages = opts.messages.filter(
    (m) => m.role === "user" && m.content.trim(),
  );
  const firstUser = userMessages[0]?.content ?? "";
  const title = truncateTitle(extractUserQuery(firstUser) || firstUser || opts.apiPath);
  const now = Date.now();
  const messages: ChatMessage[] = [
    ...opts.messages
      .filter((m) => (m.role === "user" || m.role === "assistant") && m.content.trim())
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.role === "user" ? extractUserQuery(m.content) : m.content,
        ts: now,
      })),
  ];
  if (opts.assistantText.trim()) {
    const last = messages[messages.length - 1];
    if (last?.role === "assistant") {
      last.content = opts.assistantText.trim();
    } else {
      messages.push({ role: "assistant", content: opts.assistantText.trim(), ts: now });
    }
  }

  await storeMutex.run(() => {
    const storePath = chatStorePath(config);
    const store = readStoreSync(storePath);
    const id =
      opts.sessionId ??
      `api_${now}_${Math.random().toString(16).slice(2, 10)}`;
    const existing = store.apiSessions.find((s) => s.id === id);
    const record: ApiSessionRecord = existing
      ? {
          ...existing,
          title: existing.title || title,
          updatedAt: now,
          model: opts.model ?? existing.model,
          mode: opts.mode ?? existing.mode,
          messages: messages.slice(-MAX_STORED_MESSAGES),
        }
      : {
          id,
          source: "api",
          api: opts.api,
          apiPath: opts.apiPath,
          title,
          createdAt: now,
          updatedAt: now,
          model: opts.model,
          mode: opts.mode,
          messages: messages.slice(-MAX_STORED_MESSAGES),
        };

    store.apiSessions = [
      record,
      ...store.apiSessions.filter((s) => s.id !== id),
    ].slice(0, MAX_API_SESSIONS);
    writeStoreSync(storePath, store);
  });
}

/** Resolve Cursor data roots for tests and diagnostics. */
export function resolveCursorDataRoots(config: BridgeConfig): string[] {
  return cursorRoots(config);
}

/** Home directory used when no config dirs are set. */
export function defaultCursorHome(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
}
