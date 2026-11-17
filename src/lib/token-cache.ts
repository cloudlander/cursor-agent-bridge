import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { tokenSub } from "./cursor-account-api.js";

/** Token file written per-account after each agent run */
export const TOKEN_FILE = ".cursor-token";

export function readCachedToken(configDir: string): string | undefined {
  try {
    const p = path.join(configDir, TOKEN_FILE);
    if (fs.existsSync(p))
      return fs.readFileSync(p, "utf-8").trim() || undefined;
  } catch {
    /* ignore */
  }
  return undefined;
}

export function writeCachedToken(configDir: string, token: string): void {
  try {
    fs.writeFileSync(path.join(configDir, TOKEN_FILE), token, {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch {
    /* ignore */
  }
}

/** True when the JWT `sub` matches this account's `authId` from cli-config. */
export function accessTokenMatchesAuthId(
  token: string,
  authId: string | undefined,
): boolean {
  if (!authId?.trim()) return true;
  const sub = tokenSub(token);
  return Boolean(sub && sub === authId);
}

/** Private XDG/APPDATA/HOME root whose `auth.json` belongs to one account. */
export const ACCOUNT_CLI_AUTH_DIR = "cli-auth";

export type StoredCliAuth = {
  accessToken?: string;
  refreshToken?: string;
  apiKey?: string;
};

export function accountCliAuthRoot(configDir: string): string {
  return path.join(configDir, ACCOUNT_CLI_AUTH_DIR);
}

/**
 * Path the Cursor CLI reads for this account once `applyAccountCliAuthEnv`
 * points the process at `accountCliAuthRoot`.
 * Linux: `$XDG_CONFIG_HOME/cursor/auth.json`
 * macOS: `$HOME/.cursor/auth.json`
 * Windows: `%APPDATA%/Cursor/auth.json`
 */
export function accountAuthJsonPath(
  configDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const root = accountCliAuthRoot(configDir);
  if (platform === "win32") return path.join(root, "Cursor", "auth.json");
  if (platform === "darwin") return path.join(root, ".cursor", "auth.json");
  return path.join(root, "cursor", "auth.json");
}

function readAuthJson(file: string): StoredCliAuth | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as StoredCliAuth;
    return raw && typeof raw === "object" ? raw : undefined;
  } catch {
    return undefined;
  }
}

function writeAuthJson(file: string, data: StoredCliAuth): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload: StoredCliAuth = {};
  if (data.accessToken?.trim()) payload.accessToken = data.accessToken.trim();
  if (data.refreshToken?.trim()) payload.refreshToken = data.refreshToken.trim();
  if (data.apiKey?.trim()) payload.apiKey = data.apiKey.trim();
  fs.writeFileSync(file, JSON.stringify(payload), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

function tokenOk(
  token: unknown,
  authId: string | undefined,
): token is string {
  return (
    typeof token === "string" &&
    token.trim() !== "" &&
    accessTokenMatchesAuthId(token.trim(), authId)
  );
}

function sharedAuthJsonPath(): string | undefined {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const configHome =
    process.env.XDG_CONFIG_HOME || (home ? path.join(home, ".config") : "");
  if (!configHome) return undefined;
  return path.join(configHome, "cursor", "auth.json");
}

/**
 * Materialize this account's CLI `auth.json` from a credential that matches
 * `authId`. A shared login for a different account is never copied in.
 * Returns false when this account has no usable credential.
 */
export function ensureAccountCliAuth(
  configDir: string,
  authId: string | undefined,
): boolean {
  const dest = accountAuthJsonPath(configDir);
  const existing = readAuthJson(dest);
  if (existing && tokenOk(existing.accessToken, authId)) return true;

  if (!authId?.trim()) {
    if (fs.existsSync(dest)) fs.rmSync(dest, { force: true });
    return false;
  }

  const sharedPath = sharedAuthJsonPath();
  const shared = sharedPath ? readAuthJson(sharedPath) : undefined;
  if (shared && tokenOk(shared.accessToken, authId)) {
    const access = shared.accessToken.trim();
    const refresh = tokenOk(shared.refreshToken, authId)
      ? shared.refreshToken.trim()
      : access;
    writeAuthJson(dest, { accessToken: access, refreshToken: refresh, apiKey: shared.apiKey });
    writeCachedToken(configDir, access);
    return true;
  }

  const keychain = readKeychainToken();
  if (keychain && accessTokenMatchesAuthId(keychain, authId)) {
    writeAuthJson(dest, { accessToken: keychain, refreshToken: keychain });
    writeCachedToken(configDir, keychain);
    return true;
  }

  const cached = readCachedToken(configDir);
  if (cached && accessTokenMatchesAuthId(cached, authId)) {
    writeAuthJson(dest, { accessToken: cached, refreshToken: cached });
    return true;
  }

  if (fs.existsSync(dest)) fs.rmSync(dest, { force: true });
  return false;
}

/**
 * Per-account access token for Cursor HTTP APIs (usage, billing).
 * Never returns a shared keychain/auth.json token unless it matches `authId`.
 */
export function readAccessTokenForAuth(
  configDir: string,
  authId: string | undefined,
): string | undefined {
  const local = readAuthJson(accountAuthJsonPath(configDir));
  if (local && tokenOk(local.accessToken, authId)) return local.accessToken.trim();
  const cached = readCachedToken(configDir);
  if (cached && accessTokenMatchesAuthId(cached, authId)) return cached;
  const keychain = readKeychainToken();
  if (keychain && accessTokenMatchesAuthId(keychain, authId)) return keychain;
  return undefined;
}

/** Copy a matching CLI auth token into the account cache. */
export function syncAccessTokenCacheForAuth(
  configDir: string,
  authId: string | undefined,
): void {
  const local = readAuthJson(accountAuthJsonPath(configDir));
  if (local && tokenOk(local.accessToken, authId)) {
    writeCachedToken(configDir, local.accessToken.trim());
    return;
  }
  const keychain = readKeychainToken();
  if (!keychain || !accessTokenMatchesAuthId(keychain, authId)) return;
  writeCachedToken(configDir, keychain);
}

/** macOS Keychain slot written by `agent login`. Empty on other platforms. */
export function readMacKeychainAccessToken(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    const t = execSync(
      'security find-generic-password -s "cursor-access-token" -w',
      { stdio: ["pipe", "pipe", "pipe"], timeout: 5000 },
    )
      .toString()
      .trim();
    return t || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read the Cursor CLI's shared access token: the macOS Keychain slot, or
 * `$XDG_CONFIG_HOME/cursor/auth.json` (default `~/.config/cursor`) elsewhere.
 */
export function readKeychainToken(): string | undefined {
  return readMacKeychainAccessToken() ?? readAuthFileToken();
}

/** Persist this account's CLI `auth.json` and `.cursor-token` cache. */
export function writeAccountCliCredentials(
  configDir: string,
  creds: { accessToken: string; refreshToken?: string },
  platform: NodeJS.Platform = process.platform,
): void {
  const access = creds.accessToken.trim();
  if (!access) return;
  const refresh = creds.refreshToken?.trim() || access;
  writeAuthJson(accountAuthJsonPath(configDir, platform), {
    accessToken: access,
    refreshToken: refresh,
  });
  writeCachedToken(configDir, access);
}

function readAuthFileToken(): string | undefined {
  const file = sharedAuthJsonPath();
  if (!file) return undefined;
  const raw = readAuthJson(file);
  return raw?.accessToken?.trim() || undefined;
}
