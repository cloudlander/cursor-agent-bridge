import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyAccountCliAuthEnv,
  cliCredentialStoreEnv,
} from "./account-cli-auth.js";
import { accountAuthJsonPath, accountCliAuthRoot } from "./token-cache.js";

describe("applyAccountCliAuthEnv", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  function mkDir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "account-cli-auth-"));
    dirs.push(d);
    return d;
  }

  const authA = "auth0|user_A";
  const tokenA =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
    Buffer.from(JSON.stringify({ sub: authA }), "utf-8").toString("base64url") +
    ".sig";

  it("points the child at this account's auth file and drops a global API key", () => {
    const dir = mkDir();
    fs.writeFileSync(
      path.join(dir, "cli-config.json"),
      JSON.stringify({ authInfo: { authId: authA, email: "a@example.com" } }),
    );
    fs.writeFileSync(path.join(dir, ".cursor-token"), tokenA, { mode: 0o600 });

    const env: Record<string, string | undefined> = {
      CURSOR_API_KEY: "key-for-someone-else",
      CURSOR_AUTH_TOKEN: "token-for-someone-else",
      CURSOR_CONFIG_DIR: dir,
    };
    applyAccountCliAuthEnv(env, dir);

    expect(env.CURSOR_API_KEY).toBeUndefined();
    expect(env.CURSOR_AUTH_TOKEN).toBeUndefined();
    if (process.platform === "win32") {
      expect(env.APPDATA).toBe(accountCliAuthRoot(dir));
    } else if (process.platform === "darwin") {
      expect(env.HOME).toBe(accountCliAuthRoot(dir));
      expect(env.AGENT_CLI_CREDENTIAL_STORE).toBe("file");
    } else {
      expect(env.XDG_CONFIG_HOME).toBe(accountCliAuthRoot(dir));
      expect(env.AGENT_CLI_CREDENTIAL_STORE).toBeUndefined();
    }
    const stored = JSON.parse(
      fs.readFileSync(accountAuthJsonPath(dir), "utf-8"),
    ) as { accessToken: string };
    expect(stored.accessToken).toBe(tokenA);
  });

  it("forces the file credential store on macOS only", () => {
    expect(cliCredentialStoreEnv("darwin")).toEqual({
      AGENT_CLI_CREDENTIAL_STORE: "file",
    });
    expect(cliCredentialStoreEnv("linux")).toEqual({});
    expect(cliCredentialStoreEnv("win32")).toEqual({});
  });
});
