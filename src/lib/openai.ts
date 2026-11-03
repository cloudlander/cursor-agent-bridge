export type OpenAiChatCompletionRequest = {
  model?: string;
  /** Cursor CLI mode override: agent | ask | plan */
  mode?: string;
  /** Web UI thread id — enables background generation across page refresh. */
  threadId?: string;
  messages: any[];
  stream?: boolean;
  tools?: any[];
  tool_choice?: any;
  parallel_tool_calls?: boolean;
  functions?: any[];
  function_call?: any;
  reasoning_effort?: string;
};

/** OpenAI legacy text completions (Codex / inline autocomplete clients). */
export type OpenAiCompletionRequest = {
  model?: string;
  /** Cursor CLI mode override: agent | ask | plan (default ask for completions). */
  mode?: string;
  prompt?: string | string[] | number[] | number[][];
  suffix?: string | null;
  max_tokens?: number | null;
  temperature?: number | null;
  top_p?: number | null;
  stream?: boolean;
  stop?: string | string[] | null;
  echo?: boolean | null;
  logprobs?: number | null;
  best_of?: number | null;
  n?: number | null;
  reasoning_effort?: string;
};

export type OpenAiResponsesRequest = {
  model?: string;
  /** Cursor CLI mode override: agent | ask | plan */
  mode?: string;
  input?: any;
  instructions?: string | null;
  stream?: boolean;
  tools?: any[];
  tool_choice?: any;
  max_output_tokens?: number | null;
  metadata?: Record<string, unknown> | null;
  parallel_tool_calls?: boolean;
  previous_response_id?: string | null;
  reasoning?: any;
  service_tier?: string | null;
  store?: boolean | null;
  temperature?: number | null;
  text?: any;
  top_p?: number | null;
  truncation?: string | null;
  user?: string | null;
};

export function normalizeModelId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || undefined;
}

function imageUrlToText(imageUrl: any): string {
  if (!imageUrl) return "[Image]";
  const url: string =
    typeof imageUrl === "string"
      ? imageUrl
      : typeof imageUrl?.url === "string"
        ? imageUrl.url
        : "";
  if (!url) return "[Image]";
  if (url.startsWith("data:")) {
    const mime = url.slice(5, url.indexOf(";")) || "image";
    return `[Image: base64 ${mime}]`;
  }
  return `[Image: ${url}]`;
}

function messageContentToText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (!p) return "";
        if (typeof p === "string") return p;
        if (p.type === "text" && typeof p.text === "string") return p.text;
        if (p.type === "image_url") return imageUrlToText(p.image_url);
        if (p.type === "image") return imageUrlToText(p.source?.url ?? p.url ?? p.source);
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

function responseItemContentToText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (!p) return "";
        if (typeof p === "string") return p;
        if (
          (p.type === "input_text" ||
            p.type === "output_text" ||
            p.type === "text") &&
          typeof p.text === "string"
        ) {
          return p.text;
        }
        if (p.type === "input_image" || p.type === "image_url") {
          return imageUrlToText(p.image_url ?? p.url);
        }
        if (typeof p.output === "string") return p.output;
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }
  if (typeof content?.text === "string") return content.text;
  if (typeof content?.output === "string") return content.output;
  return "";
}

/** Convert OpenAI Responses API `input` (+ optional `instructions`) into chat messages. */
export function responsesInputToMessages(
  body: OpenAiResponsesRequest,
): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [];
  const instructions =
    typeof body.instructions === "string" ? body.instructions.trim() : "";

  if (instructions) {
    messages.push({ role: "system", content: instructions });
  }

  const input = body.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }

  if (!Array.isArray(input)) {
    return messages;
  }

  for (const item of input) {
    if (!item) continue;
    if (typeof item === "string") {
      messages.push({ role: "user", content: item });
      continue;
    }

    if (item.type === "function_call_output") {
      const output = responseItemContentToText(item.output ?? item.content);
      if (output) messages.push({ role: "tool", content: output });
      continue;
    }

    if (item.type === "function_call") {
      const name = typeof item.name === "string" ? item.name : "function";
      const args =
        typeof item.arguments === "string"
          ? item.arguments
          : JSON.stringify(item.arguments ?? {});
      messages.push({
        role: "assistant",
        content: `Function call ${name}: ${args}`,
      });
      continue;
    }

    const role = typeof item.role === "string" ? item.role : "user";
    const content = responseItemContentToText(item.content ?? item.text);
    if (content) messages.push({ role, content });
  }

  return messages;
}

/**
 * Serialise tool/function schemas into a text block for the system prompt.
 * This allows the model to be aware of available tools even though we can't
 * return tool_call deltas natively.
 */
