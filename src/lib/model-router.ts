import * as http from "node:http";

import type { BridgeConfig } from "./config.js";
import { runAgentSync } from "./agent-runner.js";
import { buildAgentFixedArgs } from "./agent-cmd-args.js";
import { resolveWorkspace } from "./workspace.js";
import {
  loadModelRouterTable,
  type ModelRouterRoute,
  type ModelRouterTable,
} from "./model-router-config.js";
import { getAccountQuotaRemainingRatio } from "./quota-monitor.js";
import { matchAvailableModel } from "./model-map.js";

export type RouteReason =
  | "explicit"
  | "disabled"
  | "quota-low"
  | "quota-unknown"
  | "classified"
  | "classifier-default"
  | "classifier-error"
  | "tool-continuation";

export type RouteDecision = {
  model: string;
  routed: boolean;
  reason: RouteReason;
  remainingRatio?: number | "unknown";
};

export function isModelRoutingEligible(
  requested: string | undefined,
): boolean {
  if (requested === "default") return false;
  if (requested === undefined || requested === "auto") return true;
  return false;
}

const PROMPT_MAX = 4000;

export function extractLastUserPromptText(
  messages: Array<{ role?: string; content?: unknown }>,
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    const text = messageContentToText(m.content);
    if (text.trim()) return text.slice(0, PROMPT_MAX);
  }
  return "";
}

function messageContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (!p || typeof p !== "object") return "";
        const part = p as { type?: string; text?: string };
        if (part.type === "text" && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

/** First concrete Cursor catalog id (excludes session sentinels `auto` / `default`). */
function firstConcreteCatalogId(availableCursorIds: string[]): string | undefined {
  return availableCursorIds.find((id) => {
    const lower = id.toLowerCase();
    return lower !== "auto" && lower !== "default";
  });
}

/**
 * Fallback model for routing when catalog lists `auto` or noComposer hit — never return sentinels.
 */
function resolveConcreteFallbackCatalogId(availableCursorIds: string[]): string {
  return (
    matchAvailableModel("composer-2.5", availableCursorIds) ??
    firstConcreteCatalogId(availableCursorIds) ??
    "composer-2.5"
  );
}

function filterRoutesForCatalog(
  table: ModelRouterTable,
  availableCursorIds: string[],
): ModelRouterRoute[] {
  const out: ModelRouterRoute[] = [];
  for (const route of table.routes) {
    const matched = matchAvailableModel(route.model, availableCursorIds);
    if (matched) {
      out.push({ ...route, model: matched });
    } else {
      console.warn(
        `[model-router] Ignoring route for unknown model "${route.model}"`,
      );
    }
  }
  return out;
}

type ClassifierResult = { route: string; why?: string };

function parseClassifierJson(text: string): ClassifierResult | null {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1]!.trim() : trimmed;
  const jsonMatch = body.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]) as { route?: unknown; why?: unknown };
    if (parsed.route == null) return null;
    return {
      route: String(parsed.route).trim().toLowerCase(),
      why: typeof parsed.why === "string" ? parsed.why : undefined,
    };
  } catch {
    return null;
  }
}

function buildClassifierPrompt(
  defaultModel: string,
  routes: ModelRouterRoute[],
  promptText: string,
): string {
  const lines = [
    "You are a model router. Pick one route. Reply with JSON only: {\"route\":\"<index|default>\",\"why\":\"...\"}",
    `default = routine tasks (${defaultModel})`,
  ];
  routes.forEach((r, i) => {
    lines.push(`${i} = ${r.when} → ${r.model}`);
  });
  lines.push(`Task:\n<<<${promptText}>>>`);
  return lines.join("\n");
}

