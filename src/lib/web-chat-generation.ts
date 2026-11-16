import type * as http from "node:http";

import type { BridgeConfig } from "./config.js";
import type { ContextWindowUsage } from "./acp-context-usage.js";
import {
  finalizeWebThreadAssistant,
  updateWebThreadAssistantProgress,
  updateWebThreadContextUsage,
} from "./chat-store.js";
import { writeSseHeaders } from "./http.js";

export type GenerationStatus = "running" | "done" | "error";

export type GenerationSnapshot = {
  threadId: string;
  workspaceId?: string;
  content: string;
  reasoning: string;
  status: GenerationStatus;
  error?: string;
  contextWindowUsage?: ContextWindowUsage;
  startedAt: number;
  updatedAt: number;
};

type StreamListener = (event: GenerationStreamEvent) => void;

export type GenerationStreamEvent =
  | {
      type: "snapshot";
      content: string;
      reasoning: string;
      status: GenerationStatus;
      error?: string;
      contextWindowUsage?: ContextWindowUsage;
      startedAt?: number;
    }
  | { type: "delta"; content?: string; reasoning?: string }
  | { type: "context_usage"; usage: ContextWindowUsage }
  | {
      type: "done";
      error?: string;
      startedAt?: number;
      updatedAt?: number;
      durationMs?: number;
      thinkMs?: number;
    };

type ActiveGeneration = {
  threadId: string;
  workspaceId: string;
  content: string;
  reasoning: string;
  status: GenerationStatus;
  error?: string;
  contextWindowUsage?: ContextWindowUsage;
  startedAt: number;
  updatedAt: number;
  /** First reasoning token. Think time runs until the first answer token. */
  reasoningStartedAt?: number;
  contentStartedAt?: number;
  abortController: AbortController;
  usagePersistTimer: ReturnType<typeof setTimeout> | null;
  listeners: Set<StreamListener>;
  persistTimer: ReturnType<typeof setTimeout> | null;
  config: BridgeConfig;
};

const active = new Map<string, ActiveGeneration>();
/** Timing for a turn that just finished, so a late stream reconnect still gets server numbers. */
const recentTurns = new Map<string, GenerationTurnTiming>();

export function getRecentTurnTiming(threadId: string): GenerationTurnTiming | null {
  return recentTurns.get(threadId) ?? null;
}

function rememberTurn(threadId: string, turn: GenerationTurnTiming): void {
  recentTurns.set(threadId, turn);
  const timer = setTimeout(() => {
    if (recentTurns.get(threadId) === turn) recentTurns.delete(threadId);
  }, 60_000);
  timer.unref?.();
}

function doneEventFromTurn(
  turn: GenerationTurnTiming,
  error?: string,
): GenerationStreamEvent {
  return {
    type: "done",
    error,
    startedAt: turn.startedAt,
    updatedAt: turn.updatedAt,
    durationMs: turn.durationMs,
    thinkMs: turn.thinkMs,
  };
}

export function computeGenerationTiming(input: {
  startedAt: number;
  endedAt: number;
  reasoning: string;
  reasoningStartedAt?: number;
  contentStartedAt?: number;
}): { durationMs: number; thinkMs?: number } {
  const durationMs = Math.max(0, input.endedAt - input.startedAt);
  if (!input.reasoning.trim()) return { durationMs };
  const thinkStart = input.reasoningStartedAt ?? input.startedAt;
  const contentAt = input.contentStartedAt;
  const thinkEnd =
    contentAt != null && contentAt >= thinkStart ? contentAt : input.endedAt;
  return { durationMs, thinkMs: Math.max(0, thinkEnd - thinkStart) };
}

function snapshotEvent(gen: ActiveGeneration): GenerationStreamEvent {
  return {
    type: "snapshot",
    content: gen.content,
    reasoning: gen.reasoning,
    status: gen.status,
    error: gen.error,
    contextWindowUsage: gen.contextWindowUsage,
    startedAt: gen.startedAt,
  };
}

