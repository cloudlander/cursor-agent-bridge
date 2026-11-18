import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

import type { BridgeConfig } from "./config.js";
import {
  estimateContextWindowUsageFromMessages,
  extractContextUsageFromTranscript,
  type ContextWindowUsage,
} from "./acp-context-usage.js";
import { configDirsForAccountUsage } from "./cursor-account-snapshot.js";
import {
  DEFAULT_WORKSPACE_ID,
  apiSessionsPath,
  chatStoresDir,
  isWorkspaceId,
  legacyChatStorePath,
  listWorkspaces,
  workspaceChatStorePath,
  workspaceIdForAgentCwd,
} from "./workspaces.js";

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
  /** Wall-clock length of this assistant turn, in milliseconds. */
  durationMs?: number;
  /** Time from the first reasoning token until the answer starts (or the turn ends). */
  thinkMs?: number;
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
  /** Selected Cursor config directory for multi-account pools (web chat toolbar). */
  accountConfigDir?: string;
  messages: ChatMessage[];
  /** Latest model-reported context window fill (ACP `usage_update`). */
  contextWindowUsage?: ContextWindowUsage;
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
  /** Resolved agent cwd for this API call. Sidebar hint only; not a workspace id. */
  cwd?: string;
  messages: ChatMessage[];
};

export type WorkspaceChatStore = {
  version: 1;
  activeId: string | null;
  threads: WebChatThread[];
};

type ApiSessionsFile = {
  version: 1;
  sessions: ApiSessionRecord[];
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

const mutexes = new Map<string, StoreMutex>();
const migrationMutex = new StoreMutex();

function mutexFor(key: string): StoreMutex {
  let mutex = mutexes.get(key);
  if (!mutex) {
    mutex = new StoreMutex();
    mutexes.set(key, mutex);
  }
  return mutex;
}

/** Legacy combined path. New writes go to `chat-stores/` and `api-sessions.json`. */
export function chatStorePath(config: BridgeConfig): string {
  return legacyChatStorePath(config);
}

function emptyWorkspaceStore(): WorkspaceChatStore {
  return { version: STORE_VERSION, activeId: null, threads: [] };
}

function emptyApiSessions(): ApiSessionsFile {
  return { version: STORE_VERSION, sessions: [] };
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

function readWorkspaceStoreSync(filePath: string): WorkspaceChatStore {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<WorkspaceChatStore>;
    if (parsed.version !== STORE_VERSION) return emptyWorkspaceStore();
    return {
      version: STORE_VERSION,
      activeId: typeof parsed.activeId === "string" ? parsed.activeId : null,
      threads: Array.isArray(parsed.threads) ? parsed.threads : [],
    };
  } catch {
    return emptyWorkspaceStore();
  }
}

function readApiSessionsSync(filePath: string): ApiSessionsFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<ApiSessionsFile>;
    if (parsed.version !== STORE_VERSION) return emptyApiSessions();
    return {
      version: STORE_VERSION,
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    };
  } catch {
    return emptyApiSessions();
  }
}

/** One-shot, repeatable move from `chat-store.json` into the per-workspace files. */
function migrateLegacyChatStoreSync(config: BridgeConfig): void {
  const dest = workspaceChatStorePath(config, DEFAULT_WORKSPACE_ID);
  if (fs.existsSync(dest)) return;
  const legacy = legacyChatStorePath(config);
  if (!fs.existsSync(legacy)) return;
  let parsed: Partial<ChatStoreFile>;
  try {
    parsed = JSON.parse(fs.readFileSync(legacy, "utf8")) as Partial<ChatStoreFile>;
  } catch {
    return;
  }
  if (parsed.version !== STORE_VERSION) return;
  const threads = Array.isArray(parsed.threads) ? parsed.threads : [];
  const activeId = typeof parsed.activeId === "string" ? parsed.activeId : null;
  writeJsonAtomic(dest, {
    version: STORE_VERSION,
    activeId,
    threads,
  } satisfies WorkspaceChatStore);
  const apiPath = apiSessionsPath(config);
  if (!fs.existsSync(apiPath)) {
    const sessions = Array.isArray(parsed.apiSessions) ? parsed.apiSessions : [];
    writeJsonAtomic(apiPath, {
      version: STORE_VERSION,
      sessions,
    } satisfies ApiSessionsFile);
  }
  fs.renameSync(legacy, `${legacy}.migrated`);
}

