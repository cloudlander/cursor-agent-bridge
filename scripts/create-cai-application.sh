#!/usr/bin/env bash
# Create (or recreate) the Cloudera AI application for this project.
set -euo pipefail

: "${CDSW_APIV2_KEY:?CDSW_APIV2_KEY is not set}"
: "${CDSW_API_KEY:?CDSW_API_KEY is not set (run from an active CAI session)}"
: "${CDSW_DOMAIN:?CDSW_DOMAIN is not set}"
: "${CDSW_PROJECT_ID:?CDSW_PROJECT_ID is not set}"

APP_NAME="${CAI_APP_NAME:-Cursor Agent}"
APP_SUBDOMAIN="${CAI_APP_SUBDOMAIN:-agent-cai}"
APP_SCRIPT="${CAI_APP_SCRIPT:-app.py}"

RUNTIME_ID="$(
  curl -fsS -k -u "${CDSW_API_KEY}": "${CDSW_ENGINE_URL}" | python3 -c "import json,sys; runtime=json.load(sys.stdin).get('runtime',{});print(runtime.get('image_identifier') if runtime else '')"
)"

APP_CPU="${CAI_APP_CPU:-1}"
APP_MEMORY_GB="${CAI_APP_MEMORY_GB:-4}"

API_BASE="https://${CDSW_DOMAIN}/api/v2/projects/${CDSW_PROJECT_ID}/applications"

existing_id="$(
  curl -fsS -H "Authorization: Bearer ${CDSW_APIV2_KEY}" \
    "${API_BASE}?search_filter=$(python3 -c "import urllib.parse,json; print(urllib.parse.quote(json.dumps({'subdomain': '${APP_SUBDOMAIN}'})))")" \
    | python3 -c "import json,sys; apps=json.load(sys.stdin).get('applications',[]); print(apps[0]['id'] if apps else '')"
)"

if [[ -n "${existing_id}" ]]; then
  echo "Application subdomain '${APP_SUBDOMAIN}' already exists (id=${existing_id})."
  echo "Stop/delete it in the CAI UI or pick another CAI_APP_SUBDOMAIN."
  exit 1
fi

payload="$(python3 - <<PY
import json, os
print(json.dumps({
    "name": "${APP_NAME}",
    "subdomain": "${APP_SUBDOMAIN}",
    "description": "OpenAI-compatible LLM bridge",
    "script": "${APP_SCRIPT}",
    "runtime_identifier": "${RUNTIME_ID}",
    "cpu": float("${APP_CPU}"),
    "memory": float("${APP_MEMORY_GB}"),
    "environment": {
        "CDSW_APP_POLLING_ENDPOINT": "/healthz",
        "CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE": "false",
        "CURSOR_BRIDGE_MODE": "agent",
    },
}))
PY
)"

echo "Creating CAI application '${APP_NAME}' at subdomain '${APP_SUBDOMAIN}'..."
response_file="$(mktemp)"
trap 'rm -f "${response_file}"' EXIT
curl -fsS -X POST \
  -H "Authorization: Bearer ${CDSW_APIV2_KEY}" \
  -H "Content-Type: application/json" \
  -d "${payload}" \
  "${API_BASE}" >"${response_file}"

python3 - <<PY
import json, os
with open("${response_file}") as f:
    app = json.load(f)
domain = os.environ["CDSW_DOMAIN"]
sub = app.get("subdomain", "${APP_SUBDOMAIN}")
print("Created application:")
print(f"  id: {app.get('id')}")
print(f"  name: {app.get('name')}")
print(f"  status: {app.get('status')}")
print(f"  script: {app.get('script')}")
print(f"  URL: https://{sub}.{domain}/")
PY
