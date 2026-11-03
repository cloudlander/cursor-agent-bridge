import * as https from "node:https";

// ---------------------------------------------------------------------------
// JWT helpers (no external dependencies)
// ---------------------------------------------------------------------------

export function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return {};
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf-8"));
  } catch {
    return {};
  }
}

/** Extract the auth0 user sub from a Cursor access token (e.g. "auth0|user_01KK…"). */
export function tokenSub(token: string): string | undefined {
  const p = decodeJwtPayload(token);
  return typeof p.sub === "string" ? p.sub : undefined;
}

// ---------------------------------------------------------------------------
// Cursor API
// ---------------------------------------------------------------------------

function apiGet(path: string, token: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "api2.cursor.sh",
      path,
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(8000, () => {
      req.destroy(new Error("timeout"));
    });
    req.end();
  });
}

export type ModelUsage = {
  numRequests: number;
  numRequestsTotal: number;
  numTokens: number;
  maxTokenUsage: number | null;
  maxRequestUsage: number | null;
};

export type UsageData = {
  startOfMonth: string;
  models: Record<string, ModelUsage>;
};

export async function fetchAccountUsage(
  token: string,
): Promise<UsageData | null> {
  try {
    const raw = (await apiGet("/auth/usage", token)) as Record<
      string,
      unknown
    > | null;
    if (!raw || typeof raw !== "object") return null;
    const { startOfMonth, ...rest } = raw as Record<string, unknown>;
    return {
      startOfMonth: typeof startOfMonth === "string" ? startOfMonth : "",
      models: rest as Record<string, ModelUsage>,
    };
  } catch {
    return null;
  }
}

export type StripeProfile = {
  membershipType: string;
  subscriptionStatus: string;
  daysRemainingOnTrial: number | null;
  isTeamMember: boolean;
  isYearlyPlan: boolean;
  teamId?: number;
  teamMembershipType?: string;
};

/** Human-readable plan name + limits for display. */
export function describePlan(profile: StripeProfile): string {
  const { membershipType, subscriptionStatus, daysRemainingOnTrial } = profile;
  switch (membershipType) {
    case "free_trial": {
      const days = daysRemainingOnTrial ?? 0;
      return `Pro Trial (${days}d left) — unlimited fast requests`;
    }
    case "pro":
    case "pro_plus":
    case "ultra":
      return `${membershipType === "pro" ? "Pro" : membershipType === "pro_plus" ? "Pro+" : "Ultra"} — extended limits`;
    case "free":
    case "hobby":
      return "Hobby (free) — limited agent requests";
    case "enterprise":
    case "team":
      return [
        membershipType === "team" ? "Teams" : "Enterprise",
        profile.teamMembershipType,
        subscriptionStatus,
      ]
        .filter(Boolean)
        .join(" · ");
    default:
      return [membershipType, subscriptionStatus].filter(Boolean).join(" · ");
  }
}