function snapshotOf(gen: ActiveGeneration): GenerationSnapshot {
  return {
    threadId: gen.threadId,
    workspaceId: gen.workspaceId,
    content: gen.content,
    reasoning: gen.reasoning,
    status: gen.status,
    error: gen.error,
    contextWindowUsage: gen.contextWindowUsage,
    startedAt: gen.startedAt,
    updatedAt: gen.updatedAt,
  };
}

function notify(gen: ActiveGeneration, event: GenerationStreamEvent): void {
  for (const listener of gen.listeners) {
    try {
      listener(event);
    } catch {
      /* ignore listener errors */
    }
  }
}

function schedulePersist(gen: ActiveGeneration): void {
  if (gen.persistTimer) return;
  gen.persistTimer = setTimeout(() => {
    gen.persistTimer = null;
    void updateWebThreadAssistantProgress(gen.config, gen.threadId, {
      content: gen.content,
      reasoning: gen.reasoning || undefined,
      streaming: gen.status === "running",
      error: gen.status === "error",
    }, gen.workspaceId).catch(() => undefined);
  }, 400);
}

export type GenerationTurnTiming = {
  durationMs: number;
  thinkMs?: number;
  startedAt: number;
  updatedAt: number;
};

function turnTimingOf(
  gen: ActiveGeneration,
  timing: { durationMs: number; thinkMs?: number },
): GenerationTurnTiming {
  return {
    durationMs: timing.durationMs,
    ...(typeof timing.thinkMs === "number" ? { thinkMs: timing.thinkMs } : {}),
    startedAt: gen.startedAt,
    updatedAt: gen.updatedAt,
  };
}

function flushPersist(
  gen: ActiveGeneration,
  timing?: { durationMs: number; thinkMs?: number },
): void {
  if (gen.persistTimer) {
    clearTimeout(gen.persistTimer);
    gen.persistTimer = null;
  }
  void finalizeWebThreadAssistant(gen.config, gen.threadId, {
    content: gen.content,
    reasoning: gen.reasoning || undefined,
    error: gen.status === "error" ? gen.error : undefined,
    durationMs: timing?.durationMs,
    thinkMs: timing?.thinkMs,
  }, gen.workspaceId).catch(() => undefined);
}

export function listActiveGenerations(): GenerationSnapshot[] {
  return [...active.values()]
    .filter((g) => g.status === "running")
    .map(snapshotOf);
}

export function getGeneration(threadId: string): GenerationSnapshot | null {
  const gen = active.get(threadId);
  return gen ? snapshotOf(gen) : null;
}

export function getGenerationAbortSignal(threadId: string): AbortSignal | undefined {
  return active.get(threadId)?.abortController.signal;
}

/**
 * Register (or replace) a background web-chat generation. Returns the abort
 * signal for the agent — callers must not tie it to HTTP client disconnect.
 */
export function startWebGeneration(
  config: BridgeConfig,
  threadId: string,
  workspaceId = "default",
): { signal: AbortSignal; existed: boolean } {
  const existing = active.get(threadId);
  if (existing?.status === "running") {
    return { signal: existing.abortController.signal, existed: true };
  }

  const abortController = new AbortController();
  const now = Date.now();
  const gen: ActiveGeneration = {
    threadId,
    workspaceId: workspaceId || existing?.workspaceId || "default",
    content: existing?.content ?? "",
    reasoning: existing?.reasoning ?? "",
    status: "running",
    startedAt: existing?.startedAt ?? now,
    updatedAt: now,
    abortController,
    listeners: new Set(),
    persistTimer: null,
    usagePersistTimer: null,
    contextWindowUsage: existing?.contextWindowUsage,
    config,
  };
  active.set(threadId, gen);
  notify(gen, snapshotEvent(gen));
  return { signal: abortController.signal, existed: false };
}

function scheduleUsagePersist(gen: ActiveGeneration): void {
  if (gen.usagePersistTimer) return;
  gen.usagePersistTimer = setTimeout(() => {
    gen.usagePersistTimer = null;
    if (!gen.contextWindowUsage) return;
    void updateWebThreadContextUsage(
      gen.config,
      gen.threadId,
      gen.contextWindowUsage,
      gen.workspaceId,
    ).catch(() => undefined);
  }, 600);
}

