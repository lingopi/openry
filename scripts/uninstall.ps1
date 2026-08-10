# ============================================================================
# OpenRY — Windows Uninstaller (PowerShell)
# ============================================================================
# Usage:
#   pwsh -File uninstall.ps1                     # Data only, keep CLI
#   pwsh -File uninstall.ps1 -Full -Force        # Everything (data + plugin + CLI)
# ============================================================================

param(
    [switch]$Full,
    [switch]$Force,
    [switch]$KeepData,
    [switch]$KeepEnv
)

if (-not (Get-Command openry -ErrorAction SilentlyContinue)) {
    Write-Host "openry CLI not found. Already uninstalled?"
    Write-Host "To manually clean up: Remove-Item -Recurse ~\.openry\"
    exit 0
}

$openryArgs = @()
if ($Full)     { $openryArgs += "--with-openclaw" }
if ($Force)    { $openryArgs += "--force" }
if ($KeepData) { $openryArgs += "--keep-data" }
if ($KeepEnv)  { $openryArgs += "--keep-env" }

& openry uninstall @openryArgs
