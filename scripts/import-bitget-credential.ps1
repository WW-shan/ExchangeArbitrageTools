[CmdletBinding()]
param(
  [switch]$IpWhitelistVerified,
  [string]$CredentialFile,
  [switch]$DeleteCredentialFile,
  [string]$SecretStorePath
)

$ErrorActionPreference = 'Stop'
trap {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
$root = (Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path
$envPath = Join-Path $root '.env.live-test'
if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) {
  throw ('Environment file not found: ' + $envPath)
}

. (Join-Path $PSScriptRoot 'load-env.ps1') -Path $envPath
if ($SecretStorePath) {
  if (-not [IO.Path]::IsPathRooted($SecretStorePath)) {
    $SecretStorePath = Join-Path $root $SecretStorePath
  }
  $env:ARB_SECRET_STORE_PATH = [IO.Path]::GetFullPath($SecretStorePath)
}
if (-not $env:ARB_SECRET_STORE_KEY) {
  throw 'ARB_SECRET_STORE_KEY is not loaded. Restore data/master-key.dpapi or set the environment variable.'
}

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

function New-BitgetRecord {
  param(
    [string]$ApiKey,
    [string]$Secret,
    [string]$Passphrase
  )
  if ([string]::IsNullOrWhiteSpace($ApiKey)) {
    throw 'Bitget API key is empty. If this terminal cannot accept input, use -CredentialFile.'
  }
  if ([string]::IsNullOrWhiteSpace($Secret) -or [string]::IsNullOrWhiteSpace($Passphrase)) {
    throw 'Bitget secret and passphrase must not be empty.'
  }
  return [ordered]@{
    venueId = 'bitget'
    role = 'trade'
    withdrawalPermission = $false
    ipWhitelistVerified = [bool]$IpWhitelistVerified
    apiKey = $ApiKey
    secret = $Secret
    password = $Passphrase
  }
}

function Get-CredentialRecordFromFile {
  param([string]$Path)
  try {
    $raw = [IO.File]::ReadAllText($Path)
    $parsed = ConvertFrom-Json -InputObject $raw -ErrorAction Stop
  } catch {
    throw ('Credential file is not valid JSON: ' + $Path + '. Use one object with apiKey, secret, and password or passphrase; all keys and values must be double-quoted.')
  }
  $records = @($parsed)
  if ($records.Count -ne 1) {
    throw ('Credential file must contain exactly one record: ' + $Path)
  }
  $source = $records[0]
  $passphrase = [string]$source.password
  if ([string]::IsNullOrWhiteSpace($passphrase)) {
    $passphrase = [string]$source.passphrase
  }
  return New-BitgetRecord -ApiKey ([string]$source.apiKey) -Secret ([string]$source.secret) -Passphrase $passphrase
}

Write-Host 'Bitget credential import. Input is not written to Git.'
$defaultCredentialFile = Join-Path $root 'data/bitget-credential.local.json'
if (-not $CredentialFile -and (Test-Path -LiteralPath $defaultCredentialFile -PathType Leaf)) {
  $CredentialFile = $defaultCredentialFile
}

$credentialPath = $null
if ($CredentialFile) {
  try {
    $credentialPath = (Resolve-Path -LiteralPath $CredentialFile -ErrorAction Stop).Path
  } catch {
    throw ('Credential file not found: ' + $CredentialFile)
  }
  $record = Get-CredentialRecordFromFile -Path $credentialPath
} else {
  if ([Console]::IsInputRedirected) {
    throw ('No credential file found. Create ' + $defaultCredentialFile + ' with apiKey, secret, and password, then rerun this command. Interactive input is unavailable in this terminal.')
  }
  $apiKey = Read-PlainSecret 'Bitget API key'
  $secret = Read-PlainSecret 'Bitget API secret'
  $passphrase = Read-PlainSecret 'Bitget API passphrase'
  $record = New-BitgetRecord -ApiKey $apiKey -Secret $secret -Passphrase $passphrase
}

$payload = ConvertTo-Json -InputObject @($record) -Depth 5
$tsxCli = Join-Path $root 'node_modules/tsx/dist/cli.mjs'
$secretsCli = Join-Path $root 'apps/executor/src/secrets-cli.ts'
if (-not (Test-Path -LiteralPath $tsxCli -PathType Leaf) -or -not (Test-Path -LiteralPath $secretsCli -PathType Leaf)) {
  throw 'tsx or secrets CLI is missing. Run npm install first.'
}

try {
  $payload | & node $tsxCli $secretsCli --merge --skip-withdrawal
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    throw ('Credential import failed with exit code ' + $exitCode)
  }
  if ($credentialPath -and $DeleteCredentialFile) {
    try {
      Remove-Item -LiteralPath $credentialPath -Force
      Write-Host ('Removed local credential file: ' + $credentialPath)
    } catch {
      Write-Warning ('Credential was imported, but the local file could not be removed: ' + $credentialPath)
    }
  }
} finally {
  Remove-Variable payload, record, apiKey, secret, passphrase, source, raw, parsed, records -ErrorAction SilentlyContinue
}
