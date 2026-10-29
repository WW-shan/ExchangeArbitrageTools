[CmdletBinding()]
param(
  [string]$TaskName = 'ExchangeArbitrageTools-Rotation',
  [string]$Config = 'config/live-rotation.toml'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$watch = Join-Path $PSScriptRoot 'watch-rotation.ps1'
if (-not [IO.Path]::IsPathRooted($Config)) { $Config = Join-Path $root $Config }
$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument ('-NoProfile -ExecutionPolicy Bypass -File {0} -Config {1}' -f $watch, $Config) `
  -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Days 3650)
Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description 'Start the Gate/Hotcoin rotation watchdog at logon' `
  -Force | Out-Null
Write-Host ('Installed scheduled task: {0}' -f $TaskName)
