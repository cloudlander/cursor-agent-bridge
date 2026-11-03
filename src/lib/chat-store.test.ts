import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { BridgeConfig } from "./config.js";
import {
  listChatSessions,
  parseAgentTranscript,
  readChatStore,
  mergeWebThreadPair,
  saveWebThreads,
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
    expect(listed.threads[0]?.messages[0]?.content).toBe("ping");
    expect(listed.sessions.some((s) => s.id === "web-1" && s.source === "web")).toBe(
      true,
    );
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
