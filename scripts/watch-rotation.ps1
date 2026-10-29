[CmdletBinding()]
param(
  [string]$Config = 'config/live-rotation.toml',
  [string]$ExecutorHeartbeatFile = '',
  [string]$ScannerHeartbeatFile = '',
  [int]$MaxHeartbeatAgeSeconds = 90,
  [int]$StartupGraceSeconds = 120,
  [int]$PollSeconds = 5,
  [int]$RestartBackoffSeconds = 10,
  [int]$StopGraceSeconds = 120,
  [switch]$NoScanner
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path
$data = Join-Path $root 'data'
$logs = Join-Path $data 'logs'
New-Item -ItemType Directory -Force -Path $data, $logs | Out-Null
if (-not [IO.Path]::IsPathRooted($Config)) { $Config = Join-Path $root $Config }
if ([string]::IsNullOrWhiteSpace($ExecutorHeartbeatFile)) {
  $ExecutorHeartbeatFile = Join-Path $data 'rotation-executor.heartbeat.json'
}
if ([string]::IsNullOrWhiteSpace($ScannerHeartbeatFile)) {
  $ScannerHeartbeatFile = Join-Path $data 'rotation-scanner.heartbeat.json'
}

$lockPath = Join-Path $data 'rotation-watchdog.lock'
$pidPath = Join-Path $data 'rotation-watchdog.pid'
$statusPath = Join-Path $data 'rotation-watchdog.status.json'
$stopPath = Join-Path $data 'rotation.stop'
$watchLog = Join-Path $logs ('rotation-watchdog-{0}.jsonl' -f (Get-Date -Format 'yyyyMMdd'))
$executorScript = Join-Path $root 'apps/executor/src/main.ts'
$scannerScript = Join-Path $root 'apps/scanner/src/main.ts'

$lockStream = $null
try {
  $lockStream = [IO.File]::Open(
    $lockPath,
    [IO.FileMode]::OpenOrCreate,
    [IO.FileAccess]::ReadWrite,
    [IO.FileShare]::None
  )
} catch [IO.IOException] {
  Write-Host 'rotation watchdog is already running; exiting.'
  exit 3
}

function Write-WatchLog {
  param([string]$Level, [string]$Event, [hashtable]$Data = @{})
  $payload = [ordered]@{
    at = (Get-Date).ToUniversalTime().ToString('o')
    level = $Level
    event = $Event
    watchdogPid = $PID
    runId = $script:RunId
  }
  foreach ($key in $Data.Keys) { $payload[$key] = $Data[$key] }
  try {
    ($payload | ConvertTo-Json -Compress -Depth 8) | Add-Content -LiteralPath $watchLog
  } catch {
  }
}

function Write-WatchdogStatus {
  param([string]$State, [string]$Reason = '', [hashtable]$Extra = @{})
  $body = [ordered]@{
    version = 1
    runId = $script:RunId
    watchdogPid = $PID
    updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    state = $State
    reason = $Reason
    config = $Config
    stopFile = $stopPath
    executor = $script:ExecutorStatus
    scanner = $script:ScannerStatus
  }
  foreach ($key in $Extra.Keys) { $body[$key] = $Extra[$key] }
  try {
    [IO.File]::WriteAllText($statusPath, (($body | ConvertTo-Json -Depth 8) + "`n"), [Text.UTF8Encoding]::new($false))
  } catch {
  }
}

function Read-RotationHeartbeat {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try { return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json) } catch { return $null }
}

function Get-HeartbeatAgeMs {
  param($Heartbeat, [int64]$Now)
  if (-not $Heartbeat -or -not $Heartbeat.updatedAt) { return $null }
  return $Now - [int64]$Heartbeat.updatedAt
}

function Test-HeartbeatFresh {
  param($Heartbeat, [int]$ExpectedPid, [int64]$Now, [string]$ExpectedRunId = '')
  if (-not $Heartbeat -or $Heartbeat.state -ne 'running') { return $false }
  if ([int]$Heartbeat.pid -ne $ExpectedPid) { return $false }
  if ($ExpectedRunId -and [string]$Heartbeat.runId -ne $ExpectedRunId) { return $false }
  $age = Get-HeartbeatAgeMs -Heartbeat $Heartbeat -Now $Now
  return ($null -ne $age -and $age -ge -5000 -and $age -le ($MaxHeartbeatAgeSeconds * 1000))
}

