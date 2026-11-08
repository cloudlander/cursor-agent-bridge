import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import type { BridgeConfig } from "./config.js";
import {
  classifyWorkspaceFile,
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
    appSegment: "cursor-agent",
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

  it("allows downloadable text under workspace", () => {
    const doc = path.join(tmpDir, "notes.txt");
    fs.writeFileSync(doc, "hello");
    const resolved = resolveWorkspaceFilePath(doc, config);
    expect(resolved).toBeTruthy();
    expect(isAllowedWorkspaceFile(resolved!, config)).toBe(false);
    expect(classifyWorkspaceFile(resolved!, config)).toBe("download");
  });

  it("allows files under managed outputs dir", () => {
    const outDir = path.join(tmpDir, ".cursor-api-proxy", "outputs");
    fs.mkdirSync(outDir, { recursive: true });
    const report = path.join(outDir, "report.pdf");
    fs.writeFileSync(report, "%PDF-1.4");
    const resolved = resolveWorkspaceFilePath(report, config);
    expect(resolved).toBeTruthy();
    expect(classifyWorkspaceFile(resolved!, config)).toBe("download");
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

  it("blocks sensitive basenames under workspace", () => {
    const envFile = path.join(tmpDir, ".env");
    fs.writeFileSync(envFile, "SECRET=1");
    const resolved = resolveWorkspaceFilePath(envFile, config);
    expect(resolved).toBeTruthy();
    expect(classifyWorkspaceFile(resolved!, config)).toBeNull();
  });

  it("builds download URL when requested", () => {
    const url = workspaceFileUrlForPath("/tmp/report.pdf", true);
    expect(url).toContain("download=1");
  });

  it("classifies svg under uploads as download not inline image", () => {
    const upDir = path.join(tmpDir, ".cursor-api-proxy", "uploads");
    fs.mkdirSync(upDir, { recursive: true });
    const svg = path.join(upDir, "chart.svg");
    fs.writeFileSync(svg, "<svg></svg>");
    const resolved = resolveWorkspaceFilePath(svg, config)!;
    expect(classifyWorkspaceFile(resolved, config)).toBe("download");
  });

  it("classifies agent svg under outputs as inline image", () => {
    const outDir = path.join(tmpDir, ".cursor-api-proxy", "outputs");
    fs.mkdirSync(outDir, { recursive: true });
    const svg = path.join(outDir, "diagram.svg");
    fs.writeFileSync(svg, "<svg></svg>");
    const resolved = resolveWorkspaceFilePath(svg, config)!;
    expect(classifyWorkspaceFile(resolved, config)).toBe("inline-image");
    expect(isAllowedWorkspaceFile(resolved, config)).toBe(true);
  });

  it("classifies workspace-root agent svg as inline image", () => {
    const svg = path.join(tmpDir, "plot.svg");
    fs.writeFileSync(svg, "<svg></svg>");
    const resolved = resolveWorkspaceFilePath(svg, config)!;
    expect(classifyWorkspaceFile(resolved, config)).toBe("inline-image");
  });
});
