#!/usr/bin/env bash
# ============================================================================
# OpenRY 离线打包脚本
# 将当前已安装的全部组件打包为单个 .tar.gz
# 目标平台: macOS ARM64 (Apple Silicon)
# ============================================================================
set -euo pipefail

BUNDLE_DIR="/Users/yifan/Desktop/OpenRY-bundle"
TAR_OUTPUT="/Users/yifan/Desktop/openry-offline-bundle.tar.gz"
PROJECT_DIR="/Users/yifan/Desktop/OpenRY"
GLOBAL_OPENCLAW="/usr/local/lib/node_modules/openclaw"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

echo "============================================"
echo " OpenRY 离线打包"
echo " 时间: $TIMESTAMP"
echo "============================================"
echo ""

# 清理旧目录
rm -rf "$BUNDLE_DIR"
mkdir -p "$BUNDLE_DIR"

# ── 1. 复制项目本体（不含 .git） ──
echo "[1/5] 复制项目源码 + plugin node_modules（含 bge-m3 模型）..."
cd "$PROJECT_DIR"
tar czf "$BUNDLE_DIR/openry-project.tar.gz" \
    --exclude='.git' \
    --exclude='__pycache__' \
    --exclude='*.pyc' \
    --exclude='.DS_Store' \
    --exclude='openry.egg-info' \
    --exclude='orchestrator-plugin/dist' \
    .

echo "  项目包大小: $(du -sh "$BUNDLE_DIR/openry-project.tar.gz" | cut -f1)"

# ── 2. 复制 openclaw 全局安装 ──
echo "[2/5] 打包 openclaw 全局安装 ($GLOBAL_OPENCLAW)..."
cd /usr/local/lib/node_modules
tar czf "$BUNDLE_DIR/openclaw-global.tar.gz" openclaw
echo "  openclaw 包大小: $(du -sh "$BUNDLE_DIR/openclaw-global.tar.gz" | cut -f1)"

# ── 3. 收集 Python site-packages ──
echo "[3/5] 打包 Python pyyaml..."
SITE_PACKAGES=$(python3 -c "import site; print(site.getsitepackages()[0])" 2>/dev/null)
if [ -d "$SITE_PACKAGES" ]; then
    cd "$SITE_PACKAGES"
    tar czf "$BUNDLE_DIR/python-site-packages.tar.gz" \
        _yaml \
        yaml \
        yaml-* 2>/dev/null || true
    echo "  Python 包大小: $(du -sh "$BUNDLE_DIR/python-site-packages.tar.gz" | cut -f1)"
fi

# ── 4. 创建安装脚本 ──
echo "[4/5] 生成安装脚本..."
cat > "$BUNDLE_DIR/install-offline.sh" << 'INSTALL'
#!/usr/bin/env bash
# ============================================================================
# OpenRY 离线安装脚本
# 用法: bash install-offline.sh [目标目录, 默认 ~/Desktop/OpenRY]
# ============================================================================
set -euo pipefail

TARGET="${1:-$HOME/Desktop/OpenRY}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "============================================"
echo " OpenRY 离线安装"
echo " 目标: $TARGET"
echo "============================================"
echo ""

# ── 1. 解压项目 ──
echo "[1/4] 解压项目文件..."
mkdir -p "$TARGET"
tar xzf "$SCRIPT_DIR/openry-project.tar.gz" -C "$TARGET"
echo "  ✓ 项目已解压到 $TARGET"

# ── 2. 解压 openclaw 到全局 ──
echo "[2/4] 安装 openclaw 全局..."
mkdir -p /usr/local/lib/node_modules
tar xzf "$SCRIPT_DIR/openclaw-global.tar.gz" -C /usr/local/lib/node_modules

# 创建 openclaw CLI 链接
OPENCLAW_BIN="/usr/local/lib/node_modules/openclaw/dist/index.js"
if [ -f "$OPENCLAW_BIN" ]; then
    mkdir -p /usr/local/bin
    cat > /usr/local/bin/openclaw << 'WRAP'
#!/usr/bin/env bash
exec node /usr/local/lib/node_modules/openclaw/dist/index.js "$@"
WRAP
    chmod +x /usr/local/bin/openclaw
    echo "  ✓ openclaw CLI 已安装"
