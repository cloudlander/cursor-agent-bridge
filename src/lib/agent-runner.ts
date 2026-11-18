import * as fs from "node:fs";

import { runAcpStream, runAcpSync, type AcpPromptInput } from "./acp-client.js";
import type { ContextWindowUsage } from "./acp-context-usage.js";
import { AcpToolSession } from "./acp-tool-session.js";
import type { BridgeConfig } from "./config.js";
import type { CursorExecutionMode } from "./execution-mode.js";
import { run, runStreaming } from "./process.js";
import type { ClientToolDefinition } from "./tool-types.js";
import { getChatOnlyEnvOverrides } from "./workspace.js";
import { applyAccountCliAuthEnv } from "./account-cli-auth.js";
import { readCursorCliAuth } from "./cursor-account-snapshot.js";
import { createRunConfigDir, type RunConfigDir } from "./run-config-dir.js";
import { syncAccessTokenCacheForAuth } from "./token-cache.js";

function cacheTokenForAccount(configDir?: string): void {
  if (!configDir) return;
  const auth = readCursorCliAuth(configDir);
  syncAccessTokenCacheForAuth(configDir, auth.authId);
}

export type AgentRunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

function acpArgsWithModel(acpArgs: string[], model: string): string[] {
  const i = acpArgs.indexOf("acp");
  if (i === -1) return acpArgs;
  return [...acpArgs.slice(0, i + 1), "--model", model, ...acpArgs.slice(i + 1)];
}

function acpArgsWithMode(acpArgs: string[], mode: CursorExecutionMode): string[] {
  const i = acpArgs.indexOf("acp");
  if (i === -1) return acpArgs;
  // cursor-agent only accepts --mode plan|ask; agent mode is the default.
  if (mode === "agent") return acpArgs;
  return [...acpArgs.slice(0, i + 1), "--mode", mode, ...acpArgs.slice(i + 1)];
}

function acpArgsWithWorkspace(acpArgs: string[], workspaceDir: string): string[] {
  const i = acpArgs.indexOf("acp");
  if (i === -1) return acpArgs;
  return [...acpArgs.slice(0, i), "--workspace", workspaceDir, ...acpArgs.slice(i)];
}

function extractModelFromCmdArgs(cmdArgs: string[]): string | undefined {
  const i = cmdArgs.indexOf("--model");
  return i >= 0 && i + 1 < cmdArgs.length ? cmdArgs[i + 1] : undefined;
}

function extractModeFromCmdArgs(cmdArgs: string[]): CursorExecutionMode {
  const i = cmdArgs.indexOf("--mode");
  const m =
    i >= 0 && i + 1 < cmdArgs.length ? cmdArgs[i + 1] : undefined;
  if (m === "agent" || m === "ask" || m === "plan") return m;
  return "ask";
}

/** Private CLI config for one run. Session files stay out of the account folder. */
function openRunConfig(accountDir?: string): RunConfigDir | undefined {
  if (!accountDir) return undefined;
  return createRunConfigDir(accountDir);
}

function applyRunConfigEnv(
  env: Record<string, string | undefined>,
  workspaceDir: string,
  effectiveChatOnly: boolean,
  accountDir?: string,
  runConfigDir?: string,
): void {
  const cursorConfig = runConfigDir ?? accountDir;
  if (effectiveChatOnly) {
    Object.assign(env, getChatOnlyEnvOverrides(workspaceDir, cursorConfig));
  } else if (cursorConfig) {
    env.CURSOR_CONFIG_DIR = cursorConfig;
  }
  if (accountDir) applyAccountCliAuthEnv(env, accountDir);
  if (runConfigDir) env.CURSOR_CONFIG_DIR = runConfigDir;
}

