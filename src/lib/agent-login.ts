import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import type { BridgeConfig } from "./config.js";
import {
  accountNameAvailabilityError,
  registerAccountInBridge,
  resolveAccountsDir,
  sanitizeAccountName,
} from "./account-registry.js";
import { readCursorCliAuth } from "./cursor-account-snapshot.js";
import { resolveAgentCommand } from "./env.js";
import {
  readCachedToken,
  readKeychainToken,
  syncAccessTokenCacheForAuth,
} from "./token-cache.js";

/** Cursor CLI login URL (may span multiple stdout chunks). */
export const AGENT_LOGIN_URL_RE =
  /(https:\/\/cursor\.com\/loginDeepControl.*?redirectTarget=cli)/s;

export function extractAgentLoginUrl(text: string): string | undefined {
  if (!text.includes("https://cursor.com/loginDeepControl")) return undefined;
  const match = text.match(AGENT_LOGIN_URL_RE);
  return match?.[1]?.replace(/\s+/g, "");
}

export type AgentAuthAccount = {
  name: string;
  configDir: string;
  authenticated: boolean;
  email?: string;
  displayName?: string;
};

export type AgentAuthStatus = {
  /** True when the proxy can run the Cursor agent (API key or signed-in CLI config). */
  authenticated: boolean;
  viaApiKey: boolean;
  accounts: AgentAuthAccount[];
};

function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "";
}

/** Config dirs to inspect for CLI auth (includes account pool and default ~/.cursor). */
export function candidateAuthConfigDirs(config: BridgeConfig): string[] {
  const seen = new Set<string>();
  const add = (dir: string | undefined) => {
    if (!dir) return;
    const norm = path.normalize(dir);
    if (!seen.has(norm)) seen.add(norm);
  };

  for (const d of config.configDirs) add(d);

  const home = homeDir();
  if (home) {
    const accountsRoot = path.join(home, ".cursor-api-proxy", "accounts");
    if (fs.existsSync(accountsRoot)) {
      try {
        for (const e of fs.readdirSync(accountsRoot, { withFileTypes: true })) {
          if (e.isDirectory()) add(path.join(accountsRoot, e.name));
        }
      } catch {
        /* ignore */
      }
    }
    const defaultCursor = path.join(home, ".cursor");
    if (fs.existsSync(path.join(defaultCursor, "cli-config.json"))) {
      add(defaultCursor);
    }
  }

  return [...seen];
}

export function resolveAgentAuthStatus(config: BridgeConfig): AgentAuthStatus {
  const viaApiKey = Boolean(
    process.env.CURSOR_API_KEY?.trim() || process.env.CURSOR_AUTH_TOKEN?.trim(),
  );
  if (viaApiKey) {
    return { authenticated: true, viaApiKey: true, accounts: [] };
  }

  const accounts: AgentAuthAccount[] = candidateAuthConfigDirs(config).map(
    (configDir) => {
      const auth = readCursorCliAuth(configDir);
      return {
        name: path.basename(configDir),
        configDir,
        authenticated: auth.authenticated,
        email: auth.email,
        displayName: auth.displayName,
      };
    },
  );

  // CLI login lives in macOS keychain or $HOME/.config/cursor/auth.json (see
  // run-config-dir.ts), not in cli-config.json alone. authInfo without a token
  // must not unlock the dashboard — matches app.sh ensure_cursor_cli_auth.
  const sharedToken = readKeychainToken();
  const hasCachedAccountToken = accounts.some((a) =>
    Boolean(readCachedToken(a.configDir)),
  );
  const hasProfile = accounts.some((a) => a.authenticated);

  return {
    authenticated:
      Boolean(sharedToken) ||
      (hasProfile && hasCachedAccountToken),
    viaApiKey: false,
    accounts,
  };
}

export type AgentLoginSessionStatus =
  | "starting"
  | "awaiting_user"
  | "success"
  | "failed"
  | "cancelled";

export type AgentLoginSessionPublic = {
  sessionId: string;
  status: AgentLoginSessionStatus;
  loginUrl?: string;
  configDir: string;
  accountName: string;
  email?: string;
  error?: string;
  startedAt: string;
};

type AgentLoginSession = AgentLoginSessionPublic & {
  dirWasNew: boolean;
  child: ChildProcess;
  stdoutBuffer: string;
};

