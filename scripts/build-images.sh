#!/usr/bin/env bash
set -euo pipefail

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "'$1' was not found on PATH. $2" >&2
    exit 1
  fi
}

require docker "Install and start Docker, then re-open your shell."
require kind "Install kind."

CLUSTER="${CLUSTER:-urumi}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for app in wc-mcp-server mock-mcp gateway dashboard; do
  echo "Building urumi/${app}:local"
  docker build -t "urumi/${app}:local" "$ROOT/apps/${app}"
done

echo "Loading images into kind cluster '$CLUSTER'"
kind load docker-image \
  urumi/wc-mcp-server:local \
  urumi/mock-mcp:local \
  urumi/gateway:local \
  urumi/dashboard:local \
  --name "$CLUSTER"

echo "Images loaded."
