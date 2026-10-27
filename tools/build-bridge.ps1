param(
  [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$python = Join-Path $root ".venv\Scripts\python.exe"
$bridge = Join-Path $root "native\bridge.py"
$native = Join-Path $root "native"
$output = Join-Path $native "media-bridge.exe"

if (-not (Test-Path -LiteralPath $python)) {
  throw "Python venv not found at $python. Create it with: py -3.11 -m venv .venv"
}
if (-not (Test-Path -LiteralPath $bridge)) {
  throw "Bridge source not found at $bridge"
}

if (-not $SkipInstall) {
  Write-Host "Installing bridge build dependencies..." -ForegroundColor Cyan
  & $python -m pip install --disable-pip-version-check -r (Join-Path $PSScriptRoot "requirements-bridge.txt") --quiet
  if ($LASTEXITCODE -ne 0) { throw "pip install failed" }
}

Write-Host "Building media-bridge.exe..." -ForegroundColor Cyan
& $python -m PyInstaller `
  --noconfirm `
  --clean `
  --onefile `
  --name media-bridge `
  --icon (Join-Path $root "assets\icon.ico") `
  --distpath $native `
  --workpath (Join-Path $root "build\pyinstaller") `
  --specpath (Join-Path $root "build\pyinstaller") `
  --hidden-import winrt.windows.foundation.collections `
  --hidden-import winrt.windows.storage.streams `
  --hidden-import winrt.windows.media.control `
  --exclude-module tkinter `
  $bridge
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }
if (-not (Test-Path -LiteralPath $output)) { throw "Expected output missing: $output" }

$size = [math]::Round((Get-Item -LiteralPath $output).Length / 1MB, 1)
Write-Host "Built $output ($size MB)" -ForegroundColor Green
