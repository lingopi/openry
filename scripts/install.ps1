# ============================================================================
# OpenRY — Windows One-Click Installer (PowerShell)
# ============================================================================
# Usage:
#   pwsh -File install.ps1                           # Standard install
#   pwsh -File install.ps1 -Force                    # Clean everything, then install
#   pwsh -File install.ps1 -SkipPython               # Skip Python + pip steps
#   pwsh -File install.ps1 -SkipPlugin               # Skip orchestrator-plugin
#   pwsh -File install.ps1 -BgeSource modelscope     # Use ModelScope SDK for BGE-M3
#
# Prerequisites auto-installed:
#   - PowerShell 7 (if not present)
#   - Python 3.9+   (if not present, via winget)
#
# Asset sources (priority order):
#   1. Local deps/ directory    — GitCode clone (deps included with repo)
#   2. GitHub Releases          — lingopi/openry (fallback download)
#   3. ModelScope SDK (BGE-M3)  — modelscope Python package (-BgeSource modelscope)
#
# License: MIT — OpenRY Contributors
# ============================================================================
param(
    [switch]$SkipPwsh,        # Skip PowerShell 7 installation check
    [switch]$SkipPython,      # Skip Python installation check
    [switch]$SkipPlugin,      # Skip orchestrator-plugin installation
    [switch]$Force,           # Clean everything before install
    [string]$BgeSource = "auto"  # auto | local | github | modelscope
)

$ErrorActionPreference = "Stop"

# ── Colors / output helpers ────────────────────────────────────────────
function Write-OK   { Write-Host "  ✓ $args" -ForegroundColor Green }
function Write-Warn { Write-Host "  ⚠ $args" -ForegroundColor Yellow }
function Write-Err  { Write-Host "  ✗ $args" -ForegroundColor Red }
function Write-Info { Write-Host "  $args" -ForegroundColor Cyan }

Write-Host ""
Write-Host "╔══════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║    OpenRY — Windows Installer (PS)   ║" -ForegroundColor Green
Write-Host "╚══════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""

# ═══════════════════════════════════════════════════════════════════════
# Helper Functions
# ═══════════════════════════════════════════════════════════════════════

function Get-SHA256Hash {
    param([string]$FilePath)
    if (Test-Path $FilePath) {
        return (Get-FileHash -Path $FilePath -Algorithm SHA256).Hash.ToLower()
    }
    return ""
}

