# Source before starting cursor-api-proxy on this machine:
#   source scripts/env.local.sh && ./scripts/cursor-api-proxy start
#
# Chat-only workspace (default) isolates HOME and breaks `agent login` session
# auth unless you use CURSOR_API_KEY (dashboard key) or an account pool login.

export CURSOR_API_PROXY_ROOT="/home/cdsw"
export CURSOR_API_PROXY_NODE="/home/cdsw/.local/share/cursor-agent/versions/2026.09.15-d2fe57e/node"
export CURSOR_AGENT_BIN="/home/cdsw/.local/bin/agent"
export CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE="${CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE:-false}"
export CURSOR_BRIDGE_MODE="${CURSOR_BRIDGE_MODE:-agent}"
export CURSOR_BRIDGE_FORCE="${CURSOR_BRIDGE_FORCE:-true}"
export CURSOR_BRIDGE_HOST="${CURSOR_BRIDGE_HOST:-127.0.0.1}"
export CURSOR_BRIDGE_PORT="${CURSOR_BRIDGE_PORT:-8080}"
export PATH="/home/cdsw/.local/bin:/home/cdsw/.local/share/cursor-agent/versions/2026.09.15-d2fe57e:${PATH}"