let activeSession: AgentLoginSession | null = null;

const FINISHED_LOGIN_TTL_MS = 30 * 60 * 1000;
const finishedLoginSessions = new Map<
  string,
  { session: AgentLoginSessionPublic; at: number }
>();

function rememberFinishedSession(session: AgentLoginSession): void {
  finishedLoginSessions.set(session.sessionId, {
    session: toPublic(session),
    at: Date.now(),
  });
  const cutoff = Date.now() - FINISHED_LOGIN_TTL_MS;
  for (const [id, entry] of finishedLoginSessions) {
    if (entry.at < cutoff) finishedLoginSessions.delete(id);
  }
}

function releaseActiveSession(
  session: AgentLoginSession,
  remember: boolean,
): void {
  if (activeSession?.sessionId !== session.sessionId) return;
  if (remember) rememberFinishedSession(session);
  activeSession = null;
}

/** After a terminal status poll, drop the in-memory active handle (history kept for TTL). */
export function consumeAgentLoginSession(sessionId: string): void {
  if (activeSession?.sessionId === sessionId) {
    rememberFinishedSession(activeSession);
    activeSession = null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCliAuth(
  configDir: string,
  maxMs = 15_000,
): Promise<ReturnType<typeof readCursorCliAuth>> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const auth = readCursorCliAuth(configDir);
    if (auth.authenticated && (auth.email || auth.authId)) return auth;
    await delay(250);
  }
  return readCursorCliAuth(configDir);
}

async function finalizeAgentLoginSuccess(
  config: BridgeConfig,
  session: AgentLoginSession,
): Promise<void> {
  if (activeSession?.sessionId !== session.sessionId) return;

  const auth = await waitForCliAuth(session.configDir);
  if (!auth.authenticated) {
    finishSession(
      config,
      session,
      "failed",
      "Login finished but the account profile was not saved under this account folder",
    );
    return;
  }

  session.email = auth.email;
  syncAccessTokenCacheForAuth(session.configDir, auth.authId);
  const registered = registerAccountInBridge(config, session.configDir);
  if (!registered.ok) {
    session.status = "failed";
    session.error = registered.error;
    cleanupFailedSessionDir(session);
    releaseActiveSession(session, true);
    return;
  }
  session.status = "success";
  session.error = undefined;
}

function defaultUrlWaitMs(): number {
  const raw = process.env.CURSOR_BRIDGE_AGENT_LOGIN_URL_WAIT_MS?.trim();
  if (!raw) return 45_000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 45_000;
}

