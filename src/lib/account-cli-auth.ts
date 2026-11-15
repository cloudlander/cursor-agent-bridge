import * as path from "node:path";

import { readCursorCliAuth } from "./cursor-account-snapshot.js";
import {
  accountCliAuthRoot,
  ensureAccountCliAuth,
} from "./token-cache.js";

/**
 * Point a Cursor CLI child at this account's own `auth.json`.
 *
 * `CURSOR_CONFIG_DIR` only selects cli-config (model, authInfo). On Linux the
 * CLI still authenticates from `$XDG_CONFIG_HOME/cursor/auth.json`, otherwise
 * `~/.config/cursor/auth.json` — one shared login for every account. Leaving
 * that in place bills whichever account last wrote the shared file.
 *
 * A global `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN` is removed for the child:
 * the CLI prefers those over the account file and would bill the key's user.
 */
export function applyAccountCliAuthEnv(
  env: Record<string, string | undefined>,
  configDir: string,
): void {
  const auth = readCursorCliAuth(configDir);
  const ok = ensureAccountCliAuth(configDir, auth.authId);
  delete env.CURSOR_API_KEY;
  delete env.CURSOR_AUTH_TOKEN;
  const root = accountCliAuthRoot(configDir);
  if (process.platform === "win32") {
    env.APPDATA = root;
  } else if (process.platform === "darwin") {
    env.HOME = root;
    env.USERPROFILE = root;
  } else {
    env.XDG_CONFIG_HOME = root;
  }
  if (!ok && auth.authenticated) {
    const who = auth.email || auth.authId || path.basename(configDir);
    console.warn(
      `[account-auth] ${who} has no Cursor credentials for this account; not using the shared login`,
    );
  }
}