function Get-RotationProcesses {
  param([ValidateSet('executor', 'scanner')][string]$Role)
  $needle = $executorScript
  $relative = 'apps/executor/src/main.ts'
  if ($Role -eq 'scanner') {
    $needle = $scannerScript
    $relative = 'apps/scanner/src/main.ts'
  }
  $matches = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $command = [string]$_.CommandLine
    $command -and
    ($command.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
      ($command.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $command.IndexOf($relative, [StringComparison]::OrdinalIgnoreCase) -ge 0)) -and
    ($Role -ne 'executor' -or $command -match '(^|\s)--auto(\s|$)')
  })
  $ids = @{}
  foreach ($entry in $matches) { $ids[[int]$entry.ProcessId] = $true }
  return @($matches | Where-Object { -not $ids.ContainsKey([int]$_.ParentProcessId) })
}

function Stop-ProcessTree {
  param([int]$RootPid)
  $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $RootPid" -ErrorAction SilentlyContinue)
  foreach ($child in $children) { Stop-ProcessTree -RootPid ([int]$child.ProcessId) }
  Stop-Process -Id $RootPid -Force -ErrorAction SilentlyContinue
}

function Stop-MatchingProcesses {
  param([ValidateSet('executor', 'scanner')][string]$Role)
  $processes = Get-RotationProcesses -Role $Role
  foreach ($process in $processes) {
    Write-WatchLog 'info' 'stopping_process' @{ role = $Role; pid = [int]$process.ProcessId }
    Stop-ProcessTree -RootPid ([int]$process.ProcessId)
  }
  return $processes.Count
}

function Get-ProcessExitCode {
  param($Process)
  try {
    $Process.Refresh()
    if ($Process.HasExited) {
      $Process.WaitForExit()
      return [int]$Process.ExitCode
    }
  } catch {
    return $null
  }
  return $null
}

function New-LogPaths {
  param([string]$Role)
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
  $base = Join-Path $logs ("{0}-{1}-{2}" -f $Role, $stamp, $PID)
  return @{
    stdout = ($base + '.out.log')
    stderr = ($base + '.err.log')
  }
}

function Start-ExecutorProcess {
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $env:ARB_ROTATION_STARTED_AT = [string]$now
  $paths = New-LogPaths -Role 'executor'
  $node = (Get-Command node -ErrorAction Stop).Source
  $process = Start-Process -FilePath $node `
    -ArgumentList @('--import', 'tsx', $executorScript, '--auto') `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $paths.stdout `
    -RedirectStandardError $paths.stderr `
    -PassThru
  $script:ExecutorStarts += 1
  $script:ExecutorStatus = [ordered]@{
    pid = [int]$process.Id
    adopted = $false
    starts = $script:ExecutorStarts
    startedAt = $now
    lastExitCode = $null
    heartbeatAgeMs = $null
    phase = 'STARTING'
    stdout = $paths.stdout
    stderr = $paths.stderr
  }
  Write-WatchLog 'info' 'executor_started' @{ pid = [int]$process.Id; stdout = $paths.stdout }
  return $process
}

function Start-ScannerProcess {
  if ($NoScanner) { return $null }
  $paths = New-LogPaths -Role 'scanner'
  $node = (Get-Command node -ErrorAction Stop).Source
  $process = Start-Process -FilePath $node `
    -ArgumentList @('--import', 'tsx', $scannerScript) `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $paths.stdout `
    -RedirectStandardError $paths.stderr `
    -PassThru
  $script:ScannerStarts += 1
  $script:ScannerStatus = [ordered]@{
    pid = [int]$process.Id
    adopted = $false
    starts = $script:ScannerStarts
    startedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    lastExitCode = $null
    heartbeatAgeMs = $null
    phase = 'STARTING'
    stdout = $paths.stdout
    stderr = $paths.stderr
  }
  Write-WatchLog 'info' 'scanner_started' @{ pid = [int]$process.Id; stdout = $paths.stdout }
  return $process
}

