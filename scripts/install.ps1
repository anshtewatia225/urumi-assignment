. "$PSScriptRoot\lib.ps1"

function Get-DotEnvValue([string]$Path, [string[]]$Names) {
  if (-not (Test-Path -LiteralPath $Path)) { return "" }
  foreach ($line in Get-Content -LiteralPath $Path) {
    $trim = $line.Trim()
    if ($trim -eq "" -or $trim.StartsWith("#")) { continue }
    foreach ($name in $Names) {
      if ($trim -match ("^" + [regex]::Escape($name) + "\s*=\s*(.*)$")) {
        $value = $matches[1].Trim().Trim('"').Trim("'")
        if ($value) { return $value }
      }
    }
  }
  return ""
}

Assert-Command helm "Install Helm (winget install -e --id Helm.Helm)."
Assert-Command kubectl "Install kubectl (winget install -e --id Kubernetes.kubectl)."

kubectl cluster-info *> $null
if ($LASTEXITCODE -ne 0) {
  throw "No reachable cluster. Run .\scripts\kind-up.ps1 first."
}

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$values = if ($env:VALUES) { $env:VALUES } else { "values-local.yaml" }
$release = if ($env:RELEASE) { $env:RELEASE } else { "urumi" }
$namespace = if ($env:NAMESPACE) { $env:NAMESPACE } else { "platform" }

# Prefer an explicit --set; otherwise take the LLM key from the environment or .env.
$extra = @()
$alreadySet = ($args | Where-Object { $_ -match "secrets\.llm\.apiKey" }).Count -gt 0
if (-not $alreadySet) {
  # LLM_API_KEY is the canonical name (matches .env); OPENROUTER_API_KEY is an accepted alias.
  $llmKey = $env:LLM_API_KEY
  if (-not $llmKey) { $llmKey = $env:OPENROUTER_API_KEY }
  if (-not $llmKey) { $llmKey = Get-DotEnvValue (Join-Path $root ".env") @("LLM_API_KEY", "OPENROUTER_API_KEY") }
  if ($llmKey) {
    $extra = @("--set", "secrets.llm.apiKey=$llmKey")
    Write-Host "Using LLM API key from environment or .env"
  } else {
    Write-Host "No LLM API key found (set `$env:LLM_API_KEY or add LLM_API_KEY=... to .env). Chat will be disabled."
  }
}

$allArgs = @($args) + @($extra)

Push-Location $root
try {
  Invoke-Checked "helm dependency build" helm dependency build charts/platform
  Invoke-Checked "helm upgrade --install" helm upgrade --install $release charts/platform `
    --namespace $namespace `
    --create-namespace `
    -f $values `
    --timeout 20m `
    @allArgs
} finally {
  Pop-Location
}

Write-Host ""
Write-Host "Installed. Retrieve the admin password with:"
Write-Host "  kubectl -n $namespace get secret gateway-secrets -o jsonpath='{.data.ADMIN_PASSWORD}' | base64 -d"
Write-Host "Dashboard: http://app.local (or the host in $values)"
