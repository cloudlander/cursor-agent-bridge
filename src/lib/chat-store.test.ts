import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { BridgeConfig } from "./config.js";
import {
  listChatSessions,
  parseAgentTranscript,
  summarizeAgentTranscript,
  readChatStore,
  recordApiSession,
  mergeWebThreadPair,
  saveWebThreads,
  syncWebThreadFromChatRequest,
  writeChatStore,
  webThreadMessagesFromApiBody,
  type WebChatThread,
} from "./chat-store.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function testConfig(dir: string): BridgeConfig {
  return {
    agentBin: "agent",
    acpCommand: "agent",
    acpArgs: ["acp"],
    acpEnv: {},
    host: "127.0.0.1",
    port: 8765,
    defaultModel: "default",
    mode: "agent",
    force: false,
    approveMcps: false,
    strictModel: true,
    workspace: dir,
    timeoutMs: 30_000,
    sessionsLogPath: path.join(dir, "sessions.log"),
    chatOnlyWorkspace: true,
    chatOnlyWorkspaceExplicit: false,
    verbose: false,
    verboseFull: false,
    maxMode: false,
    promptViaStdin: false,
    useAcp: false,
    acpSkipAuthenticate: true,
    acpRawDebug: false,
    configDirs: [],
    multiPort: false,
    winCmdlineMax: 30_000,
    contextPreamble: false,
    appSegment: "cursor-agent",
    cdswBypassAuthentication: true,
    bridgePackageVersion: "test",
  };
}

function makeTmpConfig(): BridgeConfig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-store-"));
  tmpDirs.push(dir);
  return testConfig(dir);
}

describe("parseAgentTranscript", () => {
  it("extracts user query and merges assistant chunks", () => {
    const raw = [
      JSON.stringify({
        role: "user",
        message: {
          content: [
            {
              type: "text",
              text: "<user_query>\nhello world\n</user_query>",
            },
          ],
        },
      }),
      JSON.stringify({
        role: "assistant",
        message: { content: [{ type: "text", text: "Hi" }] },
      }),
      JSON.stringify({ type: "turn_ended", status: "success" }),
    ].join("\n");
    const messages = parseAgentTranscript(raw);
    expect(messages).toEqual([
      { role: "user", content: "hello world" },
      { role: "assistant", content: "Hi" },
    ]);
    const summary = summarizeAgentTranscript(raw);
    expect(summary.messageCount).toBe(2);
    expect(summary.firstUser).toBe("hello world");
  });
});

