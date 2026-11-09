import { describe, expect, it } from "vitest";

import {
  contextUsagePercent,
  estimateContextWindowUsageFromMessages,
  extractContextUsageFromTranscript,
  formatContextTokenCount,
  parseAcpPromptResultUsage,
  parseAcpUsageUpdate,
  parseContextWindowSizeFromModelId,
} from "./acp-context-usage.js";

describe("acp-context-usage", () => {
  it("parses usage_update payloads", () => {
    const u = parseAcpUsageUpdate({
      sessionUpdate: "usage_update",
      used: 120_000,
      size: 272_000,
    });
    expect(u).toMatchObject({ used: 120_000, size: 272_000 });
    expect(contextUsagePercent(u!)).toBeCloseTo(44.1, 1);
  });

  it("extracts the latest usage line from transcript JSONL", () => {
    const raw = [
      JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "hi" }] } }),
      JSON.stringify({ sessionUpdate: "usage_update", used: 1000, size: 200000 }),
      JSON.stringify({ sessionUpdate: "usage_update", used: 5000, size: 200000 }),
    ].join("\n");
    expect(extractContextUsageFromTranscript(raw)?.used).toBe(5000);
  });

  it("formats token labels", () => {
    expect(formatContextTokenCount(272000)).toBe("272k");
    expect(formatContextTokenCount(1_000_000)).toBe("1M");
  });

  it("parses model context sizes from catalog ids", () => {
    expect(parseContextWindowSizeFromModelId("gpt-5.6-sol[context=272k]")).toBe(
      272_000,
    );
    expect(parseContextWindowSizeFromModelId("claude-sonnet-4.6 1M")).toBe(
      1_000_000,
    );
  });

  it("estimates usage from thread messages when ACP is silent", () => {
    const est = estimateContextWindowUsageFromMessages(
      [{ content: "x".repeat(4000) }],
      "gpt-5.6-sol[context=272k]",
    );
    expect(est?.source).toBe("estimate");
    expect(est?.used).toBe(1000);
    expect(est?.size).toBe(272_000);
  });

  it("parses session/prompt result usage when present", () => {
    const u = parseAcpPromptResultUsage(
      {
        stopReason: "end_turn",
        usage: { inputTokens: 50_000, outputTokens: 2_000, cacheReadTokens: 10_000 },
      },
      "gpt-5.6-sol[context=272k]",
    );
    expect(u?.used).toBe(62_000);
    expect(u?.source).toBe("acp");
  });
});
