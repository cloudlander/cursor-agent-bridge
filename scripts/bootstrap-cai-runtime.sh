#!/usr/bin/env bash
# Back-compat wrapper; prefer bootstrap-cai-application.sh.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/bootstrap-cai-application.sh" "$@"
