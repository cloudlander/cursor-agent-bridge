import { AcpConnection, type AcpAvailableModel } from "./acp-connection.js";
import { matchCliModelToAcpCatalog } from "./acp-model-match.js";
import type { BridgeConfig } from "./config.js";
import type { CursorCliModel } from "./cursor-cli.js";

const ACP_MODEL_CACHE_TTL_MS = 5 * 60_000;

export type AcpModelCache = { at: number; models: AcpAvailableModel[] };
export type AcpModelCacheRef = {
  current?: AcpModelCache;
  inflight?: Promise<AcpAvailableModel[]>;
};

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
): Promise<AcpAvailableModel[]> {
  const connection = new AcpConnection(
    config.acpCommand,
    acpSpawnArgs(config, workspaceDir),
    {
      cwd: workspaceDir,
      env: config.acpEnv,
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
): Promise<AcpAvailableModel[]> {
  const now = Date.now();
  if (
    !cacheRef.current ||
    now - cacheRef.current.at > ACP_MODEL_CACHE_TTL_MS
  ) {
    if (!cacheRef.inflight) {
      cacheRef.inflight = fetchAcpAvailableModels(config, workspaceDir).then(
        (models) => {
          if (models.length > 0) {
            cacheRef.current = { at: Date.now(), models };
          }
          cacheRef.inflight = undefined;
          return models;
        },
        (err) => {
          cacheRef.inflight = undefined;
          throw err;
        },
      );
    }
    await cacheRef.inflight;
  }
  return cacheRef.current?.models ?? [];
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
