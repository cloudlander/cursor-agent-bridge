import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  appendSessionLine,
  logAgentError,
  logIncoming,
} from "./request-log.js";

describe("request logging noise filters", () => {
  const dir = mkdtempSync(join(tmpdir(), "request-log-filter-"));
  const logPath = join(dir, "sessions.log");

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips favicon and health probes for stdout and sessions log", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    for (const pathname of ["/favicon.ico", "/health", "/healthz"]) {
      logIncoming("GET", pathname, "::1");
      appendSessionLine(logPath, "GET", pathname, "::1", 200);
    }

    expect(logSpy).not.toHaveBeenCalled();
    expect(existsSync(logPath)).toBe(false);

    logSpy.mockRestore();
  });
});

describe("logAgentError", () => {
  const dir = mkdtempSync(join(tmpdir(), "request-log-test-"));
  const logPath = join(dir, "sessions.log");

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterAll(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps raw CLI stderr out of the client message", () => {
    const message = logAgentError(
      logPath,
      "POST",
      "/v1/chat/completions",
      "127.0.0.1",
      1,
      "token=secret-from-cli",
    );
    expect(message).toBe(
      "The Cursor agent process exited with code 1. See server logs for details.",
    );
    expect(readFileSync(logPath, "utf8")).toContain("token=secret-from-cli");
  });

  it("returns the proxy's failure reason when there is one", () => {
    const reason = 'ACP model catalog has no match for "x"';
    expect(
      logAgentError(logPath, "POST", "/v1/messages", "127.0.0.1", 1, "raw", reason),
    ).toBe(reason);
  });
});
