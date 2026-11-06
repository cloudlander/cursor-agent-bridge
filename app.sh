#!/usr/bin/env bash
# Cloudera AI application worker for cursor-api-proxy.
# Dashboard and API share CDSW_APP_PORT on 127.0.0.1.
#
# Usage:
#   app.sh [start]   — resolve port, bootstrap, run CLI until it exits (default)
#   app.sh stop      — if /healthz is up, kill CLI and exit when it is gone
#   app.sh keepalive — like start, but restart CLI after exit or lost /healthz (CAI app entry via app.py)

set -eu

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CAI_HOME="${ROOT}/.cai/home"
LOG="${ROOT}/.cai/startup.log"
CLI_PIDFILE="${ROOT}/.cai/cli.pid"
MODE="${1:-start}"

log() {
  printf '%s\n' "$*" | tee -a "${LOG}"
}

port_can_bind() {
  local host="$1" port="$2"
  [[ "${port}" =~ ^[0-9]+$ && "${port}" -ge 1 && "${port}" -le 65535 ]] || return 1

  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import socket, sys
host, port = sys.argv[1], int(sys.argv[2])
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.bind((host, port))
s.close()' "${host}" "${port}" 2>/dev/null && return 0
  elif command -v python >/dev/null 2>&1; then
    python -c 'import socket, sys
host, port = sys.argv[1], int(sys.argv[2])
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.bind((host, port))
s.close()' "${host}" "${port}" 2>/dev/null && return 0
  fi

  if command -v ss >/dev/null 2>&1; then
    ! ss -ltn "sport = :${port}" 2>/dev/null | grep -q .
    return $?
  fi

  return 1
}

