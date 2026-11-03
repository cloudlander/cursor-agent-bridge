import * as http from "node:http";

import {
  filterCliModelsForAcpCatalog,
  getCachedAcpAvailableModels,
  type AcpModelCacheRef,
} from "../acp-model-catalog.js";
import type { BridgeConfig } from "../config.js";
import type { CursorCliModel } from "../cursor-cli.js";
import { listCursorCliModels } from "../cursor-cli.js";
import { json } from "../http.js";
import { getAnthropicModelAliases } from "../model-map.js";

const MODEL_CACHE_TTL_MS = 5 * 60_000;

export type ModelCache = { at: number; models: CursorCliModel[] };
export type ModelCacheRef = {
  current?: ModelCache;
  inflight?: Promise<CursorCliModel[]>;
};

export type HandleModelsOpts = {
  config: BridgeConfig;
  modelCacheRef: ModelCacheRef;
  acpModelCacheRef?: AcpModelCacheRef;
  /** When true, drop CLI rows that cannot be mapped to the ACP session catalog. */
  filterForAcpCatalog?: boolean;
};

export async function getCachedCursorModels(
  config: BridgeConfig,
  modelCacheRef: ModelCacheRef,
): Promise<CursorCliModel[]> {
  const now = Date.now();
  if (
    !modelCacheRef.current ||
    now - modelCacheRef.current.at > MODEL_CACHE_TTL_MS
  ) {
    // Deduplicate concurrent fetches — reuse a single in-flight promise
    if (!modelCacheRef.inflight) {
      modelCacheRef.inflight = listCursorCliModels({
        agentBin: config.agentBin,
        timeoutMs: 60_000,
      }).then(
        (models) => {
          // Never cache an empty catalog — usually a parse/env glitch
          // (e.g. colored CLI output) and would poison /v1/models for TTL.
          if (models.length > 0) {
            modelCacheRef.current = { at: Date.now(), models };
          }
          modelCacheRef.inflight = undefined;
          return models;
        },
        (err) => {
          modelCacheRef.inflight = undefined;
          throw err;
        },
      );
    }
    await modelCacheRef.inflight;
  }
  return modelCacheRef.current?.models ?? [];
}

export async function handleModels(
  res: http.ServerResponse,
  opts: HandleModelsOpts,
): Promise<void> {
  const { config, modelCacheRef, acpModelCacheRef, filterForAcpCatalog } = opts;
  let models = await getCachedCursorModels(config, modelCacheRef);
  if (
    filterForAcpCatalog &&
    config.useAcp &&
    config.strictModel &&
    acpModelCacheRef
  ) {
    try {
      const acpModels = await getCachedAcpAvailableModels(
        config,
        config.workspace,
        acpModelCacheRef,
      );
      models = filterCliModelsForAcpCatalog(models, acpModels);
    } catch {
      /* keep full CLI catalog when ACP probe fails */
    }
  }
  const cursorModels = models.map((m) => ({
    id: m.id,
    object: "model" as const,
    owned_by: "cursor" as const,
    name: m.name,
  }));
  const anthropicAliases = getAnthropicModelAliases(
    models.map((m) => m.id),
  ).map((a) => ({
    id: a.id,
    object: "model" as const,
    owned_by: "cursor" as const,
    name: a.name,
  }));

  json(res, 200, {
    object: "list",
    data: [...cursorModels, ...anthropicAliases],
  });
}
