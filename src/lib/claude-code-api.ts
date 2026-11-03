/**
 * Claude Code speaks the Anthropic Messages API (base URL + x-api-key).
 * These helpers keep auth and error shapes compatible with the official client.
 */

import type { AnthropicMessagesRequest } from "./anthropic.js";
import { buildPromptFromAnthropicMessages } from "./anthropic.js";

export function isAnthropicApiPath(pathname: string): boolean {
  return (
    pathname === "/v1/messages" || pathname === "/v1/messages/count_tokens"
  );
}

export type AnthropicErrorBody = {
  type: "error";
  error: { type: string; message: string };
};

export function anthropicErrorBody(
  errorType: string,
  message: string,
): AnthropicErrorBody {
  return { type: "error", error: { type: errorType, message } };
}

/** Heuristic token estimate (chars ÷ 4), same family as completion usage fields. */
export function estimateInputTokensFromText(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}

export function estimateAnthropicRequestInputTokens(
  body: Pick<AnthropicMessagesRequest, "messages" | "system">,
): number {
  const prompt = buildPromptFromAnthropicMessages(
    body.messages ?? [],
    body.system,
  );
  return estimateInputTokensFromText(prompt);
}
