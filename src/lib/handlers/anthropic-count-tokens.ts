import * as http from "node:http";

import type { AnthropicMessagesRequest } from "../anthropic.js";
import { estimateAnthropicRequestInputTokens } from "../claude-code-api.js";
import { json } from "../http.js";
import { sanitizeMessages, sanitizeSystem } from "../sanitize.js";

export function handleAnthropicCountTokens(
  res: http.ServerResponse,
  rawBody: string,
): void {
  const body = JSON.parse(rawBody || "{}") as Partial<AnthropicMessagesRequest>;
  const cleanSystem = sanitizeSystem(body.system);
  const cleanMessages = sanitizeMessages(
    body.messages ?? [],
  ) as AnthropicMessagesRequest["messages"];

  const input_tokens = estimateAnthropicRequestInputTokens({
    messages: cleanMessages,
    system: cleanSystem as AnthropicMessagesRequest["system"],
  });

  json(res, 200, { input_tokens });
}
