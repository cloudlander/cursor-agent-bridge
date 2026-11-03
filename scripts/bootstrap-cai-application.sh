#!/usr/bin/env bash
# One-time (or occasional) bootstrap for the CAI application runtime.
# Installs Cursor agent + bundled Node under .cai/home/ inside the project
# so application engines can start quickly without cold installs.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CAI_HOME="${ROOT}/.cai/home"
NPM_BOOTSTRAP_VERSION="${NPM_BOOTSTRAP_VERSION:-11.6.2}"

export HOME="${CAI_HOME}"
export PATH="${HOME}/.local/bin:${PATH}"

mkdir -p "${CAI_HOME}"

if [[ ! -x "${HOME}/.local/bin/agent" ]]; then
  echo "Installing Cursor agent into ${CAI_HOME}..."
  curl -fsSL https://cursor.com/install | bash
fi

sync_cursor_cli_auth() {
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
    echo "Copied Cursor CLI auth from ${src}"
    return 0
  fi

  echo "No Cursor CLI auth found for ${CAI_HOME}."
  echo "  Set CURSOR_API_KEY for headless use, or run: HOME=${CAI_HOME} agent login"
  return 1
}

find_agent_node() {
  local versions_dir="${HOME}/.local/share/cursor-agent/versions"
  [[ -d "${versions_dir}" ]] || return 1
  local latest
  latest="$(ls -1 "${versions_dir}" 2>/dev/null | sort -r | head -1 || true)"
  [[ -n "${latest}" && -x "${versions_dir}/${latest}/node" ]] || return 1
  echo "${versions_dir}/${latest}/node"
}

# npm/npx use `#!/usr/bin/env node`; agent bundles node outside PATH.
ensure_bundled_node_on_path() {
  local node_bin="$1"
  local bin_dir="${HOME}/.local/bin"
  mkdir -p "${bin_dir}"
  ln -sf "${node_bin}" "${bin_dir}/node"
  export PATH="${bin_dir}:${PATH}"
}

# Cursor agent ships node but not npm; install npm into CAI_HOME/.local when missing.
ensure_npm() {
  local node_bin="$1"
  ensure_bundled_node_on_path "${node_bin}"

  if command -v npm >/dev/null 2>&1; then
    npm --version >/dev/null 2>&1 && return 0
  fi

  local npm_cli="${HOME}/.local/lib/node_modules/npm/bin/npm-cli.js"
  if [[ -f "${npm_cli}" ]]; then
    export PATH="${HOME}/.local/bin:${PATH}"
    return 0
  fi

  echo "Installing npm ${NPM_BOOTSTRAP_VERSION} with bundled Node (${node_bin})..."
  local prefix="${HOME}/.local"
  local tmpdir
  tmpdir="$(mktemp -d)"
  cleanup() { rm -rf "${tmpdir}"; }
  trap cleanup EXIT

  curl -fsSL "https://registry.npmjs.org/npm/-/npm-${NPM_BOOTSTRAP_VERSION}.tgz" \
    -o "${tmpdir}/npm.tgz"
  mkdir -p "${tmpdir}/pkg"
  tar -xzf "${tmpdir}/npm.tgz" -C "${tmpdir}/pkg"

  mkdir -p "${prefix}"
  "${node_bin}" "${tmpdir}/pkg/package/bin/npm-cli.js" install -g npm --prefix "${prefix}"

  cleanup
  trap - EXIT

  export PATH="${prefix}/bin:${PATH}"
  if ! command -v npm >/dev/null 2>&1; then
    echo "npm install completed but npm is not on PATH under ${prefix}/bin." >&2
    exit 1
  fi
  echo "npm ready: $(command -v npm) ($(npm --version))"
}

sync_cursor_cli_auth || true

NODE_BIN="$(find_agent_node || true)"
[[ -n "${NODE_BIN}" && -x "${NODE_BIN}" ]] || {
  echo "Could not locate bundled Node after agent install." >&2
  exit 1
}

ensure_bundled_node_on_path "${NODE_BIN}"

needs_project_build() {
  if [[ ! -f "${ROOT}/dist/cli.js" ]]; then
    return 0
  fi
  if [[ "${CAI_FORCE_BUILD:-}" =~ ^(1|true|yes)$ ]]; then
    return 0
  fi
  # Rebuild when TypeScript sources or static UI changed after the last build.
  find "${ROOT}/src" "${ROOT}/public" -type f \
    \( -name '*.ts' -o -name '*.html' -o -name '*.js' -o -name '*.css' \) \
    -newer "${ROOT}/dist/cli.js" -print -quit 2>/dev/null | grep -q .
}

if needs_project_build; then
  echo "Building cursor-agent-bridge (npm install && npm run build)..."
  ensure_npm "${NODE_BIN}"
  (cd "${ROOT}" && npm install && npm run build)
fi

echo "CAI runtime ready:"
echo "  HOME=${CAI_HOME}"
echo "  agent=${HOME}/.local/bin/agent"
echo "  node=${NODE_BIN}"
echo "  npm=$(command -v npm 2>/dev/null || echo '(not on PATH)')"
echo "  dist=${ROOT}/dist/cli.js"
