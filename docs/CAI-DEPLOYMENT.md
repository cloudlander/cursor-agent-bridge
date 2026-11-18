# Cloudera AI deployment — agent reference

Short checklist for agents operating this bridge on a **CAI Application** engine.

## Preconditions

- Application script: `app.py` (shebang runner for `app.sh`).
- Engine env must include: `CDSW_API_KEY`. Listen port: `CDSW_APP_PORT` is usual on CAI; if it is in use, `app.sh` tries `CDSW_PUBLIC_PORT`, then `CDSW_READONLY_PORT`, then an explicit `CURSOR_BRIDGE_PORT`. If none are set or bindable, startup exits with an error.
- Cursor CLI credentials (for agent runs): `CURSOR_API_KEY`, `auth.json` under `.cai/home/.config/cursor/`, or **Sign in with Cursor** on the dashboard after the app starts (no auth required for `app.sh` to bind the port).

## Bootstrap sequence

1. **Build + register** (prototype **build-project** job): `scripts/bootstrap-cai-application.py` runs bootstrap (`scripts/bootstrap-cai-application.sh`) then `scripts/create-cai-application.sh` (needs `CDSW_APIV2_KEY`, project id, domain).
2. **Install Cursor CLI into isolated home**: bootstrap script (installs npm via bundled Node when the session has no npm).

Bootstrap and `app.sh` **rebuild automatically** when any `src/` or `public/` file is newer than `dist/cli.js`. Set `CAI_FORCE_BUILD=1` to force a full rebuild after git pull.

Application **subdomain**: set `CAI_APP_SUBDOMAIN` or prototype `APP_SUBDOMAIN` to pin a name; if unset, `create-cai-application.sh` registers `agent-cai-` plus four random lowercase letters or digits.

On application start, `app.sh`:

- Sets `HOME` to `.cai/home`
- Picks the first bindable port among `CDSW_APP_PORT` → `CDSW_PUBLIC_PORT` → `CDSW_READONLY_PORT` → `CURSOR_BRIDGE_PORT` and sets `CURSOR_BRIDGE_PORT`
- Runs bootstrap if `agent` or `dist/cli.js` missing
- Copies existing `auth.json` from project or user home when present; otherwise logs a warning and still starts
- Sets `CURSOR_AGENT_BIN` and bundled Node via `CURSOR_API_PROXY_NODE`
- Sets `CURSOR_BRIDGE_TERMINAL_SSH_PORT=2222` unless already set (Cloudera AI sshd; the process default is 22)
- Sets `CURSOR_BRIDGE_APPROVE_MCPS=true` unless already set, so agent runs pass `--approve-mcps`
- Runs Node on `dist/cli.js` as a child until it exits (`app.sh` / `app.sh start`). **`app.py`** runs `app.sh keepalive` so Dashboard **Restart proxy** (`app.sh stop`) can kill the CLI and the worker brings it back without a full application restart.
- Plugin registry init (CLI cache import + redeploy) runs on **first** visit to `/plugins` or `/api/plugins/*`, not at listen time — dashboard, chat, and `/v1` start as soon as the port is up.
- Logs loopback dashboard URLs in `.cai/startup.log` only after `/healthz` responds (default wait up to **120s**, override with `CURSOR_BRIDGE_STARTUP_WAIT_SEC`). Earlier log lines show the chosen port while bootstrap or Node startup is still running.

Optional **`app.sh` modes** (second argument or first subcommand):

| Mode | Behavior |
|------|----------|
| `start` (default) | Bootstrap if needed, run CLI until killed; worker exits when CLI exits (CAI restarts the application). |
| `stop` | Require `/healthz`, kill the CLI listener, exit when health is down. Dashboard **Restart proxy** uses this on CAI (not the macOS `cursor-api-proxy restart` launcher). |
| `keepalive` | Same bootstrap as `start`; restart CLI automatically after exit. Default CAI application entry via **`app.py`**. |

## URLs

