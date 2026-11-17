import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { sanitizeAccountName } from "./account-registry.js";
import { readCursorCliAuth } from "./cursor-account-snapshot.js";
import { decodeJwtPayload, tokenSub } from "./cursor-account-api.js";
import { cursorConfigDir } from "./run-config-dir.js";
import {
  readMacKeychainAccessToken,
  writeAccountCliCredentials,
} from "./token-cache.js";
import { installedAgentBinary, type EnvSource } from "./env.js";

export type AdoptHostLoginResult = {
  /** Host CLI identity is now in `config.configDirs`. */
  adopted: boolean;
  /** A new directory was created under `~/.cursor-api-proxy/accounts/`. */
  created: boolean;
  configDir?: string;
  name?: string;
};

type Identity = {
  email?: string;
  displayName?: string;
  authId?: string;
};

type Credential = {
  accessToken: string;
  refreshToken?: string;
};

/**
 * When `cursor-agent` / `agent` is installed and this machine already has a
 * valid Cursor token, copy that login into the account pool so startup does
 * not need `cursor-api-proxy login`.
 *
 * Skipped when `CURSOR_CONFIG_DIRS` / `CURSOR_ACCOUNT_DIRS` is set, or when
 * `CURSOR_BRIDGE_ADOPT_HOST_LOGIN` is `0` / `false` / `off`.
 */
