/** Context window fill level (ACP `usage_update` or bridge estimate until CLI reports usage). */
export type ContextWindowUsage = {
  used: number;
  size: number;
  cost?: number;
  updatedAt: number;
  /** `acp` when Cursor emitted usage; `estimate` is char-based until then. */
  source?: "acp" | "estimate";
};

const DEFAULT_CONTEXT_WINDOW = 200_000;

function finiteInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.round(value));
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.max(0, Math.round(n));
  }
  return undefined;
}

/** Parse `session/update` payload when `sessionUpdate === "usage_update"`. */
export function parseAcpUsageUpdate(
  update: Record<string, unknown> | undefined,
): ContextWindowUsage | null {
  if (!update) return null;
  const sessionUpdate = update.sessionUpdate;
  if (sessionUpdate !== "usage_update" && update.type !== "usage_update") return null;
  const used = finiteInt(update.used);
  const size = finiteInt(update.size);
  if (used === undefined || size === undefined) return null;
  const costRaw = update.cost;
  const cost =
    typeof costRaw === "number" && Number.isFinite(costRaw) ? costRaw : undefined;
  return { used, size, cost, updatedAt: Date.now(), source: "acp" };
}

/** `session/prompt` result.usage (Cursor may add this before `usage_update` notifications). */
export function parseAcpPromptResultUsage(
  result: Record<string, unknown> | undefined,
  modelId?: string,
): ContextWindowUsage | null {
  if (!result) return null;
  const usage = result.usage;
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const inputTokens = finiteInt(u.inputTokens) ?? finiteInt(u.input_tokens);
  const outputTokens = finiteInt(u.outputTokens) ?? finiteInt(u.output_tokens);
  const cacheRead =
    finiteInt(u.cacheReadTokens) ??
    finiteInt(u.cachedReadTokens) ??
    finiteInt(u.cache_read_tokens);
  const cacheWrite =
    finiteInt(u.cacheWriteTokens) ??
    finiteInt(u.cachedWriteTokens) ??
    finiteInt(u.cache_write_tokens);
  const totalTokens = finiteInt(u.totalTokens) ?? finiteInt(u.total_tokens);
  const used =
    totalTokens ??
    [inputTokens, outputTokens, cacheRead, cacheWrite].reduce<number>(
      (sum, n) => sum + (n ?? 0),
      0,
    );
  if (!used) return null;
  const size = parseContextWindowSizeFromModelId(modelId ?? "") ?? DEFAULT_CONTEXT_WINDOW;
  return {
    used: Math.min(used, size),
    size,
    updatedAt: Date.now(),
    source: "acp",
  };
}

/** Read `context=272k` / `context=1m` from ACP catalog model ids. */
export function parseContextWindowSizeFromModelId(modelId: string): number | undefined {
  const text = modelId.trim();
  if (!text) return undefined;
  const bracket = text.match(/context\s*=\s*(\d+(?:\.\d+)?)\s*([km])?/i);
  if (bracket) {
    return scaleContextTokenCount(bracket[1]!, bracket[2]);
  }
  const standalone = text.match(/(?<![a-z0-9.])(\d+(?:\.\d+)?)\s*([km])(?![a-z0-9])/i);
  if (standalone) {
    return scaleContextTokenCount(standalone[1]!, standalone[2]);
  }
  return undefined;
}

function scaleContextTokenCount(numPart: string, unit?: string): number | undefined {
  const n = Number(numPart);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const u = (unit ?? "").toLowerCase();
  if (u === "m") return Math.round(n * 1_000_000);
  if (u === "k") return Math.round(n * 1000);
  return Math.round(n);
}

type MessageLike = { content?: string; reasoning?: string };

/** Char÷4 estimate for web chat when Cursor CLI does not emit ACP `usage_update`. */
export function estimateContextWindowUsageFromMessages(
  messages: MessageLike[],
  modelId?: string,
): ContextWindowUsage | null {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.content?.trim()) parts.push(m.content);
    if (m.reasoning?.trim()) parts.push(m.reasoning);
  }
  return estimateContextWindowUsageFromText(parts, modelId);
}

export function estimateContextWindowUsageFromText(
  parts: string[],
  modelId?: string,
): ContextWindowUsage | null {
  const chars = parts.reduce((n, t) => n + t.length, 0);
  if (chars <= 0) return null;
  const size = parseContextWindowSizeFromModelId(modelId ?? "") ?? DEFAULT_CONTEXT_WINDOW;
  const used = Math.max(1, Math.round(chars / 4));
  return {
    used: Math.min(used, size),
    size,
    updatedAt: Date.now(),
    source: "estimate",
  };
}

/** Latest usage line in an agent transcript JSONL (if present). */
export function extractContextUsageFromTranscript(content: string): ContextWindowUsage | null {
  const lines = content.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i]!.trim();
    if (!trimmed) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const nested =
      row.update && typeof row.update === "object"
        ? (row.update as Record<string, unknown>)
        : undefined;
    const hit =
      parseAcpUsageUpdate(row) ??
      (nested ? parseAcpUsageUpdate(nested) : null);
    if (hit) return hit;
  }
  return null;
}

export function formatContextTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function contextUsagePercent(usage: ContextWindowUsage): number | null {
  if (usage.size <= 0) return null;
  return Math.min(100, Math.max(0, (usage.used / usage.size) * 100));
}
