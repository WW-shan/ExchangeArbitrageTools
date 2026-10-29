[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path
$data = Join-Path $root 'data'
$statusPath = Join-Path $data 'rotation-watchdog.status.json'
$executorHeartbeat = Join-Path $data 'rotation-executor.heartbeat.json'
$scannerHeartbeat = Join-Path $data 'rotation-scanner.heartbeat.json'
$stopPath = Join-Path $data 'rotation.stop'
$executorScript = Join-Path $root 'apps/executor/src/main.ts'
$scannerScript = Join-Path $root 'apps/scanner/src/main.ts'

function Read-TextFileShared {
  param([string]$Path)
  $share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
  $stream = [IO.FileStream]::new(
    $Path,
    [IO.FileMode]::Open,
    [IO.FileAccess]::Read,
    $share
  )
  try {
    $reader = [IO.StreamReader]::new($stream, [Text.UTF8Encoding]::new($false), $true)
    try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
  } finally {
    $stream.Dispose()
  }
}
function Read-JsonFile {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try { return (Read-TextFileShared -Path $Path | ConvertFrom-Json) } catch { return $null }
}
function Count-RoleProcesses {
  param([string]$Needle, [string]$Relative, [switch]$Executor)
  $matches = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $command = [string]$_.CommandLine
    $command -and
      ($command.IndexOf($Needle, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        ($command.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
          $command.IndexOf($Relative, [StringComparison]::OrdinalIgnoreCase) -ge 0)) -and
      (-not $Executor -or $command -match '(^|\s)--auto(\s|$)')
  })
  $ids = @{}
  foreach ($entry in $matches) { $ids[[int]$entry.ProcessId] = $true }
  return @($matches | Where-Object { -not $ids.ContainsKey([int]$_.ParentProcessId) }).Count
}
$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$executor = Read-JsonFile -Path $executorHeartbeat
$scanner = Read-JsonFile -Path $scannerHeartbeat
$output = [ordered]@{
  status = Read-JsonFile -Path $statusPath
  stopFilePresent = (Test-Path -LiteralPath $stopPath)
  processCounts = [ordered]@{
    executor = Count-RoleProcesses -Needle $executorScript -Relative 'apps/executor/src/main.ts' -Executor
    scanner = Count-RoleProcesses -Needle $scannerScript -Relative 'apps/scanner/src/main.ts'
  }
  executorHeartbeat = if ($executor) {
    [ordered]@{
      pid = $executor.pid
      runId = $executor.runId
      state = $executor.state
      phase = $executor.phase
      updatedAt = $executor.updatedAt
      ageMs = if ($executor.updatedAt) { $now - [int64]$executor.updatedAt } else { $null }
    }
  } else { $null }
  scannerHeartbeat = if ($scanner) {
    [ordered]@{
      pid = $scanner.pid
      runId = $scanner.runId
      state = $scanner.state
      phase = $scanner.phase
      updatedAt = $scanner.updatedAt
      ageMs = if ($scanner.updatedAt) { $now - [int64]$scanner.updatedAt } else { $null }
    }
  } else { $null }
}
$output | ConvertTo-Json -Depth 8
