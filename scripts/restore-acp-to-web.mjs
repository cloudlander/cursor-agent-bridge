#!/usr/bin/env node
/**
 * Import a Cursor ACP session (store.db) into a new Web Chat thread in chat-store.json.
 *
 * Web Chat lists ACP sessions in the sidebar but does not load transcripts from store.db;
 * use this for read-only recovery in /chat.
 *
 * Usage:
 *   node scripts/restore-acp-to-web.mjs <acp-session-dir> [chat-store.json] [title]
 *   npm run restore-acp-to-web -- <acp-session-dir> [chat-store.json] [title]
 *
 * chat-store.json defaults to the same directory as CURSOR_BRIDGE_SESSIONS_LOG
 * (or ~/.cursor-api-proxy/sessions.log). Title defaults to "<meta.title> (restored from ACP)".
 *
 * Env: RESTORE_MAX_MESSAGES (default 290), RESTORE_MAX_TOOL_CHARS (default 6000)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function usage(exitCode = 1) {
  console.error(`Usage: node scripts/restore-acp-to-web.mjs <acp-session-dir> [chat-store.json] [title]

Import Cursor ACP session store.db into a new Web Chat thread (chat-store.json).

Environment:
  CURSOR_BRIDGE_SESSIONS_LOG  Locates chat-store.json when the second argument is omitted
  RESTORE_MAX_MESSAGES        Cap imported messages (default: 290)
  RESTORE_MAX_TOOL_CHARS      Truncate tool output per message (default: 6000)
`);
  process.exit(exitCode);
}

const argv = process.argv.slice(2);
if (argv.includes("-h") || argv.includes("--help")) usage(0);
if (argv.length < 1) usage();

function defaultChatStorePath() {
  const sessionsLog =
    process.env.CURSOR_BRIDGE_SESSIONS_LOG?.trim() ||
    path.join(os.homedir(), ".cursor-api-proxy", "sessions.log");
  return path.join(path.dirname(sessionsLog), "chat-store.json");
}

const SESSION_DIR = path.resolve(argv[0]);
const OUT_STORE = path.resolve(argv[1] ?? defaultChatStorePath());
const MAX_MESSAGES = Number(process.env.RESTORE_MAX_MESSAGES ?? "290");
const MAX_TOOL_CHARS = Number(process.env.RESTORE_MAX_TOOL_CHARS ?? "6000");

let TITLE = argv[2]?.trim();
if (!TITLE) {
  const metaPath = path.join(SESSION_DIR, "meta.json");
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      const base = typeof meta.title === "string" ? meta.title.trim() : "";
      TITLE = base ? `${base} (restored from ACP)` : "Restored from ACP";
    } catch {
      TITLE = "Restored from ACP";
    }
  } else {
    TITLE = "Restored from ACP";
  }
}

const dbPath = path.join(SESSION_DIR, "store.db");
if (!fs.existsSync(dbPath)) {
  console.error("store.db not found:", dbPath);
  process.exit(1);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const metaRow = db.prepare("SELECT value FROM meta WHERE key = ?").get("0");
const meta = JSON.parse(Buffer.from(metaRow.value, "hex").toString("utf8"));
const encKeyStr = meta.blobEncryptionKey;
const rootId = meta.latestRootBlobId;

const keyMaterial = crypto.createHash("sha256").update(encKeyStr).digest();
const cryptoKey = await crypto.subtle.importKey(
  "raw",
  keyMaterial,
  { name: "AES-GCM", length: 256 },
  false,
  ["decrypt"],
);

const rawById = new Map();
for (const row of db.prepare("SELECT id, data FROM blobs").all()) {
  rawById.set(row.id, Buffer.from(row.data));
}

async function plainBlob(id) {
  const raw = rawById.get(id);
  if (!raw) return null;
  if (raw.length > 0 && raw[0] === 0x7b) return raw;
  if (raw.length < 13) return raw;
  try {
    const iv = raw.subarray(0, 12);
    const ct = raw.subarray(12);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ct);
    return Buffer.from(pt);
  } catch {
    return raw;
  }
}

function turnIdsFromRoot(buf) {
  const ids = [];
  let i = 0;
  while (i < buf.length) {
    let tag = 0;
    let shift = 0;
    while (i < buf.length) {
      const b = buf[i++];
      tag |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    if ((tag & 7) === 2) {
      let len = 0;
      shift = 0;
      while (i < buf.length) {
        const b = buf[i++];
        len |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7;
      }
      const slice = buf.subarray(i, i + len);
      i += len;
      if (len === 32) ids.push(slice.toString("hex"));
    } else if ((tag & 7) === 0) {
      while (i < buf.length && buf[i] & 0x80) i++;
      if (i < buf.length) i++;
    } else if ((tag & 7) === 1) i += 8;
    else if ((tag & 7) === 5) i += 4;
    else break;
  }
  return ids;
}

function extractUserQuery(text) {
  const m = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  if (m) {
    return m[1]
      .replace(/\n\nAssistant:[\s\S]*$/i, "")
      .trim();
  }
  const via = text.match(/User:\s*([\s\S]*?)(?:\n\nAssistant:|\nAssistant:|$)/i);
  if (via) return via[1].trim();
  return text.trim();
}

function stripNoise(text) {
  return text
    .replace(/<user_info>[\s\S]*?<\/user_info>/gi, "")
    .replace(/<timestamp>[\s\S]*?<\/timestamp>/gi, "")
    .replace(/<git_status>[\s\S]*?<\/git_status>/gi, "")
    .replace(/<agent_transcripts>[\s\S]*?<\/agent_transcripts>/gi, "")
    .replace(/<rules>[\s\S]*?<\/rules>/gi, "")
    .replace(/<available_subagent_types>[\s\S]*?<\/available_subagent_types>/gi, "")
    .replace(/Via cursor-api-proxy[\s\S]*?---\s*/i, "")
    .trim();
}