describe("chat store persistence", () => {
  it("mergeWebThreadPair keeps the thread with more history when timestamps tie", () => {
    const base: WebChatThread = {
      id: "t1",
      source: "web",
      title: null,
      pinned: false,
      createdAt: 1,
      updatedAt: 100,
      model: "",
      mode: "agent",
      messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }],
    };
    const stale: WebChatThread = {
      ...base,
      messages: [{ role: "user", content: "a" }],
    };
    const merged = mergeWebThreadPair(stale, base);
    expect(merged.messages).toHaveLength(2);
  });

  it("saveWebThreads merges partial PUT without dropping other threads", async () => {
    const config = makeTmpConfig();
    const keep: WebChatThread = {
      id: "keep",
      source: "web",
      title: "Keep",
      pinned: false,
      createdAt: 1,
      updatedAt: 5000,
      model: "",
      mode: "agent",
      messages: [{ role: "user", content: "saved" }],
    };
    const dropAttempt: WebChatThread = {
      id: "touch",
      source: "web",
      title: null,
      pinned: true,
      createdAt: 2,
      updatedAt: 100,
      model: "x",
      mode: "agent",
      messages: [],
    };
    await saveWebThreads(config, { activeId: "keep", threads: [keep, dropAttempt] });
    await saveWebThreads(config, {
      activeId: "touch",
      threads: [{ ...dropAttempt, updatedAt: 200, pinned: true }],
    });
    const store = await readChatStore(config);
    expect(store.threads.map((t) => t.id).sort()).toEqual(["keep", "touch"]);
    expect(store.threads.find((t) => t.id === "keep")?.messages[0]?.content).toBe(
      "saved",
    );
    expect(store.threads.find((t) => t.id === "touch")?.pinned).toBe(true);
  });

  it("saves and lists web threads", async () => {
    const config = makeTmpConfig();
    const thread: WebChatThread = {
      id: "web-1",
      source: "web",
      title: "Test",
      pinned: false,
      createdAt: 1000,
      updatedAt: 2000,
      model: "auto",
      mode: "agent",
      messages: [{ role: "user", content: "ping" }],
    };
    await saveWebThreads(config, { activeId: "web-1", threads: [thread] });
    const store = await readChatStore(config);
    expect(store.threads).toHaveLength(1);
    const listed = await listChatSessions(config);
    expect(listed.activeId).toBe("web-1");
    expect(listed.threads[0]?.messages?.[0]?.content).toBe("ping");
    expect(listed.sessions.some((s) => s.id === "web-1" && s.source === "web")).toBe(
      true,
    );
    const compact = await listChatSessions(config, { compactThreads: true });
    expect(compact.compact).toBe(true);
    expect(compact.threads).toHaveLength(1);
    expect(compact.threads[0]?.messages).toBeUndefined();
    expect(compact.threads[0]?.id).toBe("web-1");
  });

  it("does not persist the New chat placeholder as a real title", async () => {
    const config = makeTmpConfig();
    const thread: WebChatThread = {
      id: "put-placeholder",
      source: "web",
      title: "New chat",
      pinned: false,
      createdAt: 1,
      updatedAt: 5,
      model: "",
      mode: "agent",
      messages: [{ role: "user", content: "hello from put" }],
    };
    await saveWebThreads(config, { threads: [thread] });
    const stored = await readChatStore(config);
    expect(stored.threads.find((t) => t.id === thread.id)?.title).toBeNull();
    const listed = await listChatSessions(config);
    expect(listed.sessions.find((s) => s.id === thread.id)?.title).toBe("hello from put");
    expect(listed.threads.find((t) => t.id === thread.id)?.title).toBeNull();
  });

  it("excludes zero-message sessions and sorts by createdAt", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-store-isolated-"));
    tmpDirs.push(dir);
    const isolatedHome = path.join(dir, "home");
    fs.mkdirSync(isolatedHome, { recursive: true });
    const prevHome = process.env.HOME;
    process.env.HOME = isolatedHome;
    const config = { ...testConfig(dir), configDirs: [isolatedHome] };
    const threads: WebChatThread[] = [
      {
        id: "old-with-msg",
        source: "web",
        title: "Old",
        pinned: false,
        createdAt: 1000,
        updatedAt: 9000,
        model: "",
        mode: "agent",
        messages: [{ role: "user", content: "a" }],
      },
      {
        id: "new-empty",
        source: "web",
        title: null,
        pinned: false,
        createdAt: 5000,
        updatedAt: 5000,
        model: "",
        mode: "agent",
        messages: [],
      },
      {
        id: "new-with-msg",
        source: "web",
        title: "New",
        pinned: false,
        createdAt: 3000,
        updatedAt: 1000,
        model: "",
        mode: "agent",
        messages: [{ role: "user", content: "b" }],
      },
    ];
    try {
      await saveWebThreads(config, { activeId: "new-empty", threads });
      const { sessions } = await listChatSessions(config);
      expect(sessions.map((s) => s.id)).toEqual(["new-with-msg", "old-with-msg"]);
      expect(sessions.every((s) => s.messageCount > 0)).toBe(true);
    } finally {
      process.env.HOME = prevHome;
    }
  });
});

describe("webThreadMessagesFromApiBody", () => {
  it("keeps attachment-only user messages", () => {
    const msgs = webThreadMessagesFromApiBody([
      {
        role: "user",
        content: "",
        attachments: [
          {
            name: "a.png",
            mimeType: "image/png",
            path: "/tmp/ws/.cursor-api-proxy/uploads/a.png",
          },
        ],
      },
    ]);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("");
    expect(msgs[0].attachments?.[0]?.path).toContain("uploads/a.png");
  });

  it("extracts text from multipart content", () => {
    const msgs = webThreadMessagesFromApiBody([
      {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          { type: "image_url", image_url: { url: "https://x/y" } },
        ],
      },
    ]);
    expect(msgs[0].content).toBe("hello");
  });
});

