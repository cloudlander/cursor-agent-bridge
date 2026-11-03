import { describe, expect, it } from "vitest";

import { estimateSubscriptionMonthlyUsd } from "./cursor-account-api.js";
import {
  configDirsForAccountUsage,
  summarizeAccountUsage,
} from "./cursor-account-snapshot.js";

describe("cursor account snapshot", () => {
  it("summarizes token and request totals from usage pools", () => {
    const summary = summarizeAccountUsage({
      startOfMonth: "2026-10-01T00:00:00.000Z",
      models: {
        "gpt-4": {
          numRequests: 10,
          numRequestsTotal: 100,
          numTokens: 50_000,
          maxRequestUsage: 500,
          maxTokenUsage: null,
        },
        "cursor-small": {
          numRequests: 2,
          numRequestsTotal: 2,
          numTokens: 1000,
          maxRequestUsage: null,
          maxTokenUsage: null,
        },
      },
    });
    expect(summary.totalTokens).toBe(51_000);
    expect(summary.totalRequests).toBe(12);
    expect(summary.pools[0].key).toBe("gpt-4");
  });

  it("returns configured dirs when set", () => {
    expect(configDirsForAccountUsage(["/a", "/b"])).toEqual(["/a", "/b"]);
  });

  it("estimates list subscription price for Pro", () => {
    expect(
      estimateSubscriptionMonthlyUsd({
        membershipType: "pro",
        subscriptionStatus: "active",
        daysRemainingOnTrial: null,
        isTeamMember: false,
        isYearlyPlan: false,
      }),
    ).toBe(20);
  });
});