async function ensureMigrated(config: BridgeConfig): Promise<void> {
  await migrationMutex.run(() => migrateLegacyChatStoreSync(config));
}

function workspaceStoreIdsSync(config: BridgeConfig): string[] {
  const dir = chatStoresDir(config);
  if (!fs.existsSync(dir)) return [];
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .filter((id) => isWorkspaceId(id));
}

function findWorkspaceIdForThreadSync(config: BridgeConfig, threadId: string): string | null {
  for (const id of workspaceStoreIdsSync(config)) {
    const store = readWorkspaceStoreSync(workspaceChatStorePath(config, id));
    if (store.threads.some((thread) => thread.id === threadId)) return id;
  }
  return null;
}

async function withWorkspaceStore<T>(
  config: BridgeConfig,
  workspaceId: string,
  operation: (store: WorkspaceChatStore, filePath: string) => T,
): Promise<T> {
  const id = isWorkspaceId(workspaceId) ? workspaceId : DEFAULT_WORKSPACE_ID;
  await ensureMigrated(config);
  return mutexFor(`store:${id}`).run(() => {
    const filePath = workspaceChatStorePath(config, id);
    const store = readWorkspaceStoreSync(filePath);
    return operation(store, filePath);
  });
}

export async function readWorkspaceChatStore(
  config: BridgeConfig,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<WorkspaceChatStore> {
  const id = isWorkspaceId(workspaceId) ? workspaceId : DEFAULT_WORKSPACE_ID;
  return readWorkspaceStore(config, id);
}

async function readWorkspaceStore(
  config: BridgeConfig,
  workspaceId: string,
): Promise<WorkspaceChatStore> {
  return withWorkspaceStore(config, workspaceId, (store) => store);
}

async function readApiSessions(config: BridgeConfig): Promise<ApiSessionRecord[]> {
  await ensureMigrated(config);
  return mutexFor("api").run(() => readApiSessionsSync(apiSessionsPath(config)).sessions);
}

/** Default-workspace threads plus API session history. */
export async function readChatStore(config: BridgeConfig): Promise<ChatStoreFile> {
  const [web, apiSessions] = await Promise.all([
    readWorkspaceStore(config, DEFAULT_WORKSPACE_ID),
    readApiSessions(config),
  ]);
  return {
    version: STORE_VERSION,
    activeId: web.activeId,
    threads: web.threads,
    apiSessions,
  };
}

export async function writeChatStore(
  config: BridgeConfig,
  store: ChatStoreFile,
): Promise<void> {
  await ensureMigrated(config);
  await mutexFor(`store:${DEFAULT_WORKSPACE_ID}`).run(() => {
    writeJsonAtomic(workspaceChatStorePath(config, DEFAULT_WORKSPACE_ID), {
      version: STORE_VERSION,
      activeId: store.activeId,
      threads: store.threads,
    } satisfies WorkspaceChatStore);
  });
  await mutexFor("api").run(() => {
    writeJsonAtomic(apiSessionsPath(config), {
      version: STORE_VERSION,
      sessions: store.apiSessions,
    } satisfies ApiSessionsFile);
  });
}

export async function listAllWebThreads(config: BridgeConfig): Promise<WebChatThread[]> {
  await ensureMigrated(config);
  const ids = workspaceStoreIdsSync(config);
  const threads: WebChatThread[] = [];
  for (const id of ids) {
    const store = await readWorkspaceStore(config, id);
    threads.push(...store.threads);
  }
  return threads;
}

const PLACEHOLDER_CHAT_TITLE = "New chat";

function truncateTitle(text: string, max = 48): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return PLACEHOLDER_CHAT_TITLE;
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Missing title, blank, or the sidebar placeholder — not an explicit rename. */
function isPlaceholderChatTitle(title: string | null | undefined): boolean {
  const t = title?.trim();
  return !t || t === PLACEHOLDER_CHAT_TITLE;
}

function autoTitleFromMessages(messages: ChatMessage[] | undefined): string | null {
  const first = messages?.find((m) => m.role === "user");
  const text = first?.content?.trim() || first?.attachments?.[0]?.name || "";
  if (!text) return null;
  const title = truncateTitle(text);
  return isPlaceholderChatTitle(title) ? null : title;
}

function storedWebThreadTitle(title: string | null | undefined): string | null {
  if (isPlaceholderChatTitle(title)) return null;
  return title!.trim();
}

function displayWebThreadTitle(thread: Pick<WebChatThread, "title" | "messages">): string {
  return storedWebThreadTitle(thread.title) || autoTitleFromMessages(thread.messages) || PLACEHOLDER_CHAT_TITLE;
}

function publishWebThread<T extends { title: string | null }>(thread: T): T {
  const title = storedWebThreadTitle(thread.title);
  if (title === thread.title) return thread;
  return { ...thread, title };
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

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function summarizeAgentTranscriptFile(jsonlPath: string): Promise<{
  messageCount: number;
  firstUser: string;
}> {
  const roles: Array<ChatMessage["role"]> = [];
  let firstUser = "";
  let lineNum = 0;
  const stream = fs.createReadStream(jsonlPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      lineNum++;
      const trimmed = line.trim();
      if (!trimmed) continue;
      const msg = parseTranscriptLine(trimmed);
      if (!msg) continue;
      if (msg.role === "user" && !firstUser) firstUser = msg.content;
      const prev = roles[roles.length - 1];
      if (prev === msg.role) continue;
      roles.push(msg.role);
      if (lineNum % 128 === 0) await yieldToEventLoop();
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { messageCount: roles.length, firstUser };
}

/** Line scan without retaining message bodies (for session list/catalog). */
export function summarizeAgentTranscript(content: string): {
  messageCount: number;
  firstUser: string;
} {
  const roles: Array<ChatMessage["role"]> = [];
  let firstUser = "";
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const msg = parseTranscriptLine(trimmed);
    if (!msg) continue;
    if (msg.role === "user" && !firstUser) firstUser = msg.content;
    const prev = roles[roles.length - 1];
    if (prev === msg.role) continue;
    roles.push(msg.role);
  }
  return { messageCount: roles.length, firstUser };
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
  const title = displayWebThreadTitle(thread);
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
    cwd: record.cwd,
  };
}

type DiscoveredSession = ChatSessionSummary & {
  messages?: ChatMessage[];
  transcriptPath?: string;
  contextWindowUsage?: ContextWindowUsage;
};

function cursorRoots(config: BridgeConfig): string[] {
  const roots = configDirsForAccountUsage(config.configDirs).map((dir) =>
    path.resolve(dir),
  );
  const seen = new Set(roots);
  // Adopted accounts are credential copies under ~/.cursor-api-proxy/accounts.
  // Interactive CLI history stays in the host Cursor dir (~/.cursor chats,
  // projects, acp-sessions). Keep scanning that dir after an account exists.
  for (const dir of hostCursorDataDirs()) {
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    roots.push(resolved);
  }
  return roots;
}

function isAccountPoolPath(dir: string): boolean {
  return dir.includes(`${path.sep}.cursor-api-proxy${path.sep}`);
}

/** Host Cursor data dirs that hold interactive CLI sessions. */
function hostCursorDataDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
  const candidates: string[] = [];
  const push = (dir: string | undefined) => {
    if (!dir?.trim()) return;
    const resolved = path.resolve(dir);
    if (isAccountPoolPath(resolved)) return;
    if (candidates.some((existing) => path.resolve(existing) === resolved)) return;
    candidates.push(resolved);
  };
  push(path.join(home, ".cursor"));
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg && !isAccountPoolPath(path.resolve(xdg))) {
    push(path.join(xdg, "cursor"));
  }
  push(path.join(home, ".config", "cursor"));
  const explicit = env.CURSOR_CONFIG_DIR?.trim();
  if (explicit) push(explicit);
  return candidates.filter((dir) => {
    try {
      return fs.existsSync(dir);
    } catch {
      return false;
    }
  });
}

