import type { BridgeConfig } from "./config.js";
import { getNextAccountConfigDir } from "./account-pool.js";
import {
  extractLastUserPromptText,
  isModelRoutingEligible,
  routeModel,
  type RouteDecision,
} from "./model-router.js";
import { resolveModel } from "./resolve-model.js";

export type ModelRoutingFlowResult = {
  configDir: string | undefined;
  model: string;
  skipSessionMemory: boolean;
  rememberModel: boolean;
  routeDecision?: RouteDecision;
};

export async function resolveModelWithOptionalRouting(args: {
  config: BridgeConfig;
  requested: string | undefined;
  lastRequestedModelRef: { current?: string };
  messages: Array<{ role?: string; content?: unknown }>;
  availableCursorIds: string[];
  toolContinuationModel?: string;
  /** Pre-selected account (e.g. tool session resume). */
  configDir?: string;
}): Promise<ModelRoutingFlowResult> {
  const {
    config,
    requested,
    lastRequestedModelRef,
    messages,
    availableCursorIds,
    toolContinuationModel,
  } = args;

  const routingEligible =
    config.routerEnabled && isModelRoutingEligible(requested);
  const configDir =
    args.configDir ??
    (config.configDirs.length > 0 ? getNextAccountConfigDir() : undefined);

  let routeDecision: RouteDecision | undefined;
  let resolvedInput = requested;

  if (toolContinuationModel) {
    resolvedInput = toolContinuationModel;
  } else if (routingEligible) {
    routeDecision = await routeModel({
      requested,
      promptText: extractLastUserPromptText(messages),
      configDir,
      config,
      availableCursorIds,
    });
    resolvedInput = routeDecision.model;
  }

  const skipSessionMemory = routingEligible;
  const model = resolveModel(resolvedInput, lastRequestedModelRef, config, {
    skipSessionMemory,
  });

  return {
    configDir,
    model,
    skipSessionMemory,
    rememberModel: !skipSessionMemory,
    routeDecision,
  };
}
