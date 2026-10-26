. "$PSScriptRoot\lib.ps1"

Ensure-DockerPath
Assert-Command docker "Install and start Docker Desktop, then open a NEW terminal so PATH updates."
Assert-Command kind "Install kind (winget install -e --id Kubernetes.kind)."
Assert-Command kubectl "Install kubectl (winget install -e --id Kubernetes.kubectl)."

docker info *> $null
if ($LASTEXITCODE -ne 0) {
  throw "Docker is not running. Start Docker Desktop and wait for 'Engine running', then re-run this script."
}

$cluster = if ($env:CLUSTER) { $env:CLUSTER } else { "urumi" }
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ingressVersion = if ($env:INGRESS_NGINX_VERSION) { $env:INGRESS_NGINX_VERSION } else { "v1.11.3" }
$localPathVersion = if ($env:LOCAL_PATH_VERSION) { $env:LOCAL_PATH_VERSION } else { "v0.0.30" }

$existing = @(kind get clusters 2>$null) | ForEach-Object { $_.Trim() }
if ($existing -contains $cluster) {
  Write-Host "Cluster '$cluster' already exists, reusing it."
} else {
  Write-Host "Creating kind cluster '$cluster'"
  Invoke-Checked "kind create cluster" kind create cluster --name $cluster --config "$scriptDir\kind-config.yaml"
}

Write-Host "Installing ingress-nginx"
Invoke-Checked "kubectl apply (ingress-nginx)" kubectl apply -f "https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-$ingressVersion/deploy/static/provider/kind/deploy.yaml"
Invoke-Checked "waiting for ingress-nginx" kubectl -n ingress-nginx wait --for=condition=available deployment/ingress-nginx-controller --timeout=300s

Write-Host "Installing local-path-provisioner"
Invoke-Checked "kubectl apply (local-path)" kubectl apply -f "https://raw.githubusercontent.com/rancher/local-path-provisioner/$localPathVersion/deploy/local-path-storage.yaml"
Invoke-Checked "kubectl patch (default StorageClass)" kubectl patch storageclass local-path --patch-file "$scriptDir\local-path-default.json"

Write-Host ""
Write-Host "Cluster is ready."
Write-Host "Add these entries to C:\Windows\System32\drivers\etc\hosts (as Administrator):"
Write-Host "  127.0.0.1 store.local app.local"
Write-Host ""
Write-Host "Next: .\scripts\build-images.ps1 then .\scripts\install.ps1"
