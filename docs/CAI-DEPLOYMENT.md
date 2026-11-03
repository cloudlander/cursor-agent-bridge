# Cloudera AI deployment — agent reference

Short checklist for agents operating this bridge on a **CAI Application** engine.

## Preconditions

- Application script: `app.py` (shebang runner for `app.sh`).
- Engine env must include: `CDSW_APP_PORT`, `CDSW_API_KEY`.
- Cursor CLI credentials (for agent runs): `CURSOR_API_KEY`, `auth.json` under `.cai/home/.config/cursor/`, or **Sign in with Cursor** on the dashboard after the app starts (no auth required for `app.sh` to bind the port).

## Bootstrap sequence

1. **Build TypeScript** (in a session with Node 18+): `npm install && npm run build`, or run the prototype **build-project** job (`scripts/bootstrap-cai-application.sh`).
2. **Install Cursor CLI into isolated home**: same bootstrap script (installs npm via bundled Node when the session has no npm).

Bootstrap and `app.sh` **rebuild automatically** when any `src/` or `public/` file is newer than `dist/cli.js`. Set `CAI_FORCE_BUILD=1` to force a full rebuild after git pull.
3. **Register application** (once per project/subdomain): `scripts/create-cai-application.sh` with `CDSW_APIV2_KEY`, project id, domain.

On application start, `app.sh`:

- Sets `HOME` to `.cai/home`
- Runs bootstrap if `agent` or `dist/cli.js` missing
- Copies existing `auth.json` from project or user home when present; otherwise logs a warning and still starts
- Sets `CURSOR_AGENT_BIN` and bundled Node via `CURSOR_API_PROXY_NODE`
- `exec` Node on `dist/cli.js`

## URLs

| Audience | URL |
|----------|-----|
| In-engine loopback | `http://127.0.0.1:${CDSW_APP_PORT}/` |
| Health (no auth) | `http://127.0.0.1:${CDSW_APP_PORT}/healthz` |
| OpenAI base (auth) | `http://127.0.0.1:${CDSW_APP_PORT}/v1` |
| Public subdomain | `https://model-gateway.${CDSW_DOMAIN}/` (when configured) |

Use **`CDSW_API_KEY`** as the bearer token for `/v1` from other CAI workloads unless `CURSOR_BRIDGE_API_KEY` is explicitly set.

## Plugins and MCP on CAI

- UI: `/plugins` on the same port (no bridge key).
- MCP OAuth callbacks bind `localhost:8787` on the **engine host** — use SSH/port-forward from a laptop to complete OAuth when needed.
- Installed plugins deploy into Cursor config dirs; chat-only sandboxes copy a runtime tree per request (see README).

## Failure modes (quick diagnosis)

| Symptom | Likely cause | Action |
|---------|--------------|--------|
| 401 on `/v1` | Wrong or missing `CDSW_API_KEY` / bridge key | Match application env; check `bridge-api-auth.ts` flags |
| Agent exits mid-stream | `CURSOR_BRIDGE_TIMEOUT_MS` too low | Raise in application env (CAI default 900000) |
| `agent: not found` | Bootstrap not run | Run `bootstrap-cai-application.sh`; verify `.cai/home/.local/bin/agent` |
| `npm not found` during build | Session lacks npm; agent bundle has only `node` | Re-run bootstrap; check `.cai/home/.local/bin/npm` |
| `/usr/bin/env: 'node': No such file` after npm install | Bundled `node` was not on `PATH` (npm shebang) | Re-run bootstrap (symlinks `.cai/home/.local/bin/node`); or `ln -sf …/versions/*/node .cai/home/.local/bin/node` |
| Dashboard looks like upstream only (no Chat/Plugins/Sign in) | Stale checkout or upstream `public/index.html` | Pull latest; run bootstrap or restart app (rebuilds when `public/` changed); open `/chat` and `/plugins` directly |
| Empty models list | CLI not logged in | Set `CURSOR_API_KEY` or `HOME=.cai/home agent login` |
| Hang on startup | Stale `cursor --version` | `app.sh` already reaps; check `.cai/startup.log` |

Logs: `.cai/startup.log` (application stdout from `app.sh`), proxy stderr from the Node process, `sessions.log` under configured `HOME`.

## Agent mode vs ask mode

CAI **`app.sh` sets `CURSOR_BRIDGE_MODE=agent`** so the CLI may use tools against the workspace when `CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE=false`. For read-only Q&A, set `CURSOR_BRIDGE_MODE=ask` on the application or pass `X-Cursor-Mode: ask` per request.

See [AGENTS.md](../AGENTS.md) for code locations and sync instructions.