function sessionStoreExists(sessionDir: string): boolean {
  return fs.existsSync(path.join(sessionDir, "store.db"));
}

type DiscoverAgentOptions = {
  /** Omit message bodies; only title + counts for list endpoints. */
  summariesOnly?: boolean;
};

async function discoverAgentTranscripts(
  config: BridgeConfig,
  options: DiscoverAgentOptions = {},
): Promise<DiscoveredSession[]> {
  const out: DiscoveredSession[] = [];
  const seen = new Set<string>();
  let filesScanned = 0;

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
        try {
          stat = fs.statSync(jsonlPath);
        } catch {
          continue;
        }
        filesScanned++;
        if (filesScanned % 6 === 0) await yieldToEventLoop();
        if (options.summariesOnly) {
          const { messageCount, firstUser } = await summarizeAgentTranscriptFile(jsonlPath);
          if (messageCount <= 0) continue;
          const source = inferSessionSource(firstUser);
          out.push({
            id: sessionId,
            source,
            title: truncateTitle(firstUser || sessionId.slice(0, 8)),
            createdAt: stat.birthtimeMs || stat.mtimeMs,
            updatedAt: stat.mtimeMs,
            messageCount,
            readOnly: true,
          });
        } else {
          let raw: string;
          try {
            raw = await fs.promises.readFile(jsonlPath, "utf8");
          } catch {
            continue;
          }
          const messages = parseAgentTranscript(raw);
          const contextWindowUsage = extractContextUsageFromTranscript(raw) ?? undefined;
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
            contextWindowUsage,
          });
        }
      }
    }
  }
  return out;
}

