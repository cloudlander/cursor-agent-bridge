import * as path from "node:path";

import type { BridgeConfig } from "./config.js";
import { configDirsForAccountUsage } from "./cursor-account-snapshot.js";

/** Absolute config dirs the bridge may use for Cursor CLI auth. */
export function allowedAccountConfigDirs(config: BridgeConfig): string[] {
  return configDirsForAccountUsage(config.configDirs).map((d) =>
    path.resolve(d),
  );
}

/** Resolve a client-supplied dir when it is in the allowed set. */
export function resolveAllowedAccountConfigDir(
  config: BridgeConfig,
  raw: string,
): string | undefined {
  const target = path.resolve(raw.trim());
  return allowedAccountConfigDirs(config).find((d) => d === target);
}

/** Web chat: requires an explicit allowed account (no pool rotation). */
export function pickAccountConfigDirForChat(
  config: BridgeConfig,
  explicit?: string,
): string | undefined {
  const trimmed = explicit?.trim();
  if (!trimmed) return undefined;
  return resolveAllowedAccountConfigDir(config, trimmed);
}
