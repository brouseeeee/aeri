$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$stage = Join-Path $root "build\app"
$release = Join-Path $root "release"
$bridgeExe = Join-Path $root "native\media-bridge.exe"
$packager = Join-Path $root "node_modules\.bin\electron-packager.cmd"

if (-not (Test-Path -LiteralPath $bridgeExe)) {
  throw "native\media-bridge.exe is missing. Run: npm run build:bridge"
}
if (-not (Test-Path -LiteralPath $packager)) {
  throw "electron-packager is missing. Run: npm install"
}

$package = Get-Content -LiteralPath (Join-Path $root "package.json") -Raw | ConvertFrom-Json
$appName = if ($package.productName) { $package.productName } else { $package.name }
$electronVersion = (Get-Content -LiteralPath (Join-Path $root "node_modules\electron\package.json") -Raw | ConvertFrom-Json).version

Write-Host "Staging app files..." -ForegroundColor Cyan
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stage "assets") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stage "native") -Force | Out-Null

Copy-Item -LiteralPath (Join-Path $root "package.json") -Destination $stage
Copy-Item -LiteralPath (Join-Path $root "README.md") -Destination $stage -ErrorAction SilentlyContinue
Copy-Item -LiteralPath (Join-Path $root "src") -Destination $stage -Recurse
Copy-Item -LiteralPath $bridgeExe -Destination (Join-Path $stage "native")
Copy-Item -LiteralPath (Join-Path $root "native\bridge.py") -Destination (Join-Path $stage "native")
foreach ($asset in @("icon.png", "icon.ico", "tray.png")) {
  Copy-Item -LiteralPath (Join-Path $root "assets\$asset") -Destination (Join-Path $stage "assets")
}

Write-Host "Packaging Electron app..." -ForegroundColor Cyan
& $packager $stage $appName `
  --platform=win32 `
  --arch=x64 `
  --out=$release `
  --overwrite `
  --asar=false `
  --icon (Join-Path $root "assets\icon.ico") `
  --app-version=$($package.version) `
  --electron-version=$electronVersion `
  --executable-name=$appName `
  --no-prune
if ($LASTEXITCODE -ne 0) { throw "electron-packager failed" }

$appDir = Join-Path $release "$appName-win32-x64"
$exe = Join-Path $appDir "$appName.exe"
if (-not (Test-Path -LiteralPath $exe)) { throw "Packaged executable missing: $exe" }

Write-Host ""
Write-Host "Built: $exe" -ForegroundColor Green
Write-Host "Double-click it, or pin it to the taskbar / Start menu." -ForegroundColor Green
