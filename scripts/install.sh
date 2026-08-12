#!/usr/bin/env bash
# ============================================================================
# OpenRY — One-Click Cross-Platform Installer (macOS / Linux)
# ============================================================================
# Usage:
#   bash install.sh                           # Standard install
#   bash install.sh --force                   # Clean everything, then install
#   bash install.sh --skip-python             # Skip Python + pip steps
#   bash install.sh --skip-plugin             # Skip orchestrator-plugin
#   bash install.sh --bge-source=modelscope   # Use ModelScope SDK for BGE-M3
#
# Asset sources (priority order):
#   1. Local deps/ directory    — GitCode clone (deps included with repo)
#   2. GitHub Releases          — lingopi/openry (fallback download)
#   3. ModelScope SDK (BGE-M3)  — modelscope Python package (--bge-source=modelscope)
#
# License: MIT — OpenRY Contributors
# ============================================================================
set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ── Parse arguments ───────────────────────────────────────────────────────
SKIP_PYTHON=false
SKIP_PLUGIN=false
FORCE=false
BGE_SOURCE="auto"   # auto | local | github | modelscope

# Track errors for final summary
INSTALL_ERRORS=""

for arg in "$@"; do
    case "$arg" in
        --skip-python)   SKIP_PYTHON=true ;;
        --skip-plugin)   SKIP_PLUGIN=true ;;
        --force|-f)      FORCE=true ;;
        --bge-source=*)  BGE_SOURCE="${arg#*=}" ;;
        --bge-source)    BGE_SOURCE="${2:-auto}"; shift ;;
        --help|-h)
            echo "Usage: bash install.sh [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --force, -f          Clean everything before install"
            echo "  --skip-python        Skip Python detection and pip install"
            echo "  --skip-plugin        Skip orchestrator-plugin (OpenClaw) install"
            echo "  --bge-source=SRC     BGE-M3 source: auto, local, github, modelscope"
            echo "  --help, -h           Show this help"
            exit 0
            ;;
        *) echo -e "${RED}Unknown option: $arg${NC}"; exit 1 ;;
    esac
done

echo ""
echo -e "${GREEN}${BOLD}╔══════════════════════════════════════╗${NC}"
echo -e "${GREEN}${BOLD}║       OpenRY — One-Click Installer  ║${NC}"
echo -e "${GREEN}${BOLD}╚══════════════════════════════════════╝${NC}"
echo ""

# ═══════════════════════════════════════════════════════════════════════════
# Helper Functions
# ═══════════════════════════════════════════════════════════════════════════

# Portable sha256 — works on macOS (shasum) and Linux (sha256sum)
sha256_hash() {
    local file="$1"
    if command -v sha256sum &>/dev/null; then
        sha256sum "$file" | awk '{print $1}'
    elif command -v shasum &>/dev/null; then
        shasum -a 256 "$file" | awk '{print $1}'
    else
        echo "ERROR: no sha256 tool found" >&2
        return 1
    fi
}

