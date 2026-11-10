import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BridgeConfig } from "./config.js";
import {
  accountNameAvailabilityError,
  discoverAuthenticatedAccountDirs,
  findDuplicateAuthError,
  isManagedAccountDir,
  registerAccountInBridge,
  removeManagedAccount,
  sanitizeAccountName,
} from "./account-registry.js";
import { initAccountPool } from "./account-pool.js";

function testConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
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
    timeoutMs: 30_000,
    sessionsLogPath: path.join(tmpHome, "sessions.log"),
    chatOnlyWorkspace: true,
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
    winCmdlineMax: 30_000,
    contextPreamble: true,
    bridgePackageVersion: "0.0.0-test",
    authKeepalive: {
      enabled: false,
      intervalMs: 240_000,
      skewSec: 300,
      mode: "refresh",
    },
    appSegment: "cursor-agent",
    ...overrides,
  };
}

let tmpHome = "";

function accountsRoot(): string {
  return path.join(tmpHome, ".cursor-api-proxy", "accounts");
}

describe("account-registry", () => {
  let prevHome: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "cap-acct-reg-"));
    prevHome = process.env.HOME;
    process.env.HOME = tmpHome;
    fs.mkdirSync(accountsRoot(), { recursive: true });
    initAccountPool([]);
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function writeAuth(configDir: string, email: string, authId: string): void {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "cli-config.json"),
      JSON.stringify({ authInfo: { email, authId } }),
      "utf8",
    );
  }

  it("sanitizeAccountName strips unsafe characters", () => {
    expect(sanitizeAccountName("  my.account_1 ")).toBe("my.account_1");
    expect(sanitizeAccountName("***")).toBe("-");
  });

  it("accountNameAvailabilityError rejects existing authenticated folder", () => {
    writeAuth(path.join(accountsRoot(), "work"), "a@b.com", "id1");
    expect(accountNameAvailabilityError("work")).toMatch(/already/i);
  });

  it("discoverAuthenticatedAccountDirs lists signed-in accounts only", () => {
    writeAuth(path.join(accountsRoot(), "a"), "a@b.com", "id1");
    fs.mkdirSync(path.join(accountsRoot(), "empty"), { recursive: true });
    const dirs = discoverAuthenticatedAccountDirs();
    expect(dirs).toHaveLength(1);
    expect(path.basename(dirs[0])).toBe("a");
  });

  it("findDuplicateAuthError matches email and authId", () => {
    const existing = path.join(accountsRoot(), "primary");
    writeAuth(existing, "user@example.com", "sub-123");
    const config = testConfig({ configDirs: [existing] });
    const newDir = path.join(accountsRoot(), "duplicate");
    writeAuth(newDir, "user@example.com", "sub-999");

    expect(
      findDuplicateAuthError(config, newDir, {
        email: "user@example.com",
        authId: "sub-999",
      }),
    ).toMatch(/already added/i);
  });

  it("registerAccountInBridge rejects duplicate and removes new managed dir", () => {
    const existing = path.join(accountsRoot(), "primary");
    writeAuth(existing, "user@example.com", "sub-123");
    const config = testConfig({ configDirs: [existing] });
    const newDir = path.join(accountsRoot(), "dup");
    writeAuth(newDir, "user@example.com", "sub-123");

    const result = registerAccountInBridge(config, newDir);
    expect(result.ok).toBe(false);
    expect(fs.existsSync(newDir)).toBe(false);
    expect(config.configDirs).toEqual([existing]);
  });

  it("removeManagedAccount rejects removing the only account", () => {
    const dir = path.join(accountsRoot(), "only-one");
    writeAuth(dir, "x@y.com", "id-x");
    const config = testConfig({ configDirs: [dir] });

    const result = removeManagedAccount(config, dir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/only configured/i);
    }
    expect(fs.existsSync(dir)).toBe(true);
    expect(config.configDirs).toEqual([dir]);
  });

  it("removeManagedAccount deletes folder and updates config when another remains", () => {
    const keep = path.join(accountsRoot(), "keep");
    const dir = path.join(accountsRoot(), "remove-me");
    writeAuth(keep, "a@y.com", "id-a");
    writeAuth(dir, "x@y.com", "id-x");
    const config = testConfig({ configDirs: [keep, dir] });

    const result = removeManagedAccount(config, dir);
    expect(result.ok).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
    expect(config.configDirs).toEqual([keep]);
  });

  it("isManagedAccountDir is false for arbitrary paths", () => {
    expect(isManagedAccountDir("/tmp/not-managed")).toBe(false);
    expect(isManagedAccountDir(path.join(accountsRoot(), "ok"))).toBe(true);
  });
});