# Resolve an asset: local deps/ → GitHub Releases → GitCode clone, with sha256.
# Returns the file path on success, $null on failure.
function Resolve-Asset {
    param(
        [string]$AssetName,
        [string]$LocalPath,
        [string]$ReleaseTag,
        [string]$ExpectedSHA256
    )
    $RemoteUrl = "https://github.com/lingopi/openry/releases/download/$ReleaseTag/$AssetName"
    $GitCodeUrl = "https://gitcode.com/yifan850902/openry.git"

    # ── Step 1: Try local ──
    if (Test-Path $LocalPath) {
        $Actual = Get-SHA256Hash -FilePath $LocalPath
        if ($Actual -eq $ExpectedSHA256) {
            return $LocalPath
        }
        Write-Warn "Local file corrupt (sha256 mismatch), re-downloading..."
        Remove-Item $LocalPath -Force -ErrorAction SilentlyContinue
    }

    # ── Step 2: Try GitHub Releases ──
    Write-Info "Downloading $AssetName from GitHub Releases..."
    Write-Host "    $RemoteUrl"
    $ParentDir = Split-Path -Parent $LocalPath
    New-Item -ItemType Directory -Force -Path $ParentDir | Out-Null
    $TmpPath = "$LocalPath.tmp"
    Remove-Item $TmpPath -Force -ErrorAction SilentlyContinue

    try {
        & curl.exe -fSL --connect-timeout 10 --speed-limit 102400 --speed-time 15 --progress-bar -C - -o $TmpPath $RemoteUrl 2>&1
        if ($LASTEXITCODE -eq 0) {
            $Actual = Get-SHA256Hash -FilePath $TmpPath
            if ($Actual -eq $ExpectedSHA256) {
                Move-Item $TmpPath $LocalPath -Force
                Write-OK "sha256 verified, cached to $ParentDir\"
                return $LocalPath
            }
            Write-Err "sha256 mismatch after download"
            Remove-Item $TmpPath -Force -ErrorAction SilentlyContinue
        } else {
            Write-Warn "GitHub Releases failed (connect timeout or unreachable)"
            Remove-Item $TmpPath -Force -ErrorAction SilentlyContinue
        }
    } catch {
        Write-Warn "GitHub Releases failed: $_"
        Remove-Item $TmpPath -Force -ErrorAction SilentlyContinue
    }

    # ── Step 3: GitCode sparse clone (only deps/ directory) ──
    if (Get-Command git -ErrorAction SilentlyContinue) {
        Write-Info "Fetching deps/ from GitCode..."
        Write-Host "    $GitCodeUrl"
        $TmpClone = "$env:TEMP\openry-deps-clone-$PID"
        Remove-Item $TmpClone -Recurse -Force -ErrorAction SilentlyContinue
        $GitCodeOk = $false

        try {
            & git clone --depth 1 --filter=blob:none $GitCodeUrl $TmpClone 2>&1 | Out-Null
            if ($LASTEXITCODE -eq 0) {
                # Try sparse-checkout; fall back to full checkout if it fails
                Push-Location $TmpClone
                try {
                    & git sparse-checkout set deps/ 2>&1 | Out-Null
                } catch {
                    # Older git without sparse-checkout — full checkout is fine
                    & git checkout 2>&1 | Out-Null
                }
                Pop-Location

                if (Test-Path (Join-Path $TmpClone "deps")) {
                    $DepsParent = Split-Path -Parent (Split-Path -Parent $LocalPath)
                    Copy-Item "$TmpClone\deps\*" -Destination "$DepsParent\" -Recurse -Force -ErrorAction SilentlyContinue
                    Write-OK "deps/ fetched from GitCode"
                    $GitCodeOk = $true
                } else {
                    Write-Warn "GitCode clone succeeded but deps/ not found"
                }
            } else {
                Write-Warn "GitCode clone failed (network or auth issue)"
            }
        } catch {
            Write-Warn "GitCode clone failed: $_"
        }
        Remove-Item $TmpClone -Recurse -Force -ErrorAction SilentlyContinue

        # Re-check local after GitCode fetch
        if ($GitCodeOk -and (Test-Path $LocalPath)) {
            $Actual = Get-SHA256Hash -FilePath $LocalPath
            if ($Actual -eq $ExpectedSHA256) {
                Write-OK "sha256 verified"
                return $LocalPath
            }
            Write-Err "sha256 mismatch on GitCode-fetched file"
        }
    }

    # All sources failed
    return $null
}

# Check if BGE-M3 cache is complete (file-level verification)
function Test-BGEM3Complete {
    param([string]$CacheDir)
    $RequiredFiles = @(
        "config.json",
        "tokenizer.json",
        "tokenizer_config.json",
        "onnx/model_quantized.onnx"
    )
    foreach ($f in $RequiredFiles) {
        if (-not (Test-Path (Join-Path $CacheDir $f))) {
            return $false
        }
    }
    return $true
}

# ═══════════════════════════════════════════════════════════════════════
# Resolve paths
# ═══════════════════════════════════════════════════════════════════════

$ScriptDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$OpenryHome = if ($env:OPENRY_HOME) { $env:OPENRY_HOME } else { "$env:USERPROFILE\.openry" }
$PluginDir = Join-Path $ScriptDir "orchestrator-plugin"
$WrapperDir = "$env:USERPROFILE\.local\bin"

Write-Info "Install dir: $ScriptDir"
Write-Info "OpenRY home: $OpenryHome"
Write-Host ""

# ═══════════════════════════════════════════════════════════════════════
# 1. Check / Install PowerShell 7
# ═══════════════════════════════════════════════════════════════════════

