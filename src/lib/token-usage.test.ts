import { describe, expect, it } from "vitest";

import {
  aggregateTokenUsage,
  estimateTokenCounts,
  estimateUsageCostUsd,
  parseProxyUsageLine,
} from "./token-usage.js";

describe("token usage", () => {
  it("estimates tokens from character counts", () => {
    expect(estimateTokenCounts(0, 0)).toEqual({
      promptTokens: 1,
      completionTokens: 1,
    });
    expect(estimateTokenCounts(400, 800)).toEqual({
      promptTokens: 100,
      completionTokens: 200,
    });
  });

  it("parses usage log lines", () => {
    const line =
      '2026-07-13T12:00:00.000Z USAGE {"pathname":"/v1/chat/completions","model":"sonnet-4.6","promptTokens":100,"completionTokens":50}';
    expect(parseProxyUsageLine(line)).toEqual({
      ts: "2026-07-13T12:00:00.000Z",
      pathname: "/v1/chat/completions",
      model: "sonnet-4.6",
      promptTokens: 100,
      completionTokens: 50,
    });
    expect(parseProxyUsageLine("2026-07-13T12:00:00.000Z GET /health ::1 200")).toBeNull();
  });

  it("aggregates usage within the time window", () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    const old = new Date(Date.now() - 48 * 3600_000).toISOString();
    const lines = [
      `${old} USAGE {"pathname":"/v1/chat/completions","model":"opus-4.6","promptTokens":1000,"completionTokens":500}`,
      `${recent} USAGE {"pathname":"/v1/messages","model":"sonnet-4.6","promptTokens":200,"completionTokens":100}`,
    ];
    const agg = aggregateTokenUsage(lines, 24);
    expect(agg.requestCount).toBe(1);
    expect(agg.promptTokens).toBe(200);
    expect(agg.completionTokens).toBe(100);
    expect(agg.totalTokens).toBe(300);
    expect(agg.estimatedCostUsd).toBeGreaterThan(0);
    expect(agg.byModel["sonnet-4.6"]?.totalTokens).toBe(300);
  });

  it("uses higher opus pricing in cost estimate", () => {
    const sonnet = estimateUsageCostUsd("sonnet-4.6", 1_000_000, 0);
    const opus = estimateUsageCostUsd("opus-4.6", 1_000_000, 0);
    expect(opus).toBeGreaterThan(sonnet);
  });
});
