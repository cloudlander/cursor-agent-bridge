import { describe, expect, it } from "vitest";

import { rewriteBridgeRemoteMcpUrl } from "./bridge-mcp-url.js";

describe("rewriteBridgeRemoteMcpUrl", () => {
  it("rewrites Cursor Google Drive proxy to Google-hosted MCP", () => {
    expect(
      rewriteBridgeRemoteMcpUrl("https://api.cursor.com/rest-mcp/google-drive/mcp"),
    ).toBe("https://drivemcp.googleapis.com/mcp/v1");
  });

  it("leaves other URLs unchanged", () => {
    expect(rewriteBridgeRemoteMcpUrl("https://mcp.atlassian.com/v2/mcp")).toBe(
      "https://mcp.atlassian.com/v2/mcp",
    );
  });
});
