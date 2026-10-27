$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$iss = Join-Path $PSScriptRoot "installer.iss"
$appDir = Join-Path $root "release\Aeri-win32-x64"
$appExe = Join-Path $appDir "Aeri.exe"
$icon = Join-Path $root "assets\icon.ico"

if (-not (Test-Path -LiteralPath $appExe)) {
  throw "release\Aeri-win32-x64\Aeri.exe is missing. Run: npm run build:app"
}
if (-not (Test-Path -LiteralPath $icon)) {
  throw "assets\icon.ico is missing"
}

$package = Get-Content -LiteralPath (Join-Path $root "package.json") -Raw | ConvertFrom-Json
$appName = if ($package.productName) { $package.productName } else { $package.name }
$version = $package.version
$numericVersion = ($version -split '[-+]')[0]
$parts = @($numericVersion.Split('.'))
while ($parts.Count -lt 4) { $parts += "0" }
$parts = @($parts[0..3])
foreach ($part in $parts) {
  if ($part -notmatch '^\d+$') {
    throw "Cannot convert version '$version' to a Windows file version"
  }
}
$versionInfo = $parts -join "."

function Find-Iscc {
  $candidates = @()
  if ($env:INNO_SETUP_COMPILER) { $candidates += $env:INNO_SETUP_COMPILER }
  $command = Get-Command iscc.exe -ErrorAction SilentlyContinue
  if ($command) { $candidates += $command.Source }
  if ($env:LOCALAPPDATA) {
    $candidates += Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe"
  }
  if (${env:ProgramFiles(x86)}) {
    $candidates += Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe"
  }
  if ($env:ProgramFiles) {
    $candidates += Join-Path $env:ProgramFiles "Inno Setup 6\ISCC.exe"
  }
  $uninstallKeys = @(
    "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*"
  )
  foreach ($key in $uninstallKeys) {
    Get-ItemProperty $key -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -like "Inno Setup*" -and $_.InstallLocation } |
      ForEach-Object { $candidates += Join-Path $_.InstallLocation "ISCC.exe" }
  }
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }
  return $null
}

$iscc = Find-Iscc
if (-not $iscc) {
  throw "Inno Setup 6 (ISCC.exe) was not found. Install it with: winget install --id JRSoftware.InnoSetup -e"
}

$setup = Join-Path $root "release\$appName-$version-Setup.exe"
if (Test-Path -LiteralPath $setup) { Remove-Item -LiteralPath $setup -Force }

Write-Host "Compiling $appName $version installer..." -ForegroundColor Cyan
& $iscc "/DMyAppVersion=$version" "/DMyAppVersionInfo=$versionInfo" $iss
if ($LASTEXITCODE -ne 0) { throw "Inno Setup compilation failed (exit code $LASTEXITCODE)" }
if (-not (Test-Path -LiteralPath $setup)) { throw "Installer was not created: $setup" }

$item = Get-Item -LiteralPath $setup
$stream = [System.IO.File]::OpenRead($setup)
try {
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hashBytes = $sha256.ComputeHash($stream)
  } finally {
    $sha256.Dispose()
  }
} finally {
  $stream.Dispose()
}
$hash = -join ($hashBytes | ForEach-Object { $_.ToString("X2") })
$versionString = $item.VersionInfo.ProductVersion
Write-Host ""
Write-Host "Built: $setup" -ForegroundColor Green
Write-Host ("Size: {0:N1} MB" -f ($item.Length / 1MB))
Write-Host "Version: $versionString"
Write-Host "SHA-256: $hash"
