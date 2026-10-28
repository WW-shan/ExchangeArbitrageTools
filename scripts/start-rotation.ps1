[CmdletBinding()]
param(
  [string]$Config = 'config/live-rotation.toml',
  [switch]$NoScanner
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$data = Join-Path $root 'data'
New-Item -ItemType Directory -Force -Path $data | Out-Null

. (Join-Path $PSScriptRoot 'load-env.ps1')
$env:ARB_CONFIG = $Config

$node = (Get-Command node -ErrorAction Stop).Source
$tsx = Join-Path $root 'node_modules/tsx/dist/cli.mjs'
$scanner = $null
try {
  if (-not $NoScanner) {
    $scanner = Start-Process -FilePath $node `
      -ArgumentList @($tsx, 'apps/scanner/src/main.ts') `
      -WorkingDirectory $root `
      -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $data 'rotation-scanner.stdout.log') `
      -RedirectStandardError (Join-Path $data 'rotation-scanner.stderr.log') `
      -PassThru
    Write-Host ('Scanner started (pid {0}).' -f $scanner.Id)
  }
  & $node $tsx apps/executor/src/main.ts --auto
} finally {
  if ($scanner -and -not $scanner.HasExited) {
    Stop-Process -Id $scanner.Id -Force
    Write-Host ('Scanner stopped (pid {0}).' -f $scanner.Id)
  }
}
