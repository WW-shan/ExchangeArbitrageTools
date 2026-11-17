[CmdletBinding()]
param(
  [string]$Config = 'config/live-rotation.toml',
  [switch]$NoScanner,
  [switch]$Foreground,
  [int]$WaitForExitSeconds = 180
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path
$data = Join-Path $root 'data'
New-Item -ItemType Directory -Force -Path $data | Out-Null
$stopPath = Join-Path $data 'rotation.stop'
$watch = Join-Path $PSScriptRoot 'watch-rotation.ps1'
if (-not [IO.Path]::IsPathRooted($Config)) { $Config = Join-Path $root $Config }

function Get-RotationProcesses {
  $items = [System.Collections.Generic.List[object]]::new()
  foreach ($entry in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
    $command = [string]$entry.CommandLine
    if (-not $command -or $command.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
    $role = $null
    if ($entry.Name -eq 'powershell.exe' -and $command.IndexOf('watch-rotation.ps1', [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      $role = 'watchdog'
    } elseif ($entry.Name -eq 'node.exe' -and $command.IndexOf('apps/executor/src/main.ts', [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      $role = 'executor'
    } elseif ($entry.Name -eq 'node.exe' -and $command.IndexOf('apps/scanner/src/main.ts', [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      $role = 'scanner'
    }
    if ($role) { $items.Add([pscustomobject]@{ Role = $role; ProcessId = [int]$entry.ProcessId }) }
  }
  return $items.ToArray()
}

function Wait-ForRotationExit {
  param([int]$TimeoutSeconds)
  $deadline = (Get-Date).AddSeconds([Math]::Max(10, $TimeoutSeconds))
  while ((Get-Date) -lt $deadline) {
    $remaining = @(Get-RotationProcesses)
    if ($remaining.Count -eq 0) { return $true }
    Start-Sleep -Seconds 1
  }
  $ids = (@(Get-RotationProcesses) | ForEach-Object { '{0}:{1}' -f $_.Role, $_.ProcessId }) -join ', '
  throw ('Previous rotation did not exit within {0}s ({1}).' -f $TimeoutSeconds, $ids)
}

$existing = @(Get-RotationProcesses)
if ($existing.Count -gt 0) {
  if (-not (Test-Path -LiteralPath $stopPath)) {
    $ids = ($existing | ForEach-Object { '{0}:{1}' -f $_.Role, $_.ProcessId }) -join ', '
    Write-Host ('Rotation is already running ({0}). Run npm run rotation:stop before starting again.' -f $ids)
    exit 0
  }
  Write-Host 'Waiting for the previous rotation to finish its stop sequence...'
  [void](Wait-ForRotationExit -TimeoutSeconds $WaitForExitSeconds)
}

Remove-Item -LiteralPath $stopPath -Force -ErrorAction SilentlyContinue

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
