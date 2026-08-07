#!/usr/bin/env bash
# ============================================================================
# OpenRY — Cross-Platform Uninstaller (macOS / Linux)
# ============================================================================
# Usage:
#   bash uninstall.sh                    # Interactive, keep data
#   bash uninstall.sh --force            # Non-interactive, keep data
#   bash uninstall.sh --force --all      # Non-interactive, remove EVERYTHING
#
# Options:
#   --force        Skip all confirmation prompts
#   --all          Remove DB, model cache, node_modules — complete cleanup
#   --keep-data    Keep ~/.openry (DB + YAMLs)
#   --keep-env     Keep OPENRY_HOME + PATH env vars
#   --skip-gateway Don't touch OpenClaw gateway
# ============================================================================
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

FORCE=false
ALL=false
KEEP_DATA=false
KEEP_ENV=false
SKIP_GATEWAY=false

for arg in "$@"; do
    case "$arg" in
        --force|-f)        FORCE=true ;;
        --all|-a)          ALL=true ;;
        --keep-data)       KEEP_DATA=true ;;
        --keep-env)        KEEP_ENV=true ;;
        --skip-gateway)    SKIP_GATEWAY=true ;;
        --help|-h)
            echo "Usage: bash uninstall.sh [--force] [--all] [--keep-data] [--keep-env] [--skip-gateway]"
            exit 0
            ;;
    esac
done

echo ""
echo -e "${YELLOW}${BOLD}╔══════════════════════════════════════╗${NC}"
echo -e "${YELLOW}${BOLD}║  OpenRY — Uninstaller (macOS/Linux)  ║${NC}"
echo -e "${YELLOW}${BOLD}╚══════════════════════════════════════╝${NC}"
if [ "$ALL" = true ]; then
    echo -e "  ${RED}Mode: COMPLETE (DB + models + deps)${NC}"
fi
echo ""

# ── Resolve paths ──────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OPENRY_HOME="${OPENRY_HOME:-$HOME/.openry}"
PLUGIN_DIR="${SCRIPT_DIR}/orchestrator-plugin"
HF_CACHE="$HOME/.cache/huggingface"
TRANSFORMERS_CACHE="$HOME/.cache/transformers"
WRAPPER_BIN="${HOME}/.local/bin"
SHELL_RC=""
case "${SHELL##*/}" in
    zsh)  SHELL_RC="$HOME/.zshrc" ;;
    bash) SHELL_RC="${HOME}/.bashrc" ;;
    *)    SHELL_RC="${HOME}/.profile" ;;
esac

echo -e "  Script dir:  ${CYAN}$SCRIPT_DIR${NC}"
echo -e "  OpenRY home: ${CYAN}$OPENRY_HOME${NC}"
echo ""

# ── Confirmation ────────────────────────────────────────────────────────

if [ "$FORCE" != true ]; then
    echo -ne "  This will uninstall OpenRY. Continue? (y/N) "
    read -r confirm
    if [[ ! "$confirm" =~ ^[Yy]([Ee][Ss])?$ ]]; then
        echo -e "  ${YELLOW}Aborted.${NC}"
        exit 0
    fi
    echo ""
fi

# ── 1. Stop OpenClaw gateway ────────────────────────────────────────────

if [ "$SKIP_GATEWAY" != true ]; then
    echo -e "${BOLD}═══ 1. Stopping OpenClaw gateway ═══${NC}"
    if command -v openclaw &>/dev/null; then
        openclaw gateway stop 2>/dev/null || true
        echo -e "  ${GREEN}✓${NC} OpenClaw gateway stopped"
    else
        echo -e "  ${CYAN}OpenClaw not found, skip${NC}"
    fi
    echo ""
fi

# ── 2. Unregister orchestrator-plugin ───────────────────────────────────

echo -e "${BOLD}═══ 2. Unregistering orchestrator-plugin ═══${NC}"
if command -v openclaw &>/dev/null; then
    echo "y" | openclaw plugins uninstall orchestrator-plugin 2>/dev/null || true
    echo -e "  ${GREEN}✓${NC} orchestrator-plugin unregistered"
