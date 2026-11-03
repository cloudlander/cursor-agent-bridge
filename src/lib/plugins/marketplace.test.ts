import { describe, expect, it } from "vitest";

import { parseSource } from "./marketplace.js";

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
