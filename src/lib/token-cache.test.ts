import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  TOKEN_FILE,
  accessTokenMatchesAuthId,
  readAccessTokenForAuth,
  readCachedToken,
  syncAccessTokenCacheForAuth,
  writeCachedToken,
} from "./token-cache.js";

describe("token-cache per-account", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    dirs.length = 0;
  });

  function mkDir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "token-cache-test-"));
    dirs.push(d);
    return d;
  }

  const authA = "auth0|user_A";
  const authB = "auth0|user_B";
  // JWT-shaped stubs (payload only needs `sub` for tokenSub)
  const tokenA =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
    Buffer.from(JSON.stringify({ sub: authA }), "utf-8").toString("base64url") +
    ".sig";
  const tokenB =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
    Buffer.from(JSON.stringify({ sub: authB }), "utf-8").toString("base64url") +
    ".sig";

  it("rejects cached token when authId does not match", () => {
    const dir = mkDir();
    writeCachedToken(dir, tokenA);
    expect(readAccessTokenForAuth(dir, authB)).toBeUndefined();
    expect(readAccessTokenForAuth(dir, authA)).toBe(tokenA);
  });

  it("accessTokenMatchesAuthId requires matching sub when authId is set", () => {
    expect(accessTokenMatchesAuthId(tokenA, authA)).toBe(true);
    expect(accessTokenMatchesAuthId(tokenA, authB)).toBe(false);
    expect(accessTokenMatchesAuthId(tokenA, undefined)).toBe(true);
  });

  it("does not write mismatched token to cache", () => {
    const dir = mkDir();
    const prevHome = process.env.HOME;
    const home = mkDir();
    process.env.HOME = home;
    const configHome = path.join(home, ".config", "cursor");
    fs.mkdirSync(configHome, { recursive: true });
    fs.writeFileSync(
      path.join(configHome, "auth.json"),
      JSON.stringify({ accessToken: tokenA }),
    );
    try {
      syncAccessTokenCacheForAuth(dir, authB);
      expect(readCachedToken(dir)).toBeUndefined();
      syncAccessTokenCacheForAuth(dir, authA);
      expect(readCachedToken(dir)).toBe(tokenA);
    } finally {
      process.env.HOME = prevHome;
    }
  });
});