describe("syncWebThreadFromChatRequest", () => {
  it("persists attachments from chat sync", async () => {
    const config = makeTmpConfig();
    const threadId = "sync-att-thread";
    await syncWebThreadFromChatRequest(config, threadId, {
      messages: [
        {
          role: "user",
          content: "see file",
          attachments: [
            {
              name: "doc.pdf",
              mimeType: "application/pdf",
              path: path.join(config.workspace, ".cursor-api-proxy/uploads/u1.pdf"),
            },
          ],
        },
      ],
    });
    const store = await readChatStore(config);
    const thread = store.threads.find((t) => t.id === threadId);
    expect(thread?.messages[0]?.attachments?.[0]?.name).toBe("doc.pdf");
  });

  it("preserves attachments when sync payload omits them", async () => {
    const config = makeTmpConfig();
    const threadId = "sync-preserve";
    const filePath = path.join(config.workspace, ".cursor-api-proxy/uploads/keep.png");
    await syncWebThreadFromChatRequest(config, threadId, {
      messages: [
        {
          role: "user",
          content: "pic",
          attachments: [
            { name: "keep.png", mimeType: "image/png", path: filePath },
          ],
        },
      ],
    });
    await syncWebThreadFromChatRequest(config, threadId, {
      messages: [{ role: "user", content: "pic" }],
    });
    const store = await readChatStore(config);
    const thread = store.threads.find((t) => t.id === threadId);
    expect(thread?.messages[0]?.attachments?.[0]?.path).toBe(filePath);
  });

  it("preserves assistant timing and reasoning across a later sync", async () => {
    const config = makeTmpConfig();
    const threadId = "sync-timing";
    await syncWebThreadFromChatRequest(config, threadId, {
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    });
    const store = await readChatStore(config);
    const thread = store.threads.find((t) => t.id === threadId);
    const assistant = thread?.messages.find((m) => m.role === "assistant");
    expect(assistant).toBeTruthy();
    assistant!.reasoning = "ponder";
    assistant!.durationMs = 4200;
    assistant!.thinkMs = 1500;
    assistant!.ts = 1_700_000_000_000;
    await writeChatStore(config, store);

    await syncWebThreadFromChatRequest(config, threadId, {
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "again" },
      ],
    });
    const next = await readChatStore(config);
    const saved = next.threads.find((t) => t.id === threadId)?.messages.find((m) => m.role === "assistant");
    expect(saved?.reasoning).toBe("ponder");
    expect(saved?.durationMs).toBe(4200);
    expect(saved?.thinkMs).toBe(1500);
    expect(saved?.ts).toBe(1_700_000_000_000);
  });

  it("names a new web thread from the first user message", async () => {
    const config = makeTmpConfig();
    const threadId = "sync-title";
    await syncWebThreadFromChatRequest(config, threadId, {
      messages: [{ role: "user", content: "Fix the sidebar title" }],
    });
    const store = await readChatStore(config);
    expect(store.threads.find((t) => t.id === threadId)?.title).toBe("Fix the sidebar title");

    const thread = store.threads.find((t) => t.id === threadId);
    expect(thread).toBeTruthy();
    thread!.title = "Custom";
    await writeChatStore(config, store);
    await syncWebThreadFromChatRequest(config, threadId, {
      messages: [
        { role: "user", content: "Fix the sidebar title" },
        { role: "user", content: "follow up" },
      ],
    });
    const kept = await readChatStore(config);
    expect(kept.threads.find((t) => t.id === threadId)?.title).toBe("Custom");
  });

  it("replaces a stored New chat placeholder and does not list it as the title", async () => {
    const config = makeTmpConfig();
    const thread: WebChatThread = {
      id: "placeholder",
      source: "web",
      title: "New chat",
      pinned: false,
      createdAt: 1,
      updatedAt: 2,
      model: "",
      mode: "agent",
      messages: [{ role: "user", content: "UI 加强: chat 标题" }],
    };
    await writeChatStore(config, {
      version: 1,
      activeId: thread.id,
      threads: [thread],
      apiSessions: [],
    });
    const listed = await listChatSessions(config);
    expect(listed.sessions.find((s) => s.id === thread.id)?.title).toBe("UI 加强: chat 标题");
    expect(listed.threads.find((t) => t.id === thread.id)?.title).toBeNull();

    await syncWebThreadFromChatRequest(config, thread.id, {
      messages: [{ role: "user", content: "UI 加强: chat 标题" }],
    });
    const stored = await readChatStore(config);
    expect(stored.threads.find((t) => t.id === thread.id)?.title).toBe("UI 加强: chat 标题");
  });

  it("keeps server turn timing when a newer snapshot omits it", () => {
    const base = {
      id: "t",
      source: "web" as const,
      title: null,
      pinned: false,
      createdAt: 1,
      updatedAt: 10,
      model: "",
      mode: "agent",
    };
    const server: WebChatThread = {
      ...base,
      messages: [
        { role: "user", content: "hi", ts: 1 },
        {
          role: "assistant",
          content: "hello",
          reasoning: "hmm",
          durationMs: 4200,
          thinkMs: 1500,
          ts: 9,
        },
      ],
    };
    const client: WebChatThread = {
      ...base,
      updatedAt: 20,
      messages: [
        { role: "user", content: "hi", ts: 1 },
        { role: "assistant", content: "hello", reasoning: "hmm", ts: 20 },
      ],
    };
    const merged = mergeWebThreadPair(server, client);
    const assistant = merged.messages.find((m) => m.role === "assistant");
    expect(merged.updatedAt).toBe(20);
    expect(assistant?.durationMs).toBe(4200);
    expect(assistant?.thinkMs).toBe(1500);
    expect(assistant?.ts).toBe(20);
  });
});

