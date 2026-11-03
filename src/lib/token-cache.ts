import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

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

/**
 * Read the Cursor CLI's shared access token: the macOS Keychain slot, or
 * `$XDG_CONFIG_HOME/cursor/auth.json` (default `~/.config/cursor`) elsewhere.
 */
export function readKeychainToken(): string | undefined {
  if (process.platform === "darwin") {
    try {
      const t = execSync(
        'security find-generic-password -s "cursor-access-token" -w',
        { stdio: ["pipe", "pipe", "pipe"], timeout: 5000 },
      )
        .toString()
        .trim();
      if (t) return t;
    } catch {
      /* fall through */
    }
  }
  return readAuthFileToken();
}

function readAuthFileToken(): string | undefined {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const configHome =
    process.env.XDG_CONFIG_HOME || (home ? path.join(home, ".config") : "");
  if (!configHome) return undefined;
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(configHome, "cursor", "auth.json"), "utf-8"),
    ) as { accessToken?: unknown };
    return typeof raw.accessToken === "string" && raw.accessToken.trim()
      ? raw.accessToken.trim()
      : undefined;
  } catch {
    return undefined;
  }
}
