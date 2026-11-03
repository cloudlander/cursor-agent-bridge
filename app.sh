#!/usr/bin/env bash
# Cloudera AI application worker for cursor-api-proxy.
# Dashboard and API share CDSW_APP_PORT on 127.0.0.1.

set -eu

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CAI_HOME="${ROOT}/.cai/home"
LOG="${ROOT}/.cai/startup.log"

log() {
  printf '%s\n' "$*" | tee -a "${LOG}"
}

: "${CDSW_APP_PORT:?CDSW_APP_PORT is not set}"
: "${CDSW_API_KEY:?CDSW_API_KEY is not set}"

export HOME="${CAI_HOME}"
export PATH="${HOME}/.local/bin:${PATH}"
export CURSOR_API_PROXY_ROOT="${ROOT}"
export CURSOR_BRIDGE_HOST="127.0.0.1"
export CURSOR_BRIDGE_PORT="${CDSW_APP_PORT}"
export CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE="${CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE:-false}"
export CURSOR_BRIDGE_MODE="${CURSOR_BRIDGE_MODE:-agent}"
export CURSOR_BRIDGE_FORCE="${CURSOR_BRIDGE_FORCE:-true}"
# Agent run wall-clock limit (default 15 minutes; override via env).
export CURSOR_BRIDGE_TIMEOUT_MS="${CURSOR_BRIDGE_TIMEOUT_MS:-900000}"

kill_stale_cursor_version_checks() {
  local min_age_sec="${1:-30}"
  while read -r pid etimes _; do
    [[ -n "${pid}" && "${etimes}" -ge "${min_age_sec}" ]] || continue
    kill -TERM "${pid}" 2>/dev/null || true
  done < <(
    ps -eo pid=,etimes=,args= 2>/dev/null | awk '
      /\/cursor/ && /--version/ && !/awk/ && !/ps -eo/ { print $1, $2 }
    '
  )
}

# The `cursor` shim can hang on --version when no IDE is installed; reap stale checks.
(
  while true; do
    kill_stale_cursor_version_checks 30
    sleep 60
  done
) &

log "cursor-api-proxy CAI app"
if [[ -n "${CURSOR_BRIDGE_API_KEY:-}" ]]; then
  log "  LLM /v1 auth: CURSOR_BRIDGE_API_KEY=${CURSOR_BRIDGE_API_KEY}"
elif [[ "${CURSOR_BRIDGE_DISABLE_CDSW_INBOUND_KEY:-}" =~ ^(1|true|yes)$ ]]; then
  log "  LLM /v1 auth: none (CURSOR_BRIDGE_DISABLE_CDSW_INBOUND_KEY)"
else
  log "  LLM /v1 auth: CDSW_API_KEY=${CDSW_API_KEY} (automatic; plugins UI needs no bridge key)"
fi
log "  listen: http://${CURSOR_BRIDGE_HOST}:${CURSOR_BRIDGE_PORT}/"
log "  dashboard: http://${CURSOR_BRIDGE_HOST}:${CURSOR_BRIDGE_PORT}/"
log "  health: http://${CURSOR_BRIDGE_HOST}:${CURSOR_BRIDGE_PORT}/healthz"
if [[ -n "${CDSW_DOMAIN:-}" ]]; then
  log "  subdomain URL: https://model-gateway.${CDSW_DOMAIN}/"
fi

find_agent_node() {
  local versions_dir="${HOME}/.local/share/cursor-agent/versions"
  [[ -d "${versions_dir}" ]] || return 1
  local latest
  latest="$(ls -1 "${versions_dir}" 2>/dev/null | sort -r | head -1 || true)"
  [[ -n "${latest}" && -x "${versions_dir}/${latest}/node" ]] || return 1
  echo "${versions_dir}/${latest}/node"
}

bootstrap_needed() {
  [[ ! -x "${HOME}/.local/bin/agent" || ! -f "${ROOT}/dist/cli.js" ]] && return 0
  if [[ "${CAI_FORCE_BUILD:-}" =~ ^(1|true|yes)$ ]]; then
    return 0
  fi
  find "${ROOT}/src" "${ROOT}/public" -type f \
    \( -name '*.ts' -o -name '*.html' -o -name '*.js' -o -name '*.css' \) \
    -newer "${ROOT}/dist/cli.js" -print -quit 2>/dev/null | grep -q .
}

if bootstrap_needed; then
  log "Bootstrapping project-local CAI runtime (agent, npm, and/or build)..."
  bash "${ROOT}/scripts/bootstrap-cai-application.sh" >>"${LOG}" 2>&1
fi

NODE_BIN="$(find_agent_node || true)"
if [[ -z "${NODE_BIN}" || ! -x "${NODE_BIN}" ]]; then
  log "Node.js not found under ${CAI_HOME}. Run scripts/bootstrap-cai-application.sh in a session."
  exit 1
fi

export CURSOR_AGENT_BIN="${HOME}/.local/bin/agent"
export CURSOR_API_PROXY_NODE="${NODE_BIN}"

ensure_cursor_cli_auth() {
  if [[ -n "${CURSOR_API_KEY:-}" || -n "${CURSOR_AUTH_TOKEN:-}" ]]; then
    return 0
  fi

  local dest="${CAI_HOME}/.config/cursor/auth.json"
  if [[ -f "${dest}" ]]; then
    return 0
  fi

  local src=""
  local real_home
  real_home="$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f6 || true)"
  for candidate in \
    "${ROOT}/.config/cursor/auth.json" \
    "${real_home}/.config/cursor/auth.json"
  do
    if [[ -n "${candidate}" && -f "${candidate}" ]]; then
      src="${candidate}"
      break
    fi
  done

  if [[ -n "${src}" ]]; then
    mkdir -p "$(dirname "${dest}")"
    cp "${src}" "${dest}"
    chmod 600 "${dest}"
    log "Copied Cursor CLI auth from ${src}"
    return 0
  fi

  log "WARNING: Cursor CLI is not authenticated in ${CAI_HOME}."
  log "  Open the dashboard and use Sign in with Cursor, or set CURSOR_API_KEY on the application."
  log "  CLI alternative: HOME=${CAI_HOME} agent login"
  return 0
}

ensure_cursor_cli_auth

log "  node: ${NODE_BIN}"
log "  agent: ${CURSOR_AGENT_BIN}"
log "  bridge timeout: ${CURSOR_BRIDGE_TIMEOUT_MS} ms"

exec "${NODE_BIN}" "${ROOT}/dist/cli.js"