describe("per-workspace chat stores", () => {
  it("migrates a legacy chat-store.json into the default workspace once", async () => {
    const config = makeTmpConfig();
    const dir = path.dirname(config.sessionsLogPath);
    const legacy = path.join(dir, "chat-store.json");
    fs.writeFileSync(
      legacy,
      JSON.stringify({
        version: 1,
        activeId: "t1",
        threads: [
          {
            id: "t1",
            source: "web",
            title: "Old",
            pinned: false,
            createdAt: 1,
            updatedAt: 2,
            model: "",
            mode: "agent",
            messages: [{ role: "user", content: "hi" }],
          },
        ],
        apiSessions: [
          {
            id: "api1",
            source: "api",
            api: "chat",
            apiPath: "/v1/chat/completions",
            title: "API",
            createdAt: 1,
            updatedAt: 2,
            messages: [{ role: "user", content: "q" }],
          },
        ],
      }),
    );
    const store = await readChatStore(config);
    expect(store.activeId).toBe("t1");
    expect(store.threads.map((t) => t.id)).toEqual(["t1"]);
    expect(store.apiSessions.map((s) => s.id)).toEqual(["api1"]);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.existsSync(`${legacy}.migrated`)).toBe(true);
    expect(fs.existsSync(path.join(dir, "chat-stores", "default.json"))).toBe(true);
    const again = await readChatStore(config);
    expect(again.threads).toHaveLength(1);
    expect(fs.existsSync(`${legacy}.migrated`)).toBe(true);
  });

  it("reads and lists only the requested workspace", async () => {
    const { createWorkspace } = await import("./workspaces.js");
    const config = makeTmpConfig();
    const research = await createWorkspace(config, "Research");
    const thread = (id: string): WebChatThread => ({
      id,
      source: "web",
      title: id,
      pinned: false,
      createdAt: 1,
      updatedAt: 2,
      model: "",
      mode: "agent",
      messages: [{ role: "user", content: id }],
    });
    await saveWebThreads(config, { activeId: "a", threads: [thread("a")] });
    await saveWebThreads(config, {
      workspaceId: research.id,
      activeId: "b",
      threads: [thread("b")],
    });
    await recordApiSession(config, {
      api: "chat",
      apiPath: "/v1/chat/completions",
      messages: [{ role: "user", content: "from api" }],
      assistantText: "ok",
      cwd: path.join(config.workspace, "sub"),
    });
    const def = await listChatSessions(config, { workspaceId: "default" });
    const other = await listChatSessions(config, { workspaceId: research.id });
    expect(def.threads.map((t) => t.id)).toEqual(["a"]);
    expect(def.activeId).toBe("a");
    expect(other.threads.map((t) => t.id)).toEqual(["b"]);
    expect(other.activeId).toBe("b");
    expect(def.sessions.some((s) => s.source === "api" && s.cwd?.endsWith("sub"))).toBe(true);
    expect(other.sessions.some((s) => s.source === "api")).toBe(false);
  });
});
