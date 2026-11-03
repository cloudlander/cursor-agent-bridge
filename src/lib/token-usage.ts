import * as fs from "node:fs";
import * as path from "node:path";

/** Same char/4 heuristic as API usage fields in handlers. */
export function estimateTokenCounts(
  promptChars: number,
  completionChars: number,
): { promptTokens: number; completionTokens: number } {
  return {
    promptTokens: Math.max(1, Math.round(promptChars / 4)),
    completionTokens: Math.max(1, Math.round(completionChars / 4)),
  };
}

export type ProxyUsageRecord = {
  ts: string;
  pathname: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
};

const USAGE_PREFIX = " USAGE ";

/** USD per 1M tokens — illustrative API-equivalent rates for dashboard estimates only. */
type ModelPricing = { inputPerMillion: number; outputPerMillion: number };

const DEFAULT_PRICING: ModelPricing = {
  inputPerMillion: 3,
  outputPerMillion: 15,
};

function pricingForModel(model: string): ModelPricing {
  const m = model.toLowerCase();
  if (m.includes("opus")) {
    return { inputPerMillion: 15, outputPerMillion: 75 };
  }
  if (m.includes("haiku") || m.includes("small") || m.includes("mini")) {
    return { inputPerMillion: 0.8, outputPerMillion: 4 };
  }
  if (m.includes("gpt") || m.includes("o1") || m.includes("o3")) {
    return { inputPerMillion: 5, outputPerMillion: 15 };
  }
  if (m.includes("thinking")) {
    return { inputPerMillion: 6, outputPerMillion: 22 };
  }
  return DEFAULT_PRICING;
}

export function estimateUsageCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const p = pricingForModel(model);
  const input = (promptTokens / 1_000_000) * p.inputPerMillion;
  const output = (completionTokens / 1_000_000) * p.outputPerMillion;
  return input + output;
}

export function appendProxyUsageLine(
  logPath: string,
  detail: Omit<ProxyUsageRecord, "ts">,
): void {
  const line = `${new Date().toISOString()}${USAGE_PREFIX}${JSON.stringify({
    pathname: detail.pathname,
    model: detail.model,
    promptTokens: detail.promptTokens,
    completionTokens: detail.completionTokens,
  })}\n`;
  try {
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.appendFileSync(logPath, line);
  } catch (err) {
    console.error("Failed to write token usage log:", err);
  }
}

export function recordProxyUsage(
  logPath: string,
  pathname: string,
  model: string | undefined,
  promptTokens: number,
  completionTokens: number,
): void {
  appendProxyUsageLine(logPath, {
    pathname,
    model: model?.trim() || "unknown",
    promptTokens,
    completionTokens,
  });
}

export function recordProxyUsageFromChars(
  logPath: string,
  pathname: string,
  model: string | undefined,
  promptChars: number,
  completionChars: number,
): void {
  const { promptTokens, completionTokens } = estimateTokenCounts(
    promptChars,
    completionChars,
  );
  recordProxyUsage(
    logPath,
    pathname,
    model,
    promptTokens,
    completionTokens,
  );
}

export function parseProxyUsageLine(line: string): ProxyUsageRecord | null {
  const idx = line.indexOf(USAGE_PREFIX);
  if (idx < 0) return null;
  const ts = line.slice(0, idx);
  if (!ts || Number.isNaN(Date.parse(ts))) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(line.slice(idx + USAGE_PREFIX.length));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const o = payload as Record<string, unknown>;
  const promptTokens = Number(o.promptTokens);
  const completionTokens = Number(o.completionTokens);
  if (
    !Number.isFinite(promptTokens) ||
    !Number.isFinite(completionTokens) ||
    promptTokens < 0 ||
    completionTokens < 0
  ) {
    return null;
  }
  const pathname = typeof o.pathname === "string" ? o.pathname : "";
  const model = typeof o.model === "string" ? o.model : "unknown";
  return {
    ts,
    pathname,
    model,
    promptTokens,
    completionTokens,
  };
}

export type AggregatedTokenUsage = {
  requestCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  byModel: Record<
    string,
    {
      requestCount: number;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      estimatedCostUsd: number;
    }
  >;
};

export function aggregateTokenUsage(
  lines: string[],
  hours: number,
): AggregatedTokenUsage {
  const cutoff = Date.now() - hours * 3600_000;
  const out: AggregatedTokenUsage = {
    requestCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    byModel: {},
  };

  for (const line of lines) {
    const usage = parseProxyUsageLine(line);
    if (!usage || Date.parse(usage.ts) < cutoff) continue;

    out.requestCount++;
    out.promptTokens += usage.promptTokens;
    out.completionTokens += usage.completionTokens;
    const total = usage.promptTokens + usage.completionTokens;
    out.totalTokens += total;
    const cost = estimateUsageCostUsd(
      usage.model,
      usage.promptTokens,
      usage.completionTokens,
    );
    out.estimatedCostUsd += cost;

    const bucket =
      out.byModel[usage.model] ??
      (out.byModel[usage.model] = {
        requestCount: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: 0,
      });
    bucket.requestCount++;
    bucket.promptTokens += usage.promptTokens;
    bucket.completionTokens += usage.completionTokens;
    bucket.totalTokens += total;
    bucket.estimatedCostUsd += cost;
  }

  return out;
}