# Resolve an asset: local deps/ → GitHub Releases → GitCode clone, with sha256.
# Usage: resolve_asset <asset_name> <local_path> <release_tag> <sha256>
# Prints the resolved file path on success, returns non-zero on failure.
resolve_asset() {
    local asset_name="$1"
    local local_path="$2"
    local release_tag="$3"
    local expected_sha256="$4"
    local remote_url="https://github.com/lingopi/openry/releases/download/${release_tag}/${asset_name}"
    local gitcode_url="https://gitcode.com/yifan850902/openry.git"

    # ── Step 1: Try local ──
    if [ -f "$local_path" ]; then
        local actual
        actual=$(sha256_hash "$local_path" 2>/dev/null) || true
        if [ "$actual" = "$expected_sha256" ]; then
            echo "$local_path"
            return 0
        fi
        echo -e "  ${YELLOW}⚠ Local file corrupt (sha256 mismatch), re-downloading...${NC}" >&2
        rm -f "$local_path"
    fi

    # ── Step 2: Try GitHub Releases ──
    echo -e "  Downloading ${asset_name} from GitHub Releases..." >&2
    echo -e "    ${remote_url}" >&2
    mkdir -p "$(dirname "$local_path")"
    if curl -fSL --connect-timeout 10 --speed-limit 102400 --speed-time 15 --progress-bar -C - -o "$local_path.tmp" "$remote_url"; then
        actual=$(sha256_hash "$local_path.tmp" 2>/dev/null) || true
        if [ "$actual" = "$expected_sha256" ]; then
            mv "$local_path.tmp" "$local_path"
            echo -e "  ${GREEN}✓${NC} sha256 verified, cached to $(dirname "$local_path")/" >&2
            echo "$local_path"
            return 0
        fi
        echo -e "  ${RED}✗ sha256 mismatch after download${NC}" >&2
        rm -f "$local_path.tmp"
    else
        echo -e "  ${YELLOW}⚠ GitHub Releases failed (connect timeout or unreachable)${NC}" >&2
        rm -f "$local_path.tmp"
    fi

    # ── Step 3: GitCode sparse clone (only deps/ directory) ──
    echo -e "  Fetching deps/ from GitCode..." >&2
    echo -e "    ${gitcode_url}" >&2
    local tmp_clone="/tmp/openry-deps-clone-$$"
    rm -rf "$tmp_clone" 2>/dev/null
    local deps_parent
    deps_parent="$(dirname "$(dirname "$local_path")")"
    local gitcode_ok=false

    # Clone with 120-second timeout (perl fallback on macOS; GNU timeout on Linux)
    _clone_ret=0
    if command -v timeout &>/dev/null; then
        timeout 120 git clone --depth 1 --filter=blob:none "$gitcode_url" "$tmp_clone" || _clone_ret=$?
    elif command -v perl &>/dev/null; then
        perl -e 'alarm 120; exec @ARGV' -- git clone --depth 1 --filter=blob:none "$gitcode_url" "$tmp_clone" || _clone_ret=$?
    else
        git clone --depth 1 --filter=blob:none "$gitcode_url" "$tmp_clone" || _clone_ret=$?
    fi

    if [ $_clone_ret -eq 0 ]; then
        # Try sparse-checkout; fall back to full checkout if it fails
        if ( cd "$tmp_clone" && git sparse-checkout set deps/ ); then
            :
        else
            # Older git without sparse-checkout support — full checkout is fine
            ( cd "$tmp_clone" && git checkout ) || true
        fi

        if [ -d "$tmp_clone/deps" ]; then
            cp -r "$tmp_clone/deps/"* "$deps_parent/"
            echo -e "  ${GREEN}✓${NC} deps/ fetched from GitCode" >&2
            gitcode_ok=true
        else
            echo -e "  ${YELLOW}⚠ GitCode clone succeeded but deps/ not found${NC}" >&2
        fi
    else
        if [ $_clone_ret -eq 124 ] || [ $_clone_ret -eq 142 ]; then
            echo -e "  ${YELLOW}⚠ GitCode clone timed out (120s limit)${NC}" >&2
        else
            echo -e "  ${YELLOW}⚠ GitCode clone failed (network or auth issue)${NC}" >&2
        fi
    fi

    rm -rf "$tmp_clone" 2>/dev/null

    # Re-check local after GitCode fetch
    if [ "$gitcode_ok" = true ] && [ -f "$local_path" ]; then
        actual=$(sha256_hash "$local_path" 2>/dev/null) || true
        if [ "$actual" = "$expected_sha256" ]; then
            echo -e "  ${GREEN}✓${NC} sha256 verified" >&2
            echo "$local_path"
            return 0
        fi
        echo -e "  ${RED}✗ sha256 mismatch on GitCode-fetched file${NC}" >&2
    fi

    echo -e "  ${RED}✗ All sources exhausted for ${asset_name}${NC}" >&2
    return 1
}

# Check if BGE-M3 cache is complete (file-level verification, not just dir exists)
bge_is_complete() {
    local cache_dir="$1"
    local f
    for f in "config.json" "tokenizer.json" "tokenizer_config.json" "onnx/model_quantized.onnx"; do
        [ -f "${cache_dir}/${f}" ] || return 1
    done
    return 0
}

