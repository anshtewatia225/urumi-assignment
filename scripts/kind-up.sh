#!/usr/bin/env bash
set -euo pipefail

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "'$1' was not found on PATH. $2" >&2
    exit 1
  fi
}

require docker "Install and start Docker Desktop/daemon, then re-open your shell."
require kind "Install kind: https://kind.sigs.k8s.io/docs/user/quick-start/#installation"
require kubectl "Install kubectl: https://kubernetes.io/docs/tasks/tools/"

if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running. Start it and wait for the engine, then re-run." >&2
  exit 1
fi

CLUSTER="${CLUSTER:-urumi}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INGRESS_NGINX_VERSION="${INGRESS_NGINX_VERSION:-v1.11.3}"
LOCAL_PATH_VERSION="${LOCAL_PATH_VERSION:-v0.0.30}"

if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  echo "Cluster '$CLUSTER' already exists, reusing it."
else
  echo "Creating kind cluster '$CLUSTER'"
  kind create cluster --name "$CLUSTER" --config "$SCRIPT_DIR/kind-config.yaml"
fi

echo "Installing ingress-nginx"
kubectl apply -f "https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-${INGRESS_NGINX_VERSION}/deploy/static/provider/kind/deploy.yaml"
kubectl -n ingress-nginx wait --for=condition=available deployment/ingress-nginx-controller --timeout=300s
kubectl -n ingress-nginx wait --for=condition=complete job/ingress-nginx-admission --timeout=300s || true

echo "Installing local-path-provisioner"
kubectl apply -f "https://raw.githubusercontent.com/rancher/local-path-provisioner/${LOCAL_PATH_VERSION}/deploy/local-path-storage.yaml"
kubectl patch storageclass local-path --patch-file "$SCRIPT_DIR/local-path-default.json"

echo
echo "Cluster is ready."
echo "Add these entries to your hosts file:"
echo "  127.0.0.1 store.local app.local"
echo
echo "Next: ./scripts/build-images.sh && ./scripts/install.sh"
