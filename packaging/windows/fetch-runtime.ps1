# 海芯 AI 运行环境下载器（首次启动时由 haixin.cmd 调用）。
# 读取同目录 runtime-manifest.json（构建时生成）；下载 zip → 校验 SHA256 → 解压到 %LOCALAPPDATA%\HaixinAI。
# zip 顶层含 runtime\ 与 node_modules\，解压后即得 %LOCALAPPDATA%\HaixinAI\runtime\node.exe。
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

try {
  $manifestPath = Join-Path $PSScriptRoot 'runtime-manifest.json'
  if (-not (Test-Path $manifestPath)) { throw "缺少 runtime-manifest.json（安装包不完整）" }
  $m = Get-Content -Raw -Encoding UTF8 $manifestPath | ConvertFrom-Json
  $url = $m.url
  $sha = $m.sha256
  if ([string]::IsNullOrWhiteSpace($url)) { throw "manifest 未配置下载地址 url" }

  $target = Join-Path $env:LOCALAPPDATA 'HaixinAI'
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  $zip = Join-Path $env:TEMP 'haixin-runtime.zip'
  if (Test-Path $zip) { Remove-Item -Force $zip }

  Write-Host "正在下载运行环境：$url"
  $ok = $false
  try {
    # BITS：速度快且有进度条
    Import-Module BitsTransfer -ErrorAction Stop
    Start-BitsTransfer -Source $url -Destination $zip -Description '海芯 AI 运行环境' -DisplayName '下载运行环境'
    $ok = $true
  } catch {
    Write-Host "（BITS 不可用，改用直接下载，请稍候…）"
  }
  if (-not $ok) {
    $wc = New-Object System.Net.WebClient
    $wc.DownloadFile($url, $zip)
  }
  if (-not (Test-Path $zip)) { throw "下载失败：未生成文件" }

  if (-not [string]::IsNullOrWhiteSpace($sha)) {
    Write-Host "正在校验完整性…"
    $got = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash
    if ($got.ToLower() -ne $sha.ToLower()) {
      Remove-Item -Force $zip -ErrorAction SilentlyContinue
      throw "校验失败：文件可能损坏或被篡改（期望 $sha，实际 $got）"
    }
  }

  Write-Host "正在解压运行环境（约 240MB，请稍候）…"
  # 清掉可能残留的半成品，保证干净解压
  foreach ($d in @('runtime','node_modules')) {
    $p = Join-Path $target $d
    if (Test-Path $p) { Remove-Item -Recurse -Force $p -ErrorAction SilentlyContinue }
  }
  # Expand-Archive（PowerShell 5+ 自带）
  Expand-Archive -Path $zip -DestinationPath $target -Force
  Remove-Item -Force $zip -ErrorAction SilentlyContinue

  $node = Join-Path $target 'runtime\node.exe'
  if (-not (Test-Path $node)) { throw "解压后未找到 runtime\node.exe（zip 结构异常或被拦截）" }

  # 记下版本，便于日后升级时判断是否需要重新下载
  if ($m.version) { Set-Content -Path (Join-Path $target 'runtime.version') -Value $m.version -Encoding ASCII }

  Write-Host "运行环境准备完成。"
  exit 0
} catch {
  Write-Host "[错误] $($_.Exception.Message)"
  exit 1
}
