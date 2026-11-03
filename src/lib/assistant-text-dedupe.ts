/** Extract plain text from an OpenAI-style message content field. */
export function messageContentToPlainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (p): p is { type?: string; text?: string } =>
          !!p && typeof p === "object",
      )
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text!)
      .join("");
  }
  return "";
}

/**
 * Remove back-to-back duplicate `Assistant:` sections in a linear transcript
 * (common when a client appends the same streamed reply twice to history).
 */
export function dedupeConsecutiveAssistantSections(text: string): string {
  let out = text;
  for (;;) {
    const next = out.replace(
      /(\r?\n\r?\nAssistant: ([\s\S]*?))\r?\n\r?\nAssistant: \2(?=\r?\n\r?\n(?:User: |Assistant: )|$)/,
      "$1",
    );
    if (next === out) return out;
    out = next;
  }
}

/** Drop consecutive user messages with identical content (OpenCode sometimes appends twice). */
export function dedupeConsecutiveUserMessages<T extends { role?: string; content?: unknown }>(
  messages: T[],
): T[] {
  const out: T[] = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (
      prev &&
      m?.role === "user" &&
      prev.role === "user" &&
      messageContentToPlainText(prev.content) ===
        messageContentToPlainText(m.content)
    ) {
      continue;
    }
    out.push(m);
  }
  return out;
}

/** Drop consecutive assistant messages with identical content. */
export function dedupeConsecutiveAssistantMessages<T extends { role?: string; content?: unknown }>(
  messages: T[],
): T[] {
  const out: T[] = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (
      prev &&
      m?.role === "assistant" &&
      prev.role === "assistant" &&
      messageContentToPlainText(prev.content) ===
        messageContentToPlainText(m.content)
    ) {
      continue;
    }
    out.push(m);
  }
  return out;
}

/**
 * If the entire string is an exact repeat (X + X), return X.
 * Safe guard for clients that concatenate a full body twice.
 */
export function collapseExactBackToBackDuplicate(text: string): string {
  const t = text;
  if (t.length < 2 || t.length % 2 !== 0) return t;
  const half = t.length / 2;
  if (t.slice(0, half) === t.slice(half)) return t.slice(0, half);
  return t;
}

/**
 * Remove a trailing block that repeats an earlier identical block (intro + body + body).
 */
export function collapseRepeatedTailBlock(
  text: string,
  minBlock = 64,
): string {
  const n = text.length;
  if (n < minBlock * 2) return text;
  for (let tailLen = Math.floor(n / 2); tailLen >= minBlock; tailLen--) {
    const tail = text.slice(n - tailLen);
    const firstIdx = text.indexOf(tail);
    if (firstIdx === -1 || firstIdx === n - tailLen) continue;
    if (firstIdx + tailLen <= n - tailLen) {
      return text.slice(0, n - tailLen);
    }
  }
  return text;
}

export function normalizeAssistantReplyText(text: string): string {
  return collapseRepeatedTailBlock(
    collapseExactBackToBackDuplicate(
      dedupeConsecutiveAssistantSections(text),
    ),
  );
}
