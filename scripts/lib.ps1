# Shared helpers for the PowerShell scripts. Dot-source this file.

# Native tools (kind, docker, kubectl) write progress to stderr. Do not let that
# terminate the script; every native call is checked explicitly via $LASTEXITCODE.
$ErrorActionPreference = "Continue"

function Ensure-DockerPath {
  if (Get-Command docker -ErrorAction SilentlyContinue) { return }
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\DockerDesktop\resources\bin"),
    (Join-Path ${env:ProgramFiles} "Docker\Docker\resources\bin"),
    (Join-Path ${env:ProgramFiles} "Docker\Docker\resources")
  )
  foreach ($dir in $candidates) {
    if ($dir -and (Test-Path -LiteralPath (Join-Path $dir "docker.exe"))) {
      $env:Path = "$env:Path;$dir"
      Write-Host "Added Docker CLI to PATH for this session: $dir"
      return
    }
  }
}

function Assert-Command($name, $hint) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "'$name' was not found on PATH. $hint"
  }
}

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
  )
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE"
  }
}