if (-not $SkipPwsh) {
    $pwshPath = (Get-Command pwsh -ErrorAction SilentlyContinue).Source

    if ($pwshPath) {
        $pwshVer = & pwsh -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'
        Write-OK "PowerShell 7 found: $pwshVer  ($pwshPath)"
    } else {
        Write-Warn "PowerShell 7 not found. Installing via winget..."
        try {
            winget install --id Microsoft.PowerShell --exact --accept-source-agreements --accept-package-agreements
            Write-OK "PowerShell 7 installed. Please re-run this script with: pwsh -File install.ps1"
        } catch {
            Write-Err "winget install failed. Install PowerShell 7 manually:"
            Write-Host "    https://github.com/PowerShell/PowerShell/releases"
        }
        # Refresh PATH
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                     [System.Environment]::GetEnvironmentVariable("Path", "User")
        $pwshPath = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
        if (-not $pwshPath) {
            Write-Err "Cannot find pwsh after install. Aborting."
            exit 1
        }
    }
} else {
    Write-Warn "Skipping PowerShell 7 check (--SkipPwsh)"
}
Write-Host ""

# ═══════════════════════════════════════════════════════════════════════
# 2. Check / Install Python 3.9+
# ═══════════════════════════════════════════════════════════════════════

$pythonCmd = $null
$pythonPath = $null

if (-not $SkipPython) {
    # ── Step 1: Try py launcher (most reliable on Windows) ──
    $pyExe = Get-Command py -ErrorAction SilentlyContinue
    if ($pyExe -and $pyExe.Source -notmatch "WindowsApps") {
        $pythonCmd = "py"
        $pythonPath = $pyExe.Source
    }

    # ── Step 2: Try python / python3, skip Windows Store stubs ──
    if (-not $pythonCmd) {
        foreach ($candidate in @("python3", "python")) {
            $found = Get-Command $candidate -ErrorAction SilentlyContinue
            if ($found -and $found.Source -notmatch "WindowsApps") {
                $pythonCmd = $candidate
                $pythonPath = $found.Source
                break
            }
        }
    }

    # ── Step 3: Check Windows Registry ──
    if (-not $pythonCmd) {
        $regBasePaths = @(
            "HKLM:\SOFTWARE\Python\PythonCore",
            "HKCU:\SOFTWARE\Python\PythonCore"
        )
        $regVersions = @()
        foreach ($base in $regBasePaths) {
            $versionKeys = Get-ChildItem -Path $base -ErrorAction SilentlyContinue
            if ($versionKeys) {
                foreach ($vk in $versionKeys) {
                    $installKey = Join-Path $vk.PSPath "InstallPath"
                    $props = Get-ItemProperty -Path $installKey -ErrorAction SilentlyContinue
                    if ($props) { $regVersions += $props }
                }
            }
        }
        if ($regVersions.Count -gt 0) {
            $bestReg = $regVersions | Sort-Object PSPath -Descending | Select-Object -First 1
            $regPyExe = Join-Path $bestReg.'(default)' "python.exe"
            if (Test-Path $regPyExe) {
                $pythonCmd = $regPyExe
                $pythonPath = $regPyExe
                Write-Warn "Python found via registry: $pythonPath (not on PATH — fixing...)"
                $pyDir = Split-Path -Parent $pythonPath
                $env:Path = "$pyDir;$env:Path"
                $scriptsDir = Join-Path $pyDir "Scripts"
                if (Test-Path $scriptsDir) { $env:Path = "$scriptsDir;$env:Path" }
            }
        }
    }

    # ── Step 4: Scan common install directories ──
    if (-not $pythonCmd) {
        $searchDirs = @(
            "$env:LOCALAPPDATA\Programs\Python",
            "$env:PROGRAMFILES\Python*",
            "C:\Python*"
        )
        $candidates = @()
        foreach ($dir in $searchDirs) {
            $matches = Get-ChildItem -Path $dir -Filter "python.exe" -Recurse -ErrorAction SilentlyContinue |
                       Where-Object { $_.FullName -notmatch "WindowsApps" }
            if ($matches) { $candidates += $matches }
        }
        $best = $candidates | Sort-Object FullName -Descending | Select-Object -First 1
        if ($best) {
            $pythonCmd = $best.FullName
            $pythonPath = $best.FullName
            Write-Warn "Python found at $pythonPath (not on PATH — fixing...)"
            $pyDir = Split-Path -Parent $pythonPath
            $env:Path = "$pyDir;$env:Path"
            $scriptsDir = Join-Path $pyDir "Scripts"
            if (Test-Path $scriptsDir) { $env:Path = "$scriptsDir;$env:Path" }
        }
    }

    # ── Step 5: Validate or install ──
    $pythonOk = $false
    if ($pythonCmd) {
        try {
            $pyVer = & $pythonCmd --version 2>&1
            Write-OK "Python found: $pyVer  ($pythonPath)"
            $pythonOk = $true
        } catch {
            Write-Warn "python found at $pythonCmd but failed to run: $_"
        }
    }

    if (-not $pythonOk) {
        Write-Warn "Python 3.9+ not found on PATH or in common install locations."
        Write-Host ""
        Write-Host "  Possible causes:"
        Write-Host "    1. Python is not installed → will try winget install now"
        Write-Host "    2. Python is installed but not on PATH → check manually:"
        Write-Host "       Look in: $env:LOCALAPPDATA\Programs\Python\"
        Write-Host "       Or run: where.exe python"
        Write-Host ""
        try {
            winget install --id Python.Python.3.12 --exact --accept-source-agreements --accept-package-agreements
            Write-OK "Python 3.12 installed via winget"
            $pythonCmd = "python"
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                         [System.Environment]::GetEnvironmentVariable("Path", "User")
        } catch {
            Write-Err "winget install failed. Install Python 3.9+ manually:"
            Write-Host "    https://www.python.org/downloads/"
            exit 1
        }
    }
} else {
    Write-Warn "Skipping Python check (--SkipPython)"
    $pythonCmd = "python"
}
Write-Host ""

