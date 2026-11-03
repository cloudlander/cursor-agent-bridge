import type * as http from "node:http";

import type { BridgeConfig } from "./config.js";
import {
  finalizeWebThreadAssistant,
  updateWebThreadAssistantProgress,
} from "./chat-store.js";
import { writeSseHeaders } from "./http.js";

export type GenerationStatus = "running" | "done" | "error";

export type GenerationSnapshot = {
  threadId: string;
  content: string;
  reasoning: string;
  status: GenerationStatus;
  error?: string;
  startedAt: number;
  updatedAt: number;
};

type StreamListener = (event: GenerationStreamEvent) => void;

export type GenerationStreamEvent =
  | { type: "snapshot"; content: string; reasoning: string; status: GenerationStatus; error?: string }
  | { type: "delta"; content?: string; reasoning?: string }
  | { type: "done"; error?: string };

type ActiveGeneration = {
  threadId: string;
  content: string;
  reasoning: string;
  status: GenerationStatus;
  error?: string;
  startedAt: number;
  updatedAt: number;
  abortController: AbortController;
  listeners: Set<StreamListener>;
  persistTimer: ReturnType<typeof setTimeout> | null;
  config: BridgeConfig;
};

const active = new Map<string, ActiveGeneration>();

function snapshotOf(gen: ActiveGeneration): GenerationSnapshot {
  return {
    threadId: gen.threadId,
    content: gen.content,
    reasoning: gen.reasoning,
    status: gen.status,
    error: gen.error,
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
    }).catch(() => undefined);
  }, 400);
}

function flushPersist(gen: ActiveGeneration): void {
  if (gen.persistTimer) {
    clearTimeout(gen.persistTimer);
    gen.persistTimer = null;
  }
  void finalizeWebThreadAssistant(gen.config, gen.threadId, {
    content: gen.content,
    reasoning: gen.reasoning || undefined,
    error: gen.status === "error" ? gen.error : undefined,
  }).catch(() => undefined);
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
): { signal: AbortSignal; existed: boolean } {
  const existing = active.get(threadId);
  if (existing?.status === "running") {
    return { signal: existing.abortController.signal, existed: true };
  }

  const abortController = new AbortController();
  const now = Date.now();
  const gen: ActiveGeneration = {
    threadId,
    content: existing?.content ?? "",
    reasoning: existing?.reasoning ?? "",
    status: "running",
    startedAt: existing?.startedAt ?? now,
    updatedAt: now,
    abortController,
    listeners: new Set(),
    persistTimer: null,
    config,
  };
  active.set(threadId, gen);
  notify(gen, {
    type: "snapshot",
    content: gen.content,
    reasoning: gen.reasoning,
    status: gen.status,
  });
  return { signal: abortController.signal, existed: false };
}

export function appendWebGenerationDelta(
  threadId: string,
  delta: { content?: string; reasoning?: string },
): void {
  const gen = active.get(threadId);
  if (!gen || gen.status !== "running") return;
  if (delta.content) gen.content += delta.content;
  if (delta.reasoning) gen.reasoning += delta.reasoning;
  gen.updatedAt = Date.now();
  notify(gen, { type: "delta", ...delta });
  schedulePersist(gen);
}

export function finishWebGeneration(
  threadId: string,
  outcome: { ok: true } | { ok: false; error: string },
): void {
  const gen = active.get(threadId);
  if (!gen) return;
  gen.status = outcome.ok ? "done" : "error";
  gen.error = outcome.ok ? undefined : outcome.error;
  gen.updatedAt = Date.now();
  notify(gen, { type: "done", error: gen.error });
  flushPersist(gen);
  for (const listener of gen.listeners) gen.listeners.delete(listener);
  active.delete(threadId);
}

export function abortWebGeneration(threadId: string): boolean {
  const gen = active.get(threadId);
  if (!gen || gen.status !== "running") return false;
  gen.abortController.abort();
  finishWebGeneration(threadId, { ok: false, error: "Stopped by user" });
  return true;
}

export function subscribeWebGeneration(
  threadId: string,
  listener: StreamListener,
): () => void {
  const gen = active.get(threadId);
  if (!gen) return () => undefined;
  gen.listeners.add(listener);
  listener({
    type: "snapshot",
    content: gen.content,
    reasoning: gen.reasoning,
    status: gen.status,
    error: gen.error,
  });
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
    writeEvent({ type: "done" });
    res.end();
    return () => undefined;
  }

  writeEvent({
    type: "snapshot",
    content: gen.content,
    reasoning: gen.reasoning,
    status: gen.status,
    error: gen.error,
  });

  if (gen.status !== "running") {
    writeEvent({ type: "done", error: gen.error });
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
