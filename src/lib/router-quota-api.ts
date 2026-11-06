import * as path from "node:path";

import type { BridgeConfig } from "./config.js";
import { getAccountStats } from "./account-pool.js";
import { getAccountQuotaRemainingRatio } from "./quota-monitor.js";

export type RouterQuotaAccount = {
  configDir: string;
  label: string;
  remainingRatio: number | null;
  remainingPercent: number | null;
  status: "ok" | "low" | "unknown" | "rate_limited";
  isRateLimited: boolean;
};

export type RouterQuotaResponse = {
  enabled: boolean;
  threshold: number;
  monthlyBudgetUsd: number;
  accounts: RouterQuotaAccount[];
};

export async function buildRouterQuotaResponse(
  config: BridgeConfig,
): Promise<RouterQuotaResponse> {
  const threshold = config.routerQuotaThreshold;
  const monthlyBudgetUsd = config.routerMonthlyBudgetUsd ?? 0;

  if (!config.routerEnabled) {
    return {
      enabled: false,
      threshold,
      monthlyBudgetUsd,
      accounts: [],
    };
  }

  const stats = getAccountStats();
  const dirs =
    config.configDirs.length > 0
      ? config.configDirs
      : stats.map((s) => s.configDir);
  const uniqueDirs = [...new Set(dirs)];
  if (uniqueDirs.length === 0) {
    uniqueDirs.push("");
  }

  const accounts = await Promise.all(
    uniqueDirs.map(async (configDir) => {
      const stat = stats.find((s) => s.configDir === configDir);
      const remaining = await getAccountQuotaRemainingRatio({
        configDir: configDir || undefined,
        monthlyBudgetUsd: config.routerMonthlyBudgetUsd,
      });
      const ratio = remaining === "unknown" ? null : remaining;

      let status: RouterQuotaAccount["status"] = "unknown";
      if (stat?.isRateLimited) status = "rate_limited";
      else if (ratio === null) status = "unknown";
      else if (ratio <= threshold) status = "low";
      else status = "ok";

      return {
        configDir,
        label: configDir ? path.basename(configDir) : "default",
        remainingRatio: ratio,
        remainingPercent:
          ratio != null ? Math.round(ratio * 1000) / 10 : null,
        status,
        isRateLimited: stat?.isRateLimited ?? false,
      };
    }),
  );

  return {
    enabled: true,
    threshold,
    monthlyBudgetUsd,
    accounts,
  };
}
