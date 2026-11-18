import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";

import type { BridgeConfig } from "../config.js";
import { runMcpEnable, isMcpNotApprovedMessage } from "./mcp-enable.js";
import {
  mcpOAuthLoopbackPort,
  trackMcpOAuthCallbackTarget,
} from "./mcp-oauth-callback.js";
import {
  applyMcpLoginExit,
  cancelPendingMcpLogin,
  mcpOAuthTimeoutMs,
  openMcpLoginSession,
  watchMcpLoginProcess,
} from "./mcp-login-session.js";

export type McpLoginResult = {
  ok: boolean;
  hint?: string;
  loginUrl?: string;
  /** Where the IdP redirects after sign-in (loopback on your machine, or app /callback if enabled). */
  callbackUrl?: string;
  /** True when redirect_uri was rewritten to this app’s public /callback URL. */
  callbackViaWeb?: boolean;
  /**
   * True when the IdP still redirects to loopback. The Plugins page can finish
   * login by opening this app’s /callback with the same code and state.
   */
  callbackHostRewrite?: boolean;
  /** This app’s /callback when the browser is already on a public origin. */
  publicCallbackUrl?: string;
  /** SSH -L hint when opening the loopback callback directly. */
  tunnelHint?: string;
  mcpKey?: string;
  manualCommand?: string;
  output?: string;
  /** In-flight login to poll until the CLI exits, fails, or times out. */
  loginId?: string;
  /** How long the login window waits after the authorize URL is shown. */
  timeoutMs?: number;
};

export type McpLoginOptions = {
  /** Public app origin, e.g. https://my-app.example.com */
  publicOrigin?: string;
};

/** Pull the authorization URL from CLI stdout/stderr. */
export function extractMcpLoginUrl(text: string): string | undefined {
  const markers = ["Open this URL", "open this URL", "browser:"];
  let slice = text;
  for (const m of markers) {
    const idx = text.indexOf(m);
    if (idx >= 0) {
      slice = text.slice(idx);
      break;
    }
  }
  const lines = slice.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/https:\/\/[^\s]+/);
    if (match) return match[0];
  }
  const fallback = slice.match(/https:\/\/[^\s]+/);
  return fallback?.[0];
}

export function webOAuthCallbackEnabled(): boolean {
  const raw = process.env.CURSOR_BRIDGE_MCP_OAUTH_WEB_CALLBACK?.trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
  return false;
}

/** MCP OAuth clients (e.g. Atlassian) only allow pre-registered loopback redirect URIs. */
export function isLoopbackOnlyMcpOAuthLogin(loginUrl: string): boolean {
  try {
    const auth = new URL(loginUrl);
    const host = auth.hostname.toLowerCase();
    if (host.includes("atlassian")) return true;
    const redirect = auth.searchParams.get("redirect_uri");
    if (redirect) {
      const rh = new URL(redirect).hostname.toLowerCase();
      if (rh === "127.0.0.1" || rh === "localhost") return true;
    }
  } catch {
    return true;
  }
  return false;
}

export function loopbackTunnelHint(port: number): string {
  return `To open the localhost address directly, forward port ${port}: ssh -L ${port}:127.0.0.1:${port} you@host`;
}