# ═══════════════════════════════════════════════════════════════════════
# 3. --Force: clean everything before install
# ═══════════════════════════════════════════════════════════════════════

if ($Force) {
    Write-Host "── Force clean before install ──" -ForegroundColor White
    Write-Host ""

    # pip uninstall (tolerate failure)
    if (-not $SkipPython) {
        & $pythonCmd -m pip uninstall openry -y 2>&1 | Out-Null
        Write-OK "pip package removed"
    }

    # egg-info residue
    Remove-Item (Join-Path $ScriptDir "openry.egg-info") -Recurse -Force -ErrorAction SilentlyContinue

    # Wrapper script
    Remove-Item (Join-Path $WrapperDir "openry.cmd") -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $WrapperDir "openry.bat") -Force -ErrorAction SilentlyContinue

    # Plugin artifacts
    if (Test-Path $PluginDir) {
        Remove-Item (Join-Path $PluginDir "node_modules") -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item (Join-Path $PluginDir "dist") -Recurse -Force -ErrorAction SilentlyContinue
        Write-OK "Plugin artifacts cleaned"
    }

    # OpenClaw (if available)
    if (Get-Command openclaw -ErrorAction SilentlyContinue) {
        openclaw gateway stop 2>&1 | Out-Null
        openclaw plugins uninstall orchestrator-plugin 2>&1 | Out-Null
        Write-OK "OpenClaw cleaned"
    }

    Write-Host ""
}

# ═══════════════════════════════════════════════════════════════════════
# 4. Install pyyaml
# ═══════════════════════════════════════════════════════════════════════

if (-not $SkipPython) {
    Write-Host "  Installing pyyaml..."
    try {
        & $pythonCmd -m pip install pyyaml --quiet 2>&1 | Out-Null
        Write-OK "pyyaml installed"
    } catch {
        Write-Warn "pyyaml install failed (non-fatal, continuing...)"
    }
    Write-Host ""
}

# ═══════════════════════════════════════════════════════════════════════
# 5. Install openry CLI (uninstall first, then install)
# ═══════════════════════════════════════════════════════════════════════

