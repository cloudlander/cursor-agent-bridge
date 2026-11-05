import { describe, expect, it } from "vitest";

import { isGitCommitRef, parseSource } from "./marketplace.js";

describe("isGitCommitRef", () => {
  it("detects full commit SHAs", () => {
    expect(isGitCommitRef("9de1ab435251042efbb6839a1ca748eacecf4727")).toBe(true);
    expect(isGitCommitRef("2776ddd2355d6d6c8747d3964600f28daf62f049")).toBe(true);
  });

  it("rejects branch and tag names", () => {
    expect(isGitCommitRef("main")).toBe(false);
    expect(isGitCommitRef("v0.3.0")).toBe(false);
    expect(isGitCommitRef("9de1ab4")).toBe(false);
  });
});

describe("parseSource", () => {
  it("accepts local path objects used by Slack-style marketplaces", () => {
    expect(parseSource({ source: "local", path: "./" }, undefined)).toEqual({
      kind: "path",
      path: "",
    });
  });

  it("accepts github repo shorthand", () => {
    expect(parseSource({ source: "github", repo: "org/repo" }, undefined)).toEqual({
      kind: "git",
      url: "https://github.com/org/repo",
      ref: undefined,
      path: undefined,
    });
  });
});
