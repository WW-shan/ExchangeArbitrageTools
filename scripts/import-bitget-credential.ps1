[CmdletBinding()]
param(
  [switch]$IpWhitelistVerified
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path
$envPath = Join-Path $root '.env.live-test'
if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) {
  throw ('Environment file not found: ' + $envPath)
}

. (Join-Path $PSScriptRoot 'load-env.ps1') -Path $envPath

function Read-PlainSecret {
  param([string]$Prompt)
  $secure = Read-Host $Prompt -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

Write-Host 'Bitget credential import. Input is hidden and is not written to Git.'
$apiKey = Read-Host 'Bitget API key'
if ([string]::IsNullOrWhiteSpace($apiKey)) {
  throw 'Bitget API key must not be empty'
}
$secret = Read-PlainSecret 'Bitget API secret'
$passphrase = Read-PlainSecret 'Bitget API passphrase'
if ([string]::IsNullOrWhiteSpace($secret) -or [string]::IsNullOrWhiteSpace($passphrase)) {
  throw 'Bitget secret and passphrase must not be empty'
}

$record = [ordered]@{
  venueId = 'bitget'
  role = 'trade'
  withdrawalPermission = $false
  ipWhitelistVerified = [bool]$IpWhitelistVerified
  apiKey = $apiKey
  secret = $secret
  password = $passphrase
}
$payload = ConvertTo-Json -InputObject @($record) -Depth 5
try {
  $payload | npm run executor:secrets -- --merge --skip-withdrawal
} finally {
  Remove-Variable payload, record, apiKey, secret, passphrase -ErrorAction SilentlyContinue
}
