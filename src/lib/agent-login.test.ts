import { describe, expect, it } from "vitest";

import {
  AGENT_LOGIN_URL_RE,
  extractAgentLoginUrl,
} from "./agent-login.js";

describe("extractAgentLoginUrl", () => {
  it("extracts loginDeepControl URL with redirectTarget=cli", () => {
    const url =
      "https://cursor.com/loginDeepControl?challenge=abc&uuid=1&mode=login&redirectTarget=cli";
    const text = `Authenticating...\nOpen this URL:\n${url}\n`;
    expect(extractAgentLoginUrl(text)).toBe(url);
  });

  it("buffers across chunks (whitespace stripped)", () => {
    const part1 = "https://cursor.com/loginDeepControl?challenge=abc";
    const part2 = "&uuid=1&mode=login&redirectTarget=cli";
    expect(extractAgentLoginUrl(part1 + part2)).toBe(
      part1 + part2,
    );
  });

  it("matches AGENT_LOGIN_URL_RE like CLI login", () => {
    const text =
      "foo https://cursor.com/loginDeepControl?x=1&redirectTarget=cli bar";
    expect(text.match(AGENT_LOGIN_URL_RE)?.[1]?.replace(/\s+/g, "")).toBe(
      "https://cursor.com/loginDeepControl?x=1&redirectTarget=cli",
    );
  });

  it("returns undefined when URL incomplete", () => {
    expect(
      extractAgentLoginUrl("https://cursor.com/loginDeepControl?challenge=1"),
    ).toBeUndefined();
  });
});
