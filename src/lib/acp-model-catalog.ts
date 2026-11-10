import * as path from "node:path";

import { AcpConnection, type AcpAvailableModel } from "./acp-connection.js";
import { matchCliModelToAcpCatalog } from "./acp-model-match.js";
import type { BridgeConfig } from "./config.js";
import type { CursorCliModel } from "./cursor-cli.js";

const ACP_MODEL_CACHE_TTL_MS = 5 * 60_000;

export type AcpModelCache = { at: number; models: AcpAvailableModel[] };

type AcpModelCacheBucket = {
  current?: AcpModelCache;
  inflight?: Promise<AcpAvailableModel[]>;
};

export type AcpModelCacheRef = {
  buckets: Map<string, AcpModelCacheBucket>;
};

export function createAcpModelCacheRef(): AcpModelCacheRef {
  return { buckets: new Map() };
}

function acpCacheKey(configDir?: string): string {
  return configDir ? path.resolve(configDir) : "";
}

function acpBucketFor(
  cacheRef: AcpModelCacheRef,
  configDir?: string,
): AcpModelCacheBucket {
  const key = acpCacheKey(configDir);
  let bucket = cacheRef.buckets.get(key);
  if (!bucket) {
    bucket = {};
    cacheRef.buckets.set(key, bucket);
  }
  return bucket;
}

function acpSpawnArgs(config: BridgeConfig, workspaceDir: string): string[] {
  const acpIndex = config.acpArgs.indexOf("acp");
  if (acpIndex === -1) {
    return ["--workspace", workspaceDir, ...config.acpArgs];
  }
  return [
    ...config.acpArgs.slice(0, acpIndex),
    "--workspace",
    workspaceDir,
    ...config.acpArgs.slice(acpIndex),
  ];
}

export async function fetchAcpAvailableModels(
  config: BridgeConfig,
  workspaceDir: string,
  configDir?: string,
): Promise<AcpAvailableModel[]> {
  const env = { ...config.acpEnv };
  if (configDir) {
    env.CURSOR_CONFIG_DIR = path.resolve(configDir);
  }
  const connection = new AcpConnection(
    config.acpCommand,
    acpSpawnArgs(config, workspaceDir),
    {
      cwd: workspaceDir,
      env,
      requestTimeoutMs: config.timeoutMs,
      spawnOptions: config.acpSpawnOptions,
    },
  );
  try {
    await connection.initialize();
    if (!config.acpSkipAuthenticate) {
      await connection.authenticate();
    }
    const session = await connection.newSession(workspaceDir, []);
    return session.models?.availableModels ?? [];
  } finally {
    await connection.close().catch(() => undefined);
  }
}

export async function getCachedAcpAvailableModels(
  config: BridgeConfig,
  workspaceDir: string,
  cacheRef: AcpModelCacheRef,
  configDir?: string,
): Promise<AcpAvailableModel[]> {
  const bucket = acpBucketFor(cacheRef, configDir);
  const now = Date.now();
  if (!bucket.current || now - bucket.current.at > ACP_MODEL_CACHE_TTL_MS) {
    if (!bucket.inflight) {
      bucket.inflight = fetchAcpAvailableModels(
        config,
        workspaceDir,
        configDir,
      ).then(
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

/** Keep CLI rows that resolve to a row in the ACP session catalog. */
export function filterCliModelsForAcpCatalog(
  cliModels: readonly CursorCliModel[],
  acpModels: readonly AcpAvailableModel[],
): CursorCliModel[] {
  if (!acpModels.length) return [...cliModels];
  return cliModels.filter(
    (model) =>
      matchCliModelToAcpCatalog(model.id, [model.name], acpModels) !==
      undefined,
  );
}