| Audience | URL |
|----------|-----|
| In-engine loopback | `http://127.0.0.1:${CDSW_APP_PORT}/` |
| Health (no auth) | `http://127.0.0.1:${CDSW_APP_PORT}/healthz` |
| Dashboard (browser) | `https://<cluster>/proxy/<id>/{appSegment}/` — segment from `CURSOR_BRIDGE_APP_SEGMENT` or persisted `.bridge-app-segment`. Virtual root `…/proxy/<id>/` redirects via bootstrap. See [PUBLIC-PATH.md](./PUBLIC-PATH.md). |
| OpenAI base (auth) | `http://127.0.0.1:${CDSW_APP_PORT}/v1` |
| Public subdomain | `https://model-gateway.${CDSW_DOMAIN}/` (when configured) |

Use **`CDSW_API_KEY`** as the bearer token for `/v1` from other CAI workloads unless `CURSOR_BRIDGE_API_KEY` is explicitly set.

At startup, `app.sh` calls `GET ${CDSW_ENGINE_URL}/application` (with `CDSW_API_KEY`) and exports **`CURSOR_BRIDGE_CDSW_BYPASS_AUTHENTICATION`** from JSON `bypass_authentication` (defaults to `true` if the call fails). When that value is **`false`**, the CAI application requires interactive auth and inbound `/v1` and `/health` skip API-key checks (traffic already passed CAI). `Remote-user-perm: Unauthorized` (with `Remote-user` set) is still rejected immediately. When bypass is **`true`**, only the usual CDSW/bridge API key satisfies inbound auth.

## User-deployed web apps (dynamic routes)

Static and dynamic apps are served **without restarting** the bridge. The standard deploy package is a `cursor-bridge-app` version `1` zip (`manifest.json` plus `payload/`). An app with no `launch` is static and can be exported. A dynamic app has `launch` and `port`. `POST /api/apps/deploy` is the only deployment API: a static app is copied into place, and a dynamic app is registered so the supervisor starts it. `kind` may be omitted and is inferred from `launch`. See the bundle table in [README.md](../README.md).

| Route | Purpose |
|-------|---------|
| `/{name}/` | Short URL for deployed app (e.g. `/aigc-course/`) |
| `/apps/{name}/` | Canonical app URL |
| `/apps` | Redirects to the dashboard **Deployed apps** card |
| `GET /api/apps` | JSON list of static and dynamic apps + `appsDir` path |
| `POST /api/apps/deploy` | Only deployment API. Zip (`Content-Type: application/zip`): static is copied and served; dynamic is registered and the supervisor starts it. JSON `{ "name", "sourceDir" }` copies a static workspace folder. JSON `{ "name", "port", "launch?", … }` deploys a process already listening on `127.0.0.1` |
| `GET /api/apps/{name}/export` | Download the app as `{name}.zip` (static or dynamic) |
| `POST /api/apps/{name}/restart` | Start or restart a dynamic app. 400 for a static app |
| `POST /api/apps/{name}/stop` | Stop a dynamic app; it is not relaunched until Restart. 400 for a static app |
| `DELETE /api/apps/{name}` | Delete a static or dynamic app. A dynamic app is stopped and its registration and installed files are removed |

Apps live under `<HOME>/.cursor-api-proxy/apps/` (override with `CURSOR_BRIDGE_APPS_DIR`). A static app must include `index.html` and supports deploy, export, and delete. A dynamic app is a JSON registration under `apps/.catalog/` reverse-proxied to localhost, and also supports restart and stop. The supervisor starts launch-backed apps on listen and restarts them when `GET /__bridge/catalog-health` fails. Stop survives a bridge restart. The dashboard **Deployed apps** card (search by name, 5 per page) and the chat panel Apps tab use these routes and require no bridge API key.

Move an app to another bridge:

```bash
curl -s -o aigc-course.zip "http://127.0.0.1:${CDSW_APP_PORT}/api/apps/aigc-course/export"
curl -s -X POST "http://127.0.0.1:${CDSW_APP_PORT}/api/apps/deploy" \
  -H "content-type: application/zip" \
  --data-binary @aigc-course.zip
```

Example (from project root after building a site under `public/aigc-course/`):

