#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  echo "Run this as a normal sudo-capable user, not as root." >&2
  exit 1
fi

echo "Installing k3s (Traefik disabled; ingress-nginx is used instead)"
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--disable traefik" sh -

mkdir -p "$HOME/.kube"
sudo cp /etc/rancher/k3s/k3s.yaml "$HOME/.kube/config"
sudo chown "$(id -u):$(id -g)" "$HOME/.kube/config"
export KUBECONFIG="$HOME/.kube/config"

if ! command -v helm >/dev/null 2>&1; then
  echo "Installing Helm"
  curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
fi

echo "Installing ingress-nginx"
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx --create-namespace \
  --set controller.service.type=LoadBalancer

echo "Installing cert-manager"
helm repo add jetstack https://charts.jetstack.io
helm repo update
helm upgrade --install cert-manager jetstack/cert-manager \
  --namespace cert-manager --create-namespace \
  --set crds.enabled=true

cat <<'EOF'

k3s, ingress-nginx and cert-manager are installed.

Next steps:
  1. Point DNS A records for your store and app domains at this server's public IP.
  2. Create a Let's Encrypt ClusterIssuer named letsencrypt-prod (see README).
  3. Build and push the four images, then update image references in values-prod.yaml.
  4. Run: VALUES=values-prod.yaml ./scripts/install.sh --set secrets.llm.apiKey="$LLM_API_KEY"

k3s uses the local-path StorageClass by default, which values-prod.yaml references.
EOF
