import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { BridgeConfig } from "./config.js";
import {
  getAgentLoginSession,
  resetAgentLoginSessionsForTests,
  startAgentLoginSession,
  stashAgentLoginSessionForTests,
} from "./agent-login.js";

describe("agent login session polling", () => {
  afterEach(() => {
    resetAgentLoginSessionsForTests();
  });

  it("returns terminal failed sessions after active session is cleared", () => {
    stashAgentLoginSessionForTests({
      sessionId: "sess-1",
      status: "failed",
      error: "This Cursor account is already added",
      configDir: "/tmp/accounts/dup",
      accountName: "dup",
      startedAt: new Date().toISOString(),
    });

    expect(getAgentLoginSession("sess-1")).toMatchObject({
      status: "failed",
      error: "This Cursor account is already added",
    });
    expect(getAgentLoginSession("other")).toBeNull();
  });

  it("does not create an account directory when one is already signed in", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "login-guard-"));
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      const dir = path.join(home, ".cursor-api-proxy", "accounts", "yuzhang");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "cli-config.json"),
        JSON.stringify({
          authInfo: { email: "y@example.com", authId: "auth0|user" },
        }),
      );
      const result = await startAgentLoginSession({} as BridgeConfig);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/already configured/i);
      expect(
        fs.readdirSync(path.join(home, ".cursor-api-proxy", "accounts")),
      ).toEqual(["yuzhang"]);
    } finally {
      if (prev === undefined) delete process.env.HOME;
      else process.env.HOME = prev;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
