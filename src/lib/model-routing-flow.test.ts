import { afterEach, describe, expect, it, vi } from "vitest";

import { initAccountPool } from "./account-pool.js";
import { resolveModelWithOptionalRouting } from "./model-routing-flow.js";
import { testBridgeConfig } from "./test-bridge-config.js";

vi.mock("./model-router.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./model-router.js")>();
  return {
    ...actual,
    routeModel: vi.fn(),
  };
});

import { routeModel } from "./model-router.js";

describe("resolveModelWithOptionalRouting", () => {
  afterEach(() => {
    vi.clearAllMocks();
    initAccountPool([]);
  });

  const ids = ["composer-2.5", "claude-3-opus"];
  const messages = [{ role: "user", content: "plan a refactor" }];

  it("does not route when router is disabled", async () => {
    const ref: { current?: string } = {};
    const result = await resolveModelWithOptionalRouting({
      config: testBridgeConfig({ routerEnabled: false, defaultModel: "composer-2.5" }),
      requested: "auto",
      lastRequestedModelRef: ref,
      messages,
      availableCursorIds: ids,
    });
    expect(routeModel).not.toHaveBeenCalled();
    expect(result.rememberModel).toBe(true);
    expect(result.skipSessionMemory).toBe(false);
    expect(result.routeDecision).toBeUndefined();
  });

  it("routes eligible requests and skips session memory", async () => {
    vi.mocked(routeModel).mockResolvedValue({
      model: "claude-3-opus",
      routed: true,
      reason: "classified",
      remainingRatio: 0.4,
    });
    const ref: { current?: string } = { current: "composer-2.5" };
    const result = await resolveModelWithOptionalRouting({
      config: testBridgeConfig({
        routerEnabled: true,
        defaultModel: "composer-2.5",
      }),
      requested: "auto",
      lastRequestedModelRef: ref,
      messages,
      availableCursorIds: ids,
    });
    expect(routeModel).toHaveBeenCalledOnce();
    expect(result.model).toBe("claude-3-opus");
    expect(result.rememberModel).toBe(false);
    expect(result.skipSessionMemory).toBe(true);
    expect(result.routeDecision?.reason).toBe("classified");
    expect(ref.current).toBe("composer-2.5");
  });

  it("uses pre-selected configDir without round-robin", async () => {
    initAccountPool(["/acc-a", "/acc-b"]);
    vi.mocked(routeModel).mockResolvedValue({
      model: "composer-2.5",
      routed: true,
      reason: "classifier-default",
      remainingRatio: 0.5,
    });
    const result = await resolveModelWithOptionalRouting({
      config: testBridgeConfig({
        routerEnabled: true,
        configDirs: ["/acc-a", "/acc-b"],
      }),
      requested: undefined,
      lastRequestedModelRef: {},
      messages,
      availableCursorIds: ids,
      configDir: "/acc-b",
    });
    expect(result.configDir).toBe("/acc-b");
    expect(routeModel).toHaveBeenCalledWith(
      expect.objectContaining({ configDir: "/acc-b" }),
    );
  });

  it("tool continuation model bypasses routeModel", async () => {
    const result = await resolveModelWithOptionalRouting({
      config: testBridgeConfig({ routerEnabled: true }),
      requested: "auto",
      lastRequestedModelRef: {},
      messages,
      availableCursorIds: ids,
      toolContinuationModel: "claude-3-opus",
    });
    expect(routeModel).not.toHaveBeenCalled();
    expect(result.model).toBe("claude-3-opus");
    expect(result.routeDecision).toBeUndefined();
  });
});
