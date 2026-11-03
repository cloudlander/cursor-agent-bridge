import { describe, it, expect, vi } from "vitest";
import {
  createAssistantTextDeduper,
  createGuardedAssistantTextEmitter,
} from "./assistant-stream-dedupe.js";

describe("createAssistantTextDeduper", () => {
  it("skips duplicate final full message (CLI stream-json)", () => {
    const onText = vi.fn();
    const push = createAssistantTextDeduper(onText);
    push("OK");
    push("OK");
    expect(onText).toHaveBeenCalledTimes(1);
    expect(onText).toHaveBeenCalledWith("OK");
  });

  it("handles incremental partial deltas then duplicate final", () => {
    const onText = vi.fn();
    const push = createAssistantTextDeduper(onText);
    push("Hel");
    push("lo");
    push("Hello");
    expect(onText).toHaveBeenCalledTimes(2);
    expect(onText.mock.calls.map((c) => c[0]).join("")).toBe("Hello");
  });

  it("skips a restarted cumulative that is already embedded (intro + body, then body again)", () => {
    const onText = vi.fn();
    const push = createAssistantTextDeduper(onText);
    const intro = "正在快速查看配置。\n\n";
    const body =
      "可以，两套部署是可行且常见的：Mac Cursor + 远程 proxy。".repeat(3);
    push(intro + body);
    push(body);
    expect(onText).toHaveBeenCalledTimes(1);
    expect(onText.mock.calls[0]![0]).toBe(intro + body);
  });
});

describe("createGuardedAssistantTextEmitter", () => {
  it("collapses a full duplicate body re-emitted as one chunk", () => {
    const onDelta = vi.fn();
    const emit = createGuardedAssistantTextEmitter(onDelta);
    emit("Answer");
    emit("Answer");
    expect(onDelta).toHaveBeenCalledTimes(1);
    expect(onDelta).toHaveBeenCalledWith("Answer");
  });
});
