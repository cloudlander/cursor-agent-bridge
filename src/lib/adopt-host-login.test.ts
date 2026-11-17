import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { adoptHostCursorLogin } from "./adopt-host-login.js";
import { accountAuthJsonPath, readCachedToken } from "./token-cache.js";
import type { EnvSource } from "./env.js";

function jwt(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${body}.sig`;
}

describe("adoptHostCursorLogin", () => {
  const homes: string[] = [];

  afterEach(() => {
    for (const home of homes) {
      fs.rmSync(home, { recursive: true, force: true });
    }
    homes.length = 0;
  });

  function fakeAgentEnv(): { home: string; env: EnvSource } {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "adopt-host-"));
    homes.push(home);
    const binDir = path.join(home, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const agent = path.join(binDir, "agent");
    fs.writeFileSync(agent, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(agent, 0o755);
    return {
      home,
      env: { HOME: home, USERPROFILE: home, PATH: binDir },
    };
  }

  function writeProfile(
    home: string,
    auth: { email?: string; authId?: string; displayName?: string },
    extra: Record<string, unknown> = {},
  ): void {
    const dir = path.join(home, ".cursor");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "cli-config.json"),
      JSON.stringify({ version: 1, ...extra, authInfo: auth }),
    );
  }

  function writeSharedAuth(
    home: string,
    accessToken: string,
    refreshToken?: string,
  ): void {
    const dir = path.join(home, ".config", "cursor");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "auth.json"),
      JSON.stringify({ accessToken, refreshToken }),
    );
  }

  it("creates an account from the installed agent login and token", () => {
    const { home, env } = fakeAgentEnv();
    const token = jwt({
      sub: "auth0|user_A",
      email: "alice@example.com",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    writeProfile(
      home,
      { email: "alice@example.com", authId: "auth0|user_A", displayName: "Alice" },
      { model: "composer" },
    );
    writeSharedAuth(home, token, `${token}-refresh`);

    const config = { configDirs: [] as string[] };
    const result = adoptHostCursorLogin(config, { env, platform: "linux" });

    expect(result.adopted).toBe(true);
    expect(result.created).toBe(true);
    expect(result.name).toBe("alice");
    expect(config.configDirs).toEqual([result.configDir]);

    const cli = JSON.parse(
      fs.readFileSync(path.join(result.configDir!, "cli-config.json"), "utf-8"),
    ) as { model?: string; authInfo?: { email?: string; authId?: string } };
    expect(cli.model).toBe("composer");
    expect(cli.authInfo?.email).toBe("alice@example.com");
    expect(cli.authInfo?.authId).toBe("auth0|user_A");

    const stored = JSON.parse(
      fs.readFileSync(accountAuthJsonPath(result.configDir!, "linux"), "utf-8"),
    ) as { accessToken: string; refreshToken: string };
    expect(stored.accessToken).toBe(token);
    expect(stored.refreshToken).toBe(`${token}-refresh`);
    expect(readCachedToken(result.configDir!)).toBe(token);

    const again = adoptHostCursorLogin(config, { env, platform: "linux" });
    expect(again.adopted).toBe(true);
    expect(again.created).toBe(false);
    expect(config.configDirs).toHaveLength(1);
  });

  it("does nothing when cursor-agent is not installed", () => {
    const { home, env } = fakeAgentEnv();
    env.PATH = path.join(home, "missing-bin");
    writeProfile(home, { email: "alice@example.com", authId: "auth0|user_A" });
    writeSharedAuth(home, jwt({ sub: "auth0|user_A", exp: 9_999_999_999 }));

    const config = { configDirs: [] as string[] };
    const result = adoptHostCursorLogin(config, { env, platform: "linux" });
    expect(result.adopted).toBe(false);
    expect(config.configDirs).toEqual([]);
    expect(fs.existsSync(path.join(home, ".cursor-api-proxy", "accounts"))).toBe(
      false,
    );
  });

  it("ignores an expired access token", () => {
    const { home, env } = fakeAgentEnv();
    writeProfile(home, { email: "alice@example.com", authId: "auth0|user_A" });
    writeSharedAuth(home, jwt({ sub: "auth0|user_A", exp: 1 }));

    const result = adoptHostCursorLogin(
      { configDirs: [] },
      { env, platform: "linux" },
    );
    expect(result.adopted).toBe(false);
  });

  it("uses the token identity when it does not match ~/.cursor", () => {
    const { home, env } = fakeAgentEnv();
    const token = jwt({
      sub: "auth0|user_B",
      email: "other@example.com",
      exp: 9_999_999_999,
    });
    writeProfile(home, { email: "alice@example.com", authId: "auth0|user_A" });
    writeSharedAuth(home, token);

    const config = { configDirs: [] as string[] };
    const result = adoptHostCursorLogin(config, { env, platform: "linux" });
    expect(result.created).toBe(true);
    const cli = JSON.parse(
      fs.readFileSync(path.join(result.configDir!, "cli-config.json"), "utf-8"),
    ) as { authInfo?: { email?: string; authId?: string }; model?: string };
    expect(cli.authInfo?.email).toBe("other@example.com");
    expect(cli.authInfo?.authId).toBe("auth0|user_B");
    expect(cli.model).toBeUndefined();
  });

  it("keeps an existing account with the same login", () => {
    const { home, env } = fakeAgentEnv();
    const token = jwt({ sub: "auth0|user_A", exp: 9_999_999_999 });
    writeProfile(home, { email: "alice@example.com", authId: "auth0|user_A" });
    writeSharedAuth(home, token);
    const existing = path.join(home, ".cursor-api-proxy", "accounts", "work");
    fs.mkdirSync(existing, { recursive: true });
    fs.writeFileSync(
      path.join(existing, "cli-config.json"),
      JSON.stringify({
        authInfo: { email: "alice@example.com", authId: "auth0|user_A" },
      }),
    );

    const config = { configDirs: [] as string[] };
    const result = adoptHostCursorLogin(config, { env, platform: "linux" });
    expect(result.created).toBe(false);
    expect(result.adopted).toBe(true);
    expect(path.resolve(result.configDir!)).toBe(path.resolve(existing));
    expect(
      fs.readdirSync(path.join(home, ".cursor-api-proxy", "accounts")),
    ).toEqual(["work"]);
  });

  it("creates an account from CURSOR_API_KEY when the CLI has no auth file", () => {
    const { env } = fakeAgentEnv();
    const token = jwt({
      sub: "auth0|user_K",
      email: "key@example.com",
      exp: 9_999_999_999,
    });
    env.CURSOR_API_KEY = token;

    const result = adoptHostCursorLogin(
      { configDirs: [] },
      { env, platform: "linux" },
    );
    expect(result.created).toBe(true);
    expect(result.name).toBe("key");
    expect(readCachedToken(result.configDir!)).toBe(token);
  });

  it("does not adopt when account dirs are pinned or adoption is disabled", () => {
    const { home, env } = fakeAgentEnv();
    writeProfile(home, { email: "alice@example.com", authId: "auth0|user_A" });
    writeSharedAuth(home, jwt({ sub: "auth0|user_A", exp: 9_999_999_999 }));

    const pinned = adoptHostCursorLogin(
      { configDirs: ["/explicit"] },
      { env: { ...env, CURSOR_CONFIG_DIRS: "/explicit" }, platform: "linux" },
    );
    expect(pinned.adopted).toBe(false);

    const disabled = adoptHostCursorLogin(
      { configDirs: [] },
      {
        env: { ...env, CURSOR_BRIDGE_ADOPT_HOST_LOGIN: "0" },
        platform: "linux",
      },
    );
    expect(disabled.adopted).toBe(false);
    expect(fs.existsSync(path.join(home, ".cursor-api-proxy", "accounts"))).toBe(
      false,
    );
  });
});
