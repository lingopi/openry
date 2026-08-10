#!/usr/bin/env bash
# ============================================================================
# OpenRY — Bootstrap Installer (macOS / Linux)
# ============================================================================
# Download the repo and run the full installer in one line:
#
#   curl -fsSL https://raw.githubusercontent.com/lingopi/openry/main/bootstrap.sh | bash
#
# Options are forwarded to scripts/install.sh:
#   curl ... | bash -s -- --skip-plugin --skip-python
# ============================================================================
set -eu

echo ""
echo "  Downloading OpenRY..."
d=$(mktemp -d)
curl -fsSL https://github.com/lingopi/openry/archive/refs/heads/main.tar.gz | tar xz -C "$d"
cd "$d/openry-main"

bash scripts/install.sh "$@"
ret=$?

rm -rf "$d"
exit $ret
