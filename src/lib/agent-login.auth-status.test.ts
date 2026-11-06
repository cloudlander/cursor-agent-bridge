import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { BridgeConfig } from "./config.js";
import { resolveAgentAuthStatus } from "./agent-login.js";

describe("resolveAgentAuthStatus", () => {
  const prevHome = process.env.HOME;
  const prevXdgConfigHome = process.env.XDG_CONFIG_HOME;
  let tmpHome: string;

  function useIsolatedHome(): void {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-auth-"));
    process.env.HOME = tmpHome;
    // readKeychainToken() prefers XDG_CONFIG_HOME over $HOME/.config (see token-cache.ts).
    delete process.env.XDG_CONFIG_HOME;
  }

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdgConfigHome;
    if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function minimalConfig(configDirs: string[]): BridgeConfig {
    return {
      configDirs,
    } as BridgeConfig;
  }

  it("is not authenticated when cli-config has authInfo but auth.json is missing", () => {
    useIsolatedHome();

    const cursorDir = path.join(tmpHome, ".cursor");
    fs.mkdirSync(cursorDir, { recursive: true });
    fs.writeFileSync(
      path.join(cursorDir, "cli-config.json"),
      JSON.stringify({
        authInfo: { email: "user@example.com", authId: "sub" },
      }),
      "utf-8",
    );

    const status = resolveAgentAuthStatus(minimalConfig([cursorDir]));
    expect(status.authenticated).toBe(false);
    expect(status.viaApiKey).toBe(false);
  });

  it("is authenticated when auth.json has an access token", () => {
    useIsolatedHome();

    const authDir = path.join(tmpHome, ".config", "cursor");
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(
      path.join(authDir, "auth.json"),
      JSON.stringify({ accessToken: "test-token" }),
      "utf-8",
    );

    const status = resolveAgentAuthStatus(minimalConfig([]));
    expect(status.authenticated).toBe(true);
  });
});
