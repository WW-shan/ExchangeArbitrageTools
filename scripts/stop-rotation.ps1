[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path
$processes = Get-CimInstance Win32_Process | Where-Object {
  $commandLine = [string]$_.CommandLine
  $_.Name -eq 'node.exe' -and
  $commandLine -and
  $commandLine -like "*$root*" -and
  ($commandLine -like '*apps/scanner/src/main.ts*' -or $commandLine -like '*apps/executor/src/main.ts*--auto*')
}
if (-not $processes) {
  Write-Host 'No rotation scanner or supervisor process found.'
  return
}
foreach ($process in $processes) {
  Stop-Process -Id $process.ProcessId -Force
  Write-Host ('Stopped rotation process {0}.' -f $process.ProcessId)
}
