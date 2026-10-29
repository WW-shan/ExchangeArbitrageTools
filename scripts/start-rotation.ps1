[CmdletBinding()]
param(
  [string]$Config = 'config/live-rotation.toml',
  [switch]$NoScanner,
  [switch]$Foreground
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path
$data = Join-Path $root 'data'
New-Item -ItemType Directory -Force -Path $data | Out-Null
$stopPath = Join-Path $data 'rotation.stop'
Remove-Item -LiteralPath $stopPath -Force -ErrorAction SilentlyContinue
$watch = Join-Path $PSScriptRoot 'watch-rotation.ps1'
if (-not [IO.Path]::IsPathRooted($Config)) { $Config = Join-Path $root $Config }

if ($Foreground) {
  & $watch -Config $Config -NoScanner:$NoScanner
  exit
}

$statusPath = Join-Path $data 'rotation-watchdog.status.json'
$arguments = @(
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-File', $watch,
  '-Config', $Config
)
if ($NoScanner) { $arguments += '-NoScanner' }
$process = Start-Process -FilePath 'powershell.exe' `
  -ArgumentList $arguments `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -PassThru
Start-Sleep -Seconds 3
Write-Host ('Watchdog launcher started (pid {0}).' -f $process.Id)
if (Test-Path -LiteralPath $statusPath -PathType Leaf) {
  Get-Content -LiteralPath $statusPath -Raw
}