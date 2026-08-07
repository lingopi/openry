# ============================================================================
# OpenRY — Windows Uninstaller (PowerShell)
# ============================================================================
# Usage:
#   pwsh -File uninstall.ps1                # Interactive, keep data
#   pwsh -File uninstall.ps1 -Force         # Non-interactive, keep data
#   pwsh -File uninstall.ps1 -Force -All    # Non-interactive, remove EVERYTHING
#
# Parameters:
#   -Force       Skip all confirmation prompts
#   -All         Remove DB, model cache, node_modules — complete cleanup
#   -KeepData    Keep ~\.openry (DB + YAMLs)
#   -KeepEnv     Keep OPENRY_HOME + PATH env vars
#   -SkipGateway Don't touch OpenClaw gateway
# ============================================================================

param(
    [switch]$Force,
    [switch]$All,
    [switch]$KeepData,
    [switch]$KeepEnv,
    [switch]$SkipGateway
)

$ErrorActionPreference = "Continue"

function Write-OK   { Write-Host "  ✓ $args" -ForegroundColor Green }
function Write-Warn { Write-Host "  ⚠ $args" -ForegroundColor Yellow }
function Write-Err  { Write-Host "  ✗ $args" -ForegroundColor Red }
function Write-Info { Write-Host "  $args" -ForegroundColor Cyan }

Write-Host ""
Write-Host "╔══════════════════════════════════════╗" -ForegroundColor Yellow
Write-Host "║   OpenRY — Windows Uninstaller (PS)  ║" -ForegroundColor Yellow
Write-Host "╚══════════════════════════════════════╝" -ForegroundColor Yellow
if ($All) { Write-Host "  Mode: COMPLETE (DB + models + deps)" -ForegroundColor Red }
Write-Host ""

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$OpenryHome = if ($env:OPENRY_HOME) { $env:OPENRY_HOME } else { "$env:USERPROFILE\.openry" }
$PluginDir = Join-Path $ScriptDir "orchestrator-plugin"
$HfCache = "$env:USERPROFILE\.cache\huggingface"
$TransformersCache = "$env:USERPROFILE\.cache\transformers"

Write-Info "Script  dir: $ScriptDir"
Write-Info "OpenRY home: $OpenryHome"
Write-Host ""

if (-not $Force) {
    $confirm = Read-Host "  This will uninstall OpenRY. Continue? (y/N)"
    if ($confirm -notmatch "^(y|Y|yes|YES)$") { Write-Host "  Aborted."; exit 0 }
    Write-Host ""
}

# 1. Stop gateway
if (-not $SkipGateway) {
    Write-Host "═══ 1. Stopping OpenClaw gateway ═══" -ForegroundColor White
    try {
        if (Get-Command openclaw -ErrorAction SilentlyContinue) {
            openclaw gateway stop 2>&1 | Out-Null
            Write-OK "OpenClaw gateway stopped"
        } else { Write-Info "OpenClaw not found, skip" }
    } catch { Write-Warn "Gateway stop failed: $_" }
    Write-Host ""
}

# 2. Unregister plugin (pipe input to avoid hanging)
Write-Host "═══ 2. Unregistering orchestrator-plugin ═══" -ForegroundColor White
try {
    if (Get-Command openclaw -ErrorAction SilentlyContinue) {
        "y" | openclaw plugins uninstall orchestrator-plugin 2>&1 | Out-Null
        Write-OK "orchestrator-plugin unregistered"
    } else { Write-Info "OpenClaw not found, skip" }
} catch { Write-Warn "Plugin unregister failed (may already be removed)" }
Write-Host ""

# 3. Remove agent from openclaw.json
Write-Host "═══ 3. Removing openry-worker agent ═══" -ForegroundColor White
$oclConfig = "$env:USERPROFILE\.openclaw\openclaw.json"
if (Test-Path $oclConfig) {
    try {
        $py = $null
        foreach ($c in @("python", "python3", "py")) {
            $f = Get-Command $c -ErrorAction SilentlyContinue
            if ($f -and $f.Source -notmatch "WindowsApps") { $py = $c; break }
        }
        if (-not $py) { $py = "python" }
        $script = @"
import json
with open(r'$oclConfig','r',encoding='utf-8') as f: c=json.load(f)
c['agents']['list']=[a for a in c.get('agents',{}).get('list',[]) if a.get('id')!='openry-worker']
with open(r'$oclConfig','w',encoding='utf-8') as f: json.dump(c,f,indent=2,ensure_ascii=False)
"@
        & $py -c $script 2>&1 | Out-Null
        Write-OK "openry-worker agent removed from openclaw.json"
    } catch { Write-Warn "Agent removal failed: $_" }
}
Write-Host ""

# 4. Remove plugin artifacts
Write-Host "═══ 4. Cleaning orchestrator-plugin ═══" -ForegroundColor White
if (Test-Path $PluginDir) {
    $toRemove = @("node_modules", "dist", "package-lock.json") | ForEach-Object { Join-Path $PluginDir $_ }
    foreach ($p in $toRemove) {
        if (Test-Path $p) {
            try { Remove-Item -Recurse -Force $p -ErrorAction Stop; Write-OK "Removed $(Split-Path $p -Leaf)" }
            catch { Write-Warn "Failed: $_" }
        }
    }
    try { Push-Location $PluginDir; npm cache clean --force 2>&1 | Out-Null; Pop-Location; Write-OK "npm cache cleaned" }
    catch { Write-Warn "npm cache clean failed" }
}
Write-Host ""

