import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";

import type { BridgeConfig } from "./config.js";
import { runAgentSync, runAgentStream } from "./agent-runner.js";
import { runAcpStream, runAcpSync } from "./acp-client.js";

vi.mock("./acp-client.js", () => ({
  runAcpSync: vi.fn().mockResolvedValue({ code: 0, stdout: "ok", stderr: "" }),
  runAcpStream: vi.fn().mockResolvedValue({ code: 0, stderr: "" }),
}));

vi.mock("./process.js", () => ({
  run: vi.fn().mockResolvedValue({ code: 0, stdout: "cli", stderr: "" }),
  runStreaming: vi.fn().mockResolvedValue({ code: 0, stderr: "" }),
}));

vi.mock("./token-cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./token-cache.js")>();
  return {
    ...actual,
    readKeychainToken: vi.fn().mockReturnValue(undefined),
    writeCachedToken: vi.fn(),
    syncAccessTokenCacheForAuth: vi.fn(),
  };
});

function config(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    agentBin: "agent",
    acpCommand: "agent",
    acpArgs: ["acp"],
    acpEnv: {},
    host: "127.0.0.1",
    port: 0,
    defaultModel: "default",
    mode: "ask",
    force: false,
    approveMcps: false,
    strictModel: true,
    workspace: process.cwd(),
    timeoutMs: 123_456,
    sessionsLogPath: "/tmp/agent-runner-test.log",
    chatOnlyWorkspace: true,
    chatOnlyWorkspaceExplicit: false,
    verbose: false,
    verboseFull: false,
    maxMode: false,
    promptViaStdin: false,
    useAcp: true,
    acpSkipAuthenticate: true,
    acpRawDebug: false,
    configDirs: [],
    multiPort: false,
    winCmdlineMax: 30_000,
    contextPreamble: true,
    appSegment: "cursor-agent",
    cdswBypassAuthentication: true,
    bridgePackageVersion: "0.0.0-test",
    ...overrides,
  };
}

describe("ACP requestTimeoutMs", () => {
  beforeEach(() => {
    vi.mocked(runAcpSync).mockClear();
    vi.mocked(runAcpStream).mockClear();
  });

  it("passes config.timeoutMs as ACP sync requestTimeoutMs", async () => {
    await runAgentSync(
      config(),
      "/tmp/ws",
      true,
      ["--print", "--mode", "ask", "--model", "auto"],
      undefined,
      "hello",
    );
    expect(runAcpSync).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runAcpSync).mock.calls[0][3]).toMatchObject({
      timeoutMs: 123_456,
      requestTimeoutMs: 123_456,
    });
  });

  it("passes config.timeoutMs as ACP stream requestTimeoutMs", async () => {
    await runAgentStream(
      config(),
      "/tmp/ws",
      true,
      ["--print", "--mode", "ask", "--model", "auto"],
      () => {},
      undefined,
      "hello",
    );
    expect(runAcpStream).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runAcpStream).mock.calls[0][3]).toMatchObject({
      timeoutMs: 123_456,
      requestTimeoutMs: 123_456,
    });
  });

  it("does not write the API run into the account directory", async () => {
    const account = fs.mkdtempSync(path.join(os.tmpdir(), "agent-run-account-"));
    fs.writeFileSync(
      path.join(account, "cli-config.json"),
      JSON.stringify({ version: 1 }),
    );
    try {
      await runAgentSync(
        config(),
        "/tmp/ws",
        true,
        ["--print", "--mode", "ask", "--model", "auto"],
        undefined,
        "hello",
        account,
      );
      expect(fs.readdirSync(account)).toEqual(["cli-config.json"]);
      const env = vi.mocked(runAcpSync).mock.calls.at(-1)?.[3].env ?? {};
      const cursorConfig = env.CURSOR_CONFIG_DIR ?? "";
      expect(cursorConfig).not.toBe("");
      expect(path.resolve(cursorConfig)).not.toBe(path.resolve(account));
      expect(fs.existsSync(cursorConfig)).toBe(false);
      if (process.platform !== "win32" && process.platform !== "darwin") {
        expect(env.XDG_CONFIG_HOME).toBe(path.join(account, "cli-auth"));
      }
    } finally {
      fs.rmSync(account, { recursive: true, force: true });
    }
  });
});
