import * as http from "node:http";
import * as path from "node:path";

import {
  allowedAccountConfigDirs,
  resolveAllowedAccountConfigDir,
} from "../account-config-dir.js";
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

type ModelCacheBucket = {
  current?: ModelCache;
  inflight?: Promise<CursorCliModel[]>;
};

export type ModelCacheRef = {
  /** Keyed by resolved config dir path; `""` is the default CLI environment. */
  buckets: Map<string, ModelCacheBucket>;
};

export function createModelCacheRef(): ModelCacheRef {
  return { buckets: new Map() };
}

function modelCacheKey(configDir?: string): string {
  return configDir ? path.resolve(configDir) : "";
}

function bucketFor(
  modelCacheRef: ModelCacheRef,
  configDir?: string,
): ModelCacheBucket {
  const key = modelCacheKey(configDir);
  let bucket = modelCacheRef.buckets.get(key);
  if (!bucket) {
    bucket = {};
    modelCacheRef.buckets.set(key, bucket);
  }
  return bucket;
}

export type HandleModelsOpts = {
  config: BridgeConfig;
  modelCacheRef: ModelCacheRef;
  acpModelCacheRef?: AcpModelCacheRef;
  /** When true, drop CLI rows that cannot be mapped to the ACP session catalog. */
  filterForAcpCatalog?: boolean;
  /** List models for a specific account config directory (web chat). */
  configDir?: string;
};

export async function getCachedCursorModels(
  config: BridgeConfig,
  modelCacheRef: ModelCacheRef,
  configDir?: string,
): Promise<CursorCliModel[]> {
  const bucket = bucketFor(modelCacheRef, configDir);
  const now = Date.now();
  if (!bucket.current || now - bucket.current.at > MODEL_CACHE_TTL_MS) {
    if (!bucket.inflight) {
      bucket.inflight = listCursorCliModels({
        agentBin: config.agentBin,
        timeoutMs: 60_000,
        configDir: configDir ? path.resolve(configDir) : undefined,
      }).then(
        (models) => {
          if (models.length > 0) {
            bucket.current = { at: Date.now(), models };
          }
          bucket.inflight = undefined;
          return models;
        },
        (err) => {
          bucket.inflight = undefined;
          throw err;
        },
      );
    }
    await bucket.inflight;
  }
  return bucket.current?.models ?? [];
}

/** Parse optional `configDir` query for GET /api/agent/models. */
export function parseModelsConfigDirQuery(
  config: BridgeConfig,
  raw: string | null,
): { configDir?: string; error?: string } {
  if (raw == null || raw === "") return {};
  const resolved = resolveAllowedAccountConfigDir(config, raw);
  if (!resolved) {
    const allowed = allowedAccountConfigDirs(config);
    if (allowed.length === 0) {
      return { error: "No account directories configured" };
    }
    return { error: "Unknown configDir" };
  }
  return { configDir: resolved };
}

export async function handleModels(
  res: http.ServerResponse,
  opts: HandleModelsOpts,
): Promise<void> {
  const {
    config,
    modelCacheRef,
    acpModelCacheRef,
    filterForAcpCatalog,
    configDir,
  } = opts;
  let models = await getCachedCursorModels(config, modelCacheRef, configDir);
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
        configDir,
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