else
    echo "  ⚠ openclaw entry 未找到: $OPENCLAW_BIN"
fi

# ── 3. 安装 Python 依赖 ──
echo "[3/4] 安装 Python 依赖..."
SITE_PACKAGES=$(python3 -c "import site; print(site.getsitepackages()[0])" 2>/dev/null || echo "")
if [ -n "$SITE_PACKAGES" ] && [ -f "$SCRIPT_DIR/python-site-packages.tar.gz" ]; then
    tar xzf "$SCRIPT_DIR/python-site-packages.tar.gz" -C "$SITE_PACKAGES"
    echo "  ✓ pyyaml 已安装"
fi

# 安装 openry CLI
cd "$TARGET"
python3 -m pip install --user -e . --quiet 2>/dev/null || {
    # fallback: wrapper
    mkdir -p "$HOME/.local/bin"
    cat > "$HOME/.local/bin/openry" << 'WRAP2'
#!/usr/bin/env bash
OPENRY_HOME="${OPENRY_HOME:-$HOME/.openry}"
OPENRY_DIR="TARGET_PLACEHOLDER"
PYTHONPATH="$OPENRY_DIR:$PYTHONPATH" exec python3 -m openry "$@"
WRAP2
    # 替换占位符
    if command -v gsed &>/dev/null; then
        gsed -i "s|TARGET_PLACEHOLDER|$TARGET|g" "$HOME/.local/bin/openry"
    else
        sed -i '' "s|TARGET_PLACEHOLDER|$TARGET|g" "$HOME/.local/bin/openry"
    fi
    chmod +x "$HOME/.local/bin/openry"
}
echo "  ✓ openry CLI 已安装"

# ── 4. 初始化 .openry ──
echo "[4/4] 初始化 .openry..."
OPENRY_HOME="${OPENRY_HOME:-$HOME/.openry}"
mkdir -p "$OPENRY_HOME/workflows"
mkdir -p "$OPENRY_HOME/compositions"
mkdir -p "$OPENRY_HOME/prompts"
mkdir -p "$OPENRY_HOME/prompt_blocks"

# 复制示例文件
if [ -d "$TARGET/example/workflows" ]; then
    cp -n "$TARGET/example/workflows/"*.yaml "$OPENRY_HOME/workflows/" 2>/dev/null || true
fi
if [ -d "$TARGET/example/compositions" ]; then
    cp -n "$TARGET/example/compositions/"*.yaml "$OPENRY_HOME/compositions/" 2>/dev/null || true
fi
if [ -d "$TARGET/prompts" ]; then
    cp -n "$TARGET/prompts/"*.md "$OPENRY_HOME/prompts/" 2>/dev/null || true
fi

echo ""
echo "============================================"
echo " ✓ 安装完成！"
echo "============================================"
echo ""
echo "  项目目录: $TARGET"
echo "  openclaw: $(which openclaw 2>/dev/null || echo '/usr/local/bin/openclaw')"
echo "  openry:   $(which openry 2>/dev/null || echo '$HOME/.local/bin/openry')"
echo ""
echo "  验证安装:"
echo "    openclaw --version"
echo "    openry -c 'echo hello'"
echo "    openclaw plugins list"
echo ""
echo "  启动 Gateway:"
echo "    openclaw gateway --port 18789"
echo ""
INSTALL
chmod +x "$BUNDLE_DIR/install-offline.sh"

# ── 5. 打包总包 ──
echo "[5/5] 创建最终离线包..."
cd "$BUNDLE_DIR/.."
tar czf "$TAR_OUTPUT" "OpenRY-bundle"

# 清理临时目录
rm -rf "$BUNDLE_DIR"

echo ""
echo "============================================"
echo " ✓ 离线包已生成！"
echo "============================================"
echo ""
echo "  文件: $TAR_OUTPUT"
echo "  大小: $(du -sh "$TAR_OUTPUT" | cut -f1)"
echo ""
echo "  使用方式（在目标机器上）:"
echo "    tar xzf openry-offline-bundle.tar.gz"
echo "    cd OpenRY-bundle"
echo "    bash install-offline.sh"
echo ""
