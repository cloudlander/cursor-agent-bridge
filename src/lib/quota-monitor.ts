import {
  fetchAccountUsage,
  fetchBilledUsage,
  fetchStripeProfile,
  type UsageData,
} from "./cursor-account-api.js";
import { resolveTokenForConfigDir } from "./cursor-account-snapshot.js";

export type QuotaSnapshot = {
  remainingRatio: number | "unknown";
  fetchedAt: number;
  forcedZero?: boolean;
};

const CACHE_TTL_MS = 90_000;
const cache = new Map<string, QuotaSnapshot>();

export function clearQuotaMonitorCacheForTests(): void {
  cache.clear();
}

/** Mark account quota exhausted (e.g. plan-limit) until cache TTL expires. */
export function markAccountQuotaExhausted(configDir: string | undefined): void {
  if (!configDir) return;
  cache.set(configDir, {
    remainingRatio: 0,
    fetchedAt: Date.now(),
    forcedZero: true,
  });
}

function minRemainingFromUsage(usage: UsageData): number | "unknown" {
  let minRemaining: number | undefined;
  for (const v of Object.values(usage.models)) {
    const max = v.maxRequestUsage;
    if (max == null || max <= 0) continue;
    const used = v.numRequests;
    const remaining = 1 - used / max;
    if (minRemaining === undefined || remaining < minRemaining) {
      minRemaining = remaining;
    }
  }
  return minRemaining ?? "unknown";
}

function remainingFromBudget(costUsd: number, budgetUsd: number): number {
  if (budgetUsd <= 0) return 0;
  return Math.max(0, 1 - costUsd / budgetUsd);
}

export async function getAccountQuotaRemainingRatio(args: {
  configDir?: string;
  monthlyBudgetUsd?: number;
}): Promise<number | "unknown"> {
  const configDir = args.configDir;
  if (!configDir) return "unknown";

  const cached = cache.get(configDir);
  const fetchedAt = Date.now();
  if (cached && fetchedAt - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.remainingRatio;
  }

  const token = resolveTokenForConfigDir(configDir);
  if (!token) {
    const snap: QuotaSnapshot = { remainingRatio: "unknown", fetchedAt };
    cache.set(configDir, snap);
    return "unknown";
  }

  const [usage, profile] = await Promise.all([
    fetchAccountUsage(token),
    fetchStripeProfile(token),
  ]);

  let remaining: number | "unknown" = "unknown";
  const requestBased =
    usage != null ? minRemainingFromUsage(usage) : "unknown";

  let billedRemaining: number | "unknown" = "unknown";
  if (args.monthlyBudgetUsd != null && args.monthlyBudgetUsd > 0) {
    const nowDate = new Date(fetchedAt);
    const periodStart =
      usage?.startOfMonth && !Number.isNaN(Date.parse(usage.startOfMonth))
        ? new Date(usage.startOfMonth)
        : new Date(
            Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), 1),
          );
    const billed = await fetchBilledUsage(token, {
      start: periodStart,
      end: nowDate,
      teamId: profile?.teamId,
    });
    if (billed) {
      billedRemaining = remainingFromBudget(
        billed.costUsd,
        args.monthlyBudgetUsd,
      );
    }
  }

  if (requestBased !== "unknown" && billedRemaining !== "unknown") {
    remaining = Math.min(requestBased, billedRemaining);
  } else if (requestBased !== "unknown") {
    remaining = requestBased;
  } else if (billedRemaining !== "unknown") {
    remaining = billedRemaining;
  }

  const snap: QuotaSnapshot = { remainingRatio: remaining, fetchedAt };
  cache.set(configDir, snap);
  return remaining;
}