/** Loopback redirect_uri from an MCP authorize URL, without its query string. */
export function loopbackRedirectTarget(
  loginUrl: string,
): { callbackUrl: string; port: number } | undefined {
  try {
    const redirect = new URL(loginUrl).searchParams.get("redirect_uri");
    if (!redirect) return undefined;
    const u = new URL(redirect);
    const host = u.hostname.toLowerCase();
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") return undefined;
    const port = Number(u.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
    const path = u.pathname.replace(/\/+$/, "") || "/callback";
    return { callbackUrl: `${u.protocol}//${u.host}${path}`, port };
  } catch {
    return undefined;
  }
}

export function rewriteOAuthRedirectUri(
  loginUrl: string,
  callbackUrl: string,
): string {
  const u = new URL(loginUrl);
  u.searchParams.set("redirect_uri", callbackUrl);
  return u.toString();
}

export function applyPublicOAuthCallback(
  loginUrl: string | undefined,
  publicOrigin: string | undefined,
): Pick<
  McpLoginResult,
  | "loginUrl"
  | "callbackUrl"
  | "callbackViaWeb"
  | "callbackHostRewrite"
  | "publicCallbackUrl"
  | "tunnelHint"
> {
  if (!loginUrl) return {};
  const loop = loopbackRedirectTarget(loginUrl);
  const port = loop?.port ?? mcpOAuthLoopbackPort();
  const loopbackCallback = loop?.callbackUrl ?? `http://127.0.0.1:${port}/callback`;
  const useWeb =
    !!publicOrigin &&
    webOAuthCallbackEnabled() &&
    !isLoopbackOnlyMcpOAuthLogin(loginUrl);
  if (!useWeb) {
    return {
      loginUrl,
      callbackUrl: loopbackCallback,
      callbackViaWeb: false,
      callbackHostRewrite: true,
      publicCallbackUrl: publicCallbackUrl(publicOrigin),
      tunnelHint: loopbackTunnelHint(port),
    };
  }
  const callbackUrl = `${publicOrigin.replace(/\/$/, "")}/callback`;
  return {
    loginUrl: rewriteOAuthRedirectUri(loginUrl, callbackUrl),
    callbackUrl,
    callbackViaWeb: true,
    callbackHostRewrite: false,
  };
}

function publicCallbackUrl(publicOrigin: string | undefined): string | undefined {
  if (!publicOrigin) return undefined;
  return `${publicOrigin.replace(/\/$/, "")}/callback`;
}

function defaultUrlWaitMs(): number {
  const raw = process.env.CURSOR_BRIDGE_MCP_LOGIN_URL_WAIT_MS?.trim();
  if (!raw) return 45_000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 45_000;
}

function buildResult(
  partial: Pick<McpLoginResult, "ok" | "hint">,
  out: string,
  mcpKey: string,
  manualCommand: string,
  publicOrigin?: string,
  login?: { id: string; timeoutMs: number },
): McpLoginResult {
  const rawUrl = extractMcpLoginUrl(out);
  const {
    loginUrl,
    callbackUrl,
    callbackViaWeb,
    callbackHostRewrite,
    publicCallbackUrl,
    tunnelHint,
  } = applyPublicOAuthCallback(rawUrl, publicOrigin);
  trackMcpOAuthCallbackTarget(callbackUrl);
  if (loginUrl) {
    console.log(`[cursor-api-proxy] MCP OAuth URL (${mcpKey}): ${loginUrl}`);
  } else if (out.trim()) {
    console.log(
      `[cursor-api-proxy] MCP OAuth login output (${mcpKey}):\n${out.trim().slice(0, 4000)}`,
    );
  }
  return {
    ...partial,
    loginUrl,
    callbackUrl,
    callbackViaWeb,
    callbackHostRewrite,
    publicCallbackUrl,
    tunnelHint,
    mcpKey,
    manualCommand,
    output: out.slice(0, 4000),
    loginId: login?.id,
    timeoutMs: login ? login.timeoutMs : undefined,
  };
}

export async function runMcpLoginSpawn(
  config: BridgeConfig,
  mcpKey: string,
  configDir?: string,
  options?: McpLoginOptions,
): Promise<McpLoginResult> {
  const dir =
    configDir ??
    (config.configDirs[0] || path.join(process.env.HOME ?? "", ".cursor"));
  const manualEnable = `${config.agentBin} --workspace ${config.workspace} mcp enable ${mcpKey}`;
  const manualCommand = `${manualEnable} && ${config.agentBin} --workspace ${config.workspace} mcp login ${mcpKey}`;
  const waitMs = defaultUrlWaitMs();
  const timeoutMs = mcpOAuthTimeoutMs();
  const publicOrigin = options?.publicOrigin;

  const enable = await runMcpEnable(config, mcpKey, dir);
  if (!enable.ok) {
    return buildResult(
      {
        ok: false,
        hint: `Could not approve MCP server "${mcpKey}" for login. Run: ${manualEnable}`,
      },
      enable.output,
      mcpKey,
      manualCommand,
      publicOrigin,
    );
  }

  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    let loginSessionId: string | undefined;
    let child: ChildProcess;

    const armLoginSession = () => {
      if (loginSessionId || !extractMcpLoginUrl(out)) return;
      const opened = openMcpLoginSession(mcpKey, timeoutMs);
      loginSessionId = opened.id;
      watchMcpLoginProcess(loginSessionId, child);
    };

    const finish = (partial: Pick<McpLoginResult, "ok" | "hint">) => {
      if (settled) return;
      settled = true;
      armLoginSession();
      try {
        child.unref();
      } catch {
        /* already exited */
      }
      resolve(
        buildResult(
          partial,
          out,
          mcpKey,
          manualCommand,
          publicOrigin,
          loginSessionId ? { id: loginSessionId, timeoutMs } : undefined,
        ),
      );
    };

    cancelPendingMcpLogin(mcpKey);
    child = spawn(
      config.agentBin,
      ["--workspace", config.workspace, "mcp", "login", mcpKey],
      {
        env: { ...process.env, CURSOR_CONFIG_DIR: dir },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const onData = (chunk: Buffer | string) => {
      out += chunk.toString();
      if (extractMcpLoginUrl(out)) {
        finish({
          ok: true,
          hint: oauthHint(publicOrigin, extractMcpLoginUrl(out)),
        });
      }
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    child.on("error", (err) => {
      finish({
        ok: false,
        hint: `Failed to start MCP login: ${err.message}. Try in a terminal: ${manualCommand}`,
      });
    });

    child.on("exit", (code) => {
      armLoginSession();
      if (loginSessionId) applyMcpLoginExit(loginSessionId, code, out);
      if (settled) return;
      if (code === 0 && extractMcpLoginUrl(out)) {
        finish({ ok: true, hint: "OAuth login completed." });
        return;
      }
      const notApproved = isMcpNotApprovedMessage(out);
      finish({
        ok: code === 0,
        hint:
          extractMcpLoginUrl(out) != null
            ? oauthHint(publicOrigin, extractMcpLoginUrl(out))
            : notApproved
              ? `MCP server is not approved yet. Run: ${manualEnable}`
              : `MCP login did not print a URL yet. Try again or run in a terminal: ${manualCommand}`,
      });
    });

    setTimeout(() => {
      if (settled) return;
      finish({
        ok: extractMcpLoginUrl(out) != null,
        hint: loginUrlHint(out, manualCommand, publicOrigin),
      });
    }, waitMs);
  });
}

function oauthHint(publicOrigin?: string, loginUrl?: string): string {
  if (
    publicOrigin &&
    webOAuthCallbackEnabled() &&
    loginUrl &&
    !isLoopbackOnlyMcpOAuthLogin(loginUrl)
  ) {
    return "Open the login URL below. After sign-in you will return to this app’s /callback URL.";
  }
  return "Open the login URL below. After sign-in, paste the localhost callback address into Complete callback. This app forwards code and state to the login process.";
}

function loginUrlHint(
  out: string,
  manualCommand: string,
  publicOrigin?: string,
): string {
  const url = extractMcpLoginUrl(out);
  if (url) {
    return oauthHint(publicOrigin, url);
  }
  return `Waiting for OAuth URL timed out. Run in Workbench terminal: ${manualCommand}`;
}