# 5. Uninstall openry CLI
Write-Host "═══ 5. Uninstalling openry CLI ═══" -ForegroundColor White
$pythonCmd = $null
foreach ($c in @("python", "python3", "py")) {
    $f = Get-Command $c -ErrorAction SilentlyContinue
    if ($f -and $f.Source -notmatch "WindowsApps") { $pythonCmd = $c; break }
}
if ($pythonCmd) {
    try { & $pythonCmd -m pip uninstall openry -y 2>&1 | Out-Null; Write-OK "openry uninstalled" }
    catch { Write-Warn "pip uninstall failed" }
} else { Write-Warn "Python not found" }
Write-Host ""

# 6. Remove .openry data
$removeData = $All -and -not $KeepData
if ($removeData) {
    Write-Host "═══ 6. Removing .openry (DB + workflows) ═══" -ForegroundColor Red

    # Kill any process holding openry.db lock before deletion
    try {
        Get-Process -Name "python*" -ErrorAction SilentlyContinue | ForEach-Object {
            try { $_ | Stop-Process -Force -ErrorAction SilentlyContinue } catch {}
        }
        Start-Sleep -Milliseconds 500
        Write-OK "Stopped Python processes"
    } catch { }

    if (Test-Path $OpenryHome) {
        # Try individual file removal first (DB files often locked)
        $dbFiles = @("openry.db", "openry.db-wal", "openry.db-shm")
        foreach ($f in $dbFiles) {
            $fp = Join-Path $OpenryHome $f
            if (Test-Path $fp) {
                try { Remove-Item -Force $fp -ErrorAction Stop; Write-OK "Removed $f" }
                catch { Write-Err "Cannot remove $f (still locked): $_" }
            }
        }
        # Then remove the rest of the directory
        try { Remove-Item -Recurse -Force $OpenryHome -ErrorAction Stop; Write-OK "Removed $OpenryHome" }
        catch { Write-Err "Failed: $_" }
    } else { Write-Info "Not found" }
} else {
    Write-Host "═══ 6. .openry directory ═══" -ForegroundColor White
    Write-Info "Keeping (use -All to remove DB)"
}
Write-Host ""

# 7. Remove BGE-M3 model cache
$removeModel = $All
if ($removeModel) {
    Write-Host "═══ 7. Removing AI model cache ═══" -ForegroundColor Red
    foreach ($cacheDir in @($HfCache, $TransformersCache)) {
        if (Test-Path $cacheDir) {
            try { Remove-Item -Recurse -Force $cacheDir -ErrorAction Stop; Write-OK "Removed $cacheDir" }
            catch { Write-Err "Failed: $_" }
        } else { Write-Info "$cacheDir not found" }
    }
} else {
    Write-Host "═══ 7. AI model cache ═══" -ForegroundColor White
    Write-Info "Keeping (use -All to remove)"
}
Write-Host ""

# 8. Remove env vars
Write-Host "═══ 8. Cleaning environment variables ═══" -ForegroundColor White
if (-not $KeepEnv) {
    try {
        $oh = [Environment]::GetEnvironmentVariable("OPENRY_HOME", "User")
        if ($oh) {
            [Environment]::SetEnvironmentVariable("OPENRY_HOME", $null, "User")
            Remove-Item Env:OPENRY_HOME -ErrorAction SilentlyContinue
            Write-OK "OPENRY_HOME removed"
        } else { Write-Info "Not set" }
    } catch { Write-Warn "Failed: $_" }
} else { Write-Info "Keeping (--KeepEnv)" }
Write-Host ""

# 9. Verify
Write-Host "═══ 9. Verification ═══" -ForegroundColor White
$remaining = @()
if (Get-Command openry -ErrorAction SilentlyContinue) { $remaining += "openry CLI still on PATH" }
if (Test-Path $OpenryHome) { $remaining += ".openry: $OpenryHome" }
$nm = Join-Path $PluginDir "node_modules"
if (Test-Path $nm) { $remaining += "node_modules: $nm" }
if ([Environment]::GetEnvironmentVariable("OPENRY_HOME", "User")) { $remaining += "OPENRY_HOME env var" }
if ($remaining.Count -gt 0) { Write-Warn "Some items remain:"; $remaining | ForEach-Object { Write-Host "    - $_" } }
else { Write-OK "All clean" }
Write-Host ""

Write-Host "╔══════════════════════════════════════════════════════╗" -ForegroundColor Yellow
Write-Host "║  OpenRY uninstall complete.                          ║" -ForegroundColor Yellow
Write-Host "║  Run install.ps1 to reinstall.                      ║" -ForegroundColor Yellow
Write-Host "╚══════════════════════════════════════════════════════╝" -ForegroundColor Yellow
Write-Host ""
