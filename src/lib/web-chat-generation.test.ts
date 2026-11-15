import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { BridgeConfig } from "./config.js";
import { readChatStore } from "./chat-store.js";
import {
  abortWebGeneration,
  appendWebGenerationDelta,
  computeGenerationTiming,
  finishWebGeneration,
  getGeneration,
  getRecentTurnTiming,
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
    appSegment: "cursor-agent",
    cdswBypassAuthentication: true,
    bridgePackageVersion: "test",
  };
}

describe("computeGenerationTiming", () => {
  it("counts think time until the first answer token", () => {
    expect(computeGenerationTiming({
      startedAt: 1_000,
      endedAt: 5_000,
      reasoning: "hmm",
      reasoningStartedAt: 1_200,
      contentStartedAt: 3_000,
    })).toEqual({ durationMs: 4_000, thinkMs: 1_800 });
  });

  it("counts think time through the end when the reply is reasoning only", () => {
    expect(computeGenerationTiming({
      startedAt: 1_000,
      endedAt: 4_000,
      reasoning: "only thoughts",
      reasoningStartedAt: 1_500,
    })).toEqual({ durationMs: 3_000, thinkMs: 2_500 });
  });

  it("omits think time when the turn has no reasoning", () => {
    expect(computeGenerationTiming({
      startedAt: 1_000,
      endedAt: 2_500,
      reasoning: "",
      contentStartedAt: 1_100,
    })).toEqual({ durationMs: 1_500 });
  });
});

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
    appendWebGenerationDelta("t1", { reasoning: "thinking" });
    appendWebGenerationDelta("t1", { content: "Hello" });
    const timing = finishWebGeneration("t1", { ok: true });

    expect(timing?.durationMs).toEqual(expect.any(Number));
    expect(timing?.thinkMs).toEqual(expect.any(Number));
    expect(timing?.startedAt).toEqual(expect.any(Number));
    expect(timing?.updatedAt).toBeGreaterThanOrEqual(timing?.startedAt ?? 0);
    expect(getRecentTurnTiming("t1")).toEqual(timing);
    expect(getGeneration("t1")).toBeNull();
    expect(listActiveGenerations()).toEqual([]);

    await new Promise((r) => setTimeout(r, 500));
    const store = await readChatStore(config);
    const thread = store.threads.find((t) => t.id === "t1");
    const assistant = thread?.messages.find((m) => m.role === "assistant" && m.content === "Hello");
    expect(assistant).toBeTruthy();
    expect(assistant?.reasoning).toBe("thinking");
    expect(assistant?.durationMs).toEqual(expect.any(Number));
    expect(assistant?.durationMs).toBeGreaterThanOrEqual(0);
    expect(assistant?.thinkMs).toEqual(expect.any(Number));
    expect(assistant?.thinkMs).toBeGreaterThanOrEqual(0);
    expect(assistant?.thinkMs).toBeLessThanOrEqual(assistant?.durationMs ?? 0);
  });
});
