# Public path, mount, and app segment

## Summary

The bridge is served under a **fixed application path segment** (default `cursor-agent`, overridable via `CURSOR_BRIDGE_APP_SEGMENT`) with an optional **mount prefix** inferred per request from the URL (e.g. `/proxy/1080/cursor-agent/chat`).

- **Internal routing** unchanged: `/chat`, `/api/...`, `/v1/...`, `/static/...`
- **Public URLs**: `{mount}/{appSegment}{internal}`
- **`/healthz`**: always at server root (CAI probes)
- **No `CURSOR_BRIDGE_MOUNT` env**: mount is derived per request from (in order) the request pathname, `X-Forwarded-Prefix` / `X-Forwarded-Uri`, or the `cursor_bridge_mount` cookie set by the bootstrap page when the edge strips the proxy prefix

## Environment

| Variable | Default | Notes |
|----------|---------|-------|
| `CURSOR_BRIDGE_APP_SEGMENT` | `cursor-agent` (or persisted random `agent-*` on CAI) | Single URL path segment; reserved for this instance |

## Entry bootstrap

Requests without `/{appSegment}/` in the path serve a minimal bootstrap page (`/`, `/index.html`, `/{mount}/`, `/{mount}/index.html`) that redirects the browser to `{mount}/{appSegment}/`.

## Direct bind (optional)

When the URL has no mount and no app segment, routes such as `/v1/*`, `/api/*`, `/chat`, and `/static/*` still work for local SDK use (`http://127.0.0.1:8765/v1/...`). Production behind a reverse proxy should use `{mount}/{appSegment}/...`.

## Reverse proxy

**Option A — preserve path** (simplest for the app):

```nginx
location /proxy/1080/ {
  proxy_pass http://127.0.0.1:8765/proxy/1080/;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

**Option B — strip prefix at the edge** (common on CAI): upstream may see `/agent-xxx/...` while the browser shows `/proxy/1080/agent-xxx/...`. Then either:

- Set `X-Forwarded-Prefix: /proxy/8080` (or `X-Forwarded-Uri` with the full public path), or
- Rely on the bootstrap redirect setting `cursor_bridge_mount` before the first dashboard load (users should open `…/proxy/8080/` once, not deep-link without going through bootstrap).

## Client assets

HTML responses are rewritten server-side; JavaScript uses `bridgePath()` from `public/bridge-path.js`.

## SDK

Base URL: `https://{host}{mount}/{appSegment}` (e.g. `.../proxy/1080/agent-7f3k/v1/chat/completions`).
