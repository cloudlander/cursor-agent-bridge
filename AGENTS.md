# AGENTS.md — cursor-agent-bridge

**Cursor Agent Bridge** is a GitHub-hosted fork of [cursor-api-proxy](https://github.com/anyrobert/cursor-api-proxy), tuned for **Cursor CLI agent mode** and a first-class **Cloudera AI (CAI) Application** profile. This file is the **source of truth for coding agents** (Cursor, Claude Code, CI bots): architecture, edit map, GitHub workflow, and merge rules with upstream.

Human install and env tables: [README.md](./README.md). CAI operations: [docs/CAI-DEPLOYMENT.md](./docs/CAI-DEPLOYMENT.md). Dashboard wiki: [docs/WIKI.md](./docs/WIKI.md).

---

## Product identity (GitHub)

| Item | Value |
|------|--------|
| Repository name | `cursor-agent-bridge` |
| npm package | `cursor-agent-bridge` (see `package.json`; upstream publishes `cursor-api-proxy`) |
| CLI binary | **`cursor-api-proxy`** — keep for SDK/docs compatibility with upstream |
| Upstream | [anyrobert/cursor-api-proxy](https://github.com/anyrobert/cursor-api-proxy) @ **1.7.0** baseline |
| License | MIT — root `LICENSE` |

Positioning: **OpenAI-compatible HTTP bridge to Cursor CLI agent mode** — dashboard, web chat, plugins, CDSW inbound auth, CAI bootstrap — not a replacement for the Cursor IDE.

**GitHub remote:** [cloudlander/cursor-agent-bridge](https://github.com/cloudlander/cursor-agent-bridge) — shallow `main` history: upstream **v1.7.0** import, then bridge layer, then LICENSE/CI/docs. No copied upstream git history; treat upstream tags as the baseline reference.

---

## What this system does

```text
HTTP client (OpenAI / Anthropic shape)
    → Node bridge (this repo, port CURSOR_BRIDGE_PORT)
    → cursor-agent / agent subprocess (ACP or CLI stream)
    → Cursor cloud models + optional MCP/skills from deployed plugins
```

The bridge does **not** index `@codebase` unless the CLI runs with a real workspace and prompts/tools supply context.

---

## Agent operating rules (read first)

These rules match common open-source and Cursor agent best practices. Follow them on every task unless the user explicitly overrides them in the chat.

### Scope and quality

1. **Minimize diff scope** — one behavioral change per PR/task; no drive-by refactors or unrelated formatting.
2. **Match existing style** — TypeScript in `src/lib/`, colocated `*.test.ts`, ESM imports, env via `env.ts` / `config.ts`.
3. **Reuse before rewrite** — extend `bridge-api-auth`, `agent-runner`, handlers; do not duplicate upstream logic under new names.
4. **Comments** — only for non-obvious business logic; do not narrate obvious code.
5. **No over-engineering** — no extra abstractions for one-off helpers; avoid speculative error handling for impossible paths.

### Git and GitHub

1. **Do not commit unless the user asks** — stage only what the task requires; never commit secrets or local runtime dirs.
2. **Never commit secrets** — `CDSW_API_KEY`, `CURSOR_API_KEY`, `CURSOR_BRIDGE_API_KEY`, `auth.json`, `.env` with real values, CAI `.cai/home` contents.
3. **Respect `.gitignore`** — `node_modules/`, `.cai/`, `.claude/`, `.cursor-api-proxy/`, logs, `chat-store.json`, local plugin state.
4. **Branch naming** — `fix/…`, `feat/…`, `docs/…`, `chore/upstream-sync-…` (short, kebab-case).
5. **Pull requests** — include Summary + Test plan; link issues when applicable; call out **bridge-only** vs **upstream-aligned** changes.
6. **No destructive git** — no `push --force` to `main`, no `reset --hard`, no skipping hooks, unless the user explicitly requests it.
7. **Do not change git config** — no local `user.email` / credential overrides in automation.

### Definition of done (code changes)

Before marking a task complete:

```bash
npm run typecheck   # or npm run build
npm test
```

- Fix **new** test failures you introduce; document **pre-existing** failures in the PR if you cannot fix them in scope.
- If you add or change env vars, update **README.md** env table and, when CAI-relevant, **docs/CAI-DEPLOYMENT.md**.
- If you change HTTP routes or auth behavior, update **README.md** and this file’s map if paths move.
- Run **`npm run build`** after `src/` edits so `dist/` stays publishable (this repo ships `dist/` in npm `files`).
- **GitHub Actions** (`.github/workflows/ci.yml`): on push/PR to `main`, runs `npm ci`, `typecheck`, `build`, and `npm test` on **Node 22** (minimum supported runtime; Node 18/20 are not tested). Keep CI green when changing flaky timing suites.

### Security (public repo)

- Treat **application stdout** as sensitive when CDSW key logging is enabled (by design on CAI).
- **Dashboard, `/chat`, `/plugins`, `/api/plugins/*`** are intentionally unauthenticated on the listener; document exposure risks; do not “fix” by requiring bridge key on those routes without an explicit product decision.
- **`/v1/*` and `/health`** use bridge/CDSW auth — preserve `bridge-api-auth.ts` semantics when merging upstream.
- Do not add dependencies without justification; prefer Node built-ins and existing stack.

### Upstream relationship

- **Prefer backporting** fixes and features from [cursor-api-proxy](https://github.com/anyrobert/cursor-api-proxy) over reimplementing.
- **Never blindly rsync** the whole tree — preserve **bridge-only** files (listed below).
- When upstream version bumps, align `package.json` `version` and note the upstream tag in the PR description.
- Keep npm bin name **`cursor-api-proxy`** even if the GitHub repo is `cursor-agent-bridge`.

---

## Local development

```bash
git clone https://github.com/cloudlander/cursor-agent-bridge.git
cd cursor-agent-bridge
npm install          # runs prepare → tsc
npm run build
npm test
npm start            # 127.0.0.1:8765 default
```

This path does not use `scripts/bootstrap-cai-application.sh`. If `cursor-agent` / `agent` is installed and a valid CLI token already exists (macOS Keychain, `~/.config/cursor/auth.json`, or `CURSOR_API_KEY`), startup copies that login into `~/.cursor-api-proxy/accounts/` (`CURSOR_BRIDGE_ADOPT_HOST_LOGIN`, default on).

Optional: `scripts/start-local.sh`, `scripts/env.local.sh`, `.env.example` (never commit filled `.env`).

---

## Repository map (where to edit)

| Area | Location | Notes |
|------|----------|--------|
| HTTP server, shutdown | `src/lib/server.ts` | Upstream graceful shutdown + bridge keepalive |
| Plugin UI background init | `src/lib/plugins/manager.ts` (`startPluginsUiBackgroundInit`), `plugin-api.ts`, `server.ts` | CLI sync + redeploy after listen; reads skip wait; `GET /api/plugins/init-status` |
| Route dispatch | `src/lib/request-listener.ts` | `/v1/*`, admin, chat, plugins; CDSW via `bridge-api-auth.ts` |
| Env aliases & defaults | `src/lib/env.ts`, `src/lib/config.ts` | **`CURSOR_BRIDGE_USE_ACP=true` by default**; CDSW inbound key |
| Spawn CLI / ACP | `src/lib/agent-runner.ts`, `src/lib/cursor-cli.ts` | |
| ACP client-tool passthrough | `src/lib/acp-client.ts`, `acp-tool-session.ts`, `client-tool-bridge.ts` | |
| OpenAI handlers | `src/lib/handlers/chat-completions.ts`, `responses.ts`, `completions.ts` | |
| Anthropic handler | `src/lib/handlers/anthropic-messages.ts` | |
| `/v1` auth (incl. CDSW) | `src/lib/bridge-api-auth.ts` | Dashboard/chat/plugins exempt |
| Workspace sandbox | `src/lib/workspace.ts` | Chat-only temp dir vs real cwd |
| Bridge preamble | `src/lib/bridge-context-preamble.ts` | |
| Plugin marketplace & deploy | `src/lib/plugins/*` | |
| Admin UI & web chat | `src/lib/admin-dashboard.ts`, `chat-api.ts`, `public/` | Mobile layout: `public/chat*.css/js` |
| Dynamic user apps | `src/lib/dynamic-apps.ts`, `src/lib/app-catalog.ts`, `src/lib/dynamic-app-supervisor.ts`, `src/lib/app-bundle.ts` | Standard package is the zip bundle below. Served at `/apps/{name}/` and `/{name}/`. One route set for static and dynamic apps under `/api/apps`; `POST /api/apps/deploy` is the only deployment API. Managed in the dashboard Deployed apps card (`public/app.js`) and the chat panel Apps tab (`public/chat-terminal.js`); `/apps` redirects to the dashboard. Storage `<sessions-log-dir>/apps/` |
| CLI entry | `src/cli.ts`, `src/cli/*`, `src/lib/adopt-host-login.ts` | Published bin: `cursor-api-proxy`. Startup adopts an existing host CLI login into the account pool. |
| SDK consumer | `src/client.ts` | npm export `"."` |
| CAI deploy | `app.py`, `app.sh`, `scripts/bootstrap-cai-application.sh`, `docs/CAI-DEPLOYMENT.md` | Not required for generic Node deploy |
| ACP → Web Chat import | `scripts/restore-acp-to-web.mjs` | `npm run restore-acp-to-web -- <acp-session-dir>`; Node 22+ (`node:sqlite`) |
| Tests | `src/**/*.test.ts` | Vitest; colocated with modules |

---

## User app bundle

The standard package for a static or dynamic user app is a `cursor-bridge-app` version `1` zip (`src/lib/app-bundle.ts`). A static app has no launch command. A dynamic app has one.

```text
manifest.json
payload/<files>
```

| Field | Static | Dynamic |
|-------|--------|---------|
| `format` | `"cursor-bridge-app"` | same |
| `version` | `1` | same |
| `name` | app name | same |
| `title`, `description` | optional | optional |
| `launch` | omit | required |
| `port` | omit | required, 1–65535 |
| `ttlMs` | omit | optional milliseconds (default 45000) |
| `kind` | optional `"static"` | optional `"dynamic"` |

`kind` may be omitted. Deploy classifies the bundle by `launch`: no `launch` is static, `launch` present is dynamic. When `kind` is set it must match. A static payload must include `payload/index.html`. An app with no launch command is static and can be exported from its files.

| Method | Path | Static | Dynamic |
|--------|------|--------|---------|
| `GET` | `/api/apps` | `kind: "static"` | `kind: "dynamic"` with `online`, `desired`, `managed` |
| `POST` | `/api/apps/deploy` | zip, or JSON `{ "name", "sourceDir" }` (workspace folder copy) | zip, or JSON `{ "name", "port", "title?", "description?", "ttlSec?", "pid?", "launch?" }` for a process already listening on loopback |
| `GET` | `/api/apps/{name}/export` | `{name}.zip` of its files | `{name}.zip` with `launch` |
| `POST` | `/api/apps/{name}/restart` | 400 | start or restart |
| `POST` | `/api/apps/{name}/stop` | 400 | stop; stays down until Restart, across bridge restarts |
| `DELETE` | `/api/apps/{name}` | remove the copied directory | stop, remove the registration and `.bundles/{name}` |

There is no separate catalog API. All routes are unauthenticated, same as the dashboard. Zip limit is 128MB. Deploy replaces an app of the same name. A static zip copies `payload/` into the apps directory. A dynamic zip extracts to `.bundles/{name}/` and is registered; the supervisor starts it. `launch` in a zip is `{ "runtime": "node", "args", "cwd" }`, or `{ "command", "args", "cwd" }` with `command` an executable name or a relative path inside `payload/`. `runtime: "node"` becomes this process’s Node. Relative paths are rewritten into the install directory. A dynamic app is packed from its launch working directory, or from the nearest package directory when that directory is a home directory or a git checkout.

JSON dynamic deploy requires the listener to answer `GET /__bridge/catalog-prove`, and `launch` there is accepted only from loopback. Liveness comes from the supervisor probing `GET /__bridge/catalog-health`; a dynamic process does not heartbeat. Registrations are stored in `.catalog/{name}.json`, and `.catalog/bridge.json` publishes `deployPath` for local processes.

---

## Bridge-only vs upstream (merge contract)

**Merged from upstream (1.7.0+ modules)** — safe to refresh from upstream with review:

- `src/lib/acp-model.ts`, `acp-spawn.ts`, `acp-text-trailer.ts`
- `src/lib/media-input.ts`, `plan-limit.ts`, `prompt-delivery.ts`, `run-config-dir.ts`
- `.env.example`, `.dockerignore`
- Upstream-only dashboard bits (review diffs; **do not** replace bridge UI wholesale)

**Bridge-only — do not delete or overwrite when syncing upstream:**

| Category | Paths |
|----------|--------|
| CDSW / startup auth logging | `src/lib/env.ts` (CDSW sections), `bridge-api-auth.ts` |
| Server overlays | `src/lib/server.ts` (keepalive, plugins, merged shutdown) |
| Dashboard login & nav | `src/lib/agent-login.ts`, `public/index.html`, `public/app.js`, `public/wiki.html` (Chat/Plugins links, Sign in, Cursor account) |
| Web chat | `src/lib/chat-api.ts`, `chat-store.ts`, `public/chat*` |
| Plugins UI/API extensions | `src/lib/plugins/*` (bridge marketplace behavior) |
| CAI | `.project-metadata.yaml`, `app.py`, `app.sh`, `scripts/bootstrap-cai-application.sh`, `scripts/bootstrap-cai-application.py`, `scripts/create-cai-application.sh`, `docs/CAI-DEPLOYMENT.md` |
| Agent docs | **`AGENTS.md`** |

**Not fully merged yet** — upstream expects newer ACP + `handlers/agent-turn.ts` / `agent-failure.ts`. Wire those only after upgrading `acp-connection.ts` and request logging to upstream 1.7.0 shapes; do not enable half-merged handlers.

### Syncing from upstream (maintainers)

```bash
UPSTREAM=/tmp/cursor-api-proxy
git clone --depth 1 https://github.com/anyrobert/cursor-api-proxy.git "$UPSTREAM"
DEST=/path/to/cursor-agent-bridge

for d in src public docs examples; do
  rsync -a --delete \
    --exclude 'plugins' \
    --exclude 'chat-api.ts' --exclude 'chat-store.ts' \
    --exclude 'bridge-api-auth.ts' --exclude 'agent-login.ts' \
    "$UPSTREAM/$d/" "$DEST/$d/"
done

# Restore bridge-only files from git, resolve conflicts, then:
npm install && npm run build && npm test
```

Open a PR titled e.g. `chore: sync cursor-api-proxy @ v1.x.x` with a file-level summary and bridge-only restorations listed.

---

## CAI runtime (production profile)

Optional deploy path; same codebase runs on any Node 22+ host.

| Piece | Path / command |
|-------|----------------|
| Application entry | `app.py` → `app.sh` |
| Project root | Directory containing this `AGENTS.md` |
| Isolated CLI `HOME` | `.cai/home/` (runtime; not in git) |
| Node entry | `dist/cli.js` |
| Bootstrap | `scripts/bootstrap-cai-application.sh` |
| Register CAI app | `scripts/create-cai-application.sh` (also invoked from `bootstrap-cai-application.py`) |

**`app.sh` defaults (override with env):**

- `CURSOR_BRIDGE_HOST=127.0.0.1`; `CURSOR_BRIDGE_PORT` = first bindable among `CDSW_APP_PORT`, `CDSW_PUBLIC_PORT`, `CDSW_READONLY_PORT`, explicit `CURSOR_BRIDGE_PORT` (startup fails if none bind)
- `CURSOR_BRIDGE_MODE=agent`, `CURSOR_BRIDGE_FORCE=true`
- `CURSOR_BRIDGE_USE_ACP=true` (legacy: `CURSOR_BRIDGE_USE_ACP=false`)
- `CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE=false` on CAI engine
- `CURSOR_BRIDGE_TIMEOUT_MS=900000`
- `/v1` auth: **`CDSW_API_KEY`** unless `CURSOR_BRIDGE_DISABLE_CDSW_INBOUND_KEY=1`
- Startup stdout logs: `LLM /v1 auth: CDSW_API_KEY=…`

**Cursor CLI auth:** `CURSOR_API_KEY`, `auth.json` under `.cai/home/.config/cursor/`, or dashboard **Sign in with Cursor**. **`app.sh` starts without CLI auth** so first-time dashboard login works.

Bootstrap installs **npm** via bundled Cursor agent **node** when system npm is missing; symlinks `node` into `.cai/home/.local/bin`. See [docs/CAI-DEPLOYMENT.md](./docs/CAI-DEPLOYMENT.md).

---

## Testing notes

- Runner: **Vitest** (`npm test`, `npm run test:watch`).
- Prefer unit tests colocated with changed modules; use existing mocks in sibling `*.test.ts` files.
- **Known flaky / timing tests** (as of 1.7.0 baseline): `acp-tool-session.test.ts` (TTL), parts of `client-tool-bridge.test.ts` — note in PR if still failing; do not silence tests without fixing root cause or documenting upstream parity.
- **`acp-model-api.test.ts`** is `describe.skip` here: upstream expects catalog model ids in HTTP bodies; bridge handlers return normal assistant text. **`acp-model.test.ts`** includes bridge-specific expectations for context-size labels (`1M` → `context=1m`).

E2E: `sse-keepalive.e2e.test.ts` — run only when touching SSE/stream lifecycle.

---

## Releases and npm (maintainers)

- `prepublishOnly`: build + test — do not bypass for npm publish.
- Published **`files`**: `dist/`, `public/`, `docs/`, `scripts/cursor-api-proxy`, `package.json` (not CAI-only scripts unless added intentionally).
- Version bump PRs should include changelog notes in the PR body (CHANGELOG optional until the repo adds one).
- GitHub **Releases** should tag `vX.Y.Z` matching `package.json` when cutting releases.

---

## Related docs

| Doc | Audience |
|-----|----------|
| [README.md](./README.md) | End users, API, env table |
| [docs/CAI-DEPLOYMENT.md](./docs/CAI-DEPLOYMENT.md) | CAI Application deploy |
| [docs/WIKI.md](./docs/WIKI.md) | Dashboard, troubleshooting |
| [Upstream README](https://github.com/anyrobert/cursor-api-proxy) | SDK-only / generic proxy behavior |

When in doubt: **preserve CAI and CDSW behavior**, **stay compatible with upstream CLI name and `/v1` shapes**, and **keep dashboard/chat/plugins open on the same port** unless the task explicitly changes the threat model.
