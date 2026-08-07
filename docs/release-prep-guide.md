# OpenRY 发布资源准备指南

> 在有国际网络访问的电脑上执行以下操作。  
> 工作目录：假设已 `git clone https://github.com/lingopi/openry.git` 到本地。

---

## 前置条件

- macOS（制作 macOS bundle）或 Windows（制作 Windows bundle）
- Node.js 18+
- Git LFS（`git lfs install`）
- GitHub CLI（`brew install gh` 或 `winget install GitHub.cli`）
- 磁盘空间 ~5 GB

---

## Step 1：准备 BGE-M3 模型包

```bash
cd /path/to/openry
mkdir -p release-assets
cd release-assets

# 1.1 从 HuggingFace 下载模型（会自动走 CDN，海外很快）
pip install huggingface_hub
python3 -c "
from huggingface_hub import snapshot_download
snapshot_download('Xenova/bge-m3', local_dir='./bge-m3-model', local_dir_use_symlinks=False)
"

# 1.2 创建安装脚本
cat > install-bge-m3.sh << 'EOF'
#!/usr/bin/env bash
set -euo pipefail
PLUGIN_DIR="${1:-.}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CACHE_DIR="$PLUGIN_DIR/node_modules/@xenova/transformers/.cache"
echo "安装 bge-m3 模型到: $CACHE_DIR"
mkdir -p "$CACHE_DIR"
cp -R "$SCRIPT_DIR/bge-m3-model" "$CACHE_DIR/Xenova/bge-m3"
echo ""
echo " ✓ bge-m3 模型已安装！"
EOF
chmod +x install-bge-m3.sh

# 1.3 创建 Windows 安装脚本
cat > install-bge-m3.ps1 << 'EOF'
param($PluginDir = ".")
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$CacheDir = Join-Path $PluginDir "node_modules\@xenova\transformers\.cache"
Write-Host "安装 bge-m3 模型到: $CacheDir"
New-Item -ItemType Directory -Force -Path "$CacheDir\Xenova" | Out-Null
Copy-Item -Recurse -Force (Join-Path $ScriptDir "bge-m3-model") "$CacheDir\Xenova\bge-m3"
Write-Host " ✓ bge-m3 模型已安装！" -ForegroundColor Green
EOF

# 1.4 打包
tar -czf openry-bge-m3-v1.0.tar.gz bge-m3-model install-bge-m3.sh install-bge-m3.ps1
echo "BGE 模型包创建完成: $(ls -lh openry-bge-m3-v1.0.tar.gz)"
```

**产物**：`release-assets/openry-bge-m3-v1.0.tar.gz`（~415 MB）

---

## Step 2：准备 macOS ARM Plugin Bundle

> 在 **macOS Apple Silicon** 上执行

```bash
cd /path/to/openry/orchestrator-plugin

# 2.1 完整安装（海外网络快，不需要 --ignore-scripts）
rm -rf node_modules dist
npm install

# 2.2 编译 TypeScript
npm run build

# 2.3 打包（node_modules 含 libvips 和所有原生二进制）
cd ..
tar -czf release-assets/openry-plugin-darwin-arm64.tar.gz \
    -C orchestrator-plugin node_modules dist

echo "macOS ARM bundle: $(ls -lh release-assets/openry-plugin-darwin-arm64.tar.gz)"
```

**产物**：`release-assets/openry-plugin-darwin-arm64.tar.gz`（~600 MB）

---

## Step 3：准备 macOS Intel Plugin Bundle

> 在 **macOS Intel** 上执行（如果没有 Intel Mac，可跳过，后续再补）

```bash
cd /path/to/openry/orchestrator-plugin
rm -rf node_modules dist
npm install
npm run build
cd ..
tar -czf release-assets/openry-plugin-darwin-x64.tar.gz \
    -C orchestrator-plugin node_modules dist
```

**产物**：`release-assets/openry-plugin-darwin-x64.tar.gz`

---

## Step 4：准备 Windows x64 Plugin Bundle

> 在 **Windows** 上执行（PowerShell 7+）

```powershell
cd C:\path\to\openry\orchestrator-plugin

# 4.1 完整安装
Remove-Item -Recurse -Force node_modules, dist -ErrorAction SilentlyContinue
npm install

# 4.2 编译
npm run build

# 4.3 打包
cd ..
tar -czf release-assets\openry-plugin-win32-x64.tar.gz `
    -C orchestrator-plugin node_modules dist

Write-Host "Windows bundle: $(ls release-assets\openry-plugin-win32-x64.tar.gz)"
```

**产物**：`release-assets\openry-plugin-win32-x64.tar.gz`（~130 MB）

---

## Step 5：上传到 GitHub Release

```bash
cd /path/to/openry

# 确认文件
ls -lh release-assets/

# 创建 Release 并上传
gh release create v1.0.0 \
    --title "OpenRY v1.0.0" \
    --notes "首次发布。包含 BGE-M3 模型和各平台 Plugin 预编译包。" \
    release-assets/openry-bge-m3-v1.0.tar.gz \
    release-assets/openry-plugin-darwin-arm64.tar.gz \
    release-assets/openry-plugin-win32-x64.tar.gz
    # 如果有 Intel Mac 的包也加上：
    # release-assets/openry-plugin-darwin-x64.tar.gz
```

上传完成后，确认各文件可通过以下 URL 访问（经镜像代理）：
```
https://ghfast.top/https://github.com/lingopi/openry/releases/download/v1.0.0/openry-bge-m3-v1.0.tar.gz
https://ghfast.top/https://github.com/lingopi/openry/releases/download/v1.0.0/openry-plugin-darwin-arm64.tar.gz
https://ghfast.top/https://github.com/lingopi/openry/releases/download/v1.0.0/openry-plugin-win32-x64.tar.gz
```

---

## Step 6：更新 install.sh / install.ps1 中的版本号

上传完成后，回到 Mac 上更新安装脚本中的版本号，确保指向正确的 Release tag：

```bash
# install.sh 中
BUNDLE_VERSION="v1.0.0"       # 原来是 plugin-bundle-v1.0
BGE_VER="v1.0.0"               # 原来是 bge-m3-v1.0

# install.ps1 中
$bundleVersion = "v1.0.0"
$bgeVersion = "v1.0.0"
```

同时更新下载 URL 中的 Release tag 部分。

---

## 最终 GitHub Release 文件清单

| 文件 | 平台 | 大小 |
|------|------|------|
| `openry-bge-m3-v1.0.tar.gz` | 跨平台 | ~415 MB |
| `openry-plugin-darwin-arm64.tar.gz` | macOS ARM | ~600 MB |
| `openry-plugin-darwin-x64.tar.gz` | macOS Intel | ~600 MB |
| `openry-plugin-win32-x64.tar.gz` | Windows x64 | ~130 MB |
