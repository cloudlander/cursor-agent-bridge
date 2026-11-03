import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import type { BridgeConfig } from "./config.js";
import {
  isAllowedWorkspaceFile,
  resolveWorkspaceFilePath,
  workspaceFileUrlForPath,
} from "./workspace-file.js";

function baseConfig(workspace: string): BridgeConfig {
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
    workspace,
    timeoutMs: 30_000,
    sessionsLogPath: path.join(workspace, "sessions.log"),
    chatOnlyWorkspace: false,
    chatOnlyWorkspaceExplicit: false,
    verbose: false,
    verboseFull: false,
    maxMode: false,
    promptViaStdin: false,
    useAcp: false,
    acpSkipAuthenticate: false,
    acpRawDebug: false,
    configDirs: [],
    multiPort: false,
    winCmdlineMax: 8191,
    contextPreamble: false,
    bridgePackageVersion: "test",
  };
}

describe("workspace-file", () => {
  let tmpDir: string;
  let config: BridgeConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-file-"));
    config = baseConfig(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("allows images under workspace", () => {
    const assetsDir = path.join(tmpDir, ".cai", "home", ".cursor", "projects", "p", "assets");
    fs.mkdirSync(assetsDir, { recursive: true });
    const img = path.join(assetsDir, "diagram.png");
    fs.writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const resolved = resolveWorkspaceFilePath(img, config);
    expect(resolved).toBeTruthy();
    expect(isAllowedWorkspaceFile(resolved!, config)).toBe(true);
  });

  it("rejects non-image extensions", () => {
    const secret = path.join(tmpDir, "secret.txt");
    fs.writeFileSync(secret, "nope");
    const resolved = resolveWorkspaceFilePath(secret, config);
    expect(resolved).toBeTruthy();
    expect(isAllowedWorkspaceFile(resolved!, config)).toBe(false);
  });

  it("rejects paths outside workspace", () => {
    const outside = path.join(os.tmpdir(), `outside-${Date.now()}.png`);
    fs.writeFileSync(outside, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    try {
      const resolved = resolveWorkspaceFilePath(outside, config);
      expect(resolved).toBeTruthy();
      expect(isAllowedWorkspaceFile(resolved!, config)).toBe(false);
    } finally {
      fs.unlinkSync(outside);
    }
  });

  it("builds proxy URL for absolute paths", () => {
    const url = workspaceFileUrlForPath("/home/user/proj/assets/a.png");
    expect(url).toBe("/api/workspace-file?path=%2Fhome%2Fuser%2Fproj%2Fassets%2Fa.png");
  });
});
