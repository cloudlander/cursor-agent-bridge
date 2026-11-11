import { afterEach, describe, expect, it } from "vitest";

import {
  getAgentLoginSession,
  resetAgentLoginSessionsForTests,
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
});
