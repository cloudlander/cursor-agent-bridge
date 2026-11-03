import { randomUUID } from "node:crypto";
import * as http from "node:http";

import type { BridgeConfig } from "../config.js";
import type { CursorExecutionMode } from "../execution-mode.js";
import type { ModelCacheRef } from "./models.js";
import { getCachedCursorModels } from "./models.js";
import { buildAgentFixedArgs } from "../agent-cmd-args.js";
import { runAgentStream, runAgentSync } from "../agent-runner.js";
import { createStreamParser } from "../cli-stream-parser.js";
import { createGuardedAssistantTextEmitter } from "../assistant-stream-dedupe.js";
import { json, startSseKeepalive, writeSseHeaders } from "../http.js";
import {
  resolveModelForExecution,
  UnsupportedReasoningEffortError,
} from "../model-map.js";
import {
  buildAgentPromptForCompletion,
  isTokenizedCompletionPrompt,
  normalizeCompletionOutput,
  normalizeCompletionPrompt,
  normalizeModelId,
  type OpenAiCompletionRequest,
} from "../openai.js";
import {
  logAgentError,
  logAccountAssigned,
  logAccountStats,
  logModelResolution,
  logTrafficRequest,
  logTrafficResponse,
} from "../request-log.js";
import { recordProxyUsage } from "../token-usage.js";
import { rememberResolvedModel, resolveModel } from "../resolve-model.js";
import { parseExecutionModeFromRequest } from "../execution-mode.js";
import { resolveWorkspace } from "../workspace.js";
import {
  buildBridgeContextPreamble,
  BRIDGE_AGENT_PROMPT_SEPARATOR,
} from "../bridge-context-preamble.js";
import {
  getNextAccountConfigDir,
  reportRequestStart,
  reportRequestEnd,
  reportRateLimit,
  reportRequestSuccess,
  reportRequestError,
  getAccountStats,
} from "../account-pool.js";
import { abortOnClientDisconnect } from "../client-disconnect.js";
import {
  fitPromptToWinCmdline,
  warnPromptTruncated,
} from "../win-cmdline-limit.js";

function isRateLimited(stderr: string): boolean {
  return /\b429\b|rate.?limit|too many requests/i.test(stderr);
}

export type CompletionsCtx = {
  config: BridgeConfig;
  lastRequestedModelRef: { current?: string };
  modelCacheRef: ModelCacheRef;
};

function resolveCompletionMode(
  config: BridgeConfig,
  headerMode: string | string[] | undefined,
  bodyMode: unknown,
): CursorExecutionMode {
  if (bodyMode !== undefined && bodyMode !== null) {
    if (typeof bodyMode !== "string") {
      throw new Error("Request body mode must be a string");
    }
    if (bodyMode.trim()) {
      return parseExecutionModeFromRequest(bodyMode, "body.mode");
    }
  }
  const h = Array.isArray(headerMode) ? headerMode[0] : headerMode;
  if (typeof h === "string" && h.trim()) {
    return parseExecutionModeFromRequest(h, "X-Cursor-Mode header");
  }
  return "ask";
}

function writeTextCompletionChunk(
  res: http.ServerResponse,
  meta: { id: string; created: number; model: string | undefined },
  text: string,
  finishReason: string | null,
  usage?: Record<string, number>,
) {
  res.write(
    `data: ${JSON.stringify({
      id: meta.id,
      object: "text_completion",
      created: meta.created,
      model: meta.model,
      choices: [
        {
          text,
          index: 0,
          logprobs: null,
          finish_reason: finishReason,
        },
      ],
      ...(usage ? { usage } : {}),
    })}\n\n`,
  );
}