# ═══════════════════════════════════════════════════════════════════════════
# 1. OS Detection
# ═══════════════════════════════════════════════════════════════════════════

OS="$(uname -s)"
case "$OS" in
    Darwin)  OS_NAME="macOS" ;;
    Linux)   OS_NAME="Linux" ;;
    *)
        echo -e "${RED}✗ Unsupported OS: $OS${NC}"
        echo ""
        echo "OpenRY currently supports macOS and Linux."
        exit 1
        ;;
esac
echo -e "  Detected OS: ${CYAN}$OS_NAME${NC}"

# ═══════════════════════════════════════════════════════════════════════════
# 2. Resolve paths
# ═══════════════════════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WRAPPER_BIN="${HOME}/.local/bin"
OPENRY_HOME="${OPENRY_HOME:-$HOME/.openry}"
PLUGIN_DIR="${SCRIPT_DIR}/orchestrator-plugin"

echo -e "  Install dir: ${CYAN}$SCRIPT_DIR${NC}"
echo ""

# ═══════════════════════════════════════════════════════════════════════════
# 3. Python Detection
# ═══════════════════════════════════════════════════════════════════════════

PYTHON=""
if [ "$SKIP_PYTHON" = true ]; then
    echo -e "  ${YELLOW}⚠ Skipping Python check (--skip-python)${NC}"
    PYTHON="python3"
else
    for candidate in python3.12 python3.11 python3.10 python3.9 python3; do
        if command -v "$candidate" &>/dev/null; then
            PYTHON="$candidate"
            break
        fi
    done

    if [ -z "$PYTHON" ]; then
        echo -e "${RED}✗ Python 3.9+ not found.${NC}"
        echo ""
        echo "Install Python 3 first:"
        echo "  macOS:  brew install python@3.12"
        echo "  Linux:  sudo apt install python3"
        exit 1
    fi

    PY_VER=$($PYTHON --version 2>&1)
    echo -e "  ${GREEN}✓${NC} Python: $PY_VER"

    if ! $PYTHON -m pip --version &>/dev/null; then
        echo -e "${RED}✗ pip not available for $PYTHON${NC}"
        echo "  macOS:  $PYTHON -m ensurepip --upgrade"
        echo "  Linux:  sudo apt install python3-pip"
        exit 1
    fi
fi

# ═══════════════════════════════════════════════════════════════════════════
# 4. --force: clean everything before install
# ═══════════════════════════════════════════════════════════════════════════

if [ "$FORCE" = true ]; then
    echo -e "${BOLD}── Force clean before install ──${NC}"
    echo ""

    # pip uninstall (tolerate failure — may not be installed)
    if [ "$SKIP_PYTHON" != true ]; then
        $PYTHON -m pip uninstall openry -y 2>/dev/null || true
        echo -e "  ${GREEN}✓${NC} pip package removed"
    fi

    # egg-info residue
    rm -rf "$SCRIPT_DIR/openry.egg-info" 2>/dev/null || true

    # Wrapper script
    rm -f "$WRAPPER_BIN/openry" 2>/dev/null || true

    # Plugin artifacts (node_modules, dist, Xenova BGE-M3 cache)
    if [ -d "$PLUGIN_DIR" ]; then
        rm -rf "$PLUGIN_DIR/node_modules" 2>/dev/null || true
        rm -rf "$PLUGIN_DIR/dist" 2>/dev/null || true
        echo -e "  ${GREEN}✓${NC} Plugin artifacts cleaned"
    fi

    # OpenClaw (if available)
    if command -v openclaw &>/dev/null; then
        openclaw gateway stop 2>/dev/null || true
        openclaw plugins uninstall orchestrator-plugin 2>/dev/null || true
        echo -e "  ${GREEN}✓${NC} OpenClaw cleaned"
    fi

    echo ""
fi

# ═══════════════════════════════════════════════════════════════════════════
# 5. Install pyyaml
# ═══════════════════════════════════════════════════════════════════════════

if [ "$SKIP_PYTHON" != true ]; then
    echo -e "  Installing pyyaml..."
    $PYTHON -m pip install pyyaml --quiet 2>/dev/null || {
        echo -e "  ${YELLOW}⚠ pyyaml install failed (non-fatal, continuing...)${NC}"
    }
