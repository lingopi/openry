# ============================================================================
# OpenRY — Windows One-Click Installer (PowerShell)
# ============================================================================
# Platforms:
#   Windows ✅  (PowerShell 7+ required; auto-installed if missing)
#
# Prerequisites auto-installed:
#   - PowerShell 7 (if not present)
#   - Python 3.9+   (if not present, via winget)
#
# What this script does:
#   1. Check / install PowerShell 7
#   2. Check / install Python 3.9+
#   3. pip install openry (editable, from current directory)
#   4. Create ~\.openry directory structure
#   5. Copy example YAMLs, prompts
#   6. Set OPENRY_HOME + PATH environment variables (User scope)
#   7. Verify installation
#
# Usage:
#   pwsh -File install.ps1
#
# License: MIT — OpenRY Contributors
# ============================================================================
param(
    [switch]$SkipPwsh,      # Skip PowerShell 7 installation check
    [switch]$SkipPython,    # Skip Python installation check
    [switch]$SkipPlugin     # Skip orchestrator-plugin installation
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

# ── Resolve paths ──────────────────────────────────────────────────────

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$OpenryHome = if ($env:OPENRY_HOME) { $env:OPENRY_HOME } else { "$env:USERPROFILE\.openry" }

Write-Info "Install dir: $ScriptDir"
Write-Info "OpenRY home: $OpenryHome"
Write-Host ""

# ═══════════════════════════════════════════════════════════════════════
# 1. Check / Install PowerShell 7
# ═══════════════════════════════════════════════════════════════════════

if (-not $SkipPwsh) {
    # PowerShell 7 executable is 'pwsh'; Windows PowerShell 5 is 'powershell'
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
        # Refresh PATH (winget may have added pwsh)
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

if (-not $SkipPython) {
    $pythonCmd = $null
    $pythonPath = $null

    # ── Step 1: Try py launcher (most reliable on Windows) ──
    $pyExe = Get-Command py -ErrorAction SilentlyContinue
    if ($pyExe -and $pyExe.Source -notmatch "WindowsApps") {
        $pythonCmd = "py"
        $pythonPath = $pyExe.Source
    }

    # ── Step 2: Try python / python3, but skip Windows Store stubs ──
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

    # ── Step 3: Check Windows Registry for installed Pythons ──
    if (-not $pythonCmd) {
        $regPaths = @(
            "HKLM:\SOFTWARE\Python\PythonCore\*\InstallPath",
            "HKCU:\SOFTWARE\Python\PythonCore\*\InstallPath"
        )
        $regVersions = @()
        foreach ($rp in $regPaths) {
            $items = Get-ItemProperty -Path $rp -ErrorAction SilentlyContinue
            if ($items) { $regVersions += $items }
        }
        if ($regVersions.Count -gt 0) {
            # Pick newest version
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
            $pyVerStr = "$pyVer".Trim()
            Write-OK "Python found: $pyVerStr  ($pythonPath)"
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
            # Refresh PATH
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
# 3. Install pyyaml
# ═══════════════════════════════════════════════════════════════════════

Write-Host "  Installing pyyaml..."
try {
    & $pythonCmd -m pip install pyyaml --quiet 2>&1 | Out-Null
    Write-OK "pyyaml installed"
} catch {
    Write-Warn "pyyaml install failed (non-fatal, continuing...)"
}
Write-Host ""

# ═══════════════════════════════════════════════════════════════════════
# 4. Install openry CLI
# ═══════════════════════════════════════════════════════════════════════

Write-Host "  Installing openry CLI..."
Push-Location $ScriptDir

try {
    & $pythonCmd -m pip install -e . --quiet 2>&1 | Out-Null
    # Verify it's on PATH
    $openryPath = (Get-Command openry -ErrorAction SilentlyContinue).Source
    if ($openryPath) {
        Write-OK "openry installed via pip  ($openryPath)"
    } else {
        # May be in Python Scripts dir but not on PATH
        $scriptsDir = Split-Path -Parent (& $pythonCmd -c "import sys; print(sys.executable)")
        $scriptsDir = Join-Path (Split-Path -Parent $scriptsDir) "Scripts"
        $openryExe = Join-Path $scriptsDir "openry.exe"
        if (Test-Path $openryExe) {
            Write-OK "openry installed  ($openryExe)"
            # Add to User PATH
            $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
            if ($userPath -notlike "*$scriptsDir*") {
                [Environment]::SetEnvironmentVariable("Path", "$userPath;$scriptsDir", "User")
                $env:Path = "$env:Path;$scriptsDir"
                Write-Warn "Added Python Scripts to User PATH: $scriptsDir"
            }
        } else {
            Write-Warn "openry not found on PATH. Creating wrapper..."
            # Fallback: create a wrapper batch file
            $wrapperDir = "$env:USERPROFILE\.local\bin"
            New-Item -ItemType Directory -Force -Path $wrapperDir | Out-Null
            @"
@echo off
set OPENRY_HOME=%OPENRY_HOME%
set PYTHONPATH=$ScriptDir;%PYTHONPATH%
$pythonCmd -m openry %*
"@ | Out-File -FilePath "$wrapperDir\openry.cmd" -Encoding ASCII
            Write-OK "Wrapper created: $wrapperDir\openry.cmd"
        }
    }
} catch {
    Write-Err "pip install failed: $_"
    exit 1
} finally {
    Pop-Location
}
Write-Host ""

# ═══════════════════════════════════════════════════════════════════════
# 5. Set OPENRY_HOME environment variable (User scope, permanent)
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
# 6. Initialize .openry directory structure
# ═══════════════════════════════════════════════════════════════════════

New-Item -ItemType Directory -Force -Path "$OpenryHome\workflows"      | Out-Null
New-Item -ItemType Directory -Force -Path "$OpenryHome\compositions"   | Out-Null
New-Item -ItemType Directory -Force -Path "$OpenryHome\prompts"        | Out-Null
New-Item -ItemType Directory -Force -Path "$OpenryHome\prompt_blocks"  | Out-Null
Write-OK "Initialized $OpenryHome (workflows/ + compositions/ + prompts/ + prompt_blocks/)"
Write-Host ""

# ═══════════════════════════════════════════════════════════════════════
# 7. Copy example YAMLs & prompts
# ═══════════════════════════════════════════════════════════════════════

$exampleDir = Join-Path $ScriptDir "example"
if (Test-Path $exampleDir) {
    Write-Host "  Installing example workflows & compositions..."
    $exampleWorkflows = Join-Path $exampleDir "workflows"
    if (Test-Path $exampleWorkflows) {
        Copy-Item "$exampleWorkflows\*.yaml" -Destination "$OpenryHome\workflows\" -Exclude *system* -ErrorAction SilentlyContinue
    }
    $exampleCompositions = Join-Path $exampleDir "compositions"
    if (Test-Path $exampleCompositions) {
        Copy-Item "$exampleCompositions\*.yaml" -Destination "$OpenryHome\compositions\" -ErrorAction SilentlyContinue
    }
    Write-OK "Example YAMLs copied"
}

$promptsDir = Join-Path $ScriptDir "prompts"
if (Test-Path $promptsDir) {
    Write-Host "  Installing agent prompts..."
    Copy-Item "$promptsDir\*.md" -Destination "$OpenryHome\prompts\" -ErrorAction SilentlyContinue
    Write-OK "Prompts copied"
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
# 9. orchestrator-plugin (conditional)
# ═══════════════════════════════════════════════════════════════════════

$pluginDir = Join-Path $ScriptDir "orchestrator-plugin"
if ((Test-Path $pluginDir) -and (-not $SkipPlugin)) {
    Write-Host "── Orchestrator Plugin (OpenClaw integration) ──" -ForegroundColor White
    Write-Host ""

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
        $pluginOk = $true

        Push-Location $pluginDir
        try {
            npm install --silent 2>&1 | Out-Null
        } catch {
            Write-Warn "npm install failed, skipping plugin"
            $pluginOk = $false
        }

        if ($pluginOk) {
            try {
                npm run build --silent 2>&1 | Out-Null
            } catch {
                Write-Warn "build failed, skipping plugin"
                $pluginOk = $false
            }
        }

        if ($pluginOk) {
            try {
                openclaw plugins install . --link 2>&1 | Out-Null
                Write-OK "Plugin installed"
            } catch {
                Write-Warn "openclaw plugins install failed"
                Write-Host "    Try: cd $pluginDir; openclaw plugins install . --link"
            }
        }
        Pop-Location
    }
    Write-Host ""
}

# ═══════════════════════════════════════════════════════════════════════
# Done
# ═══════════════════════════════════════════════════════════════════════

Write-Host "╔══════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║  OpenRY installation complete!                       ║" -ForegroundColor Green
Write-Host "║  Restart your terminal or run: refrshPath            ║" -ForegroundColor Green
Write-Host "║  Test: openry -c 'echo hello'                        ║" -ForegroundColor Green
Write-Host "╚══════════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