function acpInvocation(
  config: BridgeConfig,
  workspaceDir: string,
  effectiveChatOnly: boolean,
  cmdArgs: string[],
  configDir?: string,
  runConfigDir?: string,
): {
  args: string[];
  env: Record<string, string | undefined>;
  model?: string;
} {
  const model = extractModelFromCmdArgs(cmdArgs);
  const mode = extractModeFromCmdArgs(cmdArgs);
  let args = acpArgsWithWorkspace(config.acpArgs, workspaceDir);
  args = model ? acpArgsWithModel(args, model) : args;
  args = acpArgsWithMode(args, mode);
  const env = { ...config.acpEnv };
  applyRunConfigEnv(env, workspaceDir, effectiveChatOnly, configDir, runConfigDir);
  return { args, env, model };
}

function releaseAgentRun(
  configDir: string | undefined,
  tempDir: string | undefined,
  runConfig?: RunConfigDir,
): void {
  cacheTokenForAccount(configDir);
  runConfig?.dispose();
  if (!tempDir) return;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function cliEnvOverrides(
  workspaceDir: string,
  effectiveChatOnly: boolean,
  configDir: string | undefined,
  runConfig: RunConfigDir | undefined,
): Record<string, string> | undefined {
  const chat = effectiveChatOnly
    ? getChatOnlyEnvOverrides(workspaceDir, runConfig?.dir ?? configDir)
    : undefined;
  if (!runConfig) return chat;
  return { ...chat, CURSOR_CONFIG_DIR: runConfig.dir };
}

export type AgentPromptInput = string | AcpPromptInput;

function shouldUseAcp(
  config: BridgeConfig,
  prompt: AgentPromptInput | undefined,
): prompt is AgentPromptInput {
  if (prompt === undefined) return false;
  return config.useAcp || Array.isArray(prompt);
}

export function runAgentSync(
  config: BridgeConfig,
  workspaceDir: string,
  effectiveChatOnly: boolean,
  cmdArgs: string[],
  tempDir?: string,
  stdinPrompt?: AgentPromptInput,
  configDir?: string,
  signal?: AbortSignal,
  modelDisplayName?: string,
): Promise<AgentRunResult> {
  const runConfig = openRunConfig(configDir);
  const settle = (out: AgentRunResult) => {
    releaseAgentRun(configDir, tempDir, runConfig);
    return out;
  };
  const fail = (err: unknown) => {
    releaseAgentRun(configDir, tempDir, runConfig);
    throw err;
  };
  try {
    if (shouldUseAcp(config, stdinPrompt)) {
      const invocation = acpInvocation(
        config,
        workspaceDir,
        effectiveChatOnly,
        cmdArgs,
        configDir,
        runConfig?.dir,
      );
      return runAcpSync(config.acpCommand, invocation.args, stdinPrompt, {
        cwd: workspaceDir,
        timeoutMs: config.timeoutMs,
        env: invocation.env,
        model: invocation.model,
        modelAliases: modelDisplayName ? [modelDisplayName] : undefined,
        strictModel: config.strictModel,
        requestTimeoutMs: config.timeoutMs,
        spawnOptions: config.acpSpawnOptions,
        skipAuthenticate: config.acpSkipAuthenticate,
        rawDebug: config.acpRawDebug,
        autoApprovePermissions: config.force,
        signal,
      }).then(settle, fail);
    }
    return run(config.agentBin, cmdArgs, {
      cwd: workspaceDir,
      timeoutMs: config.timeoutMs,
      maxMode: config.maxMode,
      stdinContent: stdinPrompt,
      envOverrides: cliEnvOverrides(
        workspaceDir,
        effectiveChatOnly,
        configDir,
        runConfig,
      ),
      configDir,
      signal,
    }).then(settle, fail);
  } catch (err) {
    releaseAgentRun(configDir, tempDir, runConfig);
    throw err;
  }
}

export type StreamLineHandler = (line: string) => void;

export function runAgentStream(
  config: BridgeConfig,
  workspaceDir: string,
  effectiveChatOnly: boolean,
  cmdArgs: string[],
  onLine: StreamLineHandler,
  tempDir?: string,
  stdinPrompt?: AgentPromptInput,
  configDir?: string,
  signal?: AbortSignal,
  modelDisplayName?: string,
  onThoughtChunk?: StreamLineHandler,
  onContextWindowUsage?: (usage: ContextWindowUsage) => void,
): Promise<{ code: number; stderr: string }> {
  const runConfig = openRunConfig(configDir);
  const settle = (result: { code: number; stderr: string }) => {
    releaseAgentRun(configDir, tempDir, runConfig);
    return result;
  };
  const fail = (err: unknown) => {
    releaseAgentRun(configDir, tempDir, runConfig);
    throw err;
  };
  try {
    if (shouldUseAcp(config, stdinPrompt)) {
      const invocation = acpInvocation(
        config,
        workspaceDir,
        effectiveChatOnly,
        cmdArgs,
        configDir,
        runConfig?.dir,
      );
      return runAcpStream(
        config.acpCommand,
        invocation.args,
        stdinPrompt,
        {
          cwd: workspaceDir,
          timeoutMs: config.timeoutMs,
          env: invocation.env,
          model: invocation.model,
          modelAliases: modelDisplayName ? [modelDisplayName] : undefined,
          strictModel: config.strictModel,
          requestTimeoutMs: config.timeoutMs,
          spawnOptions: config.acpSpawnOptions,
          skipAuthenticate: config.acpSkipAuthenticate,
          rawDebug: config.acpRawDebug,
          autoApprovePermissions: config.force,
          signal,
        },
        onLine,
        onThoughtChunk,
        onContextWindowUsage,
      ).then(settle, fail);
    }
    return runStreaming(config.agentBin, cmdArgs, {
      cwd: workspaceDir,
      timeoutMs: config.timeoutMs,
      maxMode: config.maxMode,
      onLine,
      stdinContent: stdinPrompt,
      envOverrides: cliEnvOverrides(
        workspaceDir,
        effectiveChatOnly,
        configDir,
        runConfig,
      ),
      configDir,
      signal,
    }).then(settle, fail);
  } catch (err) {
    releaseAgentRun(configDir, tempDir, runConfig);
    throw err;
  }
}

export async function startAgentToolSession(opts: {
  config: BridgeConfig;
  workspaceDir: string;
  effectiveChatOnly: boolean;
  cmdArgs: string[];
  prompt: string;
  tools: readonly ClientToolDefinition[];
  tempDir?: string;
  configDir?: string;
  signal?: AbortSignal;
  modelDisplayName?: string;
  requireToolCall?: boolean;
  maxParallelToolCalls?: number;
}): Promise<AcpToolSession> {
  if (!opts.config.useAcp) {
    throw new Error("Structured tool passthrough requires ACP mode");
  }
  const runConfig = openRunConfig(opts.configDir);
  let invocation;
  try {
    invocation = acpInvocation(
      opts.config,
      opts.workspaceDir,
      opts.effectiveChatOnly,
      opts.cmdArgs,
      opts.configDir,
      runConfig?.dir,
    );
  } catch (err) {
    runConfig?.dispose();
    throw err;
  }
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    releaseAgentRun(opts.configDir, opts.tempDir, runConfig);
  };
  const session = new AcpToolSession({
    command: opts.config.acpCommand,
    args: invocation.args,
    cwd: opts.workspaceDir,
    env: invocation.env,
    timeoutMs: opts.config.timeoutMs,
    spawnOptions: opts.config.acpSpawnOptions,
    skipAuthenticate: opts.config.acpSkipAuthenticate,
    rawDebug: opts.config.acpRawDebug,
    signal: opts.signal,
    modelCandidates: [
      invocation.model,
      opts.modelDisplayName,
    ].filter((value): value is string => Boolean(value)),
    strictModel: opts.config.strictModel,
    tools: opts.tools,
    requireToolCall: opts.requireToolCall,
    maxParallelToolCalls: opts.maxParallelToolCalls,
    autoApprovePermissions: opts.config.force,
    onClose: cleanup,
  });
  try {
    await session.start(opts.prompt);
    return session;
  } catch (error) {
    cleanup();
    throw error;
  }
}