async function runClassifier(args: {
  config: BridgeConfig;
  configDir?: string;
  classifierModel: string;
  prompt: string;
}): Promise<string | null> {
  const { config, configDir, classifierModel, prompt } = args;
  const effectiveChatOnly = config.chatOnlyWorkspace;
  const { workspaceDir, tempDir } = resolveWorkspace(
    config,
    config.workspace,
    effectiveChatOnly,
  );
  const cmdArgs = buildAgentFixedArgs(
    config,
    workspaceDir,
    classifierModel,
    false,
    "ask",
    effectiveChatOnly,
  );
  const classifierConfig: BridgeConfig = {
    ...config,
    timeoutMs: config.routerTimeoutMs,
    useAcp: false,
    contextPreamble: false,
  };
  try {
    const result = await runAgentSync(
      classifierConfig,
      workspaceDir,
      effectiveChatOnly,
      cmdArgs,
      tempDir,
      prompt,
      configDir,
      undefined,
      `router:${classifierModel}`,
    );
    if (result.code !== 0) {
      const detail = result.stderr?.trim().slice(0, 400) ?? "";
      const sigkillHint =
        /SIGKILL|signal SIGKILL/i.test(detail) || result.code === -1
          ? " (often: classifier timeout — raise CURSOR_BRIDGE_ROUTER_TIMEOUT_MS; or host OOM / cgroup kill)"
          : "";
      console.warn(
        `[model-router] classifier exit ${result.code}${detail ? `: ${detail}` : ""}${sigkillHint}`,
      );
      return null;
    }
    const text = (result.stdout.trim() || result.stderr.trim()) || null;
    if (!text) {
      console.warn("[model-router] classifier returned empty output");
    }
    return text;
  } catch (err) {
    console.warn(
      `[model-router] classifier failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

function resolveRouteIndex(
  parsed: ClassifierResult,
  routeCount: number,
): number | "default" | null {
  const raw = parsed.route;
  if (raw === "default") return "default";
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0 || n >= routeCount) return null;
  return n;
}

export async function routeModel(input: {
  requested?: string;
  promptText: string;
  configDir?: string;
  toolContinuationModel?: string;
  config: BridgeConfig;
  availableCursorIds: string[];
  routerTable?: ModelRouterTable;
}): Promise<RouteDecision> {
  const { config, requested, configDir, promptText, availableCursorIds } =
    input;
  const configuredDefault =
    matchAvailableModel(config.defaultModel, availableCursorIds) ??
    config.defaultModel;

  if (!isModelRoutingEligible(requested)) {
    return {
      model:
        requested === "default"
          ? "default"
          : (requested ?? configuredDefault),
      routed: false,
      reason: "explicit",
    };
  }

  if (input.toolContinuationModel) {
    return {
      model: input.toolContinuationModel,
      routed: false,
      reason: "tool-continuation",
    };
  }

  if (!config.routerEnabled) {
    return { model: configuredDefault, routed: false, reason: "disabled" };
  }

  const table =
    input.routerTable ??
    loadModelRouterTable(config.routerConfigPath);
  const routes = filterRoutesForCatalog(table, availableCursorIds);
  const routineModel = resolveRouterRoutineModel(
    config,
    routes,
    availableCursorIds,
  );
  if (routes.length === 0) {
    return { model: routineModel, routed: false, reason: "disabled" };
  }

  const remaining = await getAccountQuotaRemainingRatio({
    configDir,
    monthlyBudgetUsd: config.routerMonthlyBudgetUsd,
  });

  if (remaining === "unknown") {
    return {
      model: routineModel,
      routed: false,
      reason: "quota-unknown",
      remainingRatio: "unknown",
    };
  }

  if (remaining < config.routerQuotaThreshold) {
    return {
      model: routineModel,
      routed: false,
      reason: "quota-low",
      remainingRatio: remaining,
    };
  }

  const classifierModel = resolveRouterClassifierModel(
    config,
    routes,
    availableCursorIds,
  );
  const classifierPrompt = buildClassifierPrompt(
    classifierModel,
    routes,
    promptText || "(empty)",
  );
  const classifierText = await runClassifier({
    config,
    configDir,
    classifierModel,
    prompt: classifierPrompt,
  });

  if (!classifierText) {
    console.warn(
      `[model-router] classifier-error: no output (routine fallback ${routineModel})`,
    );
    return {
      model: routineModel,
      routed: false,
      reason: "classifier-error",
      remainingRatio: remaining,
    };
  }

  const parsed = parseClassifierJson(classifierText);
  if (!parsed) {
    console.warn(
      `[model-router] classifier-error: invalid JSON in ${classifierText.slice(0, 200)}`,
    );
    return {
      model: routineModel,
      routed: false,
      reason: "classifier-error",
      remainingRatio: remaining,
    };
  }

  const index = resolveRouteIndex(parsed, routes.length);
  if (index === null) {
    console.warn(
      `[model-router] classifier-error: bad route index "${parsed.route}"`,
    );
    return {
      model: routineModel,
      routed: false,
      reason: "classifier-error",
      remainingRatio: remaining,
    };
  }

  if (index === "default") {
    return {
      model: routineModel,
      routed: true,
      reason: "classifier-default",
      remainingRatio: remaining,
    };
  }

  const picked = routes[index]!.model;
  return {
    model: picked,
    routed: true,
    reason: "classified",
    remainingRatio: remaining,
  };
}

export function applyModelRouteHeaders(
  res: http.ServerResponse,
  decision: RouteDecision,
): void {
  for (const [name, value] of Object.entries(
    bridgeRouteResponseHeaders(decision),
  )) {
    res.setHeader(name, value);
  }
}

/** Route metadata for `writeHead` / SSE (must not rely on `setHeader` before `writeHead`). */
export function bridgeRouteResponseHeaders(
  decision: RouteDecision,
): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Bridge-Routed-Model": decision.model,
    "X-Bridge-Route-Reason": decision.reason,
  };
  if (decision.remainingRatio !== undefined) {
    headers["X-Bridge-Quota-Remaining"] =
      decision.remainingRatio === "unknown"
        ? "unknown"
        : String(decision.remainingRatio);
  }
  return headers;
}

/** Final Cursor catalog model id used for the agent run (for logs and web UI). */
export function applyExecutedModelHeader(
  res: http.ServerResponse,
  model: string,
): void {
  for (const [name, value] of Object.entries(
    bridgeExecutedModelHeaders(model),
  )) {
    res.setHeader(name, value);
  }
}

export function bridgeExecutedModelHeaders(
  model: string,
): Record<string, string> {
  const id = model?.trim();
  if (!id) return {};
  return { "X-Bridge-Executed-Model": id };
}

/** Merge executed + optional route headers for SSE/JSON `writeHead`. */
export function bridgeModelResponseHeaders(
  executedModel: string,
  routeDecision?: RouteDecision,
): Record<string, string> {
  return {
    ...(routeDecision ? bridgeRouteResponseHeaders(routeDecision) : {}),
    ...bridgeExecutedModelHeaders(executedModel),
  };
}

/** OpenAI SSE chunk extension for web chat (body carries model when headers are opaque). */
export function bridgeWebStreamMeta(
  executedModel: string,
  routeDecision?: RouteDecision,
): Record<string, unknown> {
  const id = executedModel?.trim();
  if (!id || id === "auto" || id === "default") return {};
  const bridge: Record<string, string> = { executedModel: id };
  if (routeDecision) {
    bridge.routedModel = routeDecision.model;
    bridge.routeReason = routeDecision.reason;
  }
  return { bridge };
}

/**
 * Concrete catalog model for routine tier and routing fallbacks when the
 * configured default is `auto` / `default` (routing-on sentinel).
 */
export function resolveRouterRoutineModel(
  config: BridgeConfig,
  routes: ModelRouterRoute[],
  availableCursorIds: string[],
): string {
  const dm = config.defaultModel?.trim() ?? "";
  if (dm && dm !== "auto" && dm !== "default") {
    const matched = matchAvailableModel(dm, availableCursorIds);
    if (matched && matched !== "auto" && matched !== "default") {
      return matched;
    }
  }
  return resolveRouterClassifierModel(config, routes, availableCursorIds);
}

/**
 * Classifier ask must use a concrete catalog model — not session `auto`/`default`.
 */
export function resolveRouterClassifierModel(
  config: BridgeConfig,
  routes: ModelRouterRoute[],
  availableCursorIds: string[],
): string {
  for (const route of routes) {
    const matched = matchAvailableModel(route.model, availableCursorIds);
    if (matched && matched !== "auto" && matched !== "default") {
      return matched;
    }
  }
  return resolveConcreteFallbackCatalogId(availableCursorIds);
}
