[CmdletBinding()]
param(
  [string]$Path,
  [switch]$PromptMasterKey
)

$ErrorActionPreference = 'Stop'

$scriptDir = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($scriptDir)) {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
if ([string]::IsNullOrWhiteSpace($Path)) {
  $Path = Join-Path $scriptDir '..\.env.live-test'
}

$masterKeyFile = Join-Path $scriptDir '..\data\master-key.dpapi'
if (-not $env:ARB_SECRET_STORE_KEY -and (Test-Path -LiteralPath $masterKeyFile -PathType Leaf)) {
  $encrypted = (Get-Content -LiteralPath $masterKeyFile -Raw).Trim()
  $secure = ConvertTo-SecureString $encrypted
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $env:ARB_SECRET_STORE_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
  Write-Host 'Loaded ARB_SECRET_STORE_KEY from local DPAPI file.'
}

if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
  throw ('Environment file not found: ' + $Path)
}

$doubleQuote = [char]34
$singleQuote = [char]39
$loaded = [System.Collections.Generic.List[string]]::new()
foreach ($rawLine in Get-Content -LiteralPath $Path) {
  $line = $rawLine.Trim()
  if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith('#')) {
    continue
  }

  $match = [regex]::Match($line, '^(?<name>[A-Za-z_][A-Za-z0-9_]*)=(?<value>.*)$')
  if (-not $match.Success) {
    throw ('Invalid environment line in ' + $Path + ': ' + $line)
  }

  $name = $match.Groups['name'].Value
  $value = $match.Groups['value'].Value.Trim()
  if ($value.Length -ge 2) {
    $first = $value[0]
    $last = $value[$value.Length - 1]
    if (($first -eq $doubleQuote -and $last -eq $doubleQuote) -or ($first -eq $singleQuote -and $last -eq $singleQuote)) {
      $value = $value.Substring(1, $value.Length - 2)
    }
  }

  Set-Item -Path ('Env:' + $name) -Value $value
  $loaded.Add($name)
}

if (-not $env:ARB_CONFIG) {
  throw 'ARB_CONFIG was not set by the environment file'
}

if ($PromptMasterKey -and -not $env:ARB_SECRET_STORE_KEY) {
  $secure = Read-Host 'ARB_SECRET_STORE_KEY' -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $env:ARB_SECRET_STORE_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

Write-Host ('Loaded {0} environment variable(s) from {1}' -f $loaded.Count, $Path)
if (-not $env:ARB_SECRET_STORE_KEY) {
  Write-Warning 'ARB_SECRET_STORE_KEY is not set; credential import and private API calls will fail.'
}
