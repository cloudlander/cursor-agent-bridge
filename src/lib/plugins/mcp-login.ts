import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";

import type { BridgeConfig } from "../config.js";
import { runMcpEnable, isMcpNotApprovedMessage } from "./mcp-enable.js";
import { mcpOAuthLoopbackPort } from "./mcp-oauth-callback.js";

export type McpLoginResult = {
  ok: boolean;
  hint?: string;
  loginUrl?: string;
  /** Where the IdP redirects after sign-in (loopback on your machine, or app /callback if enabled). */
  callbackUrl?: string;
  /** True when redirect_uri was rewritten to this app’s public /callback URL. */
  callbackViaWeb?: boolean;
  /** SSH -L hint when OAuth must hit loopback on the user’s machine (remote workspaces). */
  tunnelHint?: string;
  mcpKey?: string;
  manualCommand?: string;
  output?: string;
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
  return `This MCP uses a localhost OAuth callback. Before signing in, forward port ${port} from your computer to this workspace (same session as the browser), for example: ssh -L ${port}:127.0.0.1:${port} you@host`;
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
): Pick<McpLoginResult, "loginUrl" | "callbackUrl" | "callbackViaWeb" | "tunnelHint"> {
  if (!loginUrl) return {};
  const port = mcpOAuthLoopbackPort();
  const loopbackCallback = `http://127.0.0.1:${port}/callback`;
  const useWeb =
    !!publicOrigin &&
    webOAuthCallbackEnabled() &&
    !isLoopbackOnlyMcpOAuthLogin(loginUrl);
  if (!useWeb) {
    return {
      loginUrl,
      callbackUrl: loopbackCallback,
      callbackViaWeb: false,
      tunnelHint: loopbackTunnelHint(port),
    };
  }
  const callbackUrl = `${publicOrigin.replace(/\/$/, "")}/callback`;
  return {
    loginUrl: rewriteOAuthRedirectUri(loginUrl, callbackUrl),
    callbackUrl,
    callbackViaWeb: true,
  };
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
): McpLoginResult {
  const rawUrl = extractMcpLoginUrl(out);
  const { loginUrl, callbackUrl, callbackViaWeb, tunnelHint } =
    applyPublicOAuthCallback(rawUrl, publicOrigin);
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
    tunnelHint,
    mcpKey,
    manualCommand,
    output: out.slice(0, 4000),
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
    let child: ChildProcess;

    const finish = (partial: Pick<McpLoginResult, "ok" | "hint">) => {
      if (settled) return;
      settled = true;
      try {
        child.unref();
      } catch {
        /* already exited */
      }
      resolve(buildResult(partial, out, mcpKey, manualCommand, publicOrigin));
    };

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
  const port = mcpOAuthLoopbackPort();
  return `Open the login URL below. After sign-in your browser opens ${loopbackCallbackLabel(port)} — set up SSH port forwarding first if this workspace is remote.`;
}

function loopbackCallbackLabel(port: number): string {
  return `http://127.0.0.1:${port}/callback on your computer`;
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