export function toolsToSystemText(
  tools?: any[],
  functions?: any[],
): string | undefined {
  const defs: any[] = [];

  if (tools && tools.length > 0) {
    for (const t of tools) {
      const fn = t?.type === "function" ? t.function : t;
      if (fn) defs.push(fn);
    }
  }
  if (functions && functions.length > 0) {
    defs.push(...functions);
  }

  if (defs.length === 0) return undefined;

  const lines = [
    "Available tools (respond with a JSON object to call one):",
    "",
    ...defs.map((fn) => {
      const params = fn.parameters
        ? JSON.stringify(fn.parameters, null, 2)
        : "{}";
      return `Function: ${fn.name}\nDescription: ${fn.description ?? ""}\nParameters: ${params}`;
    }),
  ];
  return lines.join("\n");
}

export function buildPromptFromMessages(messages: any[]): string {
  const systemParts: string[] = [];
  const convo: string[] = [];

  for (const m of messages || []) {
    const role = m?.role;
    let text = messageContentToText(m?.content);
    if (Array.isArray(m?.attachments) && m.attachments.length > 0) {
      const names = m.attachments
        .map((a: { name?: string; path?: string }) => a?.name ?? a?.path ?? "file")
        .join(", ");
      const tag = `[Attachments: ${names}]`;
      text = text ? `${text}\n${tag}` : tag;
    }
    if (!text) continue;

    if (role === "system" || role === "developer") {
      systemParts.push(text);
      continue;
    }
    if (role === "user") {
      convo.push(`User: ${text}`);
      continue;
    }
    if (role === "assistant") {
      convo.push(`Assistant: ${text}`);
      continue;
    }
    if (role === "tool" || role === "function") {
      convo.push(`Tool: ${text}`);
      continue;
    }
  }

  const system = systemParts.length
    ? `System:\n${systemParts.join("\n\n")}\n\n`
    : "";
  const transcript = convo.join("\n\n");
  return system + transcript + "\n\nAssistant:";
}

function normalizeStopSequences(
  stop: string | string[] | null | undefined,
): string[] {
  if (stop == null) return [];
  if (typeof stop === "string") return stop ? [stop] : [];
  return stop.filter((s) => typeof s === "string" && s.length > 0);
}

/**
 * Normalize OpenAI `prompt` for legacy completions (string or string batch).
 * Token id arrays are not supported — callers should decode tokens first.
 */
export function normalizeCompletionPrompt(
  prompt: OpenAiCompletionRequest["prompt"],
): string | undefined {
  if (prompt == null) return undefined;
  if (typeof prompt === "string") {
    const trimmed = prompt;
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (Array.isArray(prompt)) {
    if (prompt.length === 0) return undefined;
    if (typeof prompt[0] === "string") {
      const joined = (prompt as string[]).join("");
      return joined.length > 0 ? joined : undefined;
    }
    return undefined;
  }
  return undefined;
}

export function isTokenizedCompletionPrompt(
  prompt: OpenAiCompletionRequest["prompt"],
): boolean {
  return (
    Array.isArray(prompt) &&
    prompt.length > 0 &&
    typeof prompt[0] === "number"
  );
}

const CODE_COMPLETION_RULES = `You are a coding autocomplete engine. Continue code from the cursor position.
Rules:
- Output ONLY the text that should be inserted at the cursor.
- Do NOT repeat the prefix/context already provided below.
- Do NOT wrap output in markdown code fences or add explanations.
- Prefer minimal, syntactically valid completions (finish the current token/line when possible).`;

/** Build the Cursor agent prompt for POST /v1/completions. */
export function buildAgentPromptForCompletion(opts: {
  prefix: string;
  suffix?: string | null;
  stop?: string | string[] | null;
  maxTokens?: number | null;
}): string {
  const stops = normalizeStopSequences(opts.stop);
  let instructions = CODE_COMPLETION_RULES;
  if (typeof opts.maxTokens === "number" && opts.maxTokens > 0) {
    instructions += `\n- Keep the completion under roughly ${opts.maxTokens} tokens.`;
  }
  if (stops.length > 0) {
    instructions += `\n- Do not emit these literal substrings: ${stops.map((s) => JSON.stringify(s)).join(", ")}.`;
  }

  const suffix =
    typeof opts.suffix === "string" ? opts.suffix.trim() : "";
  if (suffix) {
    return `${instructions}

Fill in the missing code between PREFIX (already in the editor) and SUFFIX (already in the editor).

PREFIX:
${opts.prefix}

SUFFIX:
${suffix}

Insert ONLY the code that belongs between PREFIX and SUFFIX:`;
  }

  return `${instructions}

Code before the cursor (PREFIX — do not repeat in your output):
${opts.prefix}

Completion:`;
}

/** Strip common model formatting mistakes from a completion result. */
export function normalizeCompletionOutput(
  raw: string,
  prefix: string,
): string {
  let text = raw.trim();
  if (prefix && text.startsWith(prefix)) {
    text = text.slice(prefix.length);
  }
  const fence = /^```[\w-]*\n?([\s\S]*?)```\s*$/;
  const m = text.match(fence);
  if (m) text = m[1].trim();
  return text;
}