function isContextOnlyUser(text) {
  const stripped = stripNoise(text);
  if (!stripped) return true;
  if (/<user_info>/i.test(text) && !/<user_query>/i.test(text) && !/User:\s*\S/.test(text)) {
    return true;
  }
  return false;
}

function partToText(part) {
  if (!part || typeof part !== "object") return "";
  if (part.type === "text" && typeof part.text === "string") return part.text;
  if (part.type === "tool-result") {
    const name = part.toolName ?? "tool";
    const body =
      typeof part.result === "string"
        ? part.result
        : typeof part.text === "string"
          ? part.text
          : JSON.stringify(part.result ?? part, null, 2);
    const clipped =
      body.length > MAX_TOOL_CHARS ? `${body.slice(0, MAX_TOOL_CHARS)}\n\n…(truncated)` : body;
    return `**Tool: ${name}**\n\n${clipped}`;
  }
  if (part.type === "tool-call") {
    const name = part.toolName ?? "tool";
    return `*Tool call: ${name}*`;
  }
  return "";
}

function messageToWeb(obj) {
  const role = obj.role;
  if (role === "system") return null;

  let webRole = role === "user" ? "user" : "assistant";
  if (role === "tool") webRole = "assistant";

  let content = obj.content;
  if (typeof content === "string") {
    if (role === "user") {
      if (isContextOnlyUser(content)) return null;
      content = extractUserQuery(stripNoise(content));
    } else {
      content = stripNoise(content);
    }
  } else if (Array.isArray(content)) {
    const parts = content
      .map(partToText)
      .filter((t) => t.trim().length > 0);
    content = parts.join("\n\n");
    if (role === "user") {
      if (isContextOnlyUser(content)) return null;
      content = extractUserQuery(stripNoise(content));
    } else {
      content = stripNoise(content);
    }
  } else {
    return null;
  }

  if (!content?.trim()) return null;
  let out = content.trim();
  if (webRole === "user") out = out.replace(/^User:\s*/i, "");
  return { role: webRole, content: out };
}

function capMessages(messages) {
  if (messages.length <= MAX_MESSAGES) return messages;
  const first = messages[0];
  const tail = messages.slice(-(MAX_MESSAGES - 1));
  if (first && tail[0] !== first) {
    return [first, ...tail.filter((m) => m !== first)];
  }
  return messages.slice(-MAX_MESSAGES);
}

const rootPlain = await plainBlob(rootId);
if (!rootPlain) {
  console.error("Root blob missing:", rootId);
  process.exit(1);
}

const orderedIds = turnIdsFromRoot(rootPlain);
const rawMessages = [];
for (const id of orderedIds) {
  const plain = await plainBlob(id);
  if (!plain || plain[0] !== 0x7b) continue;
  let obj;
  try {
    obj = JSON.parse(plain.toString("utf8"));
  } catch {
    continue;
  }
  const web = messageToWeb(obj);
  if (web) rawMessages.push(web);
}

let chatMessages = rawMessages;
chatMessages = capMessages(chatMessages);

let store;
if (fs.existsSync(OUT_STORE)) {
  store = JSON.parse(fs.readFileSync(OUT_STORE, "utf8"));
} else {
  store = { version: 1, activeId: null, threads: [], apiSessions: [] };
}
if (!Array.isArray(store.threads)) store.threads = [];
store.threads = store.threads.filter((t) => t.title !== TITLE);

const now = Date.now();
const threadId = crypto.randomUUID();
const thread = {
  id: threadId,
  source: "web",
  title: TITLE,
  pinned: true,
  createdAt: meta.createdAt ?? now,
  updatedAt: now,
  model: "",
  mode: "agent",
  messages: chatMessages.map((m, i) => ({
    role: m.role,
    content: m.content,
    ts: (meta.createdAt ?? now) + i,
  })),
};

store.threads.unshift(thread);
store.activeId = threadId;
fs.writeFileSync(OUT_STORE, `${JSON.stringify(store, null, 2)}\n`);

console.log(
  JSON.stringify(
    {
      threadId,
      title: TITLE,
      sourceSession: SESSION_DIR,
      turnRefs: orderedIds.length,
      messageCount: chatMessages.length,
      store: OUT_STORE,
    },
    null,
    2,
  ),
);
