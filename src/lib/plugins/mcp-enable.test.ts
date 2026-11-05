import { describe, expect, it } from "vitest";

import {
  isMcpEnableSuccess,
  isMcpNotApprovedMessage,
  mcpEnableCommand,
} from "./mcp-enable.js";
import { testBridgeConfig } from "../test-bridge-config.js";

describe("isMcpEnableSuccess", () => {
  it("accepts exit 0", () => {
    expect(isMcpEnableSuccess(0, "")).toBe(true);
  });

  it("accepts already-enabled CLI message", () => {
    expect(
      isMcpEnableSuccess(
        0,
        "MCP server 'x' is already enabled and approved",
      ),
    ).toBe(true);
  });
});

describe("isMcpNotApprovedMessage", () => {
  it("detects CLI approval gate", () => {
    expect(
      isMcpNotApprovedMessage(
        'MCP server "plugin-atlassian-atlassian" has not been approved',
      ),
    ).toBe(true);
  });
});

describe("mcpEnableCommand", () => {
  it("targets agent mcp enable with config dir", () => {
    const config = testBridgeConfig();
    const { bin, args, env } = mcpEnableCommand(
      config,
      "plugin-atlassian-atlassian",
      "/tmp/cursor-test",
    );
    expect(bin).toBe(config.agentBin);
    expect(args).toEqual([
      "--workspace",
      config.workspace,
      "mcp",
      "enable",
      "plugin-atlassian-atlassian",
    ]);
    expect(env.CURSOR_CONFIG_DIR).toBe("/tmp/cursor-test");
  });
});
