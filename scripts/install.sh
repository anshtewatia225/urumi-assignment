#!/usr/bin/env bash
set -euo pipefail

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "'$1' was not found on PATH. $2" >&2
    exit 1
  fi
}

dotenv_value() {
  local file="$1"; shift
  [ -f "$file" ] || return 0
  local name
  for name in "$@"; do
    local line
    line="$(grep -E "^${name}=" "$file" | tail -n 1 || true)"
    if [ -n "$line" ]; then
      printf '%s' "${line#*=}" | tr -d '"'"'"
      return 0
    fi
  done
}

require helm "Install Helm: https://helm.sh/docs/intro/install/"
require kubectl "Install kubectl."

if ! kubectl cluster-info >/dev/null 2>&1; then
  echo "No reachable cluster. Run ./scripts/kind-up.sh first." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VALUES="${VALUES:-values-local.yaml}"
RELEASE="${RELEASE:-urumi}"
NAMESPACE="${NAMESPACE:-platform}"

EXTRA=()
if [[ " $* " != *"secrets.llm.apiKey"* ]]; then
  # LLM_API_KEY is the canonical name (matches .env); OPENROUTER_API_KEY is an accepted alias.
  LLM_KEY="${LLM_API_KEY:-${OPENROUTER_API_KEY:-}}"
  if [ -z "$LLM_KEY" ]; then
    LLM_KEY="$(dotenv_value "$ROOT/.env" LLM_API_KEY OPENROUTER_API_KEY)"
  fi
  if [ -n "$LLM_KEY" ]; then
    EXTRA=(--set "secrets.llm.apiKey=$LLM_KEY")
    echo "Using LLM API key from environment or .env"
  else
    echo "No LLM API key found (set LLM_API_KEY or add LLM_API_KEY=... to .env). Chat will be disabled."
  fi
fi

cd "$ROOT"
helm dependency build charts/platform
helm upgrade --install "$RELEASE" charts/platform \
  --namespace "$NAMESPACE" \
  --create-namespace \
  -f "$VALUES" \
  --timeout 20m \
  "$@" "${EXTRA[@]}"

echo
echo "Installed. Retrieve the admin password with:"
echo "  kubectl -n $NAMESPACE get secret gateway-secrets -o jsonpath='{.data.ADMIN_PASSWORD}' | base64 -d"
echo "Dashboard: http://app.local (or the host in $VALUES)"