export function appendWebGenerationContextUsage(
  threadId: string,
  usage: ContextWindowUsage,
): void {
  const gen = active.get(threadId);
  if (!gen) return;
  gen.contextWindowUsage = usage;
  gen.updatedAt = Date.now();
  notify(gen, { type: "context_usage", usage });
  scheduleUsagePersist(gen);
}

export function appendWebGenerationDelta(
  threadId: string,
  delta: { content?: string; reasoning?: string },
): void {
  const gen = active.get(threadId);
  if (!gen || gen.status !== "running") return;
  const now = Date.now();
  if (delta.reasoning) {
    if (!gen.reasoningStartedAt) gen.reasoningStartedAt = now;
    gen.reasoning += delta.reasoning;
  }
  if (delta.content) {
    if (!gen.contentStartedAt) gen.contentStartedAt = now;
    gen.content += delta.content;
  }
  gen.updatedAt = now;
  notify(gen, { type: "delta", ...delta });
  schedulePersist(gen);
}

export function finishWebGeneration(
  threadId: string,
  outcome: { ok: true } | { ok: false; error: string },
): GenerationTurnTiming | null {
  const gen = active.get(threadId);
  if (!gen) return null;
  gen.status = outcome.ok ? "done" : "error";
  gen.error = outcome.ok ? undefined : outcome.error;
  gen.updatedAt = Date.now();
  const timing = computeGenerationTiming({
    startedAt: gen.startedAt,
    endedAt: gen.updatedAt,
    reasoning: gen.reasoning,
    reasoningStartedAt: gen.reasoningStartedAt,
    contentStartedAt: gen.contentStartedAt,
  });
  const turn = turnTimingOf(gen, timing);
  notify(gen, {
    type: "done",
    error: gen.error,
    startedAt: turn.startedAt,
    updatedAt: turn.updatedAt,
    durationMs: turn.durationMs,
    thinkMs: turn.thinkMs,
  });
  flushPersist(gen, timing);
  for (const listener of gen.listeners) gen.listeners.delete(listener);
  active.delete(threadId);
  rememberTurn(threadId, turn);
  return turn;
}

export function abortWebGeneration(threadId: string): GenerationTurnTiming | null {
  const gen = active.get(threadId);
  if (!gen || gen.status !== "running") return null;
  gen.abortController.abort();
  return finishWebGeneration(threadId, { ok: false, error: "Stopped by user" });
}

export function subscribeWebGeneration(
  threadId: string,
  listener: StreamListener,
): () => void {
  const gen = active.get(threadId);
  if (!gen) return () => undefined;
  gen.listeners.add(listener);
  listener(snapshotEvent(gen));
  return () => {
    gen.listeners.delete(listener);
  };
}

export function writeGenerationSse(
  res: http.ServerResponse,
  threadId: string,
): () => void {
  writeSseHeaders(res);
  const writeEvent = (event: GenerationStreamEvent) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const gen = active.get(threadId);
  if (!gen) {
    // Generation already finished (or never started) — normal for reconnect after completion.
    const turn = recentTurns.get(threadId);
    writeEvent(turn ? doneEventFromTurn(turn) : { type: "done" });
    res.end();
    return () => undefined;
  }

  writeEvent(snapshotEvent(gen));

  if (gen.status !== "running") {
    const turn = recentTurns.get(threadId);
    writeEvent(turn ? doneEventFromTurn(turn, gen.error) : { type: "done", error: gen.error });
    res.end();
    return () => undefined;
  }

  const unsubscribe = subscribeWebGeneration(threadId, (event) => {
    writeEvent(event);
    if (event.type === "done") {
      unsubscribe();
      if (!res.writableEnded) res.end();
    }
  });

  res.on("close", () => unsubscribe());
  return unsubscribe;
}

/** Client disconnected from the initial chat stream — keep agent running. */
export function detachWebChatClient(_threadId: string): void {
  /* generation continues; subscribers can reconnect via /api/chat/generations/.../stream */
}
