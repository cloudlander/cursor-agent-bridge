import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { BridgeConfig } from "./config.js";
import {
  createWorkspace,
  deleteWorkspace,
  listWorkspaces,
  normalizeWorkspaceName,
  renameWorkspace,
  resolveAgentWorkspace,
  userWorkspacesRoot,
} from "./workspaces.js";

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
    chatOnlyWorkspace: false,
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

describe("workspace names", () => {
  it("trims whitespace and rejects empty or overlong names", () => {
    expect(normalizeWorkspaceName("  Research \n")).toBe("Research");
    expect(normalizeWorkspaceName("   ")).toBeNull();
    expect(normalizeWorkspaceName("x".repeat(65))).toBeNull();
  });
});

describe("workspace registry", () => {
  it("creates a default workspace and a generated directory for new names", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
    tmpDirs.push(dir);
    const config = testConfig(dir);
    const listed = await listWorkspaces(config);
    expect(listed[0]).toMatchObject({ id: "default", name: "Default", dirName: null, isDefault: true });

    const created = await createWorkspace(config, "  Lab  ");
    expect(created.name).toBe("Lab");
    expect(created.id).toMatch(/^ws_[0-9a-f]{16}$/);
    expect(created.dirName).toBe(created.id);
    expect(fs.statSync(path.join(userWorkspacesRoot(config), created.id)).isDirectory()).toBe(true);

    const renamed = await renameWorkspace(config, created.id, "Bench");
    expect(renamed.name).toBe("Bench");
    expect(renamed.dirName).toBe(created.id);

    const resolved = await resolveAgentWorkspace(config, {
      workspaceId: created.id,
      chatOnly: false,
      fromWebChat: true,
    });
    expect(resolved.workspaceDir).toBe(fs.realpathSync(path.join(userWorkspacesRoot(config), created.id)));
    expect(resolved.record.name).toBe("Bench");

    const fallback = await resolveAgentWorkspace(config, {
      workspaceId: "missing",
      chatOnly: false,
      fromWebChat: true,
    });
    expect(fallback.workspaceDir).toBe(path.resolve(dir));
    expect(fallback.record.id).toBe("default");

    await expect(deleteWorkspace(config, "default")).rejects.toThrow(/cannot be deleted/);
    await deleteWorkspace(config, created.id);
    expect(fs.existsSync(path.join(userWorkspacesRoot(config), created.id))).toBe(false);
    const after = await listWorkspaces(config);
    expect(after.map((row) => row.id)).toEqual(["default"]);
  });

  it("keeps chat-only cwd on a temp dir and API paths under the project workspace", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
    tmpDirs.push(dir);
    const config = { ...testConfig(dir), chatOnlyWorkspace: true };
    const created = await createWorkspace(config, "Sandbox");
    const isolated = await resolveAgentWorkspace(config, {
      workspaceId: created.id,
      chatOnly: true,
      fromWebChat: true,
    });
    expect(isolated.tempDir).toBeTruthy();
    expect(isolated.workspaceDir).toBe(isolated.tempDir);
    expect(isolated.record.id).toBe(created.id);
    fs.rmSync(isolated.tempDir!, { recursive: true, force: true });

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ws-out-"));
    tmpDirs.push(outside);
    await expect(
      resolveAgentWorkspace(config, {
        headerWs: outside,
        chatOnly: false,
        fromWebChat: false,
      }),
    ).rejects.toThrow(/configured workspace base/);
  });
});