export async function handleCompletions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: CompletionsCtx,
  rawBody: string,
  method: string,
  pathname: string,
  remoteAddress: string,
): Promise<void> {
  const { config, lastRequestedModelRef, modelCacheRef } = ctx;
  const body = JSON.parse(rawBody || "{}") as OpenAiCompletionRequest;

  if (isTokenizedCompletionPrompt(body.prompt)) {
    json(res, 400, {
      error: {
        message:
          "Token id prompts are not supported; pass a string prompt (UTF-8 code context).",
        code: "unsupported_prompt",
        type: "invalid_request_error",
      },
    });
    return;
  }

  const prefix = normalizeCompletionPrompt(body.prompt);
  if (prefix === undefined) {
    json(res, 400, {
      error: {
        message: "Missing or empty `prompt` field.",
        code: "missing_prompt",
        type: "invalid_request_error",
      },
    });
    return;
  }

  const requested = normalizeModelId(body.model);
  const model = resolveModel(requested, lastRequestedModelRef, config);
  const models = await getCachedCursorModels(config, modelCacheRef);
  let decision;
  try {
    decision = resolveModelForExecution({
      requested: model,
      defaultModel: config.defaultModel,
      availableCursorIds: models.map((m) => m.id),
      reasoningEffort: body.reasoning_effort,
    });
  } catch (error) {
    if (!(error instanceof UnsupportedReasoningEffortError)) throw error;
    json(res, 400, {
      error: {
        message: error.message,
        code: error.code,
        type: "invalid_request_error",
      },
    });
    return;
  }

  const cursorModel = decision.final;
  rememberResolvedModel(cursorModel, lastRequestedModelRef);
  logModelResolution(config.verbose, decision);
  const displayModel =
    decision.requestedWasDefault && config.defaultModel !== "default"
      ? config.defaultModel
      : model;
  const modelCatalogName = models.find(
    (item) => item.id === cursorModel,
  )?.name;

  const id = `cmpl_${randomUUID().replace(/-/g, "")}`;
  const created = Math.floor(Date.now() / 1000);

  let mode: CursorExecutionMode;
  try {
    mode = resolveCompletionMode(config, req.headers["x-cursor-mode"], body.mode);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Invalid mode";
    json(res, 400, { error: { message: msg, code: "invalid_mode" } });
    return;
  }

  const completionPrompt = buildAgentPromptForCompletion({
    prefix,
    suffix: body.suffix,
    stop: body.stop,
    maxTokens: body.max_tokens,
  });

  const effectiveChatOnly =
    mode === "ask"
      ? config.chatOnlyWorkspace
      : config.chatOnlyWorkspaceExplicit && config.chatOnlyWorkspace;

  const headerWs = req.headers["x-cursor-workspace"];
  let workspaceDir: string;
  let tempDir: string | undefined;
  try {
    const ws = resolveWorkspace(config, headerWs, effectiveChatOnly);
    workspaceDir = ws.workspaceDir;
    tempDir = ws.tempDir;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Invalid workspace";
    json(res, 400, { error: { message: msg, code: "invalid_workspace" } });
    return;
  }

  const agentPrompt = config.contextPreamble
    ? `${buildBridgeContextPreamble({
        headers: req.headers,
        bridgeWorkspaceBase: config.workspace,
        agentWorkspaceDir: workspaceDir,
        isolatedChatOnly: tempDir !== undefined,
        cursorMode: mode,
        contextExtra: config.contextExtra,
      })}${BRIDGE_AGENT_PROMPT_SEPARATOR}${completionPrompt}`
    : completionPrompt;

  logTrafficRequest(config.verbose, config.verboseFull, model ?? cursorModel, [
    { role: "user", content: `[completion prefix ${prefix.length} chars]` },
  ], !!body.stream);

  const fixedArgs = buildAgentFixedArgs(
    config,
    workspaceDir,
    cursorModel,
    !!body.stream,
    mode,
    effectiveChatOnly,
  );
  const fit = fitPromptToWinCmdline(config.agentBin, fixedArgs, agentPrompt, {
    maxCmdline: config.winCmdlineMax,
    platform: process.platform,
    cwd: workspaceDir,
  });
  if (!fit.ok) {
    json(res, 500, {
      error: {
        message: fit.error,
        code: "windows_cmdline_limit",
        type: "api_error",
      },
    });
    return;
  }
  if (fit.truncated) {
    warnPromptTruncated(fit.originalLength, fit.finalPromptLength);
  }

  const cmdArgs =
    config.promptViaStdin || config.useAcp ? fixedArgs : fit.args;
  const promptForAgent =
    config.promptViaStdin || config.useAcp ? agentPrompt : undefined;
  const truncatedHeaders = fit.truncated
    ? { "X-Cursor-Proxy-Prompt-Truncated": "true" }
    : undefined;

  const streamMeta = { id, created, model: displayModel };

  if (body.stream) {
    const configDir = getNextAccountConfigDir();
    logAccountAssigned(configDir);
    reportRequestStart(configDir);
    const streamStart = Date.now();

    const abortController = new AbortController();
    abortOnClientDisconnect(res, abortController);

    writeSseHeaders(res, truncatedHeaders);
    const stopKeepalive = startSseKeepalive(res);

    let accumulated = "";
    const pushAssistantText = createGuardedAssistantTextEmitter((text) => {
      accumulated += text;
      writeTextCompletionChunk(res, streamMeta, text, null);
    });
    const parseLine = createStreamParser(
      pushAssistantText,
      () => {
        const completionText = normalizeCompletionOutput(accumulated, prefix);
        const echoed = body.echo ? prefix + completionText : completionText;
        logTrafficResponse(
          config.verbose,
          config.verboseFull,
          model ?? cursorModel,
          echoed,
          true,
        );
        const promptTokens = Math.max(1, Math.round(agentPrompt.length / 4));
        const completionTokens = Math.max(1, Math.round(echoed.length / 4));
        recordProxyUsage(
          config.sessionsLogPath,
          pathname,
          displayModel ?? cursorModel,
          promptTokens,
          completionTokens,
        );
        writeTextCompletionChunk(res, streamMeta, "", "stop", {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        });
        res.write("data: [DONE]\n\n");
      },
    );

    runAgentStream(
      config,
      workspaceDir,
      effectiveChatOnly,
      cmdArgs,
      parseLine,
      tempDir,
      promptForAgent,
      configDir,
      abortController.signal,
      modelCatalogName,
    )
      .then(({ code, stderr: stderrOut }) => {
        stopKeepalive();
        const latencyMs = Date.now() - streamStart;
        reportRequestEnd(configDir);

        if (stderrOut && isRateLimited(stderrOut)) {
          reportRateLimit(configDir, 60000);
        }

        if (abortController.signal.aborted) {
          /* client disconnected */
        } else if (code !== 0) {
          reportRequestError(configDir, latencyMs);
          logAgentError(
            config.sessionsLogPath,
            method,
            pathname,
            remoteAddress,
            code,
            stderrOut,
          );
        } else {
          reportRequestSuccess(configDir, latencyMs);
        }
        logAccountStats(config.verbose, getAccountStats());
        res.end();
      })
      .catch((err) => {
        stopKeepalive();
        reportRequestEnd(configDir);
        if (!abortController.signal.aborted) {
          reportRequestError(configDir, Date.now() - streamStart);
        }
        console.error(
          `[${new Date().toISOString()}] Agent stream error:`,
          err,
        );
        res.end();
      });
    return;
  }

  const configDir = getNextAccountConfigDir();
  logAccountAssigned(configDir);
  reportRequestStart(configDir);
  const syncStart = Date.now();

  const abortController = new AbortController();
  abortOnClientDisconnect(res, abortController);

  const out = await runAgentSync(
    config,
    workspaceDir,
    effectiveChatOnly,
    cmdArgs,
    tempDir,
    promptForAgent,
    configDir,
    abortController.signal,
    modelCatalogName,
  );
  const syncLatency = Date.now() - syncStart;
  reportRequestEnd(configDir);

  if (out.stderr && isRateLimited(out.stderr)) {
    reportRateLimit(configDir, 60000);
  }

  if (out.code !== 0) {
    reportRequestError(configDir, syncLatency);
    logAccountStats(config.verbose, getAccountStats());
    const errMsg = logAgentError(
      config.sessionsLogPath,
      method,
      pathname,
      remoteAddress,
      out.code,
      out.stderr,
    );
    json(res, 500, {
      error: { message: errMsg, code: "cursor_cli_error" },
    });
    return;
  }

  reportRequestSuccess(configDir, syncLatency);
  const completionText = normalizeCompletionOutput(out.stdout.trim(), prefix);
  const choiceText = body.echo ? prefix + completionText : completionText;
  logTrafficResponse(config.verbose, config.verboseFull, model ?? cursorModel, choiceText, false);

  const promptTokens = Math.max(1, Math.round(agentPrompt.length / 4));
  const completionTokens = Math.max(1, Math.round(choiceText.length / 4));
  recordProxyUsage(
    config.sessionsLogPath,
    pathname,
    displayModel ?? cursorModel,
    promptTokens,
    completionTokens,
  );

  logAccountStats(config.verbose, getAccountStats());
  json(res, 200, {
    id,
    object: "text_completion",
    created,
    model: displayModel,
    choices: [
      {
        text: choiceText,
        index: 0,
        logprobs: null,
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  });
}
