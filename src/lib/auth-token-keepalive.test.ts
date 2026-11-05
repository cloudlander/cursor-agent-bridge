import { describe, expect, it } from "vitest";

import type { BridgeConfig } from "./config.js";
import {
  DEFAULT_AUTH_REFRESH_SKEW_SEC,
  isAccessTokenExpiringSoon,
  shouldRunAuthKeepaliveTick,
  loadAuthKeepaliveOptions,
} from "./auth-token-keepalive.js";

function fakeJwt(expSec: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
    "base64url",
  );
  const payload = Buffer.from(JSON.stringify({ exp: expSec })).toString(
    "base64url",
  );
  return `${header}.${payload}.sig`;
}

const baseConfig: BridgeConfig = {
  agentBin: "agent",
  acpCommand: "agent",
  acpArgs: ["acp"],
  acpEnv: {},
  host: "127.0.0.1",
  port: 8765,
  defaultModel: "default",
  mode: "ask",
  force: false,
  approveMcps: false,
  strictModel: true,
  workspace: "/tmp",
  timeoutMs: 30_000,
  sessionsLogPath: "/tmp/sessions.log",
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
  bridgePackageVersion: "test",
    routerEnabled: false,
    routerConfigPath: "/tmp/model-router.json",
    routerQuotaThreshold: 0.1,
    routerTimeoutMs: 8000,
};

describe("isAccessTokenExpiringSoon", () => {
  it("returns true when exp is within skew", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(
      isAccessTokenExpiringSoon(fakeJwt(now + 100), DEFAULT_AUTH_REFRESH_SKEW_SEC),
    ).toBe(true);
  });

  it("returns false when exp is far in the future", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(
      isAccessTokenExpiringSoon(
        fakeJwt(now + DEFAULT_AUTH_REFRESH_SKEW_SEC + 3600),
        DEFAULT_AUTH_REFRESH_SKEW_SEC,
      ),
    ).toBe(false);
  });
});

describe("loadAuthKeepaliveOptions", () => {
  it("defaults to enabled refresh mode", () => {
    const opts = loadAuthKeepaliveOptions({});
    expect(opts.enabled).toBe(true);
    expect(opts.mode).toBe("refresh");
  });

  it("respects disable env", () => {
    expect(
      loadAuthKeepaliveOptions({ CURSOR_BRIDGE_AUTH_KEEPALIVE: "false" })
        .enabled,
    ).toBe(false);
  });
});

describe("shouldRunAuthKeepaliveTick", () => {
  it("skips when disabled", () => {
    expect(
      shouldRunAuthKeepaliveTick(
        baseConfig,
        {
          enabled: false,
          intervalMs: 60_000,
          skewSec: 300,
          mode: "refresh",
        },
        undefined,
      ),
    ).toBe(false);
  });

  it("runs in always mode when API key is configured", () => {
    expect(
      shouldRunAuthKeepaliveTick(
        { ...baseConfig, acpEnv: { CURSOR_API_KEY: "key" } },
        {
          enabled: true,
          intervalMs: 60_000,
          skewSec: 300,
          mode: "always",
        },
        undefined,
      ),
    ).toBe(true);
  });
});