function Wait-ExecutorReady {
  param($Process)
  $deadline = (Get-Date).AddSeconds($StartupGraceSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $stopPath) { return 'stop' }
    if ($Process.HasExited) {
      $outcome = Get-ExecutorExitOutcome -Process $Process
      return $outcome.kind
    }
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $heartbeat = Read-RotationHeartbeat -Path $ExecutorHeartbeatFile
    if (Test-HeartbeatFresh -Heartbeat $heartbeat -ExpectedPid ([int]$Process.Id) -Now $now -ExpectedRunId $script:RunId) {
      return 'ready'
    }
    Start-Sleep -Seconds 2
  }
  return 'timeout'
}

function Get-ExecutorExitOutcome {
  param($Process)
  $exitCode = Get-ProcessExitCode -Process $Process
  $heartbeat = Read-RotationHeartbeat -Path $ExecutorHeartbeatFile
  $sameProcess = $heartbeat -and
    [int]$heartbeat.pid -eq [int]$Process.Id -and
    (-not $heartbeat.runId -or [string]$heartbeat.runId -eq $script:RunId)
  if ($sameProcess -and $heartbeat.state -eq 'stopped') {
    $reason = [string]($heartbeat.lastWaitReasons -join ',')
    $blockedPattern = 'kill_switch|safe_stop|blocked|failure_limit|unexpected_error|account_status|unsupervised|secret_store|transfer_'
    return @{
      kind = if ($reason -match $blockedPattern) { 'blocked' } else { 'stopped' }
      reason = $reason
      exitCode = $exitCode
    }
  }
  if ($sameProcess -and $heartbeat.state -eq 'running') {
    return @{ kind = 'crash'; reason = 'process_exit_with_running_heartbeat'; exitCode = $exitCode }
  }
  if ($null -ne $exitCode -and $exitCode -eq 2) {
    return @{ kind = 'blocked'; reason = 'exit_two'; exitCode = $exitCode }
  }
  return @{ kind = 'crash'; reason = 'missing_terminal_heartbeat'; exitCode = $exitCode }
}

function Stop-ScannerForExecutorRestart {
  if ($NoScanner) { return }
  [void](Stop-MatchingProcesses -Role 'scanner')
  $script:ScannerProcess = $null
  if ($script:ScannerStatus) { $script:ScannerStatus.phase = 'STOPPED_FOR_EXECUTOR_RESTART' }
}

function Test-ExecutorRestartAllowed {
  $now = Get-Date
  $cutoff = $now.AddMinutes(-10)
  $recent = @($script:ExecutorRestartHistory | Where-Object { $_ -ge $cutoff })
  $recent += $now
  $script:ExecutorRestartHistory = @($recent)
  return $recent.Count -le 5
}

function Invoke-RotationHalt {
  Write-WatchLog 'critical' 'duplicate_executor_halt' @{}
  try {
    $env:ARB_CONFIG = $Config
    & node --import tsx (Join-Path $root 'apps/executor/src/halt-cli.ts') | Out-Null
  } catch {
    Write-WatchLog 'error' 'halt_command_failed' @{ error = [string]$_ }
  }
}

. (Join-Path $PSScriptRoot 'load-env.ps1')
$script:RunId = [guid]::NewGuid().ToString()
$script:ExecutorProcess = $null
$script:ScannerProcess = $null
$script:ExecutorStarts = 0
$script:ScannerStarts = 0
$script:ExecutorRestartHistory = @()
$script:ExecutorStatus = $null
$script:ScannerStatus = $null
$env:ARB_CONFIG = $Config
$env:ARB_ROTATION_SUPERVISED = '1'
$env:ARB_ROTATION_RUN_ID = $script:RunId
$env:ARB_ROTATION_STOP_FILE = $stopPath
$env:ARB_ROTATION_EXECUTOR_HEARTBEAT = $ExecutorHeartbeatFile
$env:ARB_ROTATION_SCANNER_HEARTBEAT = $ScannerHeartbeatFile