```bash
curl -s -X POST "http://127.0.0.1:${CDSW_APP_PORT}/api/apps/deploy" \
  -H "content-type: application/json" \
  -d '{"name":"aigc-course","sourceDir":"public/aigc-course"}'
```

Then open `https://model-gateway.${CDSW_DOMAIN}/aigc-course/` (or loopback on the engine).

## Plugins and MCP on CAI

- UI: `/plugins` on the same port (no bridge key).
- MCP OAuth callbacks bind `localhost:8787` on the **engine host**. From Plugins → OAuth login, paste the localhost callback address the browser lands on. The page rewrites the host to this application’s `/callback`, which forwards `code` and `state` to the CLI. SSH `-L 8787:127.0.0.1:8787` still opens that localhost address directly. The login window closes when authentication finishes, or after 5 minutes (`CURSOR_BRIDGE_MCP_OAUTH_TIMEOUT_MS`). The configuration window shows success or failure, and the configuration is saved only after success.
- Installed plugins deploy into Cursor config dirs; chat-only sandboxes copy a runtime tree per request (see README).

## Upstream auto-sync (optional)

Set `CURSOR_BRIDGE_UPSTREAM_SYNC=true` on the application only when this deployment is a **git clone with push credentials** and you want weekly merges from [cursor-api-proxy](https://github.com/anyrobert/cursor-api-proxy). The proxy runs `git` and `npm test` on the engine (uses `rsync` when installed, else a Node mirror); successful server-side updates show a dashboard/chat banner and recommend **restart** (redeploy/restart the CAI application). Default is **off** so production apps do not mutate their own checkout.

## Failure modes (quick diagnosis)

| Symptom | Likely cause | Action |
|---------|--------------|--------|
| 401 on `/v1` | Wrong or missing `CDSW_API_KEY` / bridge key, or `Remote-user-perm: Unauthorized` when CAI auth is on | Match application env; read `CURSOR_BRIDGE_CDSW_BYPASS_AUTHENTICATION` in startup log; check `bridge-api-auth.ts` |
| Agent exits mid-stream | `CURSOR_BRIDGE_TIMEOUT_MS` too low | Raise in application env (CAI default 900000) |
| `agent: not found` | Bootstrap not run | Run `bootstrap-cai-application.sh`; verify `.cai/home/.local/bin/agent` |
| `npm not found` during build | Session lacks npm; agent bundle has only `node` | Re-run bootstrap; check `.cai/home/.local/bin/npm` |
| `/usr/bin/env: 'node': No such file` after npm install | Bundled `node` was not on `PATH` (npm shebang) | Re-run bootstrap (symlinks `.cai/home/.local/bin/node`); or `ln -sf …/versions/*/node .cai/home/.local/bin/node` |
| Dashboard looks like upstream only (no Chat/Plugins/Sign in) | Stale checkout or upstream `public/index.html` | Pull latest; run bootstrap or restart app (rebuilds when `public/` changed); open `/chat` and `/plugins` directly |
| ACP session missing from `/chat` | Transcript is only in `store.db`, which Web Chat does not read | `npm run restore-acp-to-web -- .cai/home/.cursor-api-proxy/accounts/<account>/acp-sessions/<id>` (see README) |
| Empty models list | CLI not logged in | Set `CURSOR_API_KEY` or `HOME=.cai/home agent login` |
| Hang on startup | Stale `cursor --version` | `app.sh` already reaps; check `.cai/startup.log` |
| `Permission denied` on `app.sh` / bootstrap after `git pull` | Script committed without executable bit (older clones) | `git pull` again after upstream fix, or `git update-index --chmod=+x app.sh scripts/*.sh` and commit; temporary: `bash app.sh` |

Logs: `.cai/startup.log` (application stdout from `app.sh`), proxy stderr from the Node process, `sessions.log` under configured `HOME`.

## Agent mode vs ask mode

CAI **`app.sh` sets `CURSOR_BRIDGE_MODE=agent`** so the CLI may use tools against the workspace when `CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE=false`. For read-only Q&A, set `CURSOR_BRIDGE_MODE=ask` on the application or pass `X-Cursor-Mode: ask` per request.

See [AGENTS.md](../AGENTS.md) for code locations and sync instructions.