fi

# ═══════════════════════════════════════════════════════════════════════════
# 6. Install openry CLI (uninstall first, then install)
# ═══════════════════════════════════════════════════════════════════════════

if [ "$SKIP_PYTHON" != true ]; then
    echo -e "  Installing openry CLI..."

    # ── Clean previous install ──
    $PYTHON -m pip uninstall openry -y 2>/dev/null || true
    rm -rf "$SCRIPT_DIR/openry.egg-info" 2>/dev/null || true
    rm -f "$WRAPPER_BIN/openry" 2>/dev/null || true

    # ── Install ──
    PIP_OK=false
    cd "$SCRIPT_DIR"

    if $PYTHON -m pip install --user -e . --quiet 2>/dev/null; then
        mkdir -p "$WRAPPER_BIN"
        export PATH="$WRAPPER_BIN:$PATH"

        if command -v openry &>/dev/null; then
            PIP_OK=true
        else
            # pip may have put it in ~/Library/Python/3.x/bin (macOS default)
            OPENRY_PATH=$($PYTHON -c "import shutil; print(shutil.which('openry') or '')" 2>/dev/null || true)
            if [ -n "$OPENRY_PATH" ] && [ -x "$OPENRY_PATH" ]; then
                PIP_OK=true
            fi
        fi
    fi

    # Fallback: create a wrapper script
    if [ "$PIP_OK" = false ]; then
        mkdir -p "$WRAPPER_BIN"
        cat > "$WRAPPER_BIN/openry" << WRAPPER
#!/usr/bin/env bash
# Auto-generated by OpenRY installer
OPENRY_HOME="\${OPENRY_HOME:-$OPENRY_HOME}"
PYTHONPATH="$SCRIPT_DIR:\$PYTHONPATH" exec $PYTHON -m openry "\$@"
WRAPPER
        chmod +x "$WRAPPER_BIN/openry"
        export PATH="$WRAPPER_BIN:$PATH"
        echo -e "  ${YELLOW}⚠ Using wrapper at ${WRAPPER_BIN}/openry${NC}"
    else
        echo -e "  ${GREEN}✓${NC} openry installed via pip"
    fi
fi

# ═══════════════════════════════════════════════════════════════════════════
# 7. Ensure ~/.local/bin in shell PATH
# ═══════════════════════════════════════════════════════════════════════════

SHELL_RC=""
case "${SHELL##*/}" in
    zsh)  SHELL_RC="$HOME/.zshrc" ;;
    bash) SHELL_RC="${HOME}/.bashrc" ;;
    *)    SHELL_RC="${HOME}/.profile" ;;
esac

if [ -f "$SHELL_RC" ] && grep -qF "$WRAPPER_BIN" "$SHELL_RC" 2>/dev/null; then
    : # already configured
else
    {
        echo ""
        echo "# Added by OpenRY installer"
        echo "export OPENRY_HOME=\"${OPENRY_HOME}\""
        echo "export PATH=\"$WRAPPER_BIN:\$PATH\""
    } >> "$SHELL_RC"
fi

export PATH="$WRAPPER_BIN:$PATH"
export OPENRY_HOME="$OPENRY_HOME"

# ═══════════════════════════════════════════════════════════════════════════
# 8. Initialize ~/.openry/ from seed
# ═══════════════════════════════════════════════════════════════════════════

