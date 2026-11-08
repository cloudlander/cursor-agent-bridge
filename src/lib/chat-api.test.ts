import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resetMaxUploadBytesCacheForTests } from "./chat-attachments.js";
import type { BridgeConfig } from "./config.js";
import { createRequestListener } from "./request-listener.js";
import type { ToolSessionRegistry } from "./tool-session-registry.js";

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
    bridgePackageVersion: "test",
  };
}

async function fetchJson(
  port: number,
  pathname: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, init);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe("chat API", () => {
  it("GET/PUT /api/chat/threads round-trips web threads", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-api-"));
    tmpDirs.push(dir);
    const isolatedHome = path.join(dir, "home");
    fs.mkdirSync(isolatedHome, { recursive: true });
    const prevHome = process.env.HOME;
    process.env.HOME = isolatedHome;
    const config = testConfig(dir);
    const toolSessions = { closeAll: async () => undefined } as ToolSessionRegistry;
    const server = http.createServer(
      createRequestListener({ version: "test", config }, { toolSessions }),
    );
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    try {
    const empty = await fetchJson(port, "/api/chat/threads");
    expect(empty.status).toBe(200);
    expect(Array.isArray((empty.body as { sessions: unknown[] }).sessions)).toBe(
      true,
    );
    expect(
      (empty.body as { threads: unknown[] }).threads,
    ).toEqual([]);

    const put = await fetchJson(port, "/api/chat/threads", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        activeId: "abc",
        threads: [
          {
            id: "abc",
            source: "web",
            title: null,
            pinned: false,
            createdAt: 1,
            updatedAt: 2,
            model: "",
            mode: "agent",
            messages: [{ role: "user", content: "hi" }],
          },
        ],
      }),
    });
    expect(put.status).toBe(200);

    const listed = await fetchJson(port, "/api/chat/threads");
    const body = listed.body as {
      activeId: string;
      threads: Array<{ messages: Array<{ content: string }> }>;
    };
    expect(body.activeId).toBe("abc");
    expect(body.threads[0]?.messages[0]?.content).toBe("hi");

    const compact = await fetchJson(port, "/api/chat/threads?compact=1");
    expect(compact.status).toBe(200);
    const compactBody = compact.body as {
      compact: boolean;
      threads: Array<{ messages?: unknown[] }>;
    };
    expect(compactBody.compact).toBe(true);
    expect(compactBody.threads[0]?.messages).toBeUndefined();
    } finally {
      process.env.HOME = prevHome;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("POST /api/chat/upload accepts multipart file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-upload-"));
    tmpDirs.push(dir);
    const isolatedHome = path.join(dir, "home");
    fs.mkdirSync(isolatedHome, { recursive: true });
    const prevHome = process.env.HOME;
    process.env.HOME = isolatedHome;
    const config = testConfig(dir);
    const toolSessions = { closeAll: async () => undefined } as ToolSessionRegistry;
    const server = http.createServer(
      createRequestListener({ version: "test", config }, { toolSessions }),
    );
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    const boundary = "----cursorbridge";
    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="note.txt"\r\n` +
      `Content-Type: text/plain\r\n\r\n` +
      `hi there\r\n` +
      `--${boundary}--\r\n`;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/chat/upload`, {
        method: "POST",
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        body,
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        attachment: { name: string; path: string; url: string };
      };
      expect(json.attachment.name).toBe("note.txt");
      expect(fs.existsSync(json.attachment.path)).toBe(true);
      expect(json.attachment.url).toContain("/api/workspace-file");
    } finally {
      process.env.HOME = prevHome;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("POST /api/chat/upload accepts JSON base64", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-upload-json-"));
    tmpDirs.push(dir);
    const isolatedHome = path.join(dir, "home");
    fs.mkdirSync(isolatedHome, { recursive: true });
    const prevHome = process.env.HOME;
    process.env.HOME = isolatedHome;
    const config = testConfig(dir);
    const toolSessions = { closeAll: async () => undefined } as ToolSessionRegistry;
    const server = http.createServer(
      createRequestListener({ version: "test", config }, { toolSessions }),
    );
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const data = Buffer.from("legacy base64").toString("base64");
      const res = await fetch(`http://127.0.0.1:${port}/api/chat/upload`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          filename: "legacy.txt",
          mimeType: "text/plain",
          data,
        }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { attachment: { path: string } };
      expect(fs.existsSync(json.attachment.path)).toBe(true);
    } finally {
      process.env.HOME = prevHome;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("POST /api/chat/upload returns 413 for oversized multipart", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-upload-413-"));
    tmpDirs.push(dir);
    const isolatedHome = path.join(dir, "home");
    fs.mkdirSync(isolatedHome, { recursive: true });
    const prevHome = process.env.HOME;
    const prevMax = process.env.CURSOR_BRIDGE_MAX_UPLOAD_BYTES;
    process.env.HOME = isolatedHome;
    process.env.CURSOR_BRIDGE_MAX_UPLOAD_BYTES = "32";
    resetMaxUploadBytesCacheForTests();
    const config = testConfig(dir);
    const toolSessions = { closeAll: async () => undefined } as ToolSessionRegistry;
    const server = http.createServer(
      createRequestListener({ version: "test", config }, { toolSessions }),
    );
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    const boundary = "----413test";

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/chat/upload`, {
        method: "POST",
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        body:
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="big.bin"\r\n\r\n` +
          `${"a".repeat(64)}\r\n` +
          `--${boundary}--\r\n`,
      });
      expect(res.status).toBe(413);
    } finally {
      process.env.HOME = prevHome;
      if (prevMax === undefined) delete process.env.CURSOR_BRIDGE_MAX_UPLOAD_BYTES;
      else process.env.CURSOR_BRIDGE_MAX_UPLOAD_BYTES = prevMax;
      resetMaxUploadBytesCacheForTests();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
