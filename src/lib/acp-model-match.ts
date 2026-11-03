export type AcpAvailableModel = { modelId: string; name: string };

const EFFORT_SUFFIXES = [
  "extra-high",
  "xhigh",
  "minimal",
  "medium",
  "high",
  "none",
  "low",
  "max",
] as const;

export type ParsedCliModel = {
  base: string;
  thinking?: boolean;
  effort?: string;
  fast?: boolean;
};

export type ParsedAcpModel = {
  base: string;
  params: Record<string, string>;
};

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}

/** Normalize Claude ids like `claude-4.5-sonnet` → `claude-sonnet-4.5`. */
export function normalizeModelBase(base: string): string {
  const value = normalizeToken(base);
  const reversed = value.match(/^claude-(\d+(?:\.\d+)?)-([a-z0-9-]+)$/);
  if (reversed) return `claude-${reversed[2]}-${reversed[1]}`;
  return value;
}

export function parseCliModelId(modelId: string): ParsedCliModel {
  let value = normalizeToken(modelId);
  let fast: boolean | undefined;

  if (value.endsWith("-fast")) {
    fast = true;
    value = value.slice(0, -5);
  }

  const thinkingMatch = value.match(
    /^(.+)-thinking(?:-(none|minimal|low|medium|high|xhigh|extra-high|max))?$/,
  );
  if (thinkingMatch) {
    return {
      base: thinkingMatch[1],
      thinking: true,
      effort: thinkingMatch[2],
      fast,
    };
  }

  for (const effort of EFFORT_SUFFIXES) {
    if (value.endsWith(`-${effort}`)) {
      return {
        base: value.slice(0, -(effort.length + 1)),
        effort: effort === "extra-high" ? "xhigh" : effort,
        fast,
      };
    }
  }

  return { base: value, fast };
}

export function parseAcpModelId(modelId: string): ParsedAcpModel {
  const trimmed = modelId.trim();
  const bracket = trimmed.match(/^(.+?)\[(.*)\]$/);
  if (!bracket) return { base: trimmed, params: {} };

  const params: Record<string, string> = {};
  for (const part of bracket[2].split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const val = part.slice(eq + 1).trim().toLowerCase();
    if (key) params[key] = val;
  }
  return { base: bracket[1], params };
}

function normalizeDisplayName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\b1m\b/g, "")
    .replace(/\bthinking\b/g, "")
    .replace(/\bextra high\b/g, "")
    .replace(/\b(high|low|medium|minimal|max|none|xhigh)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function acpEffort(params: Record<string, string>): string | undefined {
  return params.effort ?? params.reasoning_effort ?? params.reasoning;
}

function scoreCliToAcp(cli: ParsedCliModel, acp: ParsedAcpModel): number {
  if (normalizeModelBase(cli.base) !== normalizeModelBase(acp.base)) return -1;

  let score = 10;
  if (cli.thinking !== undefined) {
    const acpThinking = acp.params.thinking === "true";
    score += cli.thinking === acpThinking ? 5 : -3;
  }
  if (cli.effort) {
    const effort = acpEffort(acp.params);
    if (effort === cli.effort) score += 5;
    else if (effort) score += 1;
  }
  if (cli.fast !== undefined) {
    const acpFast = acp.params.fast === "true";
    score += cli.fast === acpFast ? 3 : 0;
  }
  return score;
}

export function matchCliModelToAcpCatalog(
  displayName: string,
  aliases: readonly string[],
  availableModels: readonly AcpAvailableModel[],
): AcpAvailableModel | undefined {
  const candidates = new Set(
    [displayName, ...aliases]
      .map((value) => normalizeToken(value))
      .filter(Boolean),
  );

  for (const model of availableModels) {
    const modelId = normalizeToken(model.modelId);
    const baseModelId = modelId.replace(/\[.*$/, "");
    const name = normalizeToken(model.name);
    if (
      candidates.has(name) ||
      candidates.has(modelId) ||
      candidates.has(baseModelId)
    ) {
      return model;
    }
  }

  for (const model of availableModels) {
    const normalizedName = normalizeDisplayName(model.name);
    if (!normalizedName) continue;
    for (const candidate of candidates) {
      if (normalizeDisplayName(candidate) === normalizedName) {
        return model;
      }
    }
  }

  let best: { model: AcpAvailableModel; score: number } | undefined;
  for (const candidate of candidates) {
    const cli = parseCliModelId(candidate);
    for (const model of availableModels) {
      const acp = parseAcpModelId(model.modelId);
      const score = scoreCliToAcp(cli, acp);
      if (score < 0) continue;
      if (!best || score > best.score) {
        best = { model, score };
      }
    }
  }
  return best?.model;
}

export function acpArgsIncludeModel(args: readonly string[]): boolean {
  const index = args.indexOf("--model");
  return index >= 0 && index + 1 < args.length && Boolean(args[index + 1]?.trim());
}

export function shouldRejectUnresolvedAcpModel(args: {
  requested?: string;
  resolved: string;
  strictModel?: boolean;
  modelOnArgv?: boolean;
}): boolean {
  if (!args.strictModel) return false;
  if (args.resolved !== "default[]") return false;
  const requested = args.requested?.trim();
  if (!requested || requested === "default" || requested === "auto") return false;
  if (args.modelOnArgv) return false;
  return true;
}
