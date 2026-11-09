#!/usr/bin/env node
/**
 * Subprocess entry: heavy plugins registry init (git, CLI sync, redeploy).
 * Forked from the bridge so HTTP stays on the main event loop.
 */
import { loadBridgeConfig } from "../config.js";
import { loadEnvConfig } from "../env.js";
import { executePluginsUiInitChild } from "./manager.js";

async function main(): Promise<void> {
  loadEnvConfig({ env: process.env });
  const config = loadBridgeConfig({ env: process.env });
  await executePluginsUiInitChild(config);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("[plugins] init child failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
