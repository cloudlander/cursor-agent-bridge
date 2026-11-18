import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

function loadRewrite(): (pasted: string, publicCallback: string) => string {
  const file = path.resolve("public/oauth-callback-rewrite.js");
  const code = fs.readFileSync(file, "utf8");
  const sandbox: {
    URL: typeof URL;
    rewriteLoopbackOAuthCallback?: (pasted: string, publicCallback: string) => string;
  } = { URL };
  vm.runInNewContext(code, sandbox, { filename: file });
  const fn = sandbox.rewriteLoopbackOAuthCallback;
  if (!fn) throw new Error("rewriteLoopbackOAuthCallback missing");
  return fn;
}

describe("rewriteLoopbackOAuthCallback", () => {
  const rewrite = loadRewrite();
  const app = "https://cai.example/proxy/8100/agent-1/callback";

  it("keeps code and state and swaps the host to this app", () => {
    const pasted =
      "http://localhost:8787/callback?code=abc+def&state=eyJzdCI6MX0&extra=1";
    const out = new URL(rewrite(pasted, app));
    expect(out.origin + out.pathname).toBe(app);
    expect(out.searchParams.get("code")).toBe("abc def");
    expect(out.searchParams.get("state")).toBe("eyJzdCI6MX0");
    expect(out.searchParams.get("extra")).toBeNull();
  });

  it("rejects a non-loopback address", () => {
    expect(() =>
      rewrite("https://evil.example/callback?code=a&state=b", app),
    ).toThrow(/localhost/);
  });

  it("rejects a callback missing code or state", () => {
    expect(() => rewrite("http://localhost:8787/callback?code=only", app)).toThrow(
      /code and state/,
    );
  });

  it("rejects an app URL that is not /callback", () => {
    expect(() =>
      rewrite(
        "http://127.0.0.1:8787/callback?code=a&state=b",
        "https://cai.example/plugins",
      ),
    ).toThrow(/not valid/);
  });
});
