import { describe, it, expect } from "vitest";
import {
  collapseExactBackToBackDuplicate,
  collapseRepeatedTailBlock,
  dedupeConsecutiveAssistantMessages,
  dedupeConsecutiveAssistantSections,
  dedupeConsecutiveUserMessages,
  normalizeAssistantReplyText,
} from "./assistant-text-dedupe.js";

describe("dedupeConsecutiveAssistantSections", () => {
  it("removes duplicate Assistant blocks before the next User turn", () => {
    const input =
      "User: Review\n\nAssistant: Same body.\n\nAssistant: Same body.\n\nUser: follow-up\n\nAssistant:";
    expect(dedupeConsecutiveAssistantSections(input)).toBe(
      "User: Review\n\nAssistant: Same body.\n\nUser: follow-up\n\nAssistant:",
    );
  });
});

describe("dedupeConsecutiveUserMessages", () => {
  it("drops consecutive user messages with identical content", () => {
    const messages = [
      { role: "assistant", content: "Hi" },
      { role: "user", content: "Same?" },
      { role: "user", content: "Same?" },
    ];
    expect(dedupeConsecutiveUserMessages(messages)).toEqual([
      { role: "assistant", content: "Hi" },
      { role: "user", content: "Same?" },
    ]);
  });
});

describe("dedupeConsecutiveAssistantMessages", () => {
  it("drops consecutive assistant messages with identical content", () => {
    const messages = [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
      { role: "assistant", content: "Hello" },
      { role: "user", content: "Again" },
    ];
    expect(dedupeConsecutiveAssistantMessages(messages)).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
      { role: "user", content: "Again" },
    ]);
  });
});

describe("collapseExactBackToBackDuplicate", () => {
  it("collapses exact doubled strings", () => {
    expect(collapseExactBackToBackDuplicate("ONCEONCE")).toBe("ONCE");
    expect(collapseExactBackToBackDuplicate("ONCE")).toBe("ONCE");
  });
});

describe("collapseRepeatedTailBlock", () => {
  it("removes a duplicated tail block after an intro", () => {
    const intro = "Line one.\n\n";
    const body = "Same paragraph content here. ".repeat(4);
    const doubled = intro + body + body;
    expect(collapseRepeatedTailBlock(doubled)).toBe(intro + body);
  });
});

describe("normalizeAssistantReplyText", () => {
  it("applies section and exact-body dedupe", () => {
    const doubled = "AnswerAnswer";
    expect(normalizeAssistantReplyText(doubled)).toBe("Answer");
  });
});
