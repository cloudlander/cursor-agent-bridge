import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as path from "node:path";

import type { BridgeConfig } from "../config.js";

export function resolveMcpConfigDir(
  config: BridgeConfig,
  configDir?: string,
): string {
  return (
    configDir ??
    (config.configDirs[0] || path.join(process.env.HOME ?? "", ".cursor"))
  );
}

export function mcpEnableCommand(
  config: BridgeConfig,
  mcpKey: string,
  configDir?: string,
): { bin: string; args: string[]; env: NodeJS.ProcessEnv } {
  const dir = resolveMcpConfigDir(config, configDir);
  return {
    bin: config.agentBin,
    args: ["--workspace", config.workspace, "mcp", "enable", mcpKey],
    env: { ...process.env, CURSOR_CONFIG_DIR: dir },
  };
}

/** CLI exits 0 when the server was already on the approved list. */
export function isMcpEnableSuccess(code: number | null, output: string): boolean {
  if (code === 0) return true;
  const lower = output.toLowerCase();
  return lower.includes("already enabled") || lower.includes("already approved");
}

export function runMcpEnableSync(
  config: BridgeConfig,
  mcpKey: string,
  configDir?: string,
): { ok: boolean; output: string } {
  const { bin, args, env } = mcpEnableCommand(config, mcpKey, configDir);
  const r = spawnSync(bin, args, { env, encoding: "utf8" });
  const output = [r.stdout, r.stderr].filter(Boolean).join("");
  return { ok: isMcpEnableSuccess(r.status, output), output };
}

export async function runMcpEnable(
  config: BridgeConfig,
  mcpKey: string,
  configDir?: string,
): Promise<{ ok: boolean; output: string }> {
  const { bin, args, env } = mcpEnableCommand(config, mcpKey, configDir);
  return new Promise((resolve) => {
    let output = "";
    let child: ChildProcess;
    child = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    const onData = (chunk: Buffer | string) => {
      output += chunk.toString();
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => {
      resolve({ ok: false, output: `${output}${err.message}` });
    });
    child.on("exit", (code) => {
      resolve({ ok: isMcpEnableSuccess(code, output), output });
    });
  });
}

export function isMcpNotApprovedMessage(text: string): boolean {
  return /has not been approved/i.test(text);
}

export function approveMcpKeysAfterDeploy(
  config: BridgeConfig,
  mcpKeys: string[],
): void {
  if (!config.approveMcps || !mcpKeys.length) return;
  const dir = resolveMcpConfigDir(config);
  for (const key of mcpKeys) {
    const { ok, output } = runMcpEnableSync(config, key, dir);
    if (!ok && output.trim()) {
      console.warn(
        `[cursor-api-proxy] MCP enable ${key} after deploy: ${output.trim().slice(0, 500)}`,
      );
    }
  }
}
