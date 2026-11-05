import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearQuotaMonitorCacheForTests,
  getAccountQuotaRemainingRatio,
  markAccountQuotaExhausted,
} from "./quota-monitor.js";

vi.mock("./cursor-account-api.js", () => ({
  fetchAccountUsage: vi.fn(),
  fetchBilledUsage: vi.fn(),
  fetchStripeProfile: vi.fn(),
}));

vi.mock("./cursor-account-snapshot.js", () => ({
  resolveTokenForConfigDir: vi.fn(() => "token"),
}));

import {
  fetchAccountUsage,
  fetchBilledUsage,
  fetchStripeProfile,
} from "./cursor-account-api.js";

describe("quota-monitor", () => {
  afterEach(() => {
    clearQuotaMonitorCacheForTests();
    vi.clearAllMocks();
  });

  it("computes request-pool remaining as minimum across capped pools", async () => {
    vi.mocked(fetchAccountUsage).mockResolvedValue({
      startOfMonth: "2026-11-01",
      models: {
        a: {
          numRequests: 50,
          numRequestsTotal: 50,
          numTokens: 0,
          maxTokenUsage: null,
          maxRequestUsage: 100,
        },
        b: {
          numRequests: 10,
          numRequestsTotal: 10,
          numTokens: 0,
          maxTokenUsage: null,
          maxRequestUsage: 200,
        },
      },
    });
    vi.mocked(fetchStripeProfile).mockResolvedValue(null);

    const ratio = await getAccountQuotaRemainingRatio({
      configDir: "/cfg/a",
    });
    expect(ratio).toBeCloseTo(0.5);
  });

  it("uses monthly budget when configured", async () => {
    vi.mocked(fetchAccountUsage).mockResolvedValue({
      startOfMonth: "2026-11-01",
      models: {},
    });
    vi.mocked(fetchStripeProfile).mockResolvedValue(null);
    vi.mocked(fetchBilledUsage).mockResolvedValue({
      startDate: "",
      endDate: "",
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      costUsd: 25,
      byModel: [],
    });

    const ratio = await getAccountQuotaRemainingRatio({
      configDir: "/cfg/b",
      monthlyBudgetUsd: 100,
    });
    expect(ratio).toBeCloseTo(0.75);
  });

  it("returns unknown without token", async () => {
    const { resolveTokenForConfigDir } = await import(
      "./cursor-account-snapshot.js"
    );
    vi.mocked(resolveTokenForConfigDir).mockReturnValue(undefined);

    const ratio = await getAccountQuotaRemainingRatio({
      configDir: "/cfg/none",
    });
    expect(ratio).toBe("unknown");
  });

  it("marks account exhausted at zero remaining", async () => {
    markAccountQuotaExhausted("/cfg/z");
    const ratio = await getAccountQuotaRemainingRatio({
      configDir: "/cfg/z",
    });
    expect(ratio).toBe(0);
    expect(fetchAccountUsage).not.toHaveBeenCalled();
  });
});
