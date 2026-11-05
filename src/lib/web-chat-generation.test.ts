import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { BridgeConfig } from "./config.js";
import { readChatStore } from "./chat-store.js";
import {
  abortWebGeneration,
  appendWebGenerationDelta,
  finishWebGeneration,
  getGeneration,
  listActiveGenerations,
  startWebGeneration,
} from "./web-chat-generation.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const id of listActiveGenerations().map((g) => g.threadId)) {
    abortWebGeneration(id);
  }
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
    routerEnabled: false,
    routerConfigPath: "/tmp/model-router.json",
    routerQuotaThreshold: 0.1,
    routerTimeoutMs: 8000,
  };
}

describe("web-chat-generation", () => {
  it("tracks deltas and persists to chat store", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-gen-"));
    tmpDirs.push(dir);
    const config = testConfig(dir);
    const storePath = path.join(dir, "chat-store.json");
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        version: 1,
        activeId: "t1",
        threads: [
          {
            id: "t1",
            source: "web",
            title: null,
            pinned: false,
            createdAt: 1,
            updatedAt: 1,
            model: "",
            mode: "",
            messages: [{ role: "user", content: "hi", ts: 1 }],
          },
        ],
        apiSessions: [],
      }),
    );

    startWebGeneration(config, "t1");
    appendWebGenerationDelta("t1", { content: "Hello" });
    finishWebGeneration("t1", { ok: true });

    expect(getGeneration("t1")).toBeNull();
    expect(listActiveGenerations()).toEqual([]);

    await new Promise((r) => setTimeout(r, 500));
    const store = await readChatStore(config);
    const thread = store.threads.find((t) => t.id === "t1");
    expect(thread?.messages.some((m) => m.role === "assistant" && m.content === "Hello")).toBe(true);
  });
});