export async function fetchStripeProfile(
  token: string,
): Promise<StripeProfile | null> {
  try {
    const raw = (await apiGet("/auth/full_stripe_profile", token)) as Record<
      string,
      unknown
    > | null;
    if (!raw || typeof raw !== "object") return null;
    return {
      membershipType: String(raw.membershipType ?? ""),
      subscriptionStatus: String(raw.subscriptionStatus ?? ""),
      daysRemainingOnTrial:
        typeof raw.daysRemainingOnTrial === "number"
          ? raw.daysRemainingOnTrial
          : null,
      isTeamMember: Boolean(raw.isTeamMember),
      isYearlyPlan: Boolean(raw.isYearlyPlan),
      teamId: typeof raw.teamId === "number" ? raw.teamId : undefined,
      teamMembershipType:
        typeof raw.teamMembershipType === "string"
          ? raw.teamMembershipType
          : undefined,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// cursor.com dashboard API (token-based billing; the source of truth for
// usage-based and enterprise plans, where /auth/usage reports zeros)
// ---------------------------------------------------------------------------

function dashboardPost(
  endpoint: string,
  token: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const userId = (tokenSub(token) ?? "").split("|").pop() ?? "";
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "cursor.com",
        path: `/api/dashboard/${endpoint}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Origin: "https://cursor.com",
          Cookie: `WorkosCursorSessionToken=${encodeURIComponent(`${userId}::${token}`)}`,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if ((res.statusCode ?? 500) >= 400) return resolve(null);
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(10000, () => {
      req.destroy(new Error("timeout"));
    });
    req.end(payload);
  });
}

export type BilledModelUsage = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUsd: number;
};

export type BilledUsage = {
  startDate: string;
  endDate: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUsd: number;
  byModel: BilledModelUsage[];
};

function num(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

/** Per-model token counts and charged cost for [start, end] from cursor.com. */
export async function fetchBilledUsage(
  token: string,
  opts: { start: Date; end: Date; teamId?: number },
): Promise<BilledUsage | null> {
  try {
    const body: Record<string, unknown> = {
      startDate: opts.start.getTime(),
      endDate: opts.end.getTime(),
    };
    if (opts.teamId !== undefined) body.teamId = opts.teamId;
    const raw = (await dashboardPost(
      "get-aggregated-usage-events",
      token,
      body,
    )) as Record<string, unknown> | null;
    if (!raw || !Array.isArray(raw.aggregations)) return null;

    const byModel: BilledModelUsage[] = (
      raw.aggregations as Record<string, unknown>[]
    ).map((a) => {
      const inputTokens = num(a.inputTokens);
      const outputTokens = num(a.outputTokens);
      const cacheWriteTokens = num(a.cacheWriteTokens);
      const cacheReadTokens = num(a.cacheReadTokens);
      return {
        model: String(a.modelIntent ?? "unknown"),
        inputTokens,
        outputTokens,
        cacheWriteTokens,
        cacheReadTokens,
        totalTokens:
          inputTokens + outputTokens + cacheWriteTokens + cacheReadTokens,
        costUsd: num(a.totalCents) / 100,
      };
    });
    byModel.sort((a, b) => b.totalTokens - a.totalTokens);

    const inputTokens = num(raw.totalInputTokens);
    const outputTokens = num(raw.totalOutputTokens);
    const cacheWriteTokens = num(raw.totalCacheWriteTokens);
    const cacheReadTokens = num(raw.totalCacheReadTokens);
    return {
      startDate: opts.start.toISOString(),
      endDate: opts.end.toISOString(),
      inputTokens,
      outputTokens,
      cacheWriteTokens,
      cacheReadTokens,
      totalTokens:
        inputTokens + outputTokens + cacheWriteTokens + cacheReadTokens,
      costUsd: num(raw.totalCostCents) / 100,
      byModel,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Summary helpers
// ---------------------------------------------------------------------------

const MODEL_LABELS: Record<string, string> = {
  "gpt-4": "Fast Premium Requests",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-sonnet-4-5-20250929-v1": "Claude Sonnet 4.5",
  "claude-sonnet-4-20250514-v1": "Claude Sonnet 4",
  "claude-opus-4-6-v1": "Claude Opus 4.6",
  "claude-opus-4-5-20251101-v1": "Claude Opus 4.5",
  "claude-opus-4-1-20250805-v1": "Claude Opus 4.1",
  "claude-opus-4-20250514-v1": "Claude Opus 4",
  "claude-haiku-4-5-20251001-v1": "Claude Haiku 4.5",
  "claude-3-5-haiku-20241022-v1": "Claude 3.5 Haiku",
  "gpt-5": "GPT-5",
  "gpt-4o": "GPT-4o",
  o1: "o1",
  "o3-mini": "o3-mini",
  "cursor-small": "Cursor Small (free)",
};

export function modelLabel(key: string): string {
  return MODEL_LABELS[key] ?? key;
}

/** Public list prices (USD) for dashboard reference — not live billing. */
export const CURSOR_SUBSCRIPTION_USD_MONTHLY: Record<string, number> = {
  pro: 20,
  pro_plus: 60,
  ultra: 200,
  free_trial: 0,
  free: 0,
  hobby: 0,
};

export function estimateSubscriptionMonthlyUsd(
  profile: StripeProfile | null | undefined,
): number | null {
  if (!profile) return null;
  const base = CURSOR_SUBSCRIPTION_USD_MONTHLY[profile.membershipType];
  if (base === undefined) return null;
  if (profile.isTeamMember) return null;
  return base;
}

export function formatUsageSummary(usage: UsageData): string[] {
  const lines: string[] = [];
  const start = usage.startOfMonth
    ? new Date(usage.startOfMonth).toLocaleDateString()
    : "?";
  lines.push(`     📅 Billing period from ${start}`);

  const entries = Object.entries(usage.models);
  if (entries.length === 0) {
    lines.push(`     🔢 No requests this billing period`);
    return lines;
  }

  const sorted = entries.sort(([, a], [, b]) => {
    if ((a.maxRequestUsage !== null) !== (b.maxRequestUsage !== null))
      return a.maxRequestUsage !== null ? -1 : 1;
    return b.numRequests - a.numRequests;
  });

  for (const [key, v] of sorted) {
    const used = v.numRequests;
    const max = v.maxRequestUsage;
    const label = modelLabel(key);
    if (max !== null && max > 0) {
      const pct = Math.round((used / max) * 100);
      const bar = makeBar(used, max, 12);
      lines.push(`     🔢 ${label}: ${used}/${max} (${pct}%) [${bar}]`);
    } else if (used > 0) {
      lines.push(`     🔢 ${label}: ${used} requests`);
    } else {
      lines.push(`     🔢 ${label}: 0 requests (unlimited)`);
    }
  }

  return lines;
}

function makeBar(used: number, max: number, width: number): string {
  const fill = Math.round((used / max) * width);
  return "█".repeat(fill) + "░".repeat(width - fill);
}
