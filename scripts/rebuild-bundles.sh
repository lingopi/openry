#!/usr/bin/env bash
# Rebuild orchestrator-plugin bundles without BGE-M3 model and non-platform binaries
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPS_DIR="$SCRIPT_DIR/../deps"
TMPDIR="$(mktemp -d)"

cleanup() { rm -rf "$TMPDIR"; }
trap cleanup EXIT

for platform in macos windows; do
    BUNDLE="$DEPS_DIR/$platform/orchestrator-plugin-bundle.tar.gz"
    if [ ! -f "$BUNDLE" ]; then
        echo "SKIP $platform: bundle not found"
        continue
    fi

    echo "=== Rebuilding $platform bundle ==="
    WORKDIR="$TMPDIR/$platform"
    mkdir -p "$WORKDIR"
    cd "$WORKDIR"

    # Extract
    tar xzf "$BUNDLE"
    echo "  Extracted: $(find . -type f | wc -l | tr -d ' ') files"

    # Remove BGE-M3 model cache (543 MB)
    if [ -d "node_modules/@xenova/transformers/.cache" ]; then
        rm -rf "node_modules/@xenova/transformers/.cache"
        echo "  ✓ Removed BGE-M3 model cache"
    fi

    # Remove non-platform binaries from onnxruntime-node
    case "$platform" in
        macos)
            # Keep only darwin
            for dir in node_modules/onnxruntime-node/bin/napi-v3/*/; do
                dirname=$(basename "$dir")
                if [ "$dirname" != "darwin" ]; then
                    rm -rf "$dir"
                    echo "  ✓ Removed onnxruntime: $dirname"
                fi
            done
            ;;
        windows)
            # Keep only win32
            for dir in node_modules/onnxruntime-node/bin/napi-v3/*/; do
                dirname=$(basename "$dir")
                if [ "$dirname" != "win32" ]; then
                    rm -rf "$dir"
                    echo "  ✓ Removed onnxruntime: $dirname"
                fi
            done
            ;;
    esac

    # Remove non-platform sharp vendor libs
    if [ -d "node_modules/sharp/vendor" ]; then
        for vdir in node_modules/sharp/vendor/*/; do
            vname=$(basename "$vdir")
            case "$platform" in
                macos)  [[ "$vname" != darwin* ]] && rm -rf "$vdir" && echo "  ✓ Removed sharp vendor: $vname" || true ;;
                windows) [[ "$vname" != win32* ]] && rm -rf "$vdir" && echo "  ✓ Removed sharp vendor: $vname" || true ;;
            esac
        done
    fi

    # Repack (include node_modules + dist)
    echo "  Repacking..."
    tar czf "$BUNDLE" node_modules dist 2>/dev/null

    SIZE=$(ls -lh "$BUNDLE" | awk '{print $5}')
    FILES=$(find . -type f | wc -l | tr -d ' ')
    echo "  Done: $SIZE, $FILES files"
    echo ""
done

echo "All bundles rebuilt."
