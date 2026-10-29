[CmdletBinding()]
param([string]$Config = 'config/live-rotation.toml')

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path
if (-not [IO.Path]::IsPathRooted($Config)) { $Config = Join-Path $root $Config }
$watch = Join-Path $PSScriptRoot 'watch-rotation.ps1'
$command = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{0}" -Config "{1}"' -f $watch, $Config
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
New-Item -Path $runKey -Force | Out-Null
Set-ItemProperty -Path $runKey -Name 'ExchangeArbitrageTools-Rotation' -Value $command
Write-Host 'Installed current-user logon autostart (HKCU Run).'
Write-Host $command