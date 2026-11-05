import { randomUUID } from "node:crypto";
import * as http from "node:http";

import type { BridgeConfig } from "../config.js";
import type { CursorExecutionMode } from "../execution-mode.js";
import type { ModelCacheRef } from "./models.js";
import { getCachedCursorModels } from "./models.js";
import { buildAgentFixedArgs } from "../agent-cmd-args.js";
import {
  runAgentStream,
  runAgentSync,
  startAgentToolSession,
} from "../agent-runner.js";
import type { ToolTurnEvent, ToolTurnResult } from "../acp-tool-session.js";
import { createStreamParser } from "../cli-stream-parser.js";
import { createGuardedAssistantTextEmitter } from "../assistant-stream-dedupe.js";
import { json, startSseKeepalive, writeSseHeaders } from "../http.js";
import {
  resolveModelForExecution,
  UnsupportedReasoningEffortError,
} from "../model-map.js";
import {
  buildPromptFromMessages,
  normalizeModelId,
  toolsToSystemText,
  type OpenAiChatCompletionRequest,
} from "../openai.js";
import {
  logAgentError,
  logAccountAssigned,
  logAccountStats,
  logModelResolution,
  logModelRoute,
  logTrafficRequest,
  logTrafficResponse,
  type TrafficMessage,
} from "../request-log.js";
import { recordProxyUsage } from "../token-usage.js";
import { rememberResolvedModel, resolveModel } from "../resolve-model.js";
import { applyModelRouteHeaders } from "../model-router.js";
import { resolveModelWithOptionalRouting } from "../model-routing-flow.js";
import { resolveRequestMode } from "../resolve-mode.js";
import { resolveWorkspace } from "../workspace.js";
import { buildBridgeContextPreamble, BRIDGE_AGENT_PROMPT_SEPARATOR } from "../bridge-context-preamble.js";
import { sanitizeMessages } from "../sanitize.js";
import { normalizeAssistantReplyText } from "../assistant-text-dedupe.js";
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
import {
  chatToolOutputs,
  parseOpenAiFunctionTools,
  resolveToolChoice,
  type PendingClientToolCall,
} from "../tool-types.js";
import { recordApiSession, syncWebThreadFromChatRequest } from "../chat-store.js";
import {
  ToolSessionError,
  toolSessionOwnerKey,
  type ToolSessionRecord,
  type ToolSessionRegistry,
} from "../tool-session-registry.js";
import {
  appendWebGenerationDelta,
  detachWebChatClient,
  finishWebGeneration,
  startWebGeneration,
  writeGenerationSse,
} from "../web-chat-generation.js";
import {
  buildMultimodalAcpPrompt,
  messagesHaveMultimodalContent,
} from "../chat-attachments.js";
import type { AcpPromptBlock } from "../acp-client.js";

function maybeRecordProxyChatSession(
  config: BridgeConfig,
  pathname: string,
  trafficMessages: TrafficMessage[],
  assistantText: string,
  model?: string,
  mode?: CursorExecutionMode,
): void {
  if (pathname === "/api/agent/chat" || !assistantText.trim()) return;
  void recordApiSession(config, {
    api: "chat",
    apiPath: pathname,
    model,
    mode,
    messages: trafficMessages,
    assistantText,
  }).catch(() => undefined);
}

function isRateLimited(stderr: string): boolean {
  return /\b429\b|rate.?limit|too many requests/i.test(stderr);
}

/** OpenAI streaming: first chunk should carry `delta.role` so clients init one assistant message. */
function createChatCompletionChunkWriter(
  res: http.ServerResponse,
  meta: { id: string; created: number; model: string | undefined },
) {
  let roleSent = false;
  let wireDeltaChars = 0;
  const write = (contentDelta: string) => {
    if (!contentDelta) return;
    wireDeltaChars += contentDelta.length;
    if (!roleSent) {
      roleSent = true;
      res.write(
        `data: ${JSON.stringify({
          id: meta.id,
          object: "chat.completion.chunk",
          created: meta.created,
          model: meta.model,
          choices: [
            { index: 0, delta: { role: "assistant" }, finish_reason: null },
          ],
        })}\n\n`,
      );
    }
    res.write(
      `data: ${JSON.stringify({
        id: meta.id,
        object: "chat.completion.chunk",
        created: meta.created,
        model: meta.model,
        choices: [
          { index: 0, delta: { content: contentDelta }, finish_reason: null },
        ],
      })}\n\n`,
    );
  };
  return { write, wireDeltaChars: () => wireDeltaChars };
}

