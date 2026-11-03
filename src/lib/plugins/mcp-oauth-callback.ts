import * as http from "node:http";
import type * as httpTypes from "node:http";

const HTML = "text/html; charset=utf-8";

export function mcpOAuthLoopbackPort(): number {
  const raw = process.env.CURSOR_BRIDGE_MCP_OAUTH_LOOPBACK_PORT?.trim();
  if (!raw) return 8787;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 8787;
}

export function mcpOAuthCallbackMatches(req: httpTypes.IncomingMessage): boolean {
  const pathname = (req.url ?? "").split("?")[0] ?? "";
  return req.method === "GET" && pathname === "/callback";
}

/** Forward browser OAuth redirect to Cursor CLI loopback listener (127.0.0.1:8787/callback). */
export function handleMcpOAuthCallback(
  req: httpTypes.IncomingMessage,
  res: httpTypes.ServerResponse,
  reqUrl: URL,
): void {
  const port = mcpOAuthLoopbackPort();
  const path = `${reqUrl.pathname}${reqUrl.search}`;
  const target = new URL(path, `http://127.0.0.1:${port}`);

  const proxyReq = http.request(
    target,
    {
      method: "GET",
      headers: {
        host: `127.0.0.1:${port}`,
        accept: req.headers.accept ?? "*/*",
      },
    },
    (proxyRes) => {
      const headers: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        if (v !== undefined) headers[k] = v;
      }
      res.writeHead(proxyRes.statusCode ?? 502, headers);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on("error", () => {
    res.writeHead(503, { "content-type": HTML });
    res.end(
      `<!doctype html><html><body style="font-family:system-ui;padding:2rem;max-width:40rem">
<h1>OAuth callback</h1>
<p>MCP login is not listening on <code>127.0.0.1:${port}</code>.</p>
<p>Start OAuth from the <a href="/plugins">Plugins</a> page again, then complete sign-in in the same browser session.</p>
</body></html>`,
    );
  });

  proxyReq.end();
}
