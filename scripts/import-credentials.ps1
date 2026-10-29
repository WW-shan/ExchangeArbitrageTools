[CmdletBinding()]
param(
  [string]$CredentialFile = 'data/api-keys.json',
  [switch]$DeleteCredentialFile,
  [switch]$SkipWithdrawal,
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

if (-not [IO.Path]::IsPathRooted($CredentialFile)) {
  $CredentialFile = Join-Path $root $CredentialFile
}
if (-not (Test-Path -LiteralPath $CredentialFile -PathType Leaf)) {
  throw ('Credential file not found: ' + $CredentialFile + '. Copy config/api-keys.example.json to data/api-keys.json and fill the records you want to import.')
}
$credentialPath = (Resolve-Path -LiteralPath $CredentialFile -ErrorAction Stop).Path

try {
  $raw = [IO.File]::ReadAllText($credentialPath)
  $parsed = ConvertFrom-Json -InputObject $raw -ErrorAction Stop
} catch {
  throw ('Credential file is not valid JSON: ' + $credentialPath + '. Use the array format from config/api-keys.example.json.')
}
$records = @($parsed)
if ($records.Count -eq 0) {
  throw ('Credential file contains no records: ' + $credentialPath)
}
$filled = @($records | Where-Object {
  -not [string]::IsNullOrWhiteSpace([string]$_.apiKey) -and
  -not [string]::IsNullOrWhiteSpace([string]$_.secret)
})
if ($filled.Count -eq 0) {
  throw ('No filled credentials found in ' + $credentialPath + '. Fill apiKey and secret for at least one record.')
}

$payload = ConvertTo-Json -InputObject @($records) -Depth 10
$tsxCli = Join-Path $root 'node_modules/tsx/dist/cli.mjs'
$secretsCli = Join-Path $root 'apps/executor/src/secrets-cli.ts'
if (-not (Test-Path -LiteralPath $tsxCli -PathType Leaf) -or -not (Test-Path -LiteralPath $secretsCli -PathType Leaf)) {
  throw 'tsx or secrets CLI is missing. Run npm install first.'
}

$arguments = @('--merge', '--skip-empty')
if ($SkipWithdrawal) {
  $arguments += '--skip-withdrawal'
}

try {
  $payload | & node $tsxCli $secretsCli @arguments
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    throw ('Credential import failed with exit code ' + $exitCode)
  }
  if ($DeleteCredentialFile) {
    try {
      Remove-Item -LiteralPath $credentialPath -Force
      Write-Host ('Removed local credential file: ' + $credentialPath)
    } catch {
      Write-Warning ('Credentials were imported, but the local file could not be removed: ' + $credentialPath)
    }
  }
} finally {
  Remove-Variable payload, raw, parsed, records, filled -ErrorAction SilentlyContinue
}
