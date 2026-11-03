import { describe, expect, it } from "vitest";

import {
  matchCliModelToAcpCatalog,
  normalizeModelBase,
  parseCliModelId,
  shouldRejectUnresolvedAcpModel,
} from "./acp-model-match.js";

const SAMPLE_ACP = [
  {
    modelId: "claude-sonnet-5[thinking=true,context=300k,effort=high]",
    name: "Claude Sonnet 5",
  },
  {
    modelId: "gpt-5.6-sol[context=272k,reasoning=medium,fast=false]",
    name: "GPT-5.6 Sol",
  },
  {
    modelId: "gpt-5.6-sol[reasoning=high]",
    name: "GPT-5.6 Sol High",
  },
  {
    modelId: "claude-sonnet-5-5[context=300k,reasoning_effort=high]",
    name: "Claude Sonnet 5.5  High",
  },
  {
    modelId: "composer-2.5[fast=true]",
    name: "Composer 2.5",
  },
] as const;

describe("parseCliModelId", () => {
  it("parses thinking effort variants", () => {
    expect(parseCliModelId("claude-sonnet-5-thinking-xhigh")).toEqual({
      base: "claude-sonnet-5",
      thinking: true,
      effort: "xhigh",
      fast: undefined,
    });
  });

  it("parses fast suffixes", () => {
    expect(parseCliModelId("claude-opus-5-thinking-xhigh-fast")).toEqual({
      base: "claude-opus-5",
      thinking: true,
      effort: "xhigh",
      fast: true,
    });
  });
});

describe("normalizeModelBase", () => {
  it("normalizes Claude version ordering", () => {
    expect(normalizeModelBase("claude-4.5-sonnet")).toBe("claude-sonnet-4.5");
  });
});

describe("matchCliModelToAcpCatalog", () => {
  it("matches exact ACP display names", () => {
    expect(
      matchCliModelToAcpCatalog(
        "claude-sonnet-5-5-high",
        ["Claude Sonnet 5.5  High"],
        SAMPLE_ACP,
      )?.modelId,
    ).toBe("claude-sonnet-5-5[context=300k,reasoning_effort=high]");
  });

  it("maps thinking CLI ids to the closest ACP base model", () => {
    expect(
      matchCliModelToAcpCatalog(
        "claude-sonnet-5-thinking-xhigh",
        ["Claude Sonnet 5 1M Extra High Thinking"],
        SAMPLE_ACP,
      )?.modelId,
    ).toBe("claude-sonnet-5[thinking=true,context=300k,effort=high]");
  });

  it("maps reasoning CLI ids when ACP exposes the variant name", () => {
    expect(
      matchCliModelToAcpCatalog(
        "gpt-5.6-sol-high",
        ["GPT-5.6 Sol High"],
        SAMPLE_ACP,
      )?.modelId,
    ).toBe("gpt-5.6-sol[reasoning=high]");
  });

  it("falls back to the base ACP model when only the family is listed", () => {
    expect(
      matchCliModelToAcpCatalog("gpt-5.6-sol-low", ["GPT-5.6 Sol Low"], [
        {
          modelId: "gpt-5.6-sol[context=272k,reasoning=medium,fast=false]",
          name: "GPT-5.6 Sol",
        },
      ])?.modelId,
    ).toBe("gpt-5.6-sol[context=272k,reasoning=medium,fast=false]");
  });
});

describe("shouldRejectUnresolvedAcpModel", () => {
  it("allows argv-selected models when the ACP catalog misses", () => {
    expect(
      shouldRejectUnresolvedAcpModel({
        requested: "claude-sonnet-5-thinking-xhigh",
        resolved: "default[]",
        strictModel: true,
        modelOnArgv: true,
      }),
    ).toBe(false);
  });

  it("still rejects unresolved models without an argv fallback", () => {
    expect(
      shouldRejectUnresolvedAcpModel({
        requested: "claude-sonnet-5-thinking-xhigh",
        resolved: "default[]",
        strictModel: true,
        modelOnArgv: false,
      }),
    ).toBe(true);
  });
});
