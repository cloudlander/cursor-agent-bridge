import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import type { BridgeConfig } from "./config.js";
import { decodeJwtPayload } from "./cursor-account-api.js";
import { configDirsForAccountUsage } from "./cursor-account-snapshot.js";
import { resolveAgentCommand } from "./env.js";
import { readCachedToken, readKeychainToken, writeCachedToken } from "./token-cache.js";

/** Match cursor-agent token-refresh-policy (refresh when < 5 minutes left). */
export const DEFAULT_AUTH_REFRESH_SKEW_SEC = 300;

export const DEFAULT_AUTH_KEEPALIVE_INTERVAL_MS = 240_000;

export type AuthKeepaliveMode = "refresh" | "always";

export type AuthKeepaliveOptions = {
  intervalMs: number;
  skewSec: number;
  mode: AuthKeepaliveMode;
  enabled: boolean;
};

let keepaliveTimer: ReturnType<typeof setInterval> | undefined;
let keepaliveRunning = false;

export function isAccessTokenExpiringSoon(
  token: string,
  skewSec = DEFAULT_AUTH_REFRESH_SKEW_SEC,
): boolean {
  try {
    const payload = decodeJwtPayload(token);
    const exp = payload.exp;
    const nowSec = Math.floor(Date.now() / 1000);
    if (typeof exp !== "number" || !Number.isFinite(exp)) return true;
    return exp - nowSec < skewSec;
  } catch {
    return true;
  }
}

function authJsonPath(): string | undefined {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (!home) return undefined;
  const configHome =
    process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  const p = path.join(configHome, "cursor", "auth.json");
  return fs.existsSync(p) ? p : undefined;
}

function readAccessTokenForDir(configDir?: string): string | undefined {
  if (configDir) {
    const cached = readCachedToken(configDir);
    if (cached) return cached;
  }
  const fromKeychain = readKeychainToken();
  if (fromKeychain) return fromKeychain;
  const authPath = authJsonPath();
  if (!authPath) return undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(authPath, "utf-8")) as {
      accessToken?: unknown;
    };
    return typeof raw.accessToken === "string" && raw.accessToken.trim()
      ? raw.accessToken.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

function hasStaticApiKey(config: BridgeConfig): boolean {
  return Boolean(
    config.acpEnv.CURSOR_API_KEY?.trim() ||
      config.acpEnv.CURSOR_AUTH_TOKEN?.trim(),
  );
}

export function shouldRunAuthKeepaliveTick(
  config: BridgeConfig,
  opts: AuthKeepaliveOptions,
  configDir?: string,
): boolean {
  if (!opts.enabled) return false;
  if (opts.mode === "always") {
    return Boolean(readAccessTokenForDir(configDir) || hasStaticApiKey(config));
  }
  const token = readAccessTokenForDir(configDir);
  if (token) return isAccessTokenExpiringSoon(token, opts.skewSec);
  return hasStaticApiKey(config);
}

export async function runAgentAuthRefresh(
  config: BridgeConfig,
  configDir?: string,
): Promise<number | null> {
  const resolved = resolveAgentCommand(config.agentBin, ["status"]);
  const env: Record<string, string | undefined> = {
    ...resolved.env,
    ...config.acpEnv,
  };
  if (configDir) env.CURSOR_CONFIG_DIR = configDir;

  return new Promise((resolve) => {
    const child = spawn(resolved.command, resolved.args, {
      env,
      stdio: "ignore",
      windowsVerbatimArguments: resolved.windowsVerbatimArguments,
    });
    const timeoutMs = 45_000;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve(null);
    }, timeoutMs);
    timer.unref?.();

    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function cacheTokenAfterRefresh(configDir?: string): void {
  if (!configDir) return;
  const token = readKeychainToken();
  if (token) writeCachedToken(configDir, token);
}

export async function runAuthKeepaliveTick(
  config: BridgeConfig,
  opts: AuthKeepaliveOptions,
): Promise<void> {
  if (keepaliveRunning) return;
  keepaliveRunning = true;
  try {
    const dirs = configDirsForAccountUsage(config.configDirs);
    const targets = dirs.length > 0 ? dirs : [undefined];

    for (const configDir of targets) {
      if (!shouldRunAuthKeepaliveTick(config, opts, configDir)) continue;

      const code = await runAgentAuthRefresh(config, configDir);
      if (code === 0) {
        cacheTokenAfterRefresh(configDir);
        if (config.verbose) {
          const label = configDir ?? "(default auth)";
          console.log(
            `[auth-keepalive] refreshed Cursor auth via agent status (${label})`,
          );
        }
      } else if (config.verbose && code !== null) {
        console.warn(
          `[auth-keepalive] agent status exited ${code}${configDir ? ` (${configDir})` : ""}`,
        );
      }
    }
  } finally {
    keepaliveRunning = false;
  }
}

export function stopAuthTokenKeepalive(): void {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = undefined;
  }
}

export function startAuthTokenKeepalive(
  config: BridgeConfig,
  opts: AuthKeepaliveOptions,
): void {
  stopAuthTokenKeepalive();
  if (!opts.enabled) return;

  const intervalMs = Math.max(60_000, opts.intervalMs);
  void runAuthKeepaliveTick(config, opts);
  keepaliveTimer = setInterval(() => {
    void runAuthKeepaliveTick(config, opts);
  }, intervalMs);
  keepaliveTimer.unref?.();

  if (config.verbose) {
    console.log(
      `[auth-keepalive] enabled (every ${Math.round(intervalMs / 1000)}s, mode=${opts.mode}, skew=${opts.skewSec}s)`,
    );
  }
}

export function loadAuthKeepaliveOptions(
  env: Record<string, string | undefined>,
): AuthKeepaliveOptions {
  const enabled = (() => {
    const raw = env.CURSOR_BRIDGE_AUTH_KEEPALIVE?.trim().toLowerCase();
    if (raw === "0" || raw === "false" || raw === "no" || raw === "off") {
      return false;
    }
    return true;
  })();

  const intervalRaw = Number(env.CURSOR_BRIDGE_AUTH_KEEPALIVE_MS);
  const intervalMs = Number.isFinite(intervalRaw) && intervalRaw > 0
    ? intervalRaw
    : DEFAULT_AUTH_KEEPALIVE_INTERVAL_MS;

  const skewRaw = Number(env.CURSOR_BRIDGE_AUTH_KEEPALIVE_SKEW_SEC);
  const skewSec =
    Number.isFinite(skewRaw) && skewRaw > 0
      ? skewRaw
      : DEFAULT_AUTH_REFRESH_SKEW_SEC;

  const modeRaw = env.CURSOR_BRIDGE_AUTH_KEEPALIVE_MODE?.trim().toLowerCase();
  const mode: AuthKeepaliveMode = modeRaw === "always" ? "always" : "refresh";

  return { enabled, intervalMs, skewSec, mode };
}
