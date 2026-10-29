[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
Remove-ItemProperty -Path $runKey -Name 'ExchangeArbitrageTools-Rotation' -ErrorAction SilentlyContinue
Write-Host 'Removed current-user logon autostart.'