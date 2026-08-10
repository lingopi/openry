#!/usr/bin/env bash
# ============================================================================
# OpenRY — Uninstaller (macOS / Linux)
# ============================================================================
# Usage:
#   bash uninstall.sh                    # Keep data, interactive
#   bash uninstall.sh --full --force     # Remove everything
#
# This is a thin wrapper around 'openry uninstall'.
# Run 'openry uninstall --help' for all options.
# ============================================================================
set -eu

FULL=""
FORCE=""
KEEP_DATA=""
KEEP_ENV=""
WITH_OC=""

for arg in "$@"; do
    case "$arg" in
        --force|-f)      FORCE="--force" ;;
        --all|-a|--full) WITH_OC="--with-openclaw" ;;
        --keep-data)     KEEP_DATA="--keep-data" ;;
        --keep-env)      KEEP_ENV="--keep-env" ;;
        --skip-gateway)  ;;  # no-op: gateway handled by CLI now
        --help|-h)
            echo "Usage: bash uninstall.sh [--full] [--force] [--keep-data] [--keep-env]"
            echo ""
            echo "Thin wrapper around 'openry uninstall'."
            echo "Run 'openry uninstall --help' for all options."
            exit 0
            ;;
    esac
done

if ! command -v openry &>/dev/null; then
    echo "openry CLI not found. Already uninstalled?"
    echo "To manually clean up: rm -rf ~/.openry/"
    exit 0
fi

openry uninstall $WITH_OC $FORCE $KEEP_DATA $KEEP_ENV