function cleanupFailedSessionDir(session: AgentLoginSession): void {
  if (!session.dirWasNew) return;
  try {
    fs.rmSync(session.configDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

function toPublic(session: AgentLoginSession): AgentLoginSessionPublic {
  return {
    sessionId: session.sessionId,
    status: session.status,
    loginUrl: session.loginUrl,
    configDir: session.configDir,
    accountName: session.accountName,
    email: session.email,
    error: session.error,
    startedAt: session.startedAt,
  };
}

export function getAgentLoginSession(
  sessionId?: string,
): AgentLoginSessionPublic | null {
  if (activeSession) {
    if (!sessionId || activeSession.sessionId === sessionId) {
      return toPublic(activeSession);
    }
  }
  if (sessionId) {
    const entry = finishedLoginSessions.get(sessionId);
    if (entry) return entry.session;
  }
  return null;
}

export function cancelAgentLoginSession(sessionId?: string): boolean {
  if (!activeSession) return false;
  if (sessionId && activeSession.sessionId !== sessionId) return false;
  const session = activeSession;
  session.status = "cancelled";
  try {
    session.child.kill();
  } catch {
    /* ignore */
  }
  cleanupFailedSessionDir(session);
  releaseActiveSession(session, true);
  return true;
}

function finishSession(
  config: BridgeConfig,
  session: AgentLoginSession,
  status: Exclude<AgentLoginSessionStatus, "success" | "awaiting_user" | "starting">,
  error?: string,
): void {
  if (activeSession?.sessionId !== session.sessionId) return;
  session.status = status;
  session.error = error;
  if (status === "failed" || status === "cancelled") {
    cleanupFailedSessionDir(session);
    releaseActiveSession(session, true);
  }
}

export type StartAgentLoginResult =
  | { ok: true; session: AgentLoginSessionPublic }
  | { ok: false; error: string; session?: AgentLoginSessionPublic };

/**
 * Spawn `agent login` for web OAuth. Returns when the login URL is available or the attempt fails.
 */
export function startAgentLoginSession(
  config: BridgeConfig,
  accountName?: string,
): Promise<StartAgentLoginResult> {
  const existing = getAgentLoginSession();
  if (
    existing &&
    (existing.status === "starting" || existing.status === "awaiting_user")
  ) {
    return Promise.resolve({ ok: true, session: existing });
  }

  const nameError = accountNameAvailabilityError(accountName);
  if (nameError) {
    return Promise.resolve({ ok: false, error: nameError });
  }

  const name =
    sanitizeAccountName(accountName ?? "") ??
    `account-${Date.now().toString().slice(-4)}`;
  const accountsDir = resolveAccountsDir();
  const configDir = path.join(accountsDir, name);
  const dirWasNew = !fs.existsSync(configDir);

  fs.mkdirSync(accountsDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });

  const sessionId = randomUUID();
  const startedAt = new Date().toISOString();

  return new Promise((resolve) => {
    let settled = false;
    const waitMs = defaultUrlWaitMs();

    const session: AgentLoginSession = {
      sessionId,
      status: "starting",
      configDir,
      accountName: name,
      startedAt,
      dirWasNew,
      child: null as unknown as ChildProcess,
      stdoutBuffer: "",
    };
    activeSession = session;

    const urlTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        session.child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      finishSession(
        config,
        session,
        "failed",
        "Timed out waiting for Cursor login URL",
      );
      resolve({
        ok: false,
        error: "Timed out waiting for Cursor login URL",
        session: toPublic(session),
      });
    }, waitMs);

    const resolved = resolveAgentCommand(config.agentBin, ["login"]);
    const child = spawn(resolved.command, resolved.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...resolved.env,
        CURSOR_CONFIG_DIR: configDir,
        NO_OPEN_BROWSER: "1",
      },
      windowsVerbatimArguments: resolved.windowsVerbatimArguments,
    });
    session.child = child;
    child.stdin?.on("error", () => {
      /* keep stream open until login completes */
    });

    const onUrl = (loginUrl: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(urlTimer);
      session.loginUrl = loginUrl;
      session.status = "awaiting_user";
      console.log(`[cursor-api-proxy] Cursor agent login URL: ${loginUrl}`);
      resolve({ ok: true, session: toPublic(session) });
    };

    const onData = (chunk: Buffer | string) => {
      session.stdoutBuffer += chunk.toString();
      const url = extractAgentLoginUrl(session.stdoutBuffer);
      if (url) onUrl(url);
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    child.on("error", (err) => {
      clearTimeout(urlTimer);
      if (!settled) {
        settled = true;
        finishSession(config, session, "failed", err.message);
        resolve({ ok: false, error: err.message, session: toPublic(session) });
        return;
      }
      finishSession(config, session, "failed", err.message);
    });

    child.on("exit", (code) => {
      clearTimeout(urlTimer);
      void (async () => {
        if (code === 0) {
          await finalizeAgentLoginSuccess(config, session);
          if (!settled) {
            settled = true;
            const pub = toPublic(session);
            if (session.status === "success") {
              resolve({ ok: true, session: pub });
            } else {
              resolve({
                ok: false,
                error: session.error ?? "Login failed",
                session: pub,
              });
            }
          }
          return;
        }
        const msg = `Cursor agent login failed (exit ${code ?? "unknown"})`;
        finishSession(config, session, "failed", msg);
        if (!settled) {
          settled = true;
          resolve({ ok: false, error: msg, session: toPublic(session) });
        }
      })();
    });
  });
}

/** @internal Vitest-only */
export function resetAgentLoginSessionsForTests(): void {
  activeSession = null;
  finishedLoginSessions.clear();
}

/** @internal Vitest-only */
export function stashAgentLoginSessionForTests(
  session: AgentLoginSessionPublic,
): void {
  finishedLoginSessions.set(session.sessionId, {
    session,
    at: Date.now(),
  });
}