/** Plain `agent` chats: `chats/<workspace-hash>/<id>/meta.json`. */
function discoverCliChats(config: BridgeConfig): DiscoveredSession[] {
  const out: DiscoveredSession[] = [];
  const seen = new Set<string>();

  for (const root of cursorRoots(config)) {
    const chatsDir = path.join(root, "chats");
    if (!fs.existsSync(chatsDir)) continue;
    let projects: string[];
    try {
      projects = fs.readdirSync(chatsDir);
    } catch {
      continue;
    }
    for (const project of projects) {
      const projectDir = path.join(chatsDir, project);
      let sessionIds: string[];
      try {
        sessionIds = fs.readdirSync(projectDir);
      } catch {
        continue;
      }
      for (const sessionId of sessionIds) {
        if (seen.has(sessionId)) continue;
        const sessionDir = path.join(projectDir, sessionId);
        const metaPath = path.join(sessionDir, "meta.json");
        if (!fs.existsSync(metaPath)) continue;
        let meta: {
          title?: string;
          cwd?: string;
          createdAtMs?: number;
          updatedAtMs?: number;
          hasConversation?: boolean;
        };
        let stat: fs.Stats;
        try {
          stat = fs.statSync(metaPath);
          meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as typeof meta;
        } catch {
          continue;
        }
        if (meta.hasConversation !== true && !sessionStoreExists(sessionDir)) {
          continue;
        }
        seen.add(sessionId);
        const title = meta.title?.trim() || sessionId.slice(0, 8);
        out.push({
          id: sessionId,
          source: "cli",
          title,
          createdAt: meta.createdAtMs || stat.birthtimeMs || stat.mtimeMs,
          updatedAt: meta.updatedAtMs || stat.mtimeMs,
          messageCount: 1,
          readOnly: true,
          cwd: meta.cwd,
        });
      }
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

export type ListChatSessionsOptions = {
  /** Omit message bodies from web threads (lighter polling payloads). */
  compactThreads?: boolean;
  /** Workspace whose web threads to return. Missing or unknown ids use the default workspace. */
  workspaceId?: string;
};

export type WebChatThreadListEntry = Omit<WebChatThread, "messages"> & {
  messages?: ChatMessage[];
};

export async function listChatSessions(
  config: BridgeConfig,
  options: ListChatSessionsOptions = {},
): Promise<{
  activeId: string | null;
  threads: WebChatThreadListEntry[];
  sessions: ChatSessionSummary[];
  compact?: boolean;
}> {
  const records = await listWorkspaces(config);
  const requested = options.workspaceId?.trim();
  const record =
    (requested && records.find((row) => row.id === requested)) ||
    records.find((row) => row.isDefault) ||
    records[0];
  const workspaceId = record?.id ?? DEFAULT_WORKSPACE_ID;
  const store = await readWorkspaceStore(config, workspaceId);
  const webSummaries = store.threads.map(webThreadSummary);
  const webIds = new Set(webSummaries.map((s) => s.id));

  // ACP sessions keep their transcript in store.db, which this list does not
  // read. Including them puts empty threads in the sidebar.
  const discovered = mergeDiscoveredSessions([
    ...(await discoverAgentTranscripts(config, { summariesOnly: true })),
    ...discoverCliChats(config),
  ]).filter((session) => {
    if (webIds.has(session.id)) return false;
    return workspaceIdForAgentCwd(config, session.cwd, records) === workspaceId;
  });

  const apiSummaries =
    workspaceId === DEFAULT_WORKSPACE_ID
      ? (await readApiSessions(config))
          .filter((session) => !webIds.has(session.id))
          .map(apiSessionSummary)
      : [];

  const discoveredSummaries = discovered.map(({ messages: _m, transcriptPath: _p, ...rest }) => rest);

  const sessions = [...webSummaries, ...apiSummaries, ...discoveredSummaries]
    .filter((s) => s.messageCount > 0)
    .sort((a, b) => b.createdAt - a.createdAt);

  const threads: WebChatThreadListEntry[] = options.compactThreads
    ? store.threads.map((t) => {
        const { messages: _messages, ...meta } = enrichWebThreadContextUsage(t);
        return publishWebThread(meta);
      })
    : store.threads.map((t) => publishWebThread(enrichWebThreadContextUsage(t)));

  return {
    activeId: store.activeId,
    threads,
    sessions,
    ...(options.compactThreads ? { compact: true } : {}),
  };
}

export function enrichWebThreadContextUsage(thread: WebChatThread): WebChatThread {
  if (thread.contextWindowUsage?.source === "acp") return thread;
  const estimate = estimateContextWindowUsageFromMessages(
    thread.messages,
    thread.model,
  );
  if (!estimate) return thread;
  return { ...thread, contextWindowUsage: estimate };
}

export async function getChatSession(
  config: BridgeConfig,
  id: string,
): Promise<(WebChatThread | ApiSessionRecord | DiscoveredSession) | null> {
  await ensureMigrated(config);
  for (const workspaceId of workspaceStoreIdsSync(config)) {
    const store = await readWorkspaceStore(config, workspaceId);
    const web = store.threads.find((thread) => thread.id === id);
    if (web) return publishWebThread(enrichWebThreadContextUsage(web));
  }

  const api = (await readApiSessions(config)).find((session) => session.id === id);
  if (api) return api;

  const discovered = mergeDiscoveredSessions([
    ...(await discoverAgentTranscripts(config)),
    ...discoverCliChats(config),
  ]);
  const hit = discovered.find((s) => s.id === id) ?? null;
  if (!hit?.messages?.length || hit.contextWindowUsage?.source === "acp") {
    return hit;
  }
  const estimate = estimateContextWindowUsageFromMessages(
    hit.messages,
    hit.model,
  );
  if (!estimate) return hit;
  return { ...hit, contextWindowUsage: hit.contextWindowUsage ?? estimate };
}

function findWebThread(
  store: { threads: WebChatThread[] },
  threadId: string,
): WebChatThread | undefined {
  return store.threads.find((t) => t.id === threadId);
}

async function mutateWorkspaceThread(
  config: BridgeConfig,
  threadId: string,
  workspaceId: string | undefined,
  mutate: (thread: WebChatThread) => void,
): Promise<void> {
  await ensureMigrated(config);
  const id =
    workspaceId && isWorkspaceId(workspaceId)
      ? workspaceId
      : findWorkspaceIdForThreadSync(config, threadId) ?? DEFAULT_WORKSPACE_ID;
  await mutexFor(`store:${id}`).run(() => {
    const filePath = workspaceChatStorePath(config, id);
    const store = readWorkspaceStoreSync(filePath);
    const thread = findWebThread(store, threadId);
    if (!thread) return;
    mutate(thread);
    writeJsonAtomic(filePath, store);
  });
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
  workspaceId?: string,
): Promise<void> {
  await mutateWorkspaceThread(config, threadId, workspaceId, (thread) => {
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
  });
}

export async function updateWebThreadContextUsage(
  config: BridgeConfig,
  threadId: string,
  usage: ContextWindowUsage,
  workspaceId?: string,
): Promise<void> {
  await mutateWorkspaceThread(config, threadId, workspaceId, (thread) => {
    thread.contextWindowUsage = usage;
    thread.updatedAt = Date.now();
  });
}

export async function finalizeWebThreadAssistant(
  config: BridgeConfig,
  threadId: string,
  update: {
    content: string;
    reasoning?: string;
    error?: string;
    durationMs?: number;
    thinkMs?: number;
  },
  workspaceId?: string,
): Promise<void> {
  await mutateWorkspaceThread(config, threadId, workspaceId, (thread) => {
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
    if (typeof update.durationMs === "number") msg.durationMs = update.durationMs;
    if (typeof update.thinkMs === "number") msg.thinkMs = update.thinkMs;
    else delete msg.thinkMs;
    thread.updatedAt = Date.now();
  });
}

function normalizeWebThread(t: WebChatThread): WebChatThread {
  return {
    ...t,
    source: "web" as const,
    title: storedWebThreadTitle(t.title),
    messages: (t.messages ?? []).slice(-MAX_STORED_MESSAGES),
  };
}

function stableMessageCount(messages: ChatMessage[]): number {
  return messages.filter((m) => !m.streaming && messageHasPayload(m)).length;
}

function sameAssistantTurn(a: ChatMessage, b: ChatMessage): boolean {
  if (a.content !== b.content) return false;
  if (a.reasoning && b.reasoning && a.reasoning !== b.reasoning) return false;
  return true;
}

/** Keep server-measured turn times when the winning snapshot never recorded them. */
function withPreservedAssistantTiming(
  chosen: WebChatThread,
  other: WebChatThread,
): WebChatThread {
  const donors = other.messages.filter(
    (m) => m.role === "assistant" && typeof m.durationMs === "number",
  );
  if (!donors.length) return chosen;
  const used = new Set<number>();
  const messages = chosen.messages.map((m) => {
    if (m.role !== "assistant" || typeof m.durationMs === "number") return m;
    const idx = donors.findIndex(
      (d, i) => !used.has(i) && sameAssistantTurn(d, m),
    );
    if (idx < 0) return m;
    used.add(idx);
    const donor = donors[idx]!;
    return {
      ...m,
      durationMs: donor.durationMs,
      ...(typeof donor.thinkMs === "number" ? { thinkMs: donor.thinkMs } : {}),
      ...(typeof m.ts !== "number" && typeof donor.ts === "number" ? { ts: donor.ts } : {}),
    };
  });
  return { ...chosen, messages };
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
  let chosen = b;
  let other = a;
  if (bUpdated !== aUpdated) {
    chosen = bUpdated > aUpdated ? b : a;
    other = chosen === b ? a : b;
  } else {
    const aStable = stableMessageCount(a.messages);
    const bStable = stableMessageCount(b.messages);
    if (bStable !== aStable) {
      chosen = bStable > aStable ? b : a;
      other = chosen === b ? a : b;
    } else if ((a.messages?.length ?? 0) > (b.messages?.length ?? 0)) {
      chosen = a;
      other = b;
    }
  }
  return withPreservedAssistantTiming(chosen, other);
}

export async function saveWebThreads(
  config: BridgeConfig,
  payload: { activeId?: string | null; threads: WebChatThread[]; workspaceId?: string },
): Promise<void> {
  const workspaceId =
    payload.workspaceId && isWorkspaceId(payload.workspaceId)
      ? payload.workspaceId
      : DEFAULT_WORKSPACE_ID;
  await withWorkspaceStore(config, workspaceId, (store, filePath) => {
    const byId = new Map(store.threads.map((thread) => [thread.id, thread]));
    for (const raw of payload.threads) {
      const incoming = normalizeWebThread(raw);
      const prev = byId.get(incoming.id);
      byId.set(incoming.id, prev ? mergeWebThreadPair(prev, incoming) : incoming);
    }
    store.threads = [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    if (payload.activeId !== undefined) store.activeId = payload.activeId;
    writeJsonAtomic(filePath, store);
  });
}

export type WebThreadSyncMessage = {
  role: string;
  content?: unknown;
  attachments?: Array<{
    name?: string;
    mimeType?: string;
    path?: string;
    url?: string;
    size?: number;
  }>;
};

/** Text payload from an OpenAI-style message (string or text parts). */
export function extractMessageTextForStore(m: {
  content?: unknown;
  role?: string;
}): string {
  if (typeof m.content === "string") return m.content.trim();
  if (Array.isArray(m.content)) {
    return m.content
      .filter(
        (p: { type?: string; text?: string }) =>
          p?.type === "text" && typeof p.text === "string",
      )
      .map((p: { text: string }) => p.text.trim())
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function normalizeStoredAttachments(
  raw: WebThreadSyncMessage["attachments"],
): ChatAttachment[] | undefined {
  if (!Array.isArray(raw) || !raw.length) return undefined;
  const out: ChatAttachment[] = [];
  for (const a of raw) {
    if (!a || typeof a.path !== "string" || !a.path.trim()) continue;
    const filePath = a.path.trim();
    const att: ChatAttachment = {
      name:
        typeof a.name === "string" && a.name.trim()
          ? a.name.trim()
          : path.basename(filePath),
      mimeType:
        typeof a.mimeType === "string" && a.mimeType.trim()
          ? a.mimeType.trim()
          : "application/octet-stream",
      path: filePath,
    };
    if (typeof a.size === "number" && Number.isFinite(a.size)) att.size = a.size;
    if (typeof a.url === "string" && a.url.startsWith("/api/workspace-file")) {
      att.url = a.url;
    }
    out.push(att);
  }
  return out.length ? out : undefined;
}

function findPreviousMessage(
  prevMessages: ChatMessage[],
  used: Set<number>,
  role: "user" | "assistant",
  content: string,
): ChatMessage | undefined {
  const trimmed = content.trim();
  for (let i = 0; i < prevMessages.length; i++) {
    if (used.has(i)) continue;
    const pm = prevMessages[i];
    if (pm.streaming || pm.role !== role || pm.content.trim() !== trimmed) continue;
    used.add(i);
    return pm;
  }
  return undefined;
}

function preserveAttachmentsFromPrevious(
  prevMessages: ChatMessage[],
  role: "user" | "assistant",
  content: string,
  incoming?: ChatAttachment[],
): ChatAttachment[] | undefined {
  if (incoming?.length) return incoming;
  const trimmed = content.trim();
  for (let i = prevMessages.length - 1; i >= 0; i--) {
    const pm = prevMessages[i];
    if (
      pm.role === role &&
      pm.content.trim() === trimmed &&
      pm.attachments?.length
    ) {
      return pm.attachments;
    }
  }
  return undefined;
}

export function webThreadMessagesFromApiBody(
  messages: WebThreadSyncMessage[],
): ChatMessage[] {
  const now = Date.now();
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => {
      const role = m.role as "user" | "assistant";
      const content = extractMessageTextForStore(m);
      const attachments = normalizeStoredAttachments(m.attachments);
      return { role, content: content.trim(), attachments, ts: now };
    })
    .filter((m) => m.content || m.attachments?.length);
}

/** Persist user/assistant history from a web `/api/agent/chat` request (server source of truth). */
export async function syncWebThreadFromChatRequest(
  config: BridgeConfig,
  threadId: string,
  opts: {
    model?: string;
    mode?: string;
    messages: WebThreadSyncMessage[];
    workspaceId?: string;
  },
): Promise<void> {
  await ensureMigrated(config);
  const workspaceId =
    opts.workspaceId && isWorkspaceId(opts.workspaceId)
      ? opts.workspaceId
      : findWorkspaceIdForThreadSync(config, threadId) ?? DEFAULT_WORKSPACE_ID;
  await withWorkspaceStore(config, workspaceId, (store, filePath) => {
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

    const prevMessages = thread.messages ?? [];
    const incoming = webThreadMessagesFromApiBody(opts.messages);
    const usedPrev = new Set<number>();
    const chatMessages: ChatMessage[] = incoming.map((m) => {
      const attachments = preserveAttachmentsFromPrevious(
        prevMessages,
        m.role,
        m.content,
        m.attachments,
      );
      const prev = findPreviousMessage(prevMessages, usedPrev, m.role, m.content);
      return {
        role: m.role,
        content: m.content,
        ts: prev?.ts ?? m.ts ?? now,
        ...(prev?.reasoning ? { reasoning: prev.reasoning } : {}),
        ...(typeof prev?.durationMs === "number" ? { durationMs: prev.durationMs } : {}),
        ...(typeof prev?.thinkMs === "number" ? { thinkMs: prev.thinkMs } : {}),
        ...(attachments?.length ? { attachments } : {}),
      };
    });

    const streamingAssistant = [...prevMessages]
      .reverse()
      .find((m) => m.role === "assistant" && m.streaming);

    thread.messages = chatMessages.slice(-MAX_STORED_MESSAGES);
    if (streamingAssistant) {
      const last = thread.messages[thread.messages.length - 1];
      if (last?.role !== "assistant" || !last.streaming) {
        thread.messages.push(streamingAssistant);
      }
    }
    if (isPlaceholderChatTitle(thread.title)) {
      thread.title = autoTitleFromMessages(thread.messages);
    }
    thread.updatedAt = now;
    writeJsonAtomic(filePath, store);
  });
}

export async function deleteWebThread(
  config: BridgeConfig,
  id: string,
  workspaceId?: string,
): Promise<boolean> {
  await ensureMigrated(config);
  const ids = workspaceId && isWorkspaceId(workspaceId)
    ? [workspaceId]
    : workspaceStoreIdsSync(config);
  for (const storeId of ids) {
    const removed = await withWorkspaceStore(config, storeId, (store, filePath) => {
      const before = store.threads.length;
      store.threads = store.threads.filter((thread) => thread.id !== id);
      if (store.threads.length === before) return false;
      if (store.activeId === id) store.activeId = store.threads[0]?.id ?? null;
      writeJsonAtomic(filePath, store);
      return true;
    });
    if (removed) return true;
  }
  return false;
}

/**
 * Move a web thread between workspace stores. Writes the destination first so a
 * crash leaves a duplicate rather than losing the chat. The thread becomes the
 * destination's active chat.
 */
export async function relocateWebThread(
  config: BridgeConfig,
  opts: { fromWorkspaceId: string; toWorkspaceId: string; thread: WebChatThread },
): Promise<void> {
  const { fromWorkspaceId, toWorkspaceId, thread } = opts;
  await withWorkspaceStore(config, toWorkspaceId, (store, filePath) => {
    store.threads = [thread, ...store.threads.filter((t) => t.id !== thread.id)];
    store.activeId = thread.id;
    writeJsonAtomic(filePath, store);
  });
  await withWorkspaceStore(config, fromWorkspaceId, (store, filePath) => {
    store.threads = store.threads.filter((t) => t.id !== thread.id);
    if (store.activeId === thread.id) store.activeId = store.threads[0]?.id ?? null;
    writeJsonAtomic(filePath, store);
  });
}

export async function migrateLocalThreads(
  config: BridgeConfig,
  imported: WebChatThread[],
): Promise<{ merged: number }> {
  let merged = 0;
  await withWorkspaceStore(config, DEFAULT_WORKSPACE_ID, (store, filePath) => {
    const existingIds = new Set(store.threads.map((thread) => thread.id));
    for (const thread of imported) {
      if (existingIds.has(thread.id)) continue;
      store.threads.push({ ...thread, source: "web" });
      existingIds.add(thread.id);
      merged++;
    }
    store.threads.sort((a, b) => b.updatedAt - a.updatedAt);
    writeJsonAtomic(filePath, store);
  });
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
    cwd?: string;
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
    const endsWithAssistant = opts.messages[opts.messages.length - 1]?.role === "assistant";
    if (endsWithAssistant && last?.role === "assistant") {
      last.content = opts.assistantText.trim();
    } else {
      messages.push({ role: "assistant", content: opts.assistantText.trim(), ts: now });
    }
  }

  await ensureMigrated(config);
  await mutexFor("api").run(() => {
    const filePath = apiSessionsPath(config);
    const file = readApiSessionsSync(filePath);
    const id =
      opts.sessionId ??
      `api_${now}_${Math.random().toString(16).slice(2, 10)}`;
    const existing = file.sessions.find((session) => session.id === id);
    const record: ApiSessionRecord = existing
      ? {
          ...existing,
          title: existing.title || title,
          updatedAt: now,
          model: opts.model ?? existing.model,
          mode: opts.mode ?? existing.mode,
          cwd: opts.cwd ?? existing.cwd,
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
          cwd: opts.cwd,
          messages: messages.slice(-MAX_STORED_MESSAGES),
        };

    file.sessions = [
      record,
      ...file.sessions.filter((session) => session.id !== id),
    ].slice(0, MAX_API_SESSIONS);
    writeJsonAtomic(filePath, file);
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
