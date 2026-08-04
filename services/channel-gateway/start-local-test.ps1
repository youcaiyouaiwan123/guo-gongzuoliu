$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "Haixin Feishu Gateway - Local Test" -ForegroundColor Green
Write-Host "Secrets stay in this process only and are not written to disk." -ForegroundColor DarkGray
Write-Host ""

$appId = Read-Host "Feishu App ID"
$appSecretSecure = Read-Host "Feishu App Secret (hidden)" -AsSecureString
$relayUrl = Read-Host "Backend relay URL"
$relaySecretSecure = Read-Host "Gateway relay secret (hidden)" -AsSecureString

if ([string]::IsNullOrWhiteSpace($appId) -or [string]::IsNullOrWhiteSpace($relayUrl)) {
  throw "App ID and backend relay URL are required."
}

if (-not $relayUrl.StartsWith("https://")) {
  throw "Backend relay URL must start with https://"
}

$appSecretPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($appSecretSecure)
$relaySecretPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($relaySecretSecure)

try {
  $appSecret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($appSecretPtr)
  $relaySecret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($relaySecretPtr)

  $account = @{
    id = "feishu-local-test"
    platform = "feishu"
    appId = $appId.Trim()
    appSecret = $appSecret
    relayUrl = $relayUrl.Trim()
    relaySecret = $relaySecret
  }
  if (-not [string]::IsNullOrWhiteSpace($env:HAIXIN_SITES_BYPASS_TOKEN)) {
    $account.sitesBypassToken = $env:HAIXIN_SITES_BYPASS_TOKEN
  }

  $env:HAIXIN_ACCOUNTS_JSON = ConvertTo-Json @($account) -Compress
  $env:PORT = "8788"

  Write-Host ""
  Write-Host "Connecting to Feishu. Keep this window open." -ForegroundColor Cyan
  Write-Host "When the gateway reports ONLINE, send: hello" -ForegroundColor Cyan
  Write-Host ""

  Set-Location $PSScriptRoot
  node index.mjs
}
finally {
  if ($appSecretPtr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($appSecretPtr)
  }
  if ($relaySecretPtr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($relaySecretPtr)
  }
  Remove-Item Env:HAIXIN_ACCOUNTS_JSON -ErrorAction SilentlyContinue
}
