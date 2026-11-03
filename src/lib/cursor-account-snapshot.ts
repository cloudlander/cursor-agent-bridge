import * as fs from "node:fs";
import * as path from "node:path";

import {
  describePlan,
  estimateSubscriptionMonthlyUsd,
  fetchAccountUsage,
  fetchBilledUsage,
  fetchStripeProfile,
  modelLabel,
  tokenSub,
  type BilledUsage,
  type StripeProfile,
  type UsageData,
} from "./cursor-account-api.js";
import { readCachedToken, readKeychainToken } from "./token-cache.js";

export type UsagePoolSummary = {
  key: string;
  label: string;
  numRequests: number;
  numRequestsTotal: number;
  numTokens: number;
  maxRequestUsage: number | null;
  maxTokenUsage: number | null;
};

export type AccountUsageSummary = {
  startOfMonth: string;
  totalTokens: number;
  totalRequests: number;
  pools: UsagePoolSummary[];
};

export type CursorAccountDashboardEntry = {
  name: string;
  configDir: string;
  email?: string;
  displayName?: string;
  authenticated: boolean;
  tokenAvailable: boolean;
  planDescription?: string;
  subscription?: {
    membershipType: string;
    subscriptionStatus: string;
    isYearlyPlan: boolean;
    isTeamMember: boolean;
    monthlyListPriceUsd: number | null;
    daysRemainingOnTrial: number | null;
  };
  usage?: AccountUsageSummary;
  /** Token counts and charged cost from cursor.com's usage-events API. */
  billed?: BilledUsage;
  error?: string;
};

export type CursorAccountDashboardSnapshot = {
  fetchedAt: string;
  cacheTtlSeconds: number;
  accounts: CursorAccountDashboardEntry[];
};

export function readCursorCliAuth(configDir: string): {
  authenticated: boolean;
  email?: string;
  displayName?: string;
  authId?: string;
} {
  const configFile = path.join(configDir, "cli-config.json");
  if (!fs.existsSync(configFile)) {
    return { authenticated: false };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(configFile, "utf-8")) as {
      authInfo?: { email?: string; displayName?: string; authId?: string };
    };
    if (!raw.authInfo) return { authenticated: false };
    return {
      authenticated: true,
      email: raw.authInfo.email,
      displayName: raw.authInfo.displayName,
      authId: raw.authInfo.authId,
    };
  } catch {
    return { authenticated: false };
  }
}

export function resolveTokenForConfigDir(configDir: string): string | undefined {
  const auth = readCursorCliAuth(configDir);
  const cachedToken = readCachedToken(configDir);
  const keychainToken = readKeychainToken();
  if (cachedToken) return cachedToken;
  if (
    keychainToken &&
    auth.authId &&
    tokenSub(keychainToken) === auth.authId
  ) {
    return keychainToken;
  }
  if (keychainToken && !auth.authId) return keychainToken;
  return undefined;
}

/** Config dirs the proxy uses, or ~/.cursor when none are configured. */
export function configDirsForAccountUsage(configDirs: string[]): string[] {
  if (configDirs.length > 0) return configDirs;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (!home) return [];
  const cursor = path.join(home, ".cursor");
  if (fs.existsSync(path.join(cursor, "cli-config.json"))) return [cursor];
  return [];
}

export function summarizeAccountUsage(usage: UsageData): AccountUsageSummary {
  const pools: UsagePoolSummary[] = Object.entries(usage.models).map(
    ([key, v]) => ({
      key,
      label: modelLabel(key),
      numRequests: v.numRequests,
      numRequestsTotal: v.numRequestsTotal,
      numTokens: v.numTokens,
      maxRequestUsage: v.maxRequestUsage,
      maxTokenUsage: v.maxTokenUsage,
    }),
  );

  pools.sort((a, b) => {
    if ((a.maxRequestUsage !== null) !== (b.maxRequestUsage !== null)) {
      return a.maxRequestUsage !== null ? -1 : 1;
    }
    return b.numRequests - a.numRequests;
  });

  let totalTokens = 0;
  let totalRequests = 0;
  for (const p of pools) {
    totalTokens += p.numTokens;
    totalRequests += p.numRequests;
  }

  return {
    startOfMonth: usage.startOfMonth,
    totalTokens,
    totalRequests,
    pools,
  };
}

function subscriptionBlock(
  profile: StripeProfile | null,
): CursorAccountDashboardEntry["subscription"] | undefined {
  if (!profile) return undefined;
  return {
    membershipType: profile.membershipType,
    subscriptionStatus: profile.subscriptionStatus,
    isYearlyPlan: profile.isYearlyPlan,
    isTeamMember: profile.isTeamMember,
    monthlyListPriceUsd: estimateSubscriptionMonthlyUsd(profile),
    daysRemainingOnTrial: profile.daysRemainingOnTrial,
  };
}

async function fetchOneAccount(
  configDir: string,
): Promise<CursorAccountDashboardEntry> {
  const name = path.basename(configDir);
  const auth = readCursorCliAuth(configDir);
  const token = resolveTokenForConfigDir(configDir);

  const entry: CursorAccountDashboardEntry = {
    name,
    configDir,
    email: auth.email,
    displayName: auth.displayName,
    authenticated: auth.authenticated,
    tokenAvailable: Boolean(token),
  };

  if (!auth.authenticated) {
    entry.error = "Not signed in — run cursor-api-proxy login";
    return entry;
  }
  if (!token) {
    entry.error =
      "No access token cached — send a request through the proxy or run login";
    return entry;
  }

  const [usage, profile] = await Promise.all([
    fetchAccountUsage(token),
    fetchStripeProfile(token),
  ]);

  if (profile) {
    entry.planDescription = describePlan(profile);
    entry.subscription = subscriptionBlock(profile);
  }

  const now = new Date();
  const periodStart =
    usage?.startOfMonth && !Number.isNaN(Date.parse(usage.startOfMonth))
      ? new Date(usage.startOfMonth)
      : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const billed = await fetchBilledUsage(token, {
    start: periodStart,
    end: now,
    teamId: profile?.teamId,
  });

  if (usage) entry.usage = summarizeAccountUsage(usage);
  if (billed) entry.billed = billed;
  if (!usage && !billed) {
    entry.error = entry.error ?? "Could not load usage from Cursor API";
  }

  return entry;
}

export async function fetchCursorAccountSnapshot(
  configDirs: string[],
  cacheTtlSeconds = 45,
): Promise<CursorAccountDashboardSnapshot> {
  const dirs = configDirsForAccountUsage(configDirs);
  const accounts =
    dirs.length === 0
      ? [
          {
            name: "(none)",
            configDir: "",
            authenticated: false,
            tokenAvailable: false,
            error:
              "No Cursor account directory configured (set CURSOR_CONFIG_DIRS or run login)",
          } satisfies CursorAccountDashboardEntry,
        ]
      : await Promise.all(dirs.map((d) => fetchOneAccount(d)));

  return {
    fetchedAt: new Date().toISOString(),
    cacheTtlSeconds,
    accounts,
  };
}