export function adoptHostCursorLogin(
  config: { configDirs: string[] },
  opts: { env?: EnvSource; platform?: NodeJS.Platform } = {},
): AdoptHostLoginResult {
  const none: AdoptHostLoginResult = { adopted: false, created: false };
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  if (!adoptEnabled(env) || dirsPinned(env)) return none;
  if (!installedAgentBinary(env, platform)) return none;

  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || "";
  if (!home) return none;

  const profileDir = cursorConfigDir(env, platform);
  const profile = readCursorCliAuth(profileDir);
  const chosen = chooseCredential(env, platform, home, profile);
  if (!chosen) return none;

  const identity = chosen.identity;
  if (!identity.email && !identity.authId) return none;

  const existing = findExistingAccount(home, config.configDirs, profileDir, identity);
  if (existing) {
    remember(config, existing);
    return {
      adopted: true,
      created: false,
      configDir: path.resolve(existing),
      name: path.basename(existing),
    };
  }

  const name = uniqueAccountName(home, identity);
  const configDir = path.join(home, ".cursor-api-proxy", "accounts", name);
  try {
    writeCliConfig(
      configDir,
      identity,
      chosen.copiedProfile ? profileDir : undefined,
    );
    writeAccountCliCredentials(configDir, chosen.credential, platform);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[account] could not adopt host Cursor login: ${msg}`);
    return none;
  }

  remember(config, configDir);
  const who = identity.email || identity.authId || name;
  console.log(
    `[account] using existing Cursor login as account '${name}' (${who})`,
  );
  return { adopted: true, created: true, configDir: path.resolve(configDir), name };
}

function adoptEnabled(env: EnvSource): boolean {
  const raw = env.CURSOR_BRIDGE_ADOPT_HOST_LOGIN?.trim().toLowerCase();
  if (!raw) return true;
  return raw !== "0" && raw !== "false" && raw !== "no" && raw !== "off";
}

function dirsPinned(env: EnvSource): boolean {
  return Boolean(
    env.CURSOR_CONFIG_DIRS?.trim() || env.CURSOR_ACCOUNT_DIRS?.trim(),
  );
}

function tokenStillValid(token: string, nowMs = Date.now()): boolean {
  const trimmed = token.trim();
  if (!trimmed) return false;
  const exp = decodeJwtPayload(trimmed).exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return true;
  return exp * 1000 > nowMs;
}

function jwtEmail(token: string): string | undefined {
  const payload = decodeJwtPayload(token);
  for (const key of ["email", "preferred_username"]) {
    const value = payload[key];
    if (typeof value === "string" && value.includes("@")) return value.trim();
  }
  return undefined;
}

function readAuthFile(file: string): Credential | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as {
      accessToken?: unknown;
      refreshToken?: unknown;
    };
    if (typeof raw.accessToken !== "string" || !raw.accessToken.trim()) {
      return undefined;
    }
    const accessToken = raw.accessToken.trim();
    const refreshToken =
      typeof raw.refreshToken === "string" && raw.refreshToken.trim()
        ? raw.refreshToken.trim()
        : undefined;
    return { accessToken, refreshToken };
  } catch {
    return undefined;
  }
}

function authJsonPaths(
  env: EnvSource,
  platform: NodeJS.Platform,
  home: string,
): string[] {
  const paths: string[] = [];
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg) paths.push(path.join(xdg, "cursor", "auth.json"));
  paths.push(path.join(home, ".config", "cursor", "auth.json"));
  if (platform === "win32") {
    const appData =
      env.APPDATA?.trim() || path.join(home, "AppData", "Roaming");
    paths.push(path.join(appData, "Cursor", "auth.json"));
  } else {
    paths.push(path.join(home, ".cursor", "auth.json"));
  }
  return paths;
}

function tokenMatchesAuthId(token: string, authId: string | undefined): boolean {
  if (!authId?.trim()) return true;
  const sub = tokenSub(token);
  return Boolean(sub && sub === authId);
}

function chooseCredential(
  env: EnvSource,
  platform: NodeJS.Platform,
  home: string,
  profile: Identity & { authenticated: boolean },
): { credential: Credential; identity: Identity; copiedProfile: boolean } | undefined {
  const cliCreds: Credential[] = [];
  if (
    platform === "darwin" &&
    process.platform === "darwin" &&
    path.resolve(home) === path.resolve(os.homedir())
  ) {
    const keychain = readMacKeychainAccessToken();
    if (keychain && tokenStillValid(keychain)) {
      cliCreds.push({ accessToken: keychain });
    }
  }
  for (const file of authJsonPaths(env, platform, home)) {
    const cred = readAuthFile(file);
    if (cred && tokenStillValid(cred.accessToken)) cliCreds.push(cred);
  }

  const matched = profile.authenticated
    ? cliCreds.find((c) => tokenMatchesAuthId(c.accessToken, profile.authId))
    : undefined;
  if (matched && (profile.email || profile.authId)) {
    return {
      credential: matched,
      identity: {
        email: profile.email || jwtEmail(matched.accessToken),
        displayName: profile.displayName,
        authId: profile.authId || tokenSub(matched.accessToken),
      },
      copiedProfile: true,
    };
  }

  const loose = cliCreds.find((c) => {
    const sub = tokenSub(c.accessToken);
    if (profile.authId && sub && sub !== profile.authId) return true;
    return !profile.authenticated && Boolean(sub || c.accessToken);
  });
  if (loose) {
    const sub = tokenSub(loose.accessToken);
    const email = jwtEmail(loose.accessToken);
    if (email || sub) {
      return {
        credential: loose,
        identity: { email, authId: sub },
        copiedProfile: false,
      };
    }
  }

  const envToken =
    env.CURSOR_API_KEY?.trim() || env.CURSOR_AUTH_TOKEN?.trim() || "";
  if (!envToken || !tokenStillValid(envToken)) return undefined;
  const sub = tokenSub(envToken);
  const email = jwtEmail(envToken) || (sub ? undefined : "api-key");
  if (!email && !sub) return undefined;
  return {
    credential: { accessToken: envToken },
    identity: { email, authId: sub },
    copiedProfile: false,
  };
}

function sameIdentity(a: Identity, b: Identity): boolean {
  if (a.authId && b.authId && a.authId === b.authId) return true;
  if (
    a.email &&
    b.email &&
    a.email.toLowerCase() === b.email.toLowerCase()
  ) {
    return true;
  }
  return false;
}

function listManagedDirs(home: string): string[] {
  const accountsDir = path.join(home, ".cursor-api-proxy", "accounts");
  if (!fs.existsSync(accountsDir)) return [];
  try {
    return fs
      .readdirSync(accountsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(accountsDir, e.name));
  } catch {
    return [];
  }
}

function findExistingAccount(
  home: string,
  configDirs: string[],
  profileDir: string,
  identity: Identity,
): string | undefined {
  const profileResolved = path.resolve(profileDir);
  const seen = new Set<string>();
  for (const dir of [...listManagedDirs(home), ...configDirs]) {
    const resolved = path.resolve(dir);
    if (resolved === profileResolved || seen.has(resolved)) continue;
    seen.add(resolved);
    const auth = readCursorCliAuth(dir);
    if (sameIdentity(identity, auth)) return dir;
  }
  return undefined;
}

function uniqueAccountName(home: string, identity: Identity): string {
  const local = identity.email?.split("@")[0];
  const base = sanitizeAccountName(local || identity.authId || "default") || "default";
  const root = path.join(home, ".cursor-api-proxy", "accounts");
  let name = base;
  for (let n = 2; n < 100; n++) {
    const dir = path.join(root, name);
    if (!fs.existsSync(dir)) return name;
    const auth = readCursorCliAuth(dir);
    if (!auth.authenticated || sameIdentity(identity, auth)) return name;
    name = `${base}-${n}`;
  }
  return `${base}-${Date.now().toString().slice(-6)}`;
}

function remember(config: { configDirs: string[] }, dir: string): void {
  const resolved = path.resolve(dir);
  if (config.configDirs.some((d) => path.resolve(d) === resolved)) return;
  config.configDirs.push(resolved);
}

function writeCliConfig(
  dir: string,
  identity: Identity,
  copyFrom: string | undefined,
): void {
  let base: Record<string, unknown> = { version: 1 };
  if (copyFrom) {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(copyFrom, "cli-config.json"), "utf-8"),
      ) as Record<string, unknown>;
      if (parsed && typeof parsed === "object") base = parsed;
    } catch {
      base = { version: 1 };
    }
  }
  const authInfo: Record<string, string> = {};
  if (identity.email) authInfo.email = identity.email;
  if (identity.displayName) authInfo.displayName = identity.displayName;
  if (identity.authId) authInfo.authId = identity.authId;
  base.authInfo = authInfo;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "cli-config.json"),
    JSON.stringify(base, null, 2),
  );
}
