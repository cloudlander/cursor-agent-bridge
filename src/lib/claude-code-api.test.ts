import { describe, expect, it } from "vitest";

import {
  anthropicErrorBody,
  estimateAnthropicRequestInputTokens,
  estimateInputTokensFromText,
  isAnthropicApiPath,
} from "./claude-code-api.js";

describe("isAnthropicApiPath", () => {
  it("matches Claude Code / Anthropic message routes", () => {
    expect(isAnthropicApiPath("/v1/messages")).toBe(true);
    expect(isAnthropicApiPath("/v1/messages/count_tokens")).toBe(true);
    expect(isAnthropicApiPath("/v1/chat/completions")).toBe(false);
  });
});

describe("anthropicErrorBody", () => {
  it("uses the official error envelope", () => {
    expect(anthropicErrorBody("authentication_error", "invalid x-api-key")).toEqual(
      {
        type: "error",
        error: { type: "authentication_error", message: "invalid x-api-key" },
      },
    );
  });
});

describe("token estimates", () => {
  it("estimates from text length", () => {
    expect(estimateInputTokensFromText("")).toBe(1);
    expect(estimateInputTokensFromText("abcd")).toBe(1);
    expect(estimateInputTokensFromText("a".repeat(40))).toBe(10);
  });

  it("estimates from messages and system", () => {
    const tokens = estimateAnthropicRequestInputTokens({
      system: "You are helpful.",
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(tokens).toBeGreaterThan(0);
  });
});