else
    echo -e "  ${CYAN}OpenClaw not found, skip${NC}"
fi
echo ""

# ── 3. Remove openry-worker agent from openclaw.json ─────────────────────

echo -e "${BOLD}═══ 3. Removing openry-worker agent ═══${NC}"
OCL_CONFIG="$HOME/.openclaw/openclaw.json"
if [ -f "$OCL_CONFIG" ]; then
    # Find a working Python
    PY=""
    for candidate in python3.12 python3.11 python3.10 python3.9 python3; do
        if command -v "$candidate" &>/dev/null; then PY="$candidate"; break; fi
    done
    if [ -n "$PY" ]; then
        $PY -c "
import json
with open('$OCL_CONFIG', 'r', encoding='utf-8') as f:
    c = json.load(f)
c['agents']['list'] = [a for a in c.get('agents', {}).get('list', []) if a.get('id') != 'openry-worker']
with open('$OCL_CONFIG', 'w', encoding='utf-8') as f:
    json.dump(c, f, indent=2, ensure_ascii=False)
" 2>/dev/null && echo -e "  ${GREEN}✓${NC} openry-worker agent removed from openclaw.json" || \
        echo -e "  ${YELLOW}⚠ Agent removal failed${NC}"
    else
        echo -e "  ${YELLOW}⚠ Python not found, cannot edit openclaw.json${NC}"
    fi
else
    echo -e "  ${CYAN}openclaw.json not found, skip${NC}"
fi
echo ""

# ── 4. Clean orchestrator-plugin artifacts ──────────────────────────────

echo -e "${BOLD}═══ 4. Cleaning orchestrator-plugin ═══${NC}"
if [ -d "$PLUGIN_DIR" ]; then
    for dir in node_modules dist; do
        if [ -d "$PLUGIN_DIR/$dir" ]; then
            rm -rf "$PLUGIN_DIR/$dir" 2>/dev/null && \
                echo -e "  ${GREEN}✓${NC} Removed $dir" || \
                echo -e "  ${YELLOW}⚠ Failed to remove $dir${NC}"
        fi
    done
    rm -f "$PLUGIN_DIR/package-lock.json" 2>/dev/null
    cd "$PLUGIN_DIR" && npm cache clean --force 2>/dev/null || true
    cd "$SCRIPT_DIR"
    echo -e "  ${GREEN}✓${NC} npm cache cleaned"
else
    echo -e "  ${CYAN}Plugin dir not found${NC}"
fi
echo ""

# ── 5. Uninstall openry CLI ─────────────────────────────────────────────

echo -e "${BOLD}═══ 5. Uninstalling openry CLI ═══${NC}"
PY=""
for candidate in python3.12 python3.11 python3.10 python3.9 python3; do
    if command -v "$candidate" &>/dev/null; then PY="$candidate"; break; fi
done
if [ -n "$PY" ]; then
    $PY -m pip uninstall openry -y 2>/dev/null && \
        echo -e "  ${GREEN}✓${NC} openry uninstalled" || \
        echo -e "  ${YELLOW}⚠ pip uninstall failed (may not be installed)${NC}"
else
    echo -e "  ${YELLOW}⚠ Python not found${NC}"
fi
echo ""

# ── 6. Remove .openry data ──────────────────────────────────────────────

REMOVE_DATA=false
if [ "$ALL" = true ] && [ "$KEEP_DATA" != true ]; then
    REMOVE_DATA=true
fi

if [ "$REMOVE_DATA" = true ]; then
    echo -e "${RED}${BOLD}═══ 6. Removing .openry (DB + workflows) ═══${NC}"

    # Kill any process holding openry.db lock before deletion
    pkill -f "openry" 2>/dev/null || true
    sleep 0.5
    echo -e "  ${GREEN}✓${NC} Stopped openry processes"

    if [ -d "$OPENRY_HOME" ]; then
        # Try individual DB file removal first (may be locked)
        for f in openry.db openry.db-wal openry.db-shm; do
            if [ -f "$OPENRY_HOME/$f" ]; then
                rm -f "$OPENRY_HOME/$f" 2>/dev/null && \
                    echo -e "  ${GREEN}✓${NC} Removed $f" || \
                    echo -e "  ${RED}✗ Cannot remove $f (still locked)${NC}"
            fi
        done
        # Then remove the rest of the directory
        rm -rf "$OPENRY_HOME" 2>/dev/null && \
            echo -e "  ${GREEN}✓${NC} Removed $OPENRY_HOME" || \
            echo -e "  ${RED}✗ Failed to remove directory${NC}"
    else
        echo -e "  ${CYAN}Not found${NC}"
    fi
