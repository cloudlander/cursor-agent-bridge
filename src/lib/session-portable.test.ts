import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { BridgeConfig } from "./config.js";
import { writeChatStore, type WebChatThread } from "./chat-store.js";
import {
  exportSessionBundle,
  importSessionBundle,
  MS_PER_DAY,
} from "./session-portable.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function testConfig(base: string, cursorRoot: string): BridgeConfig {
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
    workspace: base,
    timeoutMs: 30_000,
    sessionsLogPath: path.join(base, "sessions.log"),
    chatOnlyWorkspace: true,
    chatOnlyWorkspaceExplicit: false,
    verbose: false,
    verboseFull: false,
    maxMode: false,
    promptViaStdin: false,
    useAcp: false,
    acpSkipAuthenticate: true,
    acpRawDebug: false,
    configDirs: [cursorRoot],
    multiPort: false,
    winCmdlineMax: 30_000,
    contextPreamble: false,
    appSegment: "cursor-agent",
    cdswBypassAuthentication: true,
    bridgePackageVersion: "test",
  };
}

function makeLayout(): { base: string; cursorRoot: string; config: BridgeConfig } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "session-portable-"));
  tmpDirs.push(base);
  const cursorRoot = path.join(base, ".cursor");
  fs.mkdirSync(cursorRoot, { recursive: true });
  return { base, cursorRoot, config: testConfig(base, cursorRoot) };
}

describe("session portable export/import", () => {
  it("exports and imports web threads within the day window", async () => {
    const { base, cursorRoot, config } = makeLayout();
    const now = Date.now();
    const thread: WebChatThread = {
      id: "thread-1",
      source: "web",
      title: "Hello",
      pinned: false,
      createdAt: now - MS_PER_DAY,
      updatedAt: now - 60_000,
      model: "default",
      mode: "agent",
      messages: [
        { role: "user", content: "hi", ts: now - 60_000 },
        { role: "assistant", content: "hey", ts: now - 59_000 },
      ],
    };
    await writeChatStore(config, {
      version: 1,
      activeId: thread.id,
      threads: [thread],
      apiSessions: [],
    });

    const exportDir = path.join(base, "export");
    const summary = await exportSessionBundle(config, { outDir: exportDir, days: 3 });
    expect(summary.webThreads).toBe(1);

    const destBase = fs.mkdtempSync(path.join(os.tmpdir(), "session-portable-dest-"));
    tmpDirs.push(destBase);
    const destCursor = path.join(destBase, ".cursor");
    fs.mkdirSync(destCursor, { recursive: true });
    const destConfig = testConfig(destBase, destCursor);

    const imported = await importSessionBundle(destConfig, { bundleDir: exportDir });
    expect(imported.webThreadsMerged).toBe(1);

    const storePath = path.join(destBase, "chat-store.json");
    const store = JSON.parse(fs.readFileSync(storePath, "utf8")) as {
      threads: WebChatThread[];
    };
    expect(store.threads.some((t) => t.id === "thread-1")).toBe(true);
  });

  it("exports agent transcript jsonl files by mtime", async () => {
    const { base, cursorRoot, config } = makeLayout();
    const sessionId = "abc-123";
    const jsonlDir = path.join(
      cursorRoot,
      "projects",
      "home-test",
      "agent-transcripts",
      sessionId,
    );
    fs.mkdirSync(jsonlDir, { recursive: true });
    const jsonlPath = path.join(jsonlDir, `${sessionId}.jsonl`);
    fs.writeFileSync(
      jsonlPath,
      `${JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "<user_query>q</user_query>" }] },
      })}\n`,
      "utf8",
    );
    const now = Date.now();
    fs.utimesSync(jsonlPath, now / 1000, now / 1000);

    const exportDir = path.join(base, "export");
    const summary = await exportSessionBundle(config, { outDir: exportDir, days: 3 });
    expect(summary.agentTranscripts).toBe(1);
    expect(
      fs.existsSync(
        path.join(
          exportDir,
          "cursor",
          "projects",
          "home-test",
          "agent-transcripts",
          sessionId,
          `${sessionId}.jsonl`,
        ),
      ),
    ).toBe(true);
  });
});
