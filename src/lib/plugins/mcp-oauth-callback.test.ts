import * as http from "node:http";
import { describe, expect, it } from "vitest";

import { handleMcpOAuthCallback } from "./mcp-oauth-callback.js";

describe("handleMcpOAuthCallback", () => {
  it("returns 503 when loopback listener is down", async () => {
    const prev = process.env.CURSOR_BRIDGE_MCP_OAUTH_LOOPBACK_PORT;
    process.env.CURSOR_BRIDGE_MCP_OAUTH_LOOPBACK_PORT = "59217";
    const server = http.createServer((req, res) => {
      handleMcpOAuthCallback(
        req,
        res,
        new URL(req.url ?? "/", "http://127.0.0.1:1"),
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/callback?code=x`);
    expect(res.status).toBe(503);
    await new Promise<void>((r) => server.close(() => r()));
    if (prev === undefined) delete process.env.CURSOR_BRIDGE_MCP_OAUTH_LOOPBACK_PORT;
    else process.env.CURSOR_BRIDGE_MCP_OAUTH_LOOPBACK_PORT = prev;
  });
});
