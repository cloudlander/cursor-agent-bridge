import { describe, expect, it } from "vitest";

import { pathRequiresBridgeApiKey } from "./bridge-api-auth.js";

describe("pathRequiresBridgeApiKey", () => {
  it("requires key for OpenAI and Anthropic API paths", () => {
    expect(pathRequiresBridgeApiKey("/v1/models")).toBe(true);
    expect(pathRequiresBridgeApiKey("/v1/chat/completions")).toBe(true);
    expect(pathRequiresBridgeApiKey("/v1/messages")).toBe(true);
    expect(pathRequiresBridgeApiKey("/health")).toBe(true);
  });

  it("does not require key for dashboard, chat, or plugins", () => {
    expect(pathRequiresBridgeApiKey("/")).toBe(false);
    expect(pathRequiresBridgeApiKey("/chat")).toBe(false);
    expect(pathRequiresBridgeApiKey("/plugins")).toBe(false);
    expect(pathRequiresBridgeApiKey("/api/plugins/catalog")).toBe(false);
    expect(pathRequiresBridgeApiKey("/api/plugins/mcp-login")).toBe(false);
    expect(pathRequiresBridgeApiKey("/api/status")).toBe(false);
    expect(pathRequiresBridgeApiKey("/healthz")).toBe(false);
  });
});