SEED_DIR="${SCRIPT_DIR}/seed"
if [ -d "$SEED_DIR" ]; then
    mkdir -p "$OPENRY_HOME"
    # First-time only: don't overwrite user data on reinstall
    if [ ! -d "$OPENRY_HOME/workflows" ]; then
        cp -r "$SEED_DIR"/* "$OPENRY_HOME/" 2>/dev/null || true
        echo -e "  ${GREEN}✓${NC} Initialized ${CYAN}${OPENRY_HOME}${NC} from seed/"
    else
        echo -e "  ${CYAN}~/.openry already exists, preserving user data${NC}"
    fi
    WF_COUNT=$(ls "$OPENRY_HOME/workflows/"*.yaml 2>/dev/null | wc -l | tr -d ' ') || true
    CP_COUNT=$(ls "$OPENRY_HOME/compositions/"*.yaml 2>/dev/null | wc -l | tr -d ' ') || true
    PM_COUNT=$(ls "$OPENRY_HOME/prompts/"*.md 2>/dev/null | wc -l | tr -d ' ') || true
    echo "    workflows: ${WF_COUNT} files, compositions: ${CP_COUNT} files, prompts: ${PM_COUNT} files"
else
    mkdir -p "$OPENRY_HOME/workflows" "$OPENRY_HOME/compositions" "$OPENRY_HOME/prompts" "$OPENRY_HOME/prompt_blocks"
    echo -e "  ${YELLOW}⚠ seed/ not found, created empty structure${NC}"
fi

# Clean stale DB
rm -f "$OPENRY_HOME/openry.db" "$OPENRY_HOME/openry.db-wal" "$OPENRY_HOME/openry.db-shm" 2>/dev/null || true
echo ""

# ═══════════════════════════════════════════════════════════════════════════
# 9. Verify openry
# ═══════════════════════════════════════════════════════════════════════════

echo -e "  Verifying openry..."
OPENRY_BIN="$WRAPPER_BIN/openry"
if [ -x "$OPENRY_BIN" ] && "$OPENRY_BIN" -c 'echo "install OK"' 2>/dev/null | grep -q "install OK"; then
    echo -e "  ${GREEN}✓ openry is ready${NC}  (${CYAN}${OPENRY_BIN}${NC})"
else
    # Try PATH-based openry as fallback
    if command -v openry &>/dev/null && openry -c 'echo "install OK"' 2>/dev/null | grep -q "install OK"; then
        echo -e "  ${GREEN}✓ openry is ready${NC}"
    else
        echo -e "  ${RED}✗ Verification failed${NC}"
        echo "  Try: cd $SCRIPT_DIR && PYTHONPATH=. $PYTHON -m openry -c 'echo test'"
        exit 1
    fi
fi
echo ""

# ═══════════════════════════════════════════════════════════════════════════
# 10. orchestrator-plugin
# ═══════════════════════════════════════════════════════════════════════════

if [ "$SKIP_PLUGIN" = true ]; then
    echo -e "  ${YELLOW}⚠ Skipping orchestrator plugin (--skip-plugin)${NC}"
    echo ""
else

if [ ! -d "$PLUGIN_DIR" ]; then
    echo -e "  ${YELLOW}⚠ orchestrator-plugin/ not found, skipping${NC}"
    echo ""
else
    echo -e "${BOLD}── Orchestrator Plugin (OpenClaw integration) ──${NC}"
    echo ""

    # ── Check dependencies ──
    MISSING_DEPS=""
    command -v openclaw &>/dev/null || MISSING_DEPS="${MISSING_DEPS}  - OpenClaw not found (install: https://openclaw.ai)\n"
    command -v node &>/dev/null || MISSING_DEPS="${MISSING_DEPS}  - Node.js not found (install: https://nodejs.org)\n"
    command -v npm &>/dev/null || MISSING_DEPS="${MISSING_DEPS}  - npm not found (bundled with Node.js)\n"

    if [ -n "$MISSING_DEPS" ]; then
        echo -e "  ${YELLOW}⚠ Skipping orchestrator plugin:${NC}"
        echo -e "$MISSING_DEPS"
        echo "  Re-run this installer after installing the missing dependencies."
    else
        echo -e "  ${GREEN}✓${NC} OpenClaw + Node.js detected, installing plugin..."
        echo ""

        # ── Always clean plugin artifacts before install ──
        echo -e "  Cleaning previous plugin artifacts..."
        rm -rf "$PLUGIN_DIR/node_modules" 2>/dev/null || true
        rm -rf "$PLUGIN_DIR/dist" 2>/dev/null || true
        echo -e "  ${GREEN}✓${NC} Cleaned"

        # ── Resolve plugin bundle ──
        PLUGIN_BUNDLE_NAME="orchestrator-plugin-bundle-${OS_NAME}.tar.gz"
        # Bundle path: both macOS and Linux use deps/macos/ for now
        PLUGIN_BUNDLE_LOCAL="${SCRIPT_DIR}/deps/macos/${PLUGIN_BUNDLE_NAME}"
        PLUGIN_SHA256="632da2069a8ad8df66f5046778e3c134e01c6f60151d616f0074cc3d06b82774"

        BUNDLE_FILE=""
        BUNDLE_FILE=$(resolve_asset "$PLUGIN_BUNDLE_NAME" "$PLUGIN_BUNDLE_LOCAL" \
            "plugin-bundle-v1.0" "$PLUGIN_SHA256") || true

        if [ -z "$BUNDLE_FILE" ] || [ ! -f "$BUNDLE_FILE" ]; then
            echo -e "  ${RED}✗ Plugin bundle unavailable — local deps/ and GitHub Releases both failed${NC}"
            echo -e "  ${YELLOW}⚠ Skipping plugin (you can re-run after fixing network or deps/)${NC}"
            INSTALL_ERRORS="${INSTALL_ERRORS}  - Plugin bundle download failed (check network or deps/)\n"
        else
            # ── Extract ──
            echo -e "  Extracting plugin bundle..."
            if tar -xzf "$BUNDLE_FILE" -C "$PLUGIN_DIR" 2>/dev/null; then
                echo -e "  ${GREEN}✓${NC} Plugin bundle extracted"
            else
                echo -e "  ${RED}✗ Extraction failed${NC}"
                INSTALL_ERRORS="${INSTALL_ERRORS}  - Plugin bundle extraction failed\n"
            fi

            # Verify dist/index.js
            if [ ! -f "$PLUGIN_DIR/dist/index.js" ]; then
                echo -e "  ${YELLOW}⚠ dist/index.js missing, attempting rebuild...${NC}"
                cd "$PLUGIN_DIR" && npm run build 2>/dev/null || true
                cd "$SCRIPT_DIR"
            fi

            # ── Sync tool config from seed/tools.yaml BEFORE plugin registration ──
            # This ensures openclaw.plugin.json contracts.tools is correct
            echo -e "  Syncing tool configuration from seed/tools.yaml..."
            if openry tools sync 2>/dev/null; then
                echo -e "  ${GREEN}✓${NC} Tool config synced"
            else
                echo -e "  ${YELLOW}⚠ Tool config sync failed (non-fatal, using plugin defaults)${NC}"
            fi

            if [ ! -f "$PLUGIN_DIR/dist/index.js" ]; then
                echo -e "  ${RED}✗ Plugin dist/index.js not found — cannot register${NC}"
                INSTALL_ERRORS="${INSTALL_ERRORS}  - Plugin dist/index.js missing (try: cd orchestrator-plugin && npm install && npm run build)\n"
            else
                # ── Register with OpenClaw (idempotent) ──
                echo -e "  Registering plugin with OpenClaw..."
                if openclaw plugins list 2>/dev/null | grep -q orchestrator-plugin; then
                    echo -e "  ${CYAN}Plugin already registered, skip${NC}"
                elif openclaw plugins install "$PLUGIN_DIR" --link 2>/dev/null; then
                    echo -e "  ${GREEN}✓${NC} Plugin registered"
                else
                    echo -e "  ${YELLOW}⚠ Plugin registration failed (try: cd $PLUGIN_DIR && openclaw plugins install . --link)${NC}"
                fi
            fi
        fi

        # ── Agent registration ──
        if [ -f "$PLUGIN_DIR/dist/index.js" ]; then
            AGENT_WS="${OPENRY_HOME}/agent-workspace"
            echo -e "  Registering agent 'openry-worker'..."
            if openclaw agents add openry-worker --workspace "$AGENT_WS" --non-interactive --json >/dev/null 2>&1; then
                echo -e "  ${GREEN}✓${NC} Agent 'openry-worker' registered"
                # Sync tool config via openry CLI (also updates agent alsoAllow)
                openry tools sync 2>/dev/null && \
                    echo -e "  ${GREEN}✓${NC} Agent tools configured" || \
                    echo -e "  ${YELLOW}⚠${NC} Tools config failed (non-fatal)"
            else
                echo -e "  ${YELLOW}⚠${NC} Agent registration failed (may already exist)"
            fi
        fi

        # ═══════════════════════════════════════════════════════════════════
        # 10a. BGE-M3 Embedding Model
        # ═══════════════════════════════════════════════════════════════════

        BGE_CACHE_DIR="$PLUGIN_DIR/node_modules/@xenova/transformers/.cache/Xenova/bge-m3"

        # ── Check if already complete ──
        BGE_NEED_INSTALL=true
        if bge_is_complete "$BGE_CACHE_DIR"; then
            echo -e "  ${CYAN}BGE-M3 model already installed (files verified), skip${NC}"
            BGE_NEED_INSTALL=false
        fi

        if [ "$BGE_NEED_INSTALL" = true ]; then
            echo -e "  Installing BGE-M3 embedding model (one-time, ~400MB)..."

            BGE_FILE="bge-m3-offline.tar.gz"
            BGE_LOCAL="${SCRIPT_DIR}/deps/common/${BGE_FILE}"
            BGE_SHA256="c489b6e468a6a3b50e37485f572751dcc0c0caf08e43e6e524b2c2a5f73aed6c"
            BGE_OK=false

            case "$BGE_SOURCE" in
                local)
                    # Force local only
                    if [ -f "$BGE_LOCAL" ]; then
                        actual=$(sha256_hash "$BGE_LOCAL" 2>/dev/null) || true
                        if [ "$actual" = "$BGE_SHA256" ]; then
                            BGE_OK=true
                            BGE_TAR="$BGE_LOCAL"
                        else
                            echo -e "  ${RED}✗ Local BGE-M3 file corrupt (sha256 mismatch)${NC}"
                        fi
                    else
                        echo -e "  ${RED}✗ Local BGE-M3 not found: ${BGE_LOCAL}${NC}"
                    fi
                    ;;
                modelscope)
                    # ModelScope SDK fallback
                    echo -e "  Using ModelScope SDK to download BGE-M3..."
                    if $PYTHON -m pip install modelscope --quiet 2>/dev/null; then
                        BGE_TMP_DIR="/tmp/openry-bge-modelscope"
                        rm -rf "$BGE_TMP_DIR" 2>/dev/null
                        if $PYTHON -c "
from modelscope import snapshot_download
import shutil, os
cache = snapshot_download('BAAI/bge-m3', cache_dir='${BGE_TMP_DIR}')
# Copy ONNX + tokenizer files to Xenova cache structure
dest = '${BGE_CACHE_DIR}'
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
" 2>/dev/null | grep -q "OK"; then
                            echo -e "  ${GREEN}✓${NC} BGE-M3 installed via ModelScope SDK"
                            BGE_OK=true  # already placed in cache
                        else
                            echo -e "  ${RED}✗ ModelScope SDK download failed${NC}"
                        fi
                    else
                        echo -e "  ${RED}✗ Failed to install modelscope package${NC}"
                    fi
                    ;;
                *)
                    # auto / github: try local deps/ → GitHub Releases
                    BGE_TAR=""
                    BGE_TAR=$(resolve_asset "$BGE_FILE" "$BGE_LOCAL" \
                        "bge-m3-v1.0" "$BGE_SHA256") || true

                    if [ -n "$BGE_TAR" ] && [ -f "$BGE_TAR" ]; then
                        BGE_OK=true
                    fi
                    ;;
            esac

            # ── Extract if we got a tar ──
            if [ "$BGE_OK" = true ] && [ -n "${BGE_TAR:-}" ] && [ -f "${BGE_TAR:-}" ]; then
                BGE_TMP="/tmp/bge-m3-extract"
                rm -rf "$BGE_TMP" 2>/dev/null
                mkdir -p "$BGE_TMP"
                if tar -xzf "$BGE_TAR" -C "$BGE_TMP" 2>/dev/null; then
                    # Run the bundled install script if present
                    if [ -f "$BGE_TMP/bge-m3-bundle/install-bge-m3.sh" ]; then
                        bash "$BGE_TMP/bge-m3-bundle/install-bge-m3.sh" "$PLUGIN_DIR" && \
                            echo -e "  ${GREEN}✓${NC} BGE-M3 model installed" || \
                            echo -e "  ${YELLOW}⚠${NC} BGE-M3 install script failed"
                    else
                        echo -e "  ${YELLOW}⚠${NC} BGE-M3 install script not found in bundle"
                    fi
                else
                    echo -e "  ${RED}✗ BGE-M3 extraction failed${NC}"
                    INSTALL_ERRORS="${INSTALL_ERRORS}  - BGE-M3 extraction failed\n"
                fi
                rm -rf "$BGE_TMP" 2>/dev/null
            fi

            # ── Final verification ──
            if bge_is_complete "$BGE_CACHE_DIR"; then
                echo -e "  ${GREEN}✓${NC} BGE-M3 verified complete"
            elif [ "$BGE_OK" != true ]; then
                echo -e "  ${YELLOW}⚠${NC} BGE-M3 not installed — will download on first use (requires network)${NC}"
                INSTALL_ERRORS="${INSTALL_ERRORS}  - BGE-M3 model not installed (will download on first use)\n"
            fi
        fi

        echo ""
        echo -e "  Restart gateway: ${CYAN}openclaw gateway restart${NC}"
        cd "$SCRIPT_DIR"
    fi
    echo ""
fi
fi  # SKIP_PLUGIN

# ═══════════════════════════════════════════════════════════════════════════
# 11. Done
# ═══════════════════════════════════════════════════════════════════════════

echo ""
if [ -z "$INSTALL_ERRORS" ]; then
    echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}${BOLD}║     OpenRY installation complete!                ║${NC}"
    echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════════════╝${NC}"
else
    echo -e "${YELLOW}${BOLD}╔══════════════════════════════════════════════════╗${NC}"
    echo -e "${YELLOW}${BOLD}║  OpenRY installed with warnings (see below)      ║${NC}"
    echo -e "${YELLOW}${BOLD}╚══════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "  ${YELLOW}⚠ Installation issues:${NC}"
    echo -e "$INSTALL_ERRORS"
fi
echo ""
echo -e "  ${CYAN}Next steps:${NC}"
if [ "$SKIP_PYTHON" != true ]; then
    echo -e "    1. ${BOLD}${YELLOW}source $SHELL_RC${NC}  ${CYAN}(or restart terminal — needed once)${NC}"
fi
echo -e "    2. ${BOLD}openclaw gateway restart${NC}"
echo -e "    3. ${BOLD}openry serve${NC}"
echo "  Then open http://127.0.0.1:\${OPENRY_PORT:-9100}"
echo ""
echo -e "  ${CYAN}Quick test:${NC}"
echo "    openry -c 'echo hello'"
echo ""
echo -e "  ${CYAN}Download sources (if local deps/ unavailable):${NC}"
echo "    Plugin bundle (macOS):"
echo "      GitHub: https://github.com/lingopi/openry/releases/download/plugin-bundle-v1.0/orchestrator-plugin-bundle-macos.tar.gz"
echo "      GitCode: https://gitcode.com/yifan850902/openry.git  (deps/macos/)"
echo "    Plugin bundle (Windows):"
echo "      GitHub: https://github.com/lingopi/openry/releases/download/plugin-bundle-v1.0/orchestrator-plugin-bundle-win.tar.gz"
echo "      GitCode: https://gitcode.com/yifan850902/openry.git  (deps/windows/)"
echo "    BGE-M3 model:"
echo "      GitHub: https://github.com/lingopi/openry/releases/download/bge-m3-v1.0/bge-m3-offline.tar.gz"
echo "      GitCode: https://gitcode.com/yifan850902/openry.git  (deps/common/)"
echo ""
echo -e "  ${CYAN}Directories:${NC}"
echo "    Workflows:     ${OPENRY_HOME}/workflows/"
echo "    Compositions:  ${OPENRY_HOME}/compositions/"
echo "    Prompts:       ${OPENRY_HOME}/prompts/"
echo "    Prompt Blocks: ${OPENRY_HOME}/prompt_blocks/"
echo "    Database:      ${OPENRY_HOME}/openry.db  (auto-created on first use)"
echo ""
