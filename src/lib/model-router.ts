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
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
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
    if (result.code !== 0) return null;
    return result.stdout.trim() || null;
  } catch {
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
  const defaultModel =
    matchAvailableModel(config.defaultModel, availableCursorIds) ??
    config.defaultModel;

  if (!isModelRoutingEligible(requested)) {
    return {
      model: requested === "default" ? "default" : (requested ?? defaultModel),
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
    return { model: defaultModel, routed: false, reason: "disabled" };
  }

  const table =
    input.routerTable ??
    loadModelRouterTable(config.routerConfigPath);
  const routes = filterRoutesForCatalog(table, availableCursorIds);
  if (routes.length === 0) {
    return { model: defaultModel, routed: false, reason: "disabled" };
  }

  const remaining = await getAccountQuotaRemainingRatio({
    configDir,
    monthlyBudgetUsd: config.routerMonthlyBudgetUsd,
  });

  if (remaining === "unknown") {
    return {
      model: defaultModel,
      routed: false,
      reason: "quota-unknown",
      remainingRatio: "unknown",
    };
  }

  if (remaining < config.routerQuotaThreshold) {
    return {
      model: defaultModel,
      routed: false,
      reason: "quota-low",
      remainingRatio: remaining,
    };
  }

  const classifierModel =
    matchAvailableModel(config.defaultModel, availableCursorIds) ??
    defaultModel;
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
    return {
      model: defaultModel,
      routed: false,
      reason: "classifier-error",
      remainingRatio: remaining,
    };
  }

  const parsed = parseClassifierJson(classifierText);
  if (!parsed) {
    return {
      model: defaultModel,
      routed: false,
      reason: "classifier-error",
      remainingRatio: remaining,
    };
  }

  const index = resolveRouteIndex(parsed, routes.length);
  if (index === null) {
    return {
      model: defaultModel,
      routed: false,
      reason: "classifier-error",
      remainingRatio: remaining,
    };
  }

  if (index === "default") {
    return {
      model: defaultModel,
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
  res.setHeader("X-Bridge-Routed-Model", decision.model);
  res.setHeader("X-Bridge-Route-Reason", decision.reason);
  if (decision.remainingRatio !== undefined) {
    res.setHeader(
      "X-Bridge-Quota-Remaining",
      decision.remainingRatio === "unknown"
        ? "unknown"
        : String(decision.remainingRatio),
    );
  }
}

/** Final Cursor catalog model id used for the agent run (for logs and web UI). */
export function applyExecutedModelHeader(
  res: http.ServerResponse,
  model: string,
): void {
  const id = model?.trim();
  if (id) res.setHeader("X-Bridge-Executed-Model", id);
}
