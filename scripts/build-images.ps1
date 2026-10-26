. "$PSScriptRoot\lib.ps1"

Ensure-DockerPath
Assert-Command docker "Install and start Docker Desktop, then open a NEW terminal so PATH updates."
Assert-Command kind "Install kind (winget install -e --id Kubernetes.kind)."

docker info *> $null
if ($LASTEXITCODE -ne 0) {
  throw "Docker is not running. Start Docker Desktop and wait for 'Engine running', then re-run this script."
}

$cluster = if ($env:CLUSTER) { $env:CLUSTER } else { "urumi" }
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

foreach ($app in @("wc-mcp-server", "mock-mcp", "gateway", "dashboard")) {
  Write-Host "Building urumi/${app}:local"
  Invoke-Checked "docker build ${app}" docker build -t "urumi/${app}:local" "$root\apps\$app"
}

Write-Host "Loading images into kind cluster '$cluster'"
Invoke-Checked "kind load" kind load docker-image `
  "urumi/wc-mcp-server:local" `
  "urumi/mock-mcp:local" `
  "urumi/gateway:local" `
  "urumi/dashboard:local" `
  --name $cluster

Write-Host "Images loaded."