resolve_bridge_listen_port() {
  local host="${CURSOR_BRIDGE_HOST}"
  local -a candidates=()
  local p tried="" chosen="" existing dup

  for p in "${CDSW_APP_PORT:-}" "${CDSW_PUBLIC_PORT:-}" "${CDSW_READONLY_PORT:-}" "${CURSOR_BRIDGE_PORT:-}"; do
    [[ -n "${p}" ]] || continue
    dup=0
    for existing in "${candidates[@]}"; do
      if [[ "${existing}" == "${p}" ]]; then
        dup=1
        break
      fi
    done
    [[ "${dup}" -eq 1 ]] && continue
    candidates+=("${p}")
  done

  if [[ ${#candidates[@]} -eq 0 ]]; then
    log "ERROR: No listen port configured (set CDSW_APP_PORT, CDSW_PUBLIC_PORT, CDSW_READONLY_PORT, or CURSOR_BRIDGE_PORT)."
    exit 1
  fi

  for p in "${candidates[@]}"; do
    if port_can_bind "${host}" "${p}"; then
      chosen="${p}"
      break
    fi
    tried="${tried:+$tried, }${p}"
    log "Port ${p} unavailable on ${host} (in use or not bindable), trying next candidate..."
  done

  if [[ -z "${chosen}" ]]; then
    log "ERROR: Could not bind on ${host}; tried port(s): ${tried}"
    exit 1
  fi

  if [[ -n "${tried}" ]]; then
    log "Using listen port ${chosen} (skipped unavailable: ${tried})"
  fi

  RESOLVED_BRIDGE_PORT="${chosen}"
}

resolve_bridge_port_configured() {
  if [[ -n "${CURSOR_BRIDGE_PORT:-}" ]]; then
    RESOLVED_BRIDGE_PORT="${CURSOR_BRIDGE_PORT}"
    return 0
  fi

  local -a candidates=()
  local p existing dup
  for p in "${CDSW_APP_PORT:-}" "${CDSW_PUBLIC_PORT:-}" "${CDSW_READONLY_PORT:-}"; do
    [[ -n "${p}" ]] || continue
    dup=0
    for existing in "${candidates[@]}"; do
      [[ "${existing}" == "${p}" ]] && dup=1 && break
    done
    [[ "${dup}" -eq 1 ]] && continue
    candidates+=("${p}")
  done

  if [[ ${#candidates[@]} -eq 0 ]]; then
    log "ERROR: No listen port configured (set CURSOR_BRIDGE_PORT or CDSW_* port)."
    exit 1
  fi

  RESOLVED_BRIDGE_PORT="${candidates[0]}"
}

healthz_ok() {
  local host="${CURSOR_BRIDGE_HOST:-127.0.0.1}"
  local port="${RESOLVED_BRIDGE_PORT}"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 3 "http://${host}:${port}/healthz" 2>/dev/null | grep -qx ok && return 0
  fi
  return 1
}

find_listener_pid() {
  local port="${RESOLVED_BRIDGE_PORT}"
  local pid=""

  if [[ -f "${CLI_PIDFILE}" ]]; then
    pid="$(tr -d ' \n\r' <"${CLI_PIDFILE}" 2>/dev/null || true)"
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
      echo "${pid}"
      return 0
    fi
  fi

  if command -v ss >/dev/null 2>&1; then
    pid="$(ss -ltnp "sport = :${port}" 2>/dev/null | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1 || true)"
    if [[ -n "${pid}" ]]; then
      echo "${pid}"
      return 0
    fi
  fi

  if command -v lsof >/dev/null 2>&1; then
    pid="$(lsof -ti "TCP:${port}" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
    if [[ -n "${pid}" ]]; then
      echo "${pid}"
      return 0
    fi
  fi

  return 1
}

kill_cli_pid() {
  local pid="$1"
  [[ -n "${pid}" ]] || return 1
  if ! kill -0 "${pid}" 2>/dev/null; then
    return 0
  fi
  kill -TERM "${pid}" 2>/dev/null || true
  local i
  for i in $(seq 1 50); do
    if ! kill -0 "${pid}" 2>/dev/null; then
      rm -f "${CLI_PIDFILE}" 2>/dev/null || true
      return 0
    fi
    sleep 0.1
  done
  kill -KILL "${pid}" 2>/dev/null || true
  for i in $(seq 1 20); do
    if ! kill -0 "${pid}" 2>/dev/null; then
      rm -f "${CLI_PIDFILE}" 2>/dev/null || true
      return 0
    fi
    sleep 0.1
  done
  return 1
}

cmd_stop() {
  export HOME="${CAI_HOME}"
  export PATH="${HOME}/.local/bin:${PATH}"
  export CURSOR_API_PROXY_ROOT="${ROOT}"
  export CURSOR_BRIDGE_HOST="${CURSOR_BRIDGE_HOST:-127.0.0.1}"

  resolve_bridge_port_configured
  export CURSOR_BRIDGE_PORT="${RESOLVED_BRIDGE_PORT}"

  log "app.sh stop (port ${CURSOR_BRIDGE_PORT})"

  if ! healthz_ok; then
    log "ERROR: /healthz not OK on http://${CURSOR_BRIDGE_HOST}:${CURSOR_BRIDGE_PORT}/ — nothing to stop."
    exit 1
  fi

  local pid
  if ! pid="$(find_listener_pid)"; then
    log "ERROR: /healthz OK but could not find listener PID on port ${CURSOR_BRIDGE_PORT}."
    exit 1
  fi

  log "Stopping CLI (pid ${pid})..."
  if ! kill_cli_pid "${pid}"; then
    log "ERROR: CLI pid ${pid} did not exit."
    exit 1
  fi

  for _ in $(seq 1 30); do
    if ! healthz_ok; then
      log "CLI stopped."
      exit 0
    fi
    sleep 0.2
  done

  log "ERROR: CLI exited but /healthz still responds."
  exit 1
}

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

prepare_worker_env() {
  : "${CDSW_API_KEY:?CDSW_API_KEY is not set}"

  export HOME="${CAI_HOME}"
  export PATH="${HOME}/.local/bin:${PATH}"
  export CURSOR_API_PROXY_ROOT="${ROOT}"
  export CURSOR_BRIDGE_HOST="127.0.0.1"

  resolve_bridge_listen_port
  export CURSOR_BRIDGE_PORT="${RESOLVED_BRIDGE_PORT}"
  export CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE="${CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE:-false}"
  export CURSOR_BRIDGE_MODE="${CURSOR_BRIDGE_MODE:-agent}"
  export CURSOR_BRIDGE_FORCE="${CURSOR_BRIDGE_FORCE:-true}"
  export CURSOR_BRIDGE_TIMEOUT_MS="${CURSOR_BRIDGE_TIMEOUT_MS:-900000}"

  (
    while true; do
      kill_stale_cursor_version_checks 30
      sleep 60
    done
  ) &

  log "cursor-api-proxy CAI app (mode: ${MODE})"
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

  ensure_cursor_cli_auth

  log "  node: ${NODE_BIN}"
  log "  agent: ${CURSOR_AGENT_BIN}"
  log "  bridge timeout: ${CURSOR_BRIDGE_TIMEOUT_MS} ms"
}

run_cli_until_exit() {
  mkdir -p "${ROOT}/.cai"
  "${NODE_BIN}" "${ROOT}/dist/cli.js" &
  local cli_pid=$!
  echo "${cli_pid}" >"${CLI_PIDFILE}"
  wait "${cli_pid}" || true
  local code=$?
  rm -f "${CLI_PIDFILE}" 2>/dev/null || true
  return "${code}"
}

cmd_start() {
  prepare_worker_env
  run_cli_until_exit
  exit 0
}

run_keepalive_loop() {
  while true; do
    log "Starting CLI..."
    run_cli_until_exit
    if ! healthz_ok; then
      log "CLI exited and /healthz is down; restarting in 1s..."
    else
      log "CLI exited but /healthz still up; restarting in 1s..."
    fi
    sleep 1
  done
}

cmd_keepalive() {
  prepare_worker_env
  run_keepalive_loop
}

case "${MODE}" in
  stop)
    cmd_stop
    ;;
  keepalive)
    cmd_keepalive
    ;;
  start)
    cmd_start
    ;;
  *)
    log "ERROR: Unknown mode '${MODE}' (use start, stop, or keepalive)."
    exit 1
    ;;
esac
