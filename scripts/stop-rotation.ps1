[CmdletBinding()]
param([int]$TimeoutSeconds = 150)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path
$data = Join-Path $root 'data'
$stopPath = Join-Path $data 'rotation.stop'
$statusPath = Join-Path $data 'rotation-watchdog.status.json'
$pidPath = Join-Path $data 'rotation-watchdog.pid'
New-Item -ItemType Directory -Force -Path $data | Out-Null
[IO.File]::WriteAllText($stopPath, ((Get-Date).ToUniversalTime().ToString('o') + "`n"), [Text.UTF8Encoding]::new($false))
Write-Host 'Stop requested; waiting for the current batch to reach a safe boundary.'

$watchdogPid = $null
if (Test-Path -LiteralPath $pidPath -PathType Leaf) {
  try { $watchdogPid = [int](Get-Content -LiteralPath $pidPath -Raw).Trim() } catch { $watchdogPid = $null }
}
$deadline = (Get-Date).AddSeconds([Math]::Max(10, $TimeoutSeconds))
while ((Get-Date) -lt $deadline) {
  $watchdogAlive = $false
  if ($watchdogPid) {
    $watchdogAlive = $null -ne (Get-Process -Id $watchdogPid -ErrorAction SilentlyContinue)
  }
  if (-not $watchdogAlive) { break }
  Start-Sleep -Seconds 2
}

function Stop-ProcessTree {
  param([int]$RootPid)
  $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $RootPid" -ErrorAction SilentlyContinue)
  foreach ($child in $children) { Stop-ProcessTree -RootPid ([int]$child.ProcessId) }
  Stop-Process -Id $RootPid -Force -ErrorAction SilentlyContinue
}function Get-RotationNodeRoots {
  $matches = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $command = [string]$_.CommandLine
    $command -and
      $command.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
      ($command.IndexOf('apps/executor/src/main.ts', [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        $command.IndexOf('apps/scanner/src/main.ts', [StringComparison]::OrdinalIgnoreCase) -ge 0)
  })
  $ids = @{}
  foreach ($entry in $matches) { $ids[[int]$entry.ProcessId] = $true }
  return @($matches | Where-Object { -not $ids.ContainsKey([int]$_.ParentProcessId) })
}

if ($watchdogPid) {
  $watchdog = Get-Process -Id $watchdogPid -ErrorAction SilentlyContinue
  if ($watchdog) {
    Write-Host ('Watchdog did not stop within {0}s; stopping its process tree.' -f $TimeoutSeconds)
    Stop-ProcessTree -RootPid $watchdogPid
  }
}

$status = $null
if (Test-Path -LiteralPath $statusPath -PathType Leaf) {
  try { $status = Get-Content -LiteralPath $statusPath -Raw } catch { $status = $null }
}
foreach ($nodeProcess in @(Get-RotationNodeRoots)) {
  Write-Host ('Stopping remaining rotation process tree {0}.' -f [int]$nodeProcess.ProcessId)
  Stop-ProcessTree -RootPid ([int]$nodeProcess.ProcessId)
}
Write-Host 'Stop sequence completed. The stop file remains until the next explicit start.'
if ($status) { Write-Host $status }