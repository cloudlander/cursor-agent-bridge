# Public path, mount, and app segment

## Summary

The bridge is served under a **fixed application path segment** (default `cursor-agent`, overridable via `CURSOR_BRIDGE_APP_SEGMENT`) with an optional **mount prefix** inferred per request from the URL (e.g. `/proxy/1080/cursor-agent/chat`).

- **Internal routing** unchanged: `/chat`, `/api/...`, `/v1/...`, `/static/...`
- **Public URLs**: `{mount}/{appSegment}{internal}`
- **`/healthz`**: always at server root (CAI probes)
- **No `CURSOR_BRIDGE_MOUNT` env**: mount is derived per request from (in order) the external request pathname, `X-Forwarded-Prefix` / `X-Forwarded-Uri`, or empty. Pathnames are taken from origin-form paths (`/proxy/8100/...`) or absolute request targets (`https://host/proxy/8100/...`). Dashboard **Status** shows full public OpenAI API and Agent chat URLs. The browser may still infer mount from `location.pathname` when server context is empty; do not use a shared cookie (multiple proxies on one host would clash).

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

- Set `X-Forwarded-Prefix: /proxy/8080` (or `X-Forwarded-Uri` with the full public path) so server-side redirects and OAuth URLs are correct when the edge strips the prefix, and/or
- Ensure users open the app via the full public URL (`…/proxy/8080/agent-xxx/…`); client `bridge-path.js` derives mount from the address bar when the server sees a stripped path.

## Client assets

HTML responses are rewritten server-side; JavaScript uses `bridgePath()` from `public/bridge-path.js`.

## SDK

Base URL: `https://{host}{mount}/{appSegment}` (e.g. `.../proxy/1080/agent-7f3k/v1/chat/completions`).