if (-not $SkipPython) {
    Write-Host "  Installing openry CLI..."

    # ── Clean previous install ──
    & $pythonCmd -m pip uninstall openry -y 2>&1 | Out-Null
    Remove-Item (Join-Path $ScriptDir "openry.egg-info") -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $WrapperDir "openry.cmd") -Force -ErrorAction SilentlyContinue

    Push-Location $ScriptDir

    try {
        & $pythonCmd -m pip install -e . --quiet 2>&1 | Out-Null
        # Use Python to tell us where scripts are installed (handles venv, system, user installs)
        $scriptsDir = & $pythonCmd -c "import sysconfig; print(sysconfig.get_path('scripts'))" 2>&1
        $openryExe = Join-Path $scriptsDir "openry.exe"

        if (Test-Path $openryExe) {
            Write-OK "openry installed  ($openryExe)"
            # Add to permanent User PATH
            $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
            if ($userPath -notlike "*$scriptsDir*") {
                [Environment]::SetEnvironmentVariable("Path", "$userPath;$scriptsDir", "User")
            }
            if ($env:Path -notlike "*$scriptsDir*") {
                $env:Path = "$scriptsDir;$env:Path"
            }
        } else {
            Write-Warn "openry.exe not found, creating wrapper..."
            New-Item -ItemType Directory -Force -Path $WrapperDir | Out-Null
            @"
@echo off
set OPENRY_HOME=%OPENRY_HOME%
set PYTHONPATH=$ScriptDir;%PYTHONPATH%
$pythonCmd -m openry %*
"@ | Out-File -FilePath "$WrapperDir\openry.cmd" -Encoding ASCII
            Write-OK "Wrapper created: $WrapperDir\openry.cmd"
            $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
            if ($userPath -notlike "*$WrapperDir*") {
                [Environment]::SetEnvironmentVariable("Path", "$userPath;$WrapperDir", "User")
            }
            if ($env:Path -notlike "*$WrapperDir*") {
                $env:Path = "$WrapperDir;$env:Path"
            }
        }
    } catch {
        Write-Err "pip install failed: $_"
        exit 1
    } finally {
        Pop-Location
    }
    Write-Host ""
}

# ═══════════════════════════════════════════════════════════════════════
# 6. Set OPENRY_HOME environment variable (User scope, permanent)
# ═══════════════════════════════════════════════════════════════════════

$currentOpenryHome = [Environment]::GetEnvironmentVariable("OPENRY_HOME", "User")
if ($currentOpenryHome -ne $OpenryHome) {
    [Environment]::SetEnvironmentVariable("OPENRY_HOME", $OpenryHome, "User")
    $env:OPENRY_HOME = $OpenryHome
    Write-OK "OPENRY_HOME set to $OpenryHome"
} else {
    Write-Info "OPENRY_HOME already set to $OpenryHome"
}
Write-Host ""

# ═══════════════════════════════════════════════════════════════════════
# 7. Initialize .openry from seed directory
# ═══════════════════════════════════════════════════════════════════════

$seedDir = Join-Path $ScriptDir "seed"
if (Test-Path $seedDir) {
    # First-time only: don't overwrite user data on reinstall
    if (-not (Test-Path (Join-Path $OpenryHome "workflows"))) {
        # Use robocopy — PowerShell Copy-Item -Recurse has a known bug that
        # flattens single-file subdirectories (e.g. agent-workspace/ → loose AGENTS.md)
        robocopy "$seedDir" "$OpenryHome" /E /NFL /NDL /NJH /NJS 2>&1 | Out-Null
        Write-OK "Initialized $OpenryHome from seed/"
    } else {
        Write-Host "  ~/.openry already exists, preserving user data" -ForegroundColor Cyan
    }
    $wfCount = (Get-ChildItem "$OpenryHome\workflows\*.yaml" -ErrorAction SilentlyContinue).Count
    $cpCount = (Get-ChildItem "$OpenryHome\compositions\*.yaml" -ErrorAction SilentlyContinue).Count
    $pmCount = (Get-ChildItem "$OpenryHome\prompts\*.md" -ErrorAction SilentlyContinue).Count
    Write-Host "    workflows: $wfCount files, compositions: $cpCount files, prompts: $pmCount files"
} else {
    New-Item -ItemType Directory -Force -Path "$OpenryHome\workflows","$OpenryHome\compositions","$OpenryHome\prompts","$OpenryHome\prompt_blocks" | Out-Null
    Write-Warn "seed/ not found, created empty structure"
}

