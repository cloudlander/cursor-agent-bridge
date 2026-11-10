import * as fs from "node:fs";
import * as path from "node:path";

import type { BridgeConfig } from "./config.js";
import { readCursorCliAuth } from "./cursor-account-snapshot.js";
import { initAccountPool } from "./account-pool.js";

function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "";
}

export function resolveAccountsDir(): string {
  return path.join(homeDir(), ".cursor-api-proxy", "accounts");
}

/** True when account dirs are fixed by `CURSOR_CONFIG_DIRS` / `CURSOR_ACCOUNT_DIRS`. */
export function isConfigDirsEnvPinned(): boolean {
  const raw =
    process.env.CURSOR_CONFIG_DIRS?.trim() ||
    process.env.CURSOR_ACCOUNT_DIRS?.trim();
  return Boolean(raw);
}

function isAuthenticatedAccountDir(dir: string): boolean {
  const configFile = path.join(dir, "cli-config.json");
  if (!fs.existsSync(configFile)) return false;
  try {
    const config = JSON.parse(fs.readFileSync(configFile, "utf-8")) as {
      authInfo?: { email?: string };
    };
    return Boolean(config?.authInfo?.email);
  } catch {
    return false;
  }
}

/** Authenticated account folders under `~/.cursor-api-proxy/accounts/`. */
export function discoverAuthenticatedAccountDirs(): string[] {
  const home = homeDir();
  if (!home) return [];
  const accountsDir = path.join(home, ".cursor-api-proxy", "accounts");
  if (!fs.existsSync(accountsDir)) return [];

  try {
    const entries = fs.readdirSync(accountsDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => path.join(accountsDir, e.name))
      .filter(isAuthenticatedAccountDir)
      .map((d) => path.resolve(d));
  } catch {
    return [];
  }
}

export function refreshAccountPoolFromConfig(config: BridgeConfig): void {
  if (!isConfigDirsEnvPinned()) {
    const seen = new Set(config.configDirs.map((d) => path.resolve(d)));
    for (const d of discoverAuthenticatedAccountDirs()) {
      if (!seen.has(d)) {
        config.configDirs.push(d);
        seen.add(d);
      }
    }
  }
  initAccountPool(config.configDirs);
}

export function sanitizeAccountName(raw: string): string | undefined {
  const name = raw
    .trim()
    .replace(/[^\w.-]+/g, "-")
    .slice(0, 64);
  return name.length > 0 ? name : undefined;
}

/** Reject reserved / existing account folder names before OAuth. */
export function accountNameAvailabilityError(
  accountName: string | undefined,
): string | undefined {
  const name =
    sanitizeAccountName(accountName ?? "") ??
    (accountName?.trim() ? undefined : undefined);
  if (accountName?.trim() && !name) {
    return "Invalid account name";
  }
  if (!name) return undefined;

  const configDir = path.join(resolveAccountsDir(), name);
  if (!fs.existsSync(configDir)) return undefined;

  const auth = readCursorCliAuth(configDir);
  if (auth.authenticated) {
    return `Account "${name}" is already signed in`;
  }
  return `Account folder "${name}" already exists — remove it or pick another name`;
}

function allKnownConfigDirs(config: BridgeConfig): string[] {
  const seen = new Set<string>();
  const add = (dir: string) => {
    const norm = path.resolve(dir);
    if (!seen.has(norm)) seen.add(norm);
  };
  for (const d of config.configDirs) add(d);
  for (const d of discoverAuthenticatedAccountDirs()) add(d);
  const home = homeDir();
  if (home) {
    const cursor = path.join(home, ".cursor");
    if (fs.existsSync(path.join(cursor, "cli-config.json"))) {
      add(cursor);
    }
  }
  return [...seen];
}

export function findDuplicateAuthError(
  config: BridgeConfig,
  newDir: string,
  auth: { email?: string; authId?: string },
): string | undefined {
  if (!auth.authId && !auth.email) return undefined;
  const newResolved = path.resolve(newDir);
  for (const d of allKnownConfigDirs(config)) {
    const resolved = path.resolve(d);
    if (resolved === newResolved) continue;
    const other = readCursorCliAuth(d);
    if (auth.authId && other.authId && auth.authId === other.authId) {
      return `This Cursor account is already added (${other.email ?? path.basename(d)})`;
    }
    if (
      auth.email &&
      other.email &&
      auth.email.toLowerCase() === other.email.toLowerCase()
    ) {
      return `This Cursor account is already added (${other.email})`;
    }
  }
  return undefined;
}

export function registerAccountInBridge(
  config: BridgeConfig,
  configDir: string,
): { ok: true } | { ok: false; error: string } {
  const auth = readCursorCliAuth(configDir);
  const dup = findDuplicateAuthError(config, configDir, auth);
  if (dup) {
    if (isManagedAccountDir(configDir)) {
      try {
        fs.rmSync(configDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    return { ok: false, error: dup };
  }

  const resolved = path.resolve(configDir);
  const seen = new Set(config.configDirs.map((d) => path.resolve(d)));
  if (!seen.has(resolved)) {
    config.configDirs.push(resolved);
  }
  refreshAccountPoolFromConfig(config);
  return { ok: true };
}

/** Only dirs created via bridge login under `~/.cursor-api-proxy/accounts/`. */
export function isManagedAccountDir(configDir: string): boolean {
  const resolved = path.resolve(configDir);
  const accountsRoot = path.resolve(resolveAccountsDir());
  if (!resolved.startsWith(accountsRoot + path.sep)) return false;
  const rel = path.relative(accountsRoot, resolved);
  return rel.length > 0 && !rel.includes(path.sep);
}

export function removeManagedAccount(
  config: BridgeConfig,
  configDir: string,
): { ok: true } | { ok: false; error: string } {
  const resolved = path.resolve(configDir.trim());
  if (!isManagedAccountDir(resolved)) {
    return {
      ok: false,
      error: "Only accounts under ~/.cursor-api-proxy/accounts can be removed from the dashboard",
    };
  }
  if (!fs.existsSync(resolved)) {
    return { ok: false, error: "Account directory not found" };
  }
  if (config.configDirs.length <= 1) {
    return {
      ok: false,
      error: "Cannot remove the only configured Cursor account",
    };
  }

  try {
    fs.rmSync(resolved, { recursive: true, force: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }

  const idx = config.configDirs.findIndex((d) => path.resolve(d) === resolved);
  if (idx >= 0) {
    config.configDirs.splice(idx, 1);
  }
  refreshAccountPoolFromConfig(config);
  return { ok: true };
}
