#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=env.local.sh
source "${ROOT}/scripts/env.local.sh"

if [[ ! -f "${ROOT}/dist/cli.js" ]]; then
  echo "Building cursor-api-proxy..."
  (cd "${ROOT}" && npm run build)
fi

exec "${ROOT}/scripts/cursor-api-proxy" start "$@"