else
    echo -e "${BOLD}═══ 6. .openry directory ═══${NC}"
    echo -e "  ${CYAN}Keeping (use --all to remove DB)${NC}"
fi
echo ""

# ── 7. Remove BGE-M3 model cache ────────────────────────────────────────

if [ "$ALL" = true ]; then
    echo -e "${RED}${BOLD}═══ 7. Removing AI model cache ═══${NC}"
    for cache_dir in "$HF_CACHE" "$TRANSFORMERS_CACHE"; do
        if [ -d "$cache_dir" ]; then
            rm -rf "$cache_dir" 2>/dev/null && \
                echo -e "  ${GREEN}✓${NC} Removed $cache_dir" || \
                echo -e "  ${RED}✗ Failed${NC}"
        else
            echo -e "  ${CYAN}$cache_dir not found${NC}"
        fi
    done
else
    echo -e "${BOLD}═══ 7. AI model cache ═══${NC}"
    echo -e "  ${CYAN}Keeping (use --all to remove)${NC}"
fi
echo ""

# ── 8. Clean environment variables ──────────────────────────────────────

echo -e "${BOLD}═══ 8. Cleaning environment variables ═══${NC}"
if [ "$KEEP_ENV" != true ]; then
    if [ -f "$SHELL_RC" ]; then
        # Remove OPENRY_HOME + PATH lines added by OpenRY installer
        if grep -q "# Added by OpenRY installer" "$SHELL_RC" 2>/dev/null; then
            # Create a temp file without the OpenRY block
            sed -i '' '/# Added by OpenRY installer/,+2d' "$SHELL_RC" 2>/dev/null || \
            sed -i '/# Added by OpenRY installer/,+2d' "$SHELL_RC" 2>/dev/null || true
            echo -e "  ${GREEN}✓${NC} OpenRY entries removed from $SHELL_RC"
        else
            echo -e "  ${CYAN}No OpenRY entries found in $SHELL_RC${NC}"
        fi
    else
        echo -e "  ${CYAN}$SHELL_RC not found${NC}"
    fi
else
    echo -e "  ${CYAN}Keeping (--keep-env)${NC}"
fi
echo ""

# ── 9. Verify ───────────────────────────────────────────────────────────

echo -e "${BOLD}═══ 9. Verification ═══${NC}"
REMAINING=()
if command -v openry &>/dev/null; then REMAINING+=("openry CLI still on PATH"); fi
if [ -d "$OPENRY_HOME" ]; then REMAINING+=(".openry: $OPENRY_HOME"); fi
if [ -d "$PLUGIN_DIR/node_modules" ]; then REMAINING+=("node_modules: $PLUGIN_DIR/node_modules"); fi
if grep -q "OPENRY_HOME" "$SHELL_RC" 2>/dev/null; then REMAINING+=("OPENRY_HOME in $SHELL_RC"); fi

if [ ${#REMAINING[@]} -gt 0 ]; then
    echo -e "  ${YELLOW}⚠ Some items remain:${NC}"
    for item in "${REMAINING[@]}"; do
        echo -e "    - $item"
    done
else
    echo -e "  ${GREEN}✓${NC} All clean"
fi
echo ""

echo -e "${YELLOW}${BOLD}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${YELLOW}${BOLD}║  OpenRY uninstall complete.                      ║${NC}"
echo -e "${YELLOW}${BOLD}║  Run install.sh to reinstall.                    ║${NC}"
echo -e "${YELLOW}${BOLD}╚══════════════════════════════════════════════════╝${NC}"
echo ""
