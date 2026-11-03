import { describe, expect, it } from "vitest";

import {
  applyPublicOAuthCallback,
  extractMcpLoginUrl,
  isLoopbackOnlyMcpOAuthLogin,
  rewriteOAuthRedirectUri,
  webOAuthCallbackEnabled,
} from "./mcp-login.js";

describe("extractMcpLoginUrl", () => {
  it("finds URL after Open this URL line", () => {
    const text = `MCP requires authentication.
Open this URL in your browser:
https://auth.example.com/authorize?client_id=abc

Listening on http://localhost:8787/callback`;
    expect(extractMcpLoginUrl(text)).toBe(
      "https://auth.example.com/authorize?client_id=abc",
    );
  });

  it("finds URL after browser: line", () => {
    const text = `MCP 'x' requires authentication.
Open this URL in your browser:
https://auth.example.com/o?state=1

Listening on http://localhost:8787/callback`;
    expect(extractMcpLoginUrl(text)).toBe("https://auth.example.com/o?state=1");
  });

  it("falls back to first https URL in output", () => {
    expect(extractMcpLoginUrl("see https://auth.test/o?id=1 for login")).toBe(
      "https://auth.test/o?id=1",
    );
  });
});

describe("rewriteOAuthRedirectUri", () => {
  it("sets redirect_uri query param", () => {
    const login =
      "https://auth.example.com/o?client_id=a&redirect_uri=http%3A%2F%2Flocalhost%3A8787%2Fcallback";
    const out = rewriteOAuthRedirectUri(
      login,
      "https://app.example.com/callback",
    );
    expect(new URL(out).searchParams.get("redirect_uri")).toBe(
      "https://app.example.com/callback",
    );
  });
});

describe("webOAuthCallbackEnabled", () => {
  it("is off unless explicitly enabled", () => {
    const prev = process.env.CURSOR_BRIDGE_MCP_OAUTH_WEB_CALLBACK;
    delete process.env.CURSOR_BRIDGE_MCP_OAUTH_WEB_CALLBACK;
    expect(webOAuthCallbackEnabled()).toBe(false);
    process.env.CURSOR_BRIDGE_MCP_OAUTH_WEB_CALLBACK = "1";
    expect(webOAuthCallbackEnabled()).toBe(true);
    if (prev === undefined) delete process.env.CURSOR_BRIDGE_MCP_OAUTH_WEB_CALLBACK;
    else process.env.CURSOR_BRIDGE_MCP_OAUTH_WEB_CALLBACK = prev;
  });
});

describe("isLoopbackOnlyMcpOAuthLogin", () => {
  it("detects Atlassian authorize URLs", () => {
    expect(
      isLoopbackOnlyMcpOAuthLogin(
        "https://auth.atlassian.com/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A8787%2Fcallback",
      ),
    ).toBe(true);
  });
});

describe("applyPublicOAuthCallback", () => {
  it("keeps loopback by default even with public origin", () => {
    const login = "https://auth.example.com/o?redirect_uri=http%3A%2F%2F127.0.0.1%3A8787%2Fcallback";
    const prev = process.env.CURSOR_BRIDGE_MCP_OAUTH_WEB_CALLBACK;
    delete process.env.CURSOR_BRIDGE_MCP_OAUTH_WEB_CALLBACK;
    const { loginUrl, callbackUrl, callbackViaWeb } = applyPublicOAuthCallback(
      login,
      "https://cai.example.com",
    );
    expect(callbackViaWeb).toBe(false);
    expect(callbackUrl).toBe("http://127.0.0.1:8787/callback");
    expect(loginUrl).toBe(login);
    if (prev === undefined) delete process.env.CURSOR_BRIDGE_MCP_OAUTH_WEB_CALLBACK;
    else process.env.CURSOR_BRIDGE_MCP_OAUTH_WEB_CALLBACK = prev;
  });

  it("rewrites when web callback env is on and provider allows it", () => {
    const login =
      "https://auth.example.com/o?client_id=x&redirect_uri=https%3A%2F%2Fapp.example%2Fcb";
    const prev = process.env.CURSOR_BRIDGE_MCP_OAUTH_WEB_CALLBACK;
    process.env.CURSOR_BRIDGE_MCP_OAUTH_WEB_CALLBACK = "1";
    const { loginUrl, callbackUrl, callbackViaWeb } = applyPublicOAuthCallback(
      login,
      "https://cai.example.com",
    );
    expect(callbackViaWeb).toBe(true);
    expect(callbackUrl).toBe("https://cai.example.com/callback");
    expect(loginUrl).toContain("redirect_uri=");
    expect(decodeURIComponent(new URL(loginUrl!).searchParams.get("redirect_uri")!)).toBe(
      callbackUrl,
    );
    if (prev === undefined) delete process.env.CURSOR_BRIDGE_MCP_OAUTH_WEB_CALLBACK;
    else process.env.CURSOR_BRIDGE_MCP_OAUTH_WEB_CALLBACK = prev;
  });

  it("never rewrites Atlassian when web callback env is on", () => {
    const login =
      "https://auth.atlassian.com/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A8787%2Fcallback";
    const prev = process.env.CURSOR_BRIDGE_MCP_OAUTH_WEB_CALLBACK;
    process.env.CURSOR_BRIDGE_MCP_OAUTH_WEB_CALLBACK = "1";
    const { loginUrl, callbackViaWeb } = applyPublicOAuthCallback(
      login,
      "https://cai.example.com",
    );
    expect(callbackViaWeb).toBe(false);
    expect(loginUrl).toBe(login);
    if (prev === undefined) delete process.env.CURSOR_BRIDGE_MCP_OAUTH_WEB_CALLBACK;
    else process.env.CURSOR_BRIDGE_MCP_OAUTH_WEB_CALLBACK = prev;
  });

  it("keeps loopback callback without public origin", () => {
    const login = "https://auth.example.com/o";
    const { callbackUrl } = applyPublicOAuthCallback(login, undefined);
    expect(callbackUrl).toBe("http://127.0.0.1:8787/callback");
  });
});
