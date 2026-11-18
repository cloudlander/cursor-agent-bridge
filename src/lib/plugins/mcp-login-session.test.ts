import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyMcpLoginExit,
  formatMcpOAuthTimeout,
  getMcpLoginSession,
  mcpLoginFailureMessage,
  mcpOAuthTimeoutMessage,
  mcpOAuthTimeoutMs,
  openMcpLoginSession,
  resetMcpLoginSessions,
  watchMcpLoginProcess,
  type McpLoginProcess,
} from "./mcp-login-session.js";

type FakeChild = McpLoginProcess & {
  emitExit(code: number | null): void;
  emitError(err: Error): void;
};

function fakeChild(): FakeChild {
  const exitListeners: Array<(code: number | null) => void> = [];
  const errorListeners: Array<(err: Error) => void> = [];
  const child: FakeChild = {
    exitCode: null,
    kill() {
      return true;
    },
    on(event: "exit" | "error", listener: ((code: number | null) => void) | ((err: Error) => void)) {
      if (event === "exit") exitListeners.push(listener as (code: number | null) => void);
      else errorListeners.push(listener as (err: Error) => void);
    },
    emitExit(code) {
      child.exitCode = code;
      for (const listener of exitListeners) listener(code);
    },
    emitError(err) {
      for (const listener of errorListeners) listener(err);
    },
  };
  return child;
}

describe("mcp OAuth login session", () => {
  afterEach(() => {
    resetMcpLoginSessions();
    vi.useRealTimers();
    delete process.env.CURSOR_BRIDGE_MCP_OAUTH_TIMEOUT_MS;
  });

  it("defaults the wait to 5 minutes", () => {
    expect(mcpOAuthTimeoutMs()).toBe(5 * 60 * 1000);
    expect(formatMcpOAuthTimeout(5 * 60 * 1000)).toBe("5 minutes");
    expect(mcpOAuthTimeoutMessage(5 * 60 * 1000)).toBe(
      "Authentication timed out after 5 minutes.",
    );
  });

  it("reads a positive timeout override", () => {
    process.env.CURSOR_BRIDGE_MCP_OAUTH_TIMEOUT_MS = "15000";
    expect(mcpOAuthTimeoutMs()).toBe(15_000);
    expect(formatMcpOAuthTimeout(15_000)).toBe("15 seconds");
    process.env.CURSOR_BRIDGE_MCP_OAUTH_TIMEOUT_MS = "0";
    expect(mcpOAuthTimeoutMs()).toBe(5 * 60 * 1000);
  });

  it("records success when the login process exits 0", () => {
    const opened = openMcpLoginSession("plugin-google-drive-google-drive", 5_000);
    const child = fakeChild();
    watchMcpLoginProcess(opened.id, child);
    child.emitExit(0);
    const session = getMcpLoginSession(opened.id);
    expect(session?.phase).toBe("succeeded");
    expect(session?.message).toBe("Authentication succeeded.");
  });

  it("records failure and keeps that result after the timeout would have fired", () => {
    vi.useFakeTimers();
    const opened = openMcpLoginSession("plugin-google-drive-google-drive", 5_000);
    const child = fakeChild();
    const kill = vi.spyOn(child, "kill");
    watchMcpLoginProcess(opened.id, child);
    child.emitExit(1);
    vi.advanceTimersByTime(5_000);
    expect(getMcpLoginSession(opened.id)?.phase).toBe("failed");
    expect(kill).not.toHaveBeenCalled();
  });

  it("times out, stops the process, and ignores the later exit", () => {
    vi.useFakeTimers();
    const opened = openMcpLoginSession("plugin-google-drive-google-drive", 5 * 60 * 1000);
    const child = fakeChild();
    const kill = vi.spyOn(child, "kill");
    watchMcpLoginProcess(opened.id, child);
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    expect(getMcpLoginSession(opened.id)?.phase).toBe("timed_out");
    expect(getMcpLoginSession(opened.id)?.message).toBe(
      "Authentication timed out after 5 minutes.",
    );
    child.emitExit(null);
    expect(getMcpLoginSession(opened.id)?.phase).toBe("timed_out");
  });

  it("replaces a pending login for the same MCP key", () => {
    const first = openMcpLoginSession("plugin-google-drive-google-drive", 5_000);
    const child = fakeChild();
    const kill = vi.spyOn(child, "kill");
    watchMcpLoginProcess(first.id, child);
    const second = openMcpLoginSession("plugin-google-drive-google-drive", 5_000);
    expect(kill).toHaveBeenCalled();
    expect(getMcpLoginSession(first.id)?.phase).toBe("failed");
    expect(getMcpLoginSession(second.id)?.phase).toBe("pending");
  });

  it("applyMcpLoginExit keeps the CLI failure detail and does not overwrite success", () => {
    const failed = openMcpLoginSession("plugin-google-drive-google-drive", 5_000);
    applyMcpLoginExit(failed.id, 1, "token exchange failed");
    expect(getMcpLoginSession(failed.id)?.message).toBe(
      "Authentication failed. token exchange failed",
    );
    const opened = openMcpLoginSession("plugin-atlassian-atlassian", 5_000);
    applyMcpLoginExit(opened.id, 0);
    applyMcpLoginExit(opened.id, 1, "access_denied");
    expect(getMcpLoginSession(opened.id)?.phase).toBe("succeeded");
  });

  it("drops authorize URLs from the failure detail", () => {
    expect(
      mcpLoginFailureMessage("Open this URL\nhttps://accounts.google.com/o/oauth\n"),
    ).toBe("Authentication failed.");
    expect(mcpLoginFailureMessage("access_denied")).toBe(
      "Authentication failed. access_denied",
    );
  });
});