# Clean stale DB from previous install
$dbFiles = @("openry.db", "openry.db-wal", "openry.db-shm")
foreach ($f in $dbFiles) {
    $fp = Join-Path $OpenryHome $f
    if (Test-Path $fp) {
        try { Remove-Item -Force $fp -ErrorAction SilentlyContinue } catch {}
    }
}
Write-Host ""

# ═══════════════════════════════════════════════════════════════════════
# 8. Verify installation
# ═══════════════════════════════════════════════════════════════════════

Write-Host "  Verifying openry..."
try {
    $result = & openry -c 'echo "install OK"' 2>&1
    if ($result -match "install OK") {
        Write-OK "openry is ready"
    } else {
        throw "unexpected output: $result"
    }
} catch {
    Write-Err "Verification failed: $_"
    Write-Host "  Try: cd $ScriptDir; `$env:PYTHONPATH='$ScriptDir'; python -m openry -c 'echo test'"
    exit 1
}
Write-Host ""

# ═══════════════════════════════════════════════════════════════════════
# 9. orchestrator-plugin
# ═══════════════════════════════════════════════════════════════════════

if ((-not (Test-Path $PluginDir)) -or $SkipPlugin) {
    if ($SkipPlugin) {
        Write-Warn "Skipping orchestrator plugin (-SkipPlugin)"
    } else {
        Write-Warn "orchestrator-plugin/ not found, skipping"
    }
    Write-Host ""
} else {
    Write-Host "── Orchestrator Plugin (OpenClaw integration) ──" -ForegroundColor White
    Write-Host ""

    # ── Check dependencies ──
    $missingDeps = @()
    if (-not (Get-Command openclaw -ErrorAction SilentlyContinue)) {
        $missingDeps += "  - OpenClaw not found (install: https://openclaw.ai)"
    }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        $missingDeps += "  - Node.js not found (install: https://nodejs.org)"
    }
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        $missingDeps += "  - npm not found (bundled with Node.js)"
    }

    if ($missingDeps.Count -gt 0) {
        Write-Warn "Skipping orchestrator plugin:"
        $missingDeps | ForEach-Object { Write-Host $_ }
        Write-Host "  Re-run this installer after installing the missing dependencies."
    } else {
        Write-OK "OpenClaw + Node.js detected, installing plugin..."
        Write-Host ""

        # ── Always clean plugin artifacts before install ──
        Write-Host "  Cleaning previous plugin artifacts..."
        Remove-Item (Join-Path $PluginDir "node_modules") -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item (Join-Path $PluginDir "dist") -Recurse -Force -ErrorAction SilentlyContinue
        Write-OK "Cleaned"

        # ── Resolve plugin bundle ──
        $pluginBundleName = "orchestrator-plugin-bundle-win.tar.gz"
        $pluginBundleLocal = Join-Path $ScriptDir "deps\windows\$pluginBundleName"
        $pluginSHA256 = "956740690c9fe62bc58ccb070c6ecea4a863776fa056b89a7fb8168622e0fddf"

        $bundleFile = Resolve-Asset -AssetName $pluginBundleName `
            -LocalPath $pluginBundleLocal `
            -ReleaseTag "plugin-bundle-v1.0" `
            -ExpectedSHA256 $pluginSHA256

        if (-not $bundleFile) {
            Write-Err "Plugin bundle unavailable — local deps/ and GitHub Releases both failed"
            Write-Warn "Skipping plugin (you can re-run after fixing network or deps/)"
        } else {
            # ── Extract ──
            Write-Host "  Extracting plugin bundle..."
            try {
                tar -xzf $bundleFile -C $PluginDir 2>&1 | Out-Null
                Write-OK "Plugin bundle extracted"
            } catch {
                Write-Err "Extraction failed: $_"
            }

            # Verify dist/index.js
            if (-not (Test-Path (Join-Path $PluginDir "dist\index.js"))) {
                Write-Warn "dist\index.js missing, attempting rebuild..."
                try {
                    Push-Location $PluginDir
                    npm run build 2>&1 | Out-Null
                    Pop-Location
                } catch {
                    Pop-Location -ErrorAction SilentlyContinue
                }
            }

            if (-not (Test-Path (Join-Path $PluginDir "dist\index.js"))) {
                Write-Err "Plugin dist\index.js not found — cannot register"
            } else {
                # ── Sync tool config from seed/tools.yaml BEFORE plugin registration ──
                Write-Host "  Syncing tool configuration from seed/tools.yaml..."
                try {
                    & openry tools sync 2>&1 | Out-Null
                    Write-OK "Tool config synced"
                } catch {
                    Write-Warn "Tool config sync failed (non-fatal, using plugin defaults)"
                }

                # ── Register with OpenClaw (idempotent) ──
                Push-Location $PluginDir
                Write-Host "  Registering plugin with OpenClaw..."
                $alreadyRegistered = (openclaw plugins list 2>&1 | Select-String "orchestrator-plugin" -Quiet)
                if ($alreadyRegistered) {
                    Write-Host "  Plugin already registered, skip" -ForegroundColor Cyan
                } else {
                    try {
                        openclaw plugins install "$PluginDir" --link 2>&1 | Out-Null
                        Write-OK "Plugin registered"
                    } catch {
                        Write-Warn "Plugin registration failed (try: cd $PluginDir; openclaw plugins install . --link)"
                    }
                }
                Pop-Location
            }
        }

        # ── Agent registration ──
        if (Test-Path (Join-Path $PluginDir "dist\index.js")) {
            $agentWs = Join-Path $OpenryHome "agent-workspace"
            try {
                openclaw agents add openry-worker --workspace $agentWs --non-interactive --json 2>&1 | Out-Null
                Write-OK "Agent 'openry-worker' registered"
                # Sync tool config via openry CLI (also updates agent alsoAllow)
                try {
                    & openry tools sync 2>&1 | Out-Null
                    Write-OK "Agent tools configured"
                } catch {
                    Write-Warn "Tools config failed (non-fatal)"
                }
            } catch {
                Write-Warn "Agent registration failed (may already exist)"
            }
        }

        # ═══════════════════════════════════════════════════════════════
        # 9a. BGE-M3 Embedding Model
        # ═══════════════════════════════════════════════════════════════

        $bgeCacheDir = Join-Path $PluginDir "node_modules\@xenova\transformers\.cache\Xenova\bge-m3"

        # ── Check if already complete ──
        $bgeNeedInstall = $true
        if (Test-BGEM3Complete -CacheDir $bgeCacheDir) {
            Write-Host "  BGE-M3 model already installed (files verified), skip" -ForegroundColor Cyan
            $bgeNeedInstall = $false
        }

        if ($bgeNeedInstall) {
            Write-Host "  Installing BGE-M3 embedding model (one-time, ~400MB)..."

            $bgeFile = "bge-m3-offline.tar.gz"
            $bgeLocal = Join-Path $ScriptDir "deps\common\$bgeFile"
            $bgeSHA256 = "c489b6e468a6a3b50e37485f572751dcc0c0caf08e43e6e524b2c2a5f73aed6c"
            $bgeOk = $false
            $bgeTar = $null   # only set by 'local' and 'auto/github' branches; modelscope installs directly

            switch ($BgeSource) {
                "local" {
                    if (Test-Path $bgeLocal) {
                        $actual = Get-SHA256Hash -FilePath $bgeLocal
                        if ($actual -eq $bgeSHA256) {
                            $bgeOk = $true
                            $bgeTar = $bgeLocal
                        } else {
                            Write-Err "Local BGE-M3 file corrupt (sha256 mismatch)"
                        }
                    } else {
                        Write-Err "Local BGE-M3 not found: $bgeLocal"
                    }
                }
                "modelscope" {
                    Write-Host "  Using ModelScope SDK to download BGE-M3..."
                    try {
                        & $pythonCmd -m pip install modelscope --quiet 2>&1 | Out-Null
                        $bgeTmpDir = "$env:TEMP\openry-bge-modelscope"
                        Remove-Item $bgeTmpDir -Recurse -Force -ErrorAction SilentlyContinue
                        $pyScript = @"
from modelscope import snapshot_download
import shutil, os
cache = snapshot_download('BAAI/bge-m3', cache_dir=r'$bgeTmpDir')
dest = r'$bgeCacheDir'
os.makedirs(dest, exist_ok=True)
for f in ['config.json', 'tokenizer.json', 'tokenizer_config.json',
          'special_tokens_map.json', 'sentencepiece.bpe.model',
          'modules.json', 'sentence_bert_config.json',
          'config_sentence_transformers.json']:
    src = os.path.join(cache, f)
    if os.path.exists(src):
        shutil.copy2(src, os.path.join(dest, f))
onnx_src = os.path.join(cache, 'onnx')
onnx_dst = os.path.join(dest, 'onnx')
if os.path.exists(onnx_src):
    if os.path.exists(onnx_dst):
        shutil.rmtree(onnx_dst)
    shutil.copytree(onnx_src, onnx_dst)
print('OK')
"@
                        $result = & $pythonCmd -c $pyScript 2>&1
                        if ($result -match "OK") {
                            Write-OK "BGE-M3 installed via ModelScope SDK"
                            $bgeOk = $true
                        } else {
                            Write-Err "ModelScope SDK download failed"
                        }
                    } catch {
                        Write-Err "Failed to install modelscope package: $_"
                    }
                }
                default {
                    # auto / github: try local deps/ → GitHub Releases
                    $bgeTar = Resolve-Asset -AssetName $bgeFile `
                        -LocalPath $bgeLocal `
                        -ReleaseTag "bge-m3-v1.0" `
                        -ExpectedSHA256 $bgeSHA256

                    if ($bgeTar) {
                        $bgeOk = $true
                    }
                }
            }

            # ── Extract if we got a tar ──
            if ($bgeOk -and $bgeTar) {
                $bgeTmp = "$env:TEMP\bge-m3-extract"
                Remove-Item $bgeTmp -Recurse -Force -ErrorAction SilentlyContinue
                New-Item -ItemType Directory -Force $bgeTmp | Out-Null
                try {
                    tar -xzf $bgeTar -C $bgeTmp 2>&1 | Out-Null
                    $bundleDir = Join-Path $bgeTmp "bge-m3-bundle"
                    # Prefer native PowerShell script on Windows; fall back to bash + .sh
                    $ps1Script = Join-Path $bundleDir "install-bge-m3.ps1"
                    $shScript  = Join-Path $bundleDir "install-bge-m3.sh"
                    if (Test-Path $ps1Script) {
                        & powershell -NoProfile -ExecutionPolicy Bypass -File $ps1Script -PluginDir $PluginDir 2>&1 | Out-Null
                        Write-OK "BGE-M3 model installed"
                    } elseif (Test-Path $shScript) {
                        if (Get-Command bash -ErrorAction SilentlyContinue) {
                            bash $shScript $PluginDir 2>&1 | Out-Null
                            Write-OK "BGE-M3 model installed"
                        } else {
                            Write-Warn "bash not available — BGE-M3 install script skipped"
                            Write-Host "    Manually extract ONNX files to: $bgeCacheDir"
                        }
                    } else {
                        Write-Warn "BGE-M3 install script not found in bundle"
                    }
                } catch {
                    Write-Err "BGE-M3 extraction failed: $_"
                }
                Remove-Item $bgeTmp -Recurse -Force -ErrorAction SilentlyContinue
            }

            # ── Final verification ──
            if (Test-BGEM3Complete -CacheDir $bgeCacheDir) {
                Write-OK "BGE-M3 verified complete"
            } elseif (-not $bgeOk) {
                Write-Warn "BGE-M3 not installed — will download on first use (requires network)"
            }
        }  # bgeNeedInstall

        Write-Host ""
        Write-Host "  Restart gateway: openclaw gateway restart" -ForegroundColor Cyan
    }
    Write-Host ""
}

# ═══════════════════════════════════════════════════════════════════════
# Done
# ═══════════════════════════════════════════════════════════════════════

Write-Host "╔══════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║  OpenRY installation complete!                   ║" -ForegroundColor Green
Write-Host "╚══════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "  Next steps:" -ForegroundColor Cyan
Write-Host "    1. openclaw gateway restart" -ForegroundColor White
Write-Host "    2. openry serve --port 9100" -ForegroundColor White
Write-Host "  Then open http://127.0.0.1:9100" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Verify: openry -c 'echo hello'" -ForegroundColor DarkGray
Write-Host ""
