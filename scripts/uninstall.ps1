# ============================================================================
# OpenRY — Windows Uninstaller (PowerShell)
# ============================================================================
# Usage:
#   pwsh -File uninstall.ps1                     # Keep data, interactive
#   pwsh -File uninstall.ps1 -Full -Force         # Remove everything
#
# Thin wrapper around 'openry uninstall'.
# Run 'openry uninstall --help' for all options.
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

$openryArgs = @("--with-openclaw")
if ($Force)    { $openryArgs += "--force" }
if ($KeepData) { $openryArgs += "--keep-data" }
if ($KeepEnv)  { $openryArgs += "--keep-env" }

& openry uninstall @openryArgs