try {
  [IO.File]::WriteAllText($pidPath, [string]$PID, [Text.UTF8Encoding]::new($false))
  Write-WatchLog 'info' 'watchdog_started' @{ config = $Config }
  if (Test-Path -LiteralPath $stopPath) {
    Write-WatchdogStatus -State 'STOPPED' -Reason 'stop_file_present'
    Write-WatchLog 'info' 'watchdog_stopped' @{ reason = 'stop_file_present' }
    exit 0
  }

  $existingExecutors = @(Get-RotationProcesses -Role 'executor')
  if ($existingExecutors.Count -gt 1) {
    Invoke-RotationHalt
    Write-WatchdogStatus -State 'BLOCKED' -Reason 'duplicate_executor_processes' -Extra @{ executorCount = $existingExecutors.Count }
    exit 4
  }
  if ($existingExecutors.Count -eq 1) {
    $existingPid = [int]$existingExecutors[0].ProcessId
    $heartbeat = Read-RotationHeartbeat -Path $ExecutorHeartbeatFile
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if (-not (Test-HeartbeatFresh -Heartbeat $heartbeat -ExpectedPid $existingPid -Now $now)) {
      Write-WatchLog 'warn' 'executor_adoption_blocked' @{ pid = $existingPid }
      Write-WatchdogStatus -State 'ATTENTION' -Reason 'existing_executor_without_fresh_heartbeat'
      exit 5
    }
    $script:RunId = [string]$heartbeat.runId
    $env:ARB_ROTATION_RUN_ID = $script:RunId
    $script:ExecutorProcess = Get-Process -Id $existingPid -ErrorAction Stop
    $script:ExecutorStatus = [ordered]@{
      pid = $existingPid
      adopted = $true
      starts = 0
      startedAt = $heartbeat.startedAt
      lastExitCode = $null
      heartbeatAgeMs = (Get-HeartbeatAgeMs -Heartbeat $heartbeat -Now $now)
      phase = $heartbeat.phase
      stdout = $null
      stderr = $null
    }
    Write-WatchLog 'info' 'executor_adopted' @{ pid = $existingPid; runId = $script:RunId }
  } else {
    $script:ExecutorProcess = Start-ExecutorProcess
    $ready = Wait-ExecutorReady -Process $script:ExecutorProcess
    if ($ready -ne 'ready') {
      if ($ready -eq 'timeout') {
        [void](Stop-MatchingProcesses -Role 'executor')
        Write-WatchdogStatus -State 'BLOCKED' -Reason 'executor_startup_timeout'
        exit 2
      }
      if ($ready -eq 'stop') {
        Write-WatchdogStatus -State 'STOPPED' -Reason 'stop_requested_during_startup'
        exit 0
      }
      if ($ready -eq 'blocked') {
        Write-WatchdogStatus -State 'BLOCKED' -Reason 'executor_startup_blocked'
        exit 2
      }
      if ($ready -eq 'stopped') {
        Write-WatchdogStatus -State 'STOPPED' -Reason 'executor_exited_cleanly'
        exit 0
      }
      Write-WatchdogStatus -State 'BLOCKED' -Reason ("executor_startup_failed_{0}" -f $ready)
      exit 2
    }
  }

  $existingScanners = @(Get-RotationProcesses -Role 'scanner')
  if (-not $NoScanner -and $existingScanners.Count -gt 0) {
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $scannerPid = [int]$existingScanners[0].ProcessId
    $scannerHeartbeat = Read-RotationHeartbeat -Path $ScannerHeartbeatFile
    if ($existingScanners.Count -eq 1 -and (Test-HeartbeatFresh -Heartbeat $scannerHeartbeat -ExpectedPid $scannerPid -Now $now -ExpectedRunId $script:RunId)) {
      $script:ScannerProcess = Get-Process -Id $scannerPid -ErrorAction Stop
      $script:ScannerStatus = [ordered]@{
        pid = $scannerPid
        adopted = $true
        starts = 0
        startedAt = $scannerHeartbeat.startedAt
        lastExitCode = $null
        heartbeatAgeMs = (Get-HeartbeatAgeMs -Heartbeat $scannerHeartbeat -Now $now)
        phase = $scannerHeartbeat.phase
        stdout = $null
        stderr = $null
      }
      Write-WatchLog 'info' 'scanner_adopted' @{ pid = $scannerPid }
    } else {
      [void](Stop-MatchingProcesses -Role 'scanner')
    }
  }
  if (-not $NoScanner -and -not $script:ScannerProcess) {
    $script:ScannerProcess = Start-ScannerProcess
  }
  if ($NoScanner) {
    $script:ScannerStatus = [ordered]@{ enabled = $false; pid = $null; phase = 'DISABLED' }
  }

  Write-WatchdogStatus -State 'RUNNING' -Reason 'executor_and_scanner_started'
  $lastDuplicateCheck = Get-Date
  while ($true) {
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if (Test-Path -LiteralPath $stopPath) {
      Write-WatchLog 'info' 'stop_requested' @{ graceSeconds = $StopGraceSeconds }
      $deadline = (Get-Date).AddSeconds($StopGraceSeconds)
      while ((Get-Date) -lt $deadline) {
        $executorStopped = $script:ExecutorProcess.HasExited
        $scannerStopped = $NoScanner -or -not $script:ScannerProcess -or $script:ScannerProcess.HasExited
        if ($executorStopped -and $scannerStopped) { break }
        Start-Sleep -Seconds 2
      }
      Write-WatchdogStatus -State 'STOPPED' -Reason 'stop_requested'
      break
    }
    if (-not $script:ExecutorProcess) {
      Write-WatchdogStatus -State 'BLOCKED' -Reason 'executor_process_missing'
      break
    }
    if ($script:ExecutorProcess.HasExited) {
      $outcome = Get-ExecutorExitOutcome -Process $script:ExecutorProcess
      Stop-ScannerForExecutorRestart
      $script:ExecutorStatus.lastExitCode = $outcome.exitCode
      Write-WatchLog 'warn' 'executor_exited' @{ kind = $outcome.kind; reason = $outcome.reason; exitCode = $outcome.exitCode }
      if ($outcome.kind -eq 'stopped') {
        Write-WatchdogStatus -State 'STOPPED' -Reason 'executor_exited_cleanly'
        break
      }
      if ($outcome.kind -eq 'blocked') {
        Write-WatchdogStatus -State 'BLOCKED' -Reason ("executor_blocked_{0}" -f $outcome.reason)
        break
      }
      if (-not (Test-ExecutorRestartAllowed)) {
        Write-WatchdogStatus -State 'BLOCKED' -Reason 'executor_restart_loop'
        break
      }
      Start-Sleep -Seconds $RestartBackoffSeconds
      $script:ExecutorProcess = Start-ExecutorProcess
      $ready = Wait-ExecutorReady -Process $script:ExecutorProcess
      if ($ready -ne 'ready') {
        Write-WatchdogStatus -State 'BLOCKED' -Reason ("executor_restart_failed_{0}" -f $ready)
        break
      }
      $script:ScannerProcess = Start-ScannerProcess
      Write-WatchdogStatus -State 'RUNNING' -Reason 'executor_restarted'
      continue
    }

    $heartbeat = Read-RotationHeartbeat -Path $ExecutorHeartbeatFile
    $age = Get-HeartbeatAgeMs -Heartbeat $heartbeat -Now $now
    if ($script:ExecutorStatus) {
      $script:ExecutorStatus.heartbeatAgeMs = $age
      if ($heartbeat) { $script:ExecutorStatus.phase = $heartbeat.phase } else { $script:ExecutorStatus.phase = 'MISSING' }
    }
    if (-not (Test-HeartbeatFresh -Heartbeat $heartbeat -ExpectedPid ([int]$script:ExecutorProcess.Id) -Now $now -ExpectedRunId $script:RunId)) {
      Write-WatchLog 'warn' 'executor_heartbeat_stale' @{ ageMs = $age }
      Stop-ScannerForExecutorRestart
      [void](Stop-MatchingProcesses -Role 'executor')
      if (-not (Test-ExecutorRestartAllowed)) {
        Write-WatchdogStatus -State 'BLOCKED' -Reason 'executor_restart_loop'
        break
      }
      Start-Sleep -Seconds $RestartBackoffSeconds
      $script:ExecutorProcess = Start-ExecutorProcess
      $ready = Wait-ExecutorReady -Process $script:ExecutorProcess
      if ($ready -ne 'ready') {
        Write-WatchdogStatus -State 'BLOCKED' -Reason ("executor_restart_failed_{0}" -f $ready)
        break
      }
      $script:ScannerProcess = Start-ScannerProcess
      Write-WatchdogStatus -State 'RUNNING' -Reason 'executor_heartbeat_restart'
      continue
    }

    if (-not $NoScanner) {
      if (-not $script:ScannerProcess) {
        $script:ScannerProcess = Start-ScannerProcess
      } else {
        if ($script:ScannerProcess.HasExited) {
          $script:ScannerStatus.lastExitCode = Get-ProcessExitCode -Process $script:ScannerProcess
          Write-WatchLog 'warn' 'scanner_exited' @{ exitCode = $script:ScannerStatus.lastExitCode }
          $script:ScannerProcess = Start-ScannerProcess
        } else {
          $scannerHeartbeat = Read-RotationHeartbeat -Path $ScannerHeartbeatFile
          $scannerAge = Get-HeartbeatAgeMs -Heartbeat $scannerHeartbeat -Now $now
          if ($script:ScannerStatus) {
            $script:ScannerStatus.heartbeatAgeMs = $scannerAge
            if ($scannerHeartbeat) { $script:ScannerStatus.phase = $scannerHeartbeat.phase } else { $script:ScannerStatus.phase = 'MISSING' }
          }
          $scannerStartedAt = 0
          if ($script:ScannerStatus -and $script:ScannerStatus.startedAt) {
            $scannerStartedAt = [int64]$script:ScannerStatus.startedAt
          }
          $scannerStarting = $scannerStartedAt -gt 0 -and ($now - $scannerStartedAt) -lt ($StartupGraceSeconds * 1000)
          if (-not $scannerStarting -and -not (Test-HeartbeatFresh -Heartbeat $scannerHeartbeat -ExpectedPid ([int]$script:ScannerProcess.Id) -Now $now -ExpectedRunId $script:RunId)) {
            Write-WatchLog 'warn' 'scanner_heartbeat_stale' @{ ageMs = $scannerAge; startedAt = $scannerStartedAt }
            [void](Stop-MatchingProcesses -Role 'scanner')
            $script:ScannerProcess = Start-ScannerProcess
          }
        }
      }
    }

    if (((Get-Date) - $lastDuplicateCheck).TotalSeconds -ge 30) {
      $lastDuplicateCheck = Get-Date
      $executorCount = @(Get-RotationProcesses -Role 'executor').Count
      if ($executorCount -gt 1) {
        Invoke-RotationHalt
        Stop-ScannerForExecutorRestart
        [void](Stop-MatchingProcesses -Role 'executor')
        Write-WatchdogStatus -State 'BLOCKED' -Reason 'duplicate_executor_detected' -Extra @{ executorCount = $executorCount }
        break
      }
    }

    Write-WatchdogStatus -State 'RUNNING'
    Start-Sleep -Seconds ([Math]::Max(1, $PollSeconds))
  }
} catch {
  $message = $_.Exception.Message
  Write-WatchLog 'critical' 'watchdog_exception' @{ error = $message }
  Write-WatchdogStatus -State 'FAILED' -Reason $message
  exit 1
} finally {
  if ($script:ScannerProcess -and -not $script:ScannerProcess.HasExited) {
    Stop-ProcessTree -RootPid ([int]$script:ScannerProcess.Id)
  }
  if ($script:ExecutorProcess -and -not $script:ExecutorProcess.HasExited) {
    Stop-ProcessTree -RootPid ([int]$script:ExecutorProcess.Id)
  }
  if ($lockStream) { $lockStream.Dispose() }
  Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
  Write-WatchLog 'info' 'watchdog_exited' @{}
}
