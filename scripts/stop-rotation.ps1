[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path
$processes = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
  $commandLine = [string]$_.CommandLine
  $commandLine.Contains($root) -and
  ($commandLine -match 'apps[\\/]scanner[\\/]src[\\/]main\\.ts|apps[\\/]executor[\\/]src[\\/]main\\.ts.*--auto')
}
if (-not $processes) {
  Write-Host 'No rotation scanner or supervisor process found.'
  return
}
foreach ($process in $processes) {
  Stop-Process -Id $process.ProcessId -Force
  Write-Host ('Stopped rotation process {0}.' -f $process.ProcessId)
}
