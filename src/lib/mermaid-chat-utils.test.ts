import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { describe, expect, it, beforeAll } from "vitest";

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

type ChatMermaidUtils = {
  prepareMermaidSource: (source: string) => string;
  sanitizeMermaidSvg: (svg: string) => string;
  isMeaningfulMermaidSvg: (svg: string) => boolean;
  computeMermaidLightboxLayout: (
    natW: number,
    natH: number,
    availW: number,
    availH: number,
  ) => { displayW: number; displayH: number; wrapW: number; wrapH: number };
};

let utils: ChatMermaidUtils;

beforeAll(() => {
  const window = new Window();
  const g = globalThis as Record<string, unknown>;
  g.window = window;
  g.document = window.document;
  g.DOMParser = window.DOMParser;
  g.XMLSerializer = window.XMLSerializer;
  const code = readFileSync(path.join(root, "public/mermaid-chat-utils.js"), "utf8");
  new Function("window", `${code}\nreturn window.ChatMermaidUtils;`)(window);
  const loaded = (window as unknown as { ChatMermaidUtils?: ChatMermaidUtils }).ChatMermaidUtils;
  if (!loaded) throw new Error("ChatMermaidUtils missing");
  utils = loaded;
});

describe("prepareMermaidSource", () => {
  it("keeps participant alias on one line when model uses <br/>", () => {
    const inSrc =
      "sequenceDiagram\n  participant Bridge as cursor-agent-bridge<br/>Node 监听端口\n  Bridge->>CLI: test";
    const out = utils.prepareMermaidSource(inSrc);
    expect(out).toContain("participant Bridge as cursor-agent-bridge Node 监听端口");
    expect(out).not.toMatch(/participant[^\n]*\n[^\n]*Node/);
  });

  it("converts <br/> to newlines inside flowchart node labels", () => {
    const inSrc = 'flowchart TB\n  U["line1<br/>line2"]';
    const out = utils.prepareMermaidSource(inSrc);
    expect(out).toContain('U["line1\nline2"]');
  });
});

describe("sanitizeMermaidSvg", () => {
  it("keeps foreignObject labels (strict mermaid output)", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">ok</div></foreignObject><path d="M0 0"/></svg>';
    const out = utils.sanitizeMermaidSvg(svg);
    expect(out.toLowerCase()).toContain("foreignobject");
    expect(out).toContain("<path");
  });

  it("strips script tags", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><text>hi</text></svg>';
    const out = utils.sanitizeMermaidSvg(svg);
    expect(out.toLowerCase()).not.toContain("<script");
    expect(out).toContain("<text");
  });
});

describe("computeMermaidLightboxLayout", () => {
  it("scales up small diagrams to fill the viewport", () => {
    const layout = utils.computeMermaidLightboxLayout(100, 50, 800, 400);
    expect(layout.displayW).toBe(800);
    expect(layout.displayH).toBe(400);
    expect(layout.wrapW).toBe(800);
    expect(layout.wrapH).toBe(400);
  });

  it("keeps natural size when larger than viewport and expands wrapper for scroll", () => {
    const layout = utils.computeMermaidLightboxLayout(2000, 1000, 800, 400);
    expect(layout.displayW).toBe(2000);
    expect(layout.displayH).toBe(1000);
    expect(layout.wrapW).toBe(2000);
    expect(layout.wrapH).toBe(1000);
  });
});

describe("isMeaningfulMermaidSvg", () => {
  it("rejects empty svg shells", () => {
    expect(utils.isMeaningfulMermaidSvg('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).toBe(false);
  });

  it("accepts svg with shapes", () => {
    expect(
      utils.isMeaningfulMermaidSvg(
        '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>',
      ),
    ).toBe(true);
  });
});