export type ChatCompletionsCtx = {
  config: BridgeConfig;
  lastRequestedModelRef: { current?: string };
  modelCacheRef: ModelCacheRef;
  toolSessions: ToolSessionRegistry;
};

function chatToolCallWire(calls: readonly PendingClientToolCall[]) {
  return calls.map((call) => ({
    id: call.callId,
    type: "function" as const,
    function: { name: call.name, arguments: call.arguments },
  }));
}

function chatToolResponse(opts: {
  id: string;
  created: number;
  model: string | undefined;
  result: ToolTurnResult;
  promptLength: number;
}) {
  const completionText = normalizeAssistantReplyText(opts.result.text);
  const promptTokens = Math.max(1, Math.round(opts.promptLength / 4));
  const completionTokens = Math.max(
    1,
    Math.round(completionText.length / 4),
  );
  const calls =
    opts.result.status === "tool_calls"
      ? chatToolCallWire(opts.result.toolCalls)
      : undefined;
  return {
    id: opts.id,
    object: "chat.completion",
    created: opts.created,
    model: opts.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: completionText || (calls ? null : ""),
          ...(opts.result.reasoning
            ? { reasoning_content: opts.result.reasoning }
            : {}),
          ...(calls ? { tool_calls: calls } : {}),
        },
        finish_reason: calls ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

async function writeStructuredChatTurn(opts: {
  res: http.ServerResponse;
  stream: boolean;
  id: string;
  created: number;
  model: string | undefined;
  promptLength: number;
  usageLogPath?: string;
  usagePathname?: string;
  run: (
    listener?: (event: ToolTurnEvent) => void,
  ) => Promise<ToolTurnResult>;
}): Promise<ToolTurnResult> {
  if (!opts.stream) {
    const result = await opts.run();
    const body = chatToolResponse({
      id: opts.id,
      created: opts.created,
      model: opts.model,
      result,
      promptLength: opts.promptLength,
    });
    if (opts.usageLogPath && opts.usagePathname) {
      recordProxyUsage(
        opts.usageLogPath,
        opts.usagePathname,
        opts.model,
        body.usage.prompt_tokens,
        body.usage.completion_tokens,
      );
    }
    json(opts.res, 200, body);
    return result;
  }

  writeSseHeaders(opts.res);
  const stopKeepalive = startSseKeepalive(opts.res);
  try {
    const writeChunk = (
      delta: Record<string, unknown>,
      finishReason: string | null = null,
      usage?: Record<string, number>,
    ) => {
      opts.res.write(
        `data: ${JSON.stringify({
          id: opts.id,
          object: "chat.completion.chunk",
          created: opts.created,
          model: opts.model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
          ...(usage ? { usage } : {}),
        })}\n\n`,
      );
    };
    writeChunk({ role: "assistant" });
    let emittedText = "";
    let emittedReasoning = "";
    const result = await opts.run((event) => {
      if (event.type === "text") {
        emittedText += event.text;
        writeChunk({ content: event.text });
      } else {
        emittedReasoning += event.text;
        writeChunk({ reasoning_content: event.text });
      }
    });
    if (result.reasoning.length > emittedReasoning.length) {
      writeChunk({
        reasoning_content: result.reasoning.slice(emittedReasoning.length),
      });
    }
    const normalizedText = normalizeAssistantReplyText(result.text);
    if (normalizedText.length > emittedText.length) {
      writeChunk({ content: normalizedText.slice(emittedText.length) });
    }
    if (result.status === "tool_calls") {
      result.toolCalls.forEach((call, index) => {
        writeChunk({
          tool_calls: [
            {
              index,
              id: call.callId,
              type: "function",
              function: { name: call.name, arguments: call.arguments },
            },
          ],
        });
      });
    }
    const promptTokens = Math.max(1, Math.round(opts.promptLength / 4));
    const completionTokens = Math.max(
      1,
      Math.round(normalizedText.length / 4),
    );
    writeChunk(
      {},
      result.status === "tool_calls" ? "tool_calls" : "stop",
      {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    );
    if (opts.usageLogPath && opts.usagePathname) {
      recordProxyUsage(
        opts.usageLogPath,
        opts.usagePathname,
        opts.model,
        promptTokens,
        completionTokens,
      );
    }
    opts.res.write("data: [DONE]\n\n");
    opts.res.end();
    return result;
  } finally {
    stopKeepalive();
  }
}

export async function handleChatCompletions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ChatCompletionsCtx,
  rawBody: string,
  method: string,
  pathname: string,
  remoteAddress: string,
): Promise<void> {
  const { config, lastRequestedModelRef, modelCacheRef } = ctx;
  const body = JSON.parse(rawBody || "{}") as OpenAiChatCompletionRequest;
  let selectedTools;
  let toolInstruction: string | undefined;
  let requireToolCall = false;
  let maxParallelToolCalls: number | undefined;
  let submittedToolOutputs;
  try {
    const parsedTools = parseOpenAiFunctionTools(body.tools, body.functions);
    const choice = resolveToolChoice(
      parsedTools,
      body.tool_choice ?? body.function_call,
      {
      parallelToolCalls: (body as any).parallel_tool_calls,
      },
    );
    selectedTools = choice.tools;
    toolInstruction = choice.instruction;
    requireToolCall = choice.required;
    maxParallelToolCalls = choice.maxParallelToolCalls;
    submittedToolOutputs = chatToolOutputs(body.messages ?? []);
  } catch (error) {
    json(res, 400, {
      error: {
        message: error instanceof Error ? error.message : String(error),
        code: "invalid_tools",
        type: "invalid_request_error",
      },
    });
    return;
  }
  const ownerKey = toolSessionOwnerKey(req, remoteAddress);
  const requested = normalizeModelId(body.model);
  const cleanMessages = sanitizeMessages(body.messages ?? []);
  const models = await getCachedCursorModels(config, modelCacheRef);
  const availableCursorIds = models.map((m) => m.id);
  const skipRouting =
    config.useAcp && submittedToolOutputs.length > 0;
  let assignedConfigDir: string | undefined;
  const pickConfigDir = (): string | undefined => {
    if (assignedConfigDir) return assignedConfigDir;
    assignedConfigDir = getNextAccountConfigDir();
    return assignedConfigDir;
  };
  const routingFlow: Awaited<
    ReturnType<typeof resolveModelWithOptionalRouting>
  > = skipRouting
    ? {
        model: resolveModel(requested, lastRequestedModelRef, config),
        rememberModel: true,
        skipSessionMemory: false,
        configDir:
          config.configDirs.length > 0 ? pickConfigDir() : undefined,
      }
    : await resolveModelWithOptionalRouting({
        config,
        requested,
        lastRequestedModelRef,
        messages: cleanMessages,
        availableCursorIds,
      });
  if (routingFlow.routeDecision) {
    applyModelRouteHeaders(res, routingFlow.routeDecision);
    logModelRoute(config.verbose, routingFlow.routeDecision);
  }
  assignedConfigDir = routingFlow.configDir ?? assignedConfigDir;
  const model = routingFlow.model;
  let decision;
  try {
    decision = resolveModelForExecution({
      requested: model,
      defaultModel: config.defaultModel,
      availableCursorIds,
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
  if (routingFlow.rememberModel) {
    rememberResolvedModel(cursorModel, lastRequestedModelRef);
  }
  logModelResolution(config.verbose, decision);
  // When request is "default", use defaultModel for response display (dashboard) if set; else echo "default"
  const displayModel =
    decision.requestedWasDefault && config.defaultModel !== "default"
      ? config.defaultModel
      : model;
  const modelCatalogName = models.find(
    (item) => item.id === cursorModel,
  )?.name;
  const id = `chatcmpl_${randomUUID().replace(/-/g, "")}`;
  const created = Math.floor(Date.now() / 1000);

  const structuredToolStart =
    config.useAcp &&
    selectedTools.length > 0 &&
    submittedToolOutputs.length === 0;
  const toolsText = structuredToolStart
    ? undefined
    : body.tool_choice === "none"
      ? undefined
      : toolsToSystemText(body.tools, body.functions);
  const messagesWithTools = [
    ...(toolInstruction && structuredToolStart
      ? [{ role: "system", content: toolInstruction }]
      : []),
    ...(toolsText ? [{ role: "system", content: toolsText }] : []),
    ...cleanMessages,
  ];
  const prompt = buildPromptFromMessages(messagesWithTools);

  const trafficMessages: TrafficMessage[] = cleanMessages.map((m: any) => {
    const content =
      typeof m?.content === "string"
        ? m.content
        : Array.isArray(m?.content)
          ? (m.content as Array<{ type?: string; text?: string }>)
              .filter((p) => p.type === "text")
              .map((p) => p.text ?? "")
              .join("")
          : "";
    return { role: String(m?.role ?? "user"), content };
  });
  logTrafficRequest(
    config.verbose,
    config.verboseFull,
    model ?? cursorModel,
    trafficMessages,
    !!body.stream,
  );

  if (config.useAcp && submittedToolOutputs.length > 0) {
    const record = ctx.toolSessions.findByCallIds(
      "chat",
      ownerKey,
      submittedToolOutputs.map((output) => output.callId),
    );
    if (!record) {
      json(res, 409, {
        error: {
          message:
            "Tool session is missing or expired; restart the conversation",
          code: "tool_session_expired",
          type: "invalid_request_error",
        },
      });
      return;
    }
    const configDir = record.configDir;
    logAccountAssigned(configDir);
    reportRequestStart(configDir);
    const startedAt = Date.now();
    const abortController = new AbortController();
    abortOnClientDisconnect(res, abortController);
    abortController.signal.addEventListener(
      "abort",
      () => void record.session.close(),
      { once: true },
    );
    try {
      const result = await writeStructuredChatTurn({
        res,
        stream: !!body.stream,
        id,
        created,
        model: displayModel,
        promptLength: prompt.length,
        usageLogPath: config.sessionsLogPath,
        usagePathname: pathname,
        run: (listener) =>
          ctx.toolSessions.resume(record, submittedToolOutputs, listener),
      });
      reportRequestSuccess(configDir, Date.now() - startedAt);
      logTrafficResponse(
        config.verbose,
        config.verboseFull,
        model ?? cursorModel,
        normalizeAssistantReplyText(result.text),
        !!body.stream,
      );
    } catch (error) {
      reportRequestError(configDir, Date.now() - startedAt);
      if (!res.headersSent) {
        json(res, error instanceof ToolSessionError ? error.status : 500, {
          error: {
            message: error instanceof Error ? error.message : String(error),
            code:
              error instanceof ToolSessionError
                ? error.code
                : "tool_session_error",
          },
        });
      } else if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({
            error: {
              message: error instanceof Error ? error.message : String(error),
              code: "tool_session_error",
            },
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
      }
    } finally {
      reportRequestEnd(configDir);
      logAccountStats(config.verbose, getAccountStats());
    }
    return;
  }

  let mode: CursorExecutionMode;
  try {
    mode = resolveRequestMode(
      config,
      req.headers["x-cursor-mode"],
      body.mode,
      body.messages,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Invalid mode";
    json(res, 400, { error: { message: msg, code: "invalid_mode" } });
    return;
  }

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
      })}${BRIDGE_AGENT_PROMPT_SEPARATOR}${prompt}`
    : prompt;

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
  // When the prompt is delivered via stdin (or ACP), keep it OUT of argv,
  // otherwise a long prompt still blows past the kernel ARG_MAX (spawn E2BIG
  // on Linux). fit.args appends the full prompt for the argv path only.
  const multimodal = messagesHaveMultimodalContent(cleanMessages);
  let acpPromptBlocks: AcpPromptBlock[] | undefined;
  if (multimodal) {
    acpPromptBlocks = buildMultimodalAcpPrompt(
      cleanMessages,
      agentPrompt,
      workspaceDir,
    );
  }

  const usePromptDelivery = config.promptViaStdin || config.useAcp || multimodal;
  const cmdArgs = usePromptDelivery ? fixedArgs : fit.args;

  const promptForAgent: string | AcpPromptBlock[] | undefined = usePromptDelivery
    ? acpPromptBlocks ?? agentPrompt
    : undefined;

  const truncatedHeaders = fit.truncated
    ? { "X-Cursor-Proxy-Prompt-Truncated": "true" }
    : undefined;

  if (structuredToolStart) {
    const configDir = pickConfigDir();
    logAccountAssigned(configDir);
    reportRequestStart(configDir);
    const startedAt = Date.now();
    const abortController = new AbortController();
    abortOnClientDisconnect(res, abortController);
    let record: ToolSessionRecord | undefined;
    try {
      const session = await startAgentToolSession({
        config,
        workspaceDir,
        effectiveChatOnly,
        cmdArgs,
        prompt: agentPrompt,
        tools: selectedTools,
        tempDir,
        configDir,
        signal: abortController.signal,
        modelDisplayName: modelCatalogName,
        requireToolCall,
        maxParallelToolCalls,
      });
      record = ctx.toolSessions.createRecord({
        api: "chat",
        ownerKey,
        model: displayModel ?? cursorModel,
        configDir,
        session,
      });
      abortController.signal.addEventListener(
        "abort",
        () => void session.close(),
        { once: true },
      );
      const result = await writeStructuredChatTurn({
        res,
        stream: !!body.stream,
        id,
        created,
        model: displayModel,
        promptLength: agentPrompt.length,
        usageLogPath: config.sessionsLogPath,
        usagePathname: pathname,
        run: (listener) => ctx.toolSessions.collect(record!, listener),
      });
      reportRequestSuccess(configDir, Date.now() - startedAt);
      if (
        result.status === "completed" &&
        result.stderr &&
        isRateLimited(result.stderr)
      ) {
        reportRateLimit(configDir, 60_000);
      }
      logTrafficResponse(
        config.verbose,
        config.verboseFull,
        model ?? cursorModel,
        normalizeAssistantReplyText(result.text),
        !!body.stream,
      );
    } catch (error) {
      if (record) {
        ctx.toolSessions.remove(record);
        await record.session.close().catch(() => undefined);
      }
      reportRequestError(configDir, Date.now() - startedAt);
      if (!res.headersSent) {
        json(res, 500, {
          error: {
            message: error instanceof Error ? error.message : String(error),
            code: "tool_session_error",
            type: "api_error",
          },
        });
      } else if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({
            error: {
              message: error instanceof Error ? error.message : String(error),
              code: "tool_session_error",
            },
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
      }
    } finally {
      reportRequestEnd(configDir);
      logAccountStats(config.verbose, getAccountStats());
    }
    return;
  }

  if (body.stream) {
    const webThreadId =
      pathname === "/api/agent/chat" && typeof body.threadId === "string"
        ? body.threadId.trim() || undefined
        : undefined;

    let agentSignal: AbortSignal;
    if (webThreadId) {
      await syncWebThreadFromChatRequest(config, webThreadId, {
        model: displayModel,
        mode,
        messages: trafficMessages,
      }).catch(() => undefined);
      const reg = startWebGeneration(config, webThreadId);
      if (reg.existed) {
        writeGenerationSse(res, webThreadId);
        return;
      }
      agentSignal = reg.signal;
      res.on("close", () => detachWebChatClient(webThreadId));
    } else {
      const abortController = new AbortController();
      abortOnClientDisconnect(res, abortController);
      agentSignal = abortController.signal;
    }

    const configDir = pickConfigDir();
    logAccountAssigned(configDir);
    reportRequestStart(configDir);
    const streamStart = Date.now();

    writeSseHeaders(res, truncatedHeaders);
    const stopKeepalive = startSseKeepalive(res);
    res.on("error", () => {
      /* client disconnected mid-stream */
    });

    const chunkWriter = createChatCompletionChunkWriter(res, {
      id,
      created,
      model: displayModel,
    });
    const writeContentDelta = (delta: string) => {
      chunkWriter.write(delta);
      if (webThreadId) appendWebGenerationDelta(webThreadId, { content: delta });
    };
    const finishWeb = (outcome: { ok: true } | { ok: false; error: string }) => {
      if (webThreadId) finishWebGeneration(webThreadId, outcome);
    };
    const streamResponseMeta = () => ({
      wireDeltaChars: chunkWriter.wireDeltaChars(),
      rawAccumulatedChars: accumulated.length,
    });
    let accumulated = "";

    if (config.useAcp || Array.isArray(promptForAgent)) {
      const pushAssistantText = createGuardedAssistantTextEmitter((text) => {
        accumulated += text;
        writeContentDelta(text);
      });
      runAgentStream(
        config,
        workspaceDir,
        effectiveChatOnly,
        cmdArgs,
        pushAssistantText,
        tempDir,
        promptForAgent,
        configDir,
        agentSignal,
        modelCatalogName,
      )
        .then(({ code, stderr: stderrOut }) => {
          stopKeepalive();
          const latencyMs = Date.now() - streamStart;
          reportRequestEnd(configDir);

          if (stderrOut && isRateLimited(stderrOut)) {
            reportRateLimit(configDir, 60000);
          }

          if (agentSignal.aborted) {
            /* stopped explicitly — background job already finalized */
          } else if (code !== 0) {
            reportRequestError(configDir, latencyMs);
            const publicMsg = logAgentError(
              config.sessionsLogPath,
              method,
              pathname,
              remoteAddress,
              code,
              stderrOut,
            );
            finishWeb({ ok: false, error: publicMsg });
            if (!res.writableEnded) {
              res.write(
                `data: ${JSON.stringify({
                  error: { message: publicMsg, code: "cursor_cli_error" },
                })}\n\n`,
              );
              res.write("data: [DONE]\n\n");
              logAccountStats(config.verbose, getAccountStats());
              res.end();
            }
            return;
          } else {
            reportRequestSuccess(configDir, latencyMs);
          }
          logAccountStats(config.verbose, getAccountStats());
          const normalizedAccumulated =
            normalizeAssistantReplyText(accumulated);
          finishWeb({ ok: true });
          logTrafficResponse(
            config.verbose,
            config.verboseFull,
            model ?? cursorModel,
            normalizedAccumulated,
            true,
            streamResponseMeta(),
          );
          maybeRecordProxyChatSession(
            config,
            pathname,
            trafficMessages,
            normalizedAccumulated,
            displayModel ?? cursorModel,
            mode,
          );
          const promptTokens = Math.max(1, Math.round(agentPrompt.length / 4));
          const completionTokens = Math.max(
            1,
            Math.round(normalizedAccumulated.length / 4),
          );
          recordProxyUsage(
            config.sessionsLogPath,
            pathname,
            displayModel ?? cursorModel,
            promptTokens,
            completionTokens,
          );
          res.write(
            `data: ${JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created,
              model: displayModel,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: promptTokens + completionTokens,
              },
            })}\n\n`,
          );
          res.write("data: [DONE]\n\n");
          res.end();
        })
        .catch((err) => {
          stopKeepalive();
          reportRequestEnd(configDir);
          if (!agentSignal.aborted) {
            reportRequestError(configDir, Date.now() - streamStart);
            finishWeb({
              ok: false,
              error: "The Cursor agent stream failed. See server logs for details.",
            });
            if (!res.writableEnded) {
              res.write(
                `data: ${JSON.stringify({
                  error: {
                    message:
                      "The Cursor agent stream failed. See server logs for details.",
                    code: "cursor_cli_error",
                  },
                })}\n\n`,
              );
              res.write("data: [DONE]\n\n");
            }
          }
          console.error(
            `[${new Date().toISOString()}] Agent stream error:`,
            err,
          );
          if (!res.writableEnded) res.end();
        });
      return;
    }

    const pushAssistantText = createGuardedAssistantTextEmitter((text) => {
      accumulated += text;
      writeContentDelta(text);
    });
    const parseLine = createStreamParser(
      pushAssistantText,
      () => {
        const normalizedAccumulated =
          normalizeAssistantReplyText(accumulated);
        logTrafficResponse(
          config.verbose,
          config.verboseFull,
          model ?? cursorModel,
          normalizedAccumulated,
          true,
          streamResponseMeta(),
        );
        maybeRecordProxyChatSession(
          config,
          pathname,
          trafficMessages,
          normalizedAccumulated,
          displayModel ?? cursorModel,
          mode,
        );
        const promptTokens = Math.max(1, Math.round(agentPrompt.length / 4));
        const completionTokens = Math.max(
          1,
          Math.round(normalizedAccumulated.length / 4),
        );
        recordProxyUsage(
          config.sessionsLogPath,
          pathname,
          displayModel ?? cursorModel,
          promptTokens,
          completionTokens,
        );
        finishWeb({ ok: true });
        if (!res.writableEnded) {
          res.write(
            `data: ${JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created,
              model: displayModel,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: promptTokens + completionTokens,
              },
            })}\n\n`,
          );
          res.write("data: [DONE]\n\n");
        }
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
      agentSignal,
      modelCatalogName,
    )
      .then(({ code, stderr: stderrOut }) => {
        stopKeepalive();
        const latencyMs = Date.now() - streamStart;
        reportRequestEnd(configDir);

        if (stderrOut && isRateLimited(stderrOut)) {
          reportRateLimit(configDir, 60000);
        }

        if (agentSignal.aborted) {
          /* stopped explicitly */
        } else if (code !== 0) {
          reportRequestError(configDir, latencyMs);
          const publicMsg = logAgentError(
            config.sessionsLogPath,
            method,
            pathname,
            remoteAddress,
            code,
            stderrOut,
          );
          finishWeb({ ok: false, error: publicMsg });
        } else {
          reportRequestSuccess(configDir, latencyMs);
        }
        logAccountStats(config.verbose, getAccountStats());
        if (!res.writableEnded) res.end();
      })
      .catch((err) => {
        stopKeepalive();
        reportRequestEnd(configDir);
        if (!agentSignal.aborted) {
          reportRequestError(configDir, Date.now() - streamStart);
          finishWeb({
            ok: false,
            error: "The Cursor agent stream failed. See server logs for details.",
          });
        }
        console.error(
          `[${new Date().toISOString()}] Agent stream error:`,
          err,
        );
        if (!res.writableEnded) res.end();
      });
    return;
  }

  const configDir = pickConfigDir();
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
  const content = normalizeAssistantReplyText(out.stdout.trim());
  logTrafficResponse(config.verbose, config.verboseFull, model ?? cursorModel, content, false);
  maybeRecordProxyChatSession(
    config,
    pathname,
    trafficMessages,
    content,
    displayModel ?? cursorModel,
    mode,
  );

  const promptTokens = Math.max(1, Math.round(agentPrompt.length / 4));
  const completionTokens = Math.max(1, Math.round(content.length / 4));
  const totalTokens = promptTokens + completionTokens;
  recordProxyUsage(
    config.sessionsLogPath,
    pathname,
    displayModel ?? cursorModel,
    promptTokens,
    completionTokens,
  );

  logAccountStats(config.verbose, getAccountStats());
  json(
    res,
    200,
    {
      id,
      object: "chat.completion",
      created,
      model: displayModel,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
      },
    },
    truncatedHeaders,
  );
}
