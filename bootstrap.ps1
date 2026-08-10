# OpenRY — Bootstrap Installer (Windows PowerShell)
# ============================================================================
# Download the repo and run the full installer in one line:
#
#   irm https://raw.githubusercontent.com/lingopi/openry/main/bootstrap.ps1 | iex
#
# Options are forwarded to scripts/install.ps1:
#   $s = irm https://.../bootstrap.ps1; iex "$s -SkipPlugin"
# ============================================================================

$d = Join-Path $env:TEMP "openry-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
New-Item -ItemType Directory -Force $d | Out-Null

Write-Host "  Downloading OpenRY..."
Invoke-WebRequest -Uri "https://github.com/lingopi/openry/archive/refs/heads/main.zip" -OutFile "$d\openry.zip"
Expand-Archive "$d\openry.zip" -DestinationPath $d -Force

Push-Location "$d\openry-main"
try {
    pwsh -File scripts/install.ps1 @args
} finally {
    Pop-Location
    Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue
}
