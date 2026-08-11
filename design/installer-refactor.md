# Installer Refactor Design

> 状态：macOS ✅ 完成并测试 | Windows ✅ 完成并测试（2026-08-11）
> 测试：install → uninstall → reinstall → tools sync 四轮全通过（双平台）
> Windows 额外修复：8 个 Bug（见第十一节）

---

## 一、背景与目标

当前 `scripts/install.sh` 和 `scripts/install.ps1` 存在以下问题：

1. **安装源单一**：只从本地 `deps/` 读取 tar 包，找不到直接报错退出，无网络 fallback。
2. **"已安装"检测逻辑脆弱**：
   - Plugin：仅检查 `node_modules/` 和 `dist/index.js` 是否存在——目录存在不代表完整，半途失败的残留会导致误判。
   - BGE-M3：仅检查缓存目录是否存在——不验证内部文件完整性。
3. **无干净重装能力**：首次安装失败后的残留物（损坏的 node_modules、半截 dist、egg-info 残留）会阻塞后续安装。
4. **uninstall 覆盖不全**：`cmd_uninstall` 遗漏了 plugin 目录（仓库内）和 `openry.egg-info/` 的清理。

**目标**：改造安装脚本，实现可靠的"先清理、再安装"流程，并建立三级 fallback 下载源。

---

## 二、安装源优先级策略

### 2.1 三个 tar 包

| 包 | 本地路径 | GitHub Release Tag | GitHub Release URL | 大小 |
|---|---|---|---|---|
| Plugin bundle (macOS) | `deps/macos/orchestrator-plugin-bundle-macos.tar.gz` | `plugin-bundle-v1.0` | `https://github.com/lingopi/openry/releases/download/plugin-bundle-v1.0/orchestrator-plugin-bundle-macos.tar.gz` | 186 MB |
| Plugin bundle (Windows) | `deps/windows/orchestrator-plugin-bundle-win.tar.gz` | `plugin-bundle-v1.0` | `https://github.com/lingopi/openry/releases/download/plugin-bundle-v1.0/orchestrator-plugin-bundle-win.tar.gz` | 174 MB |
| BGE-M3 模型 | `deps/common/bge-m3-offline.tar.gz` | `bge-m3-v1.0` | `https://github.com/lingopi/openry/releases/download/bge-m3-v1.0/bge-m3-offline.tar.gz` | 416 MB |

> **核实确认**：以上 Release 和 tag 已于 2026-08-11 在 `lingopi/openry` 仓库验证存在，均包含 sha256 checksum。

### 2.2 优先级链

```
Priority 1: 本地 deps/ 文件
  → 来源：GitCode clone（deps/ 随仓库一起 pull，无需 LFS）
  → 无需网络，速度最快

Priority 2: GitHub Releases 下载
  → 来源：lingopi/openry Releases
  → 需要网络，下载后缓存回 deps/ 目录（下次命中 Priority 1）
  → 支持 curl 断点续传（-C -）
  → 下载后做 sha256 校验，防止文件损坏
  → 超时策略：curl --connect-timeout 10 --speed-limit 102400 --speed-time 15
  → connect-timeout：10 秒 TCP 连不上就放弃
  → speed-limit：持续 15 秒低于 100 KB/s 自动断开（防止国内 GitHub 慢速下载卡死）
  → 实测：HEAD 请求 4.26s，国内下载速度取决于带宽

Priority 3: GitCode sparse clone 拉取 deps/
  → 来源：https://gitcode.com/yifan850902/openry.git
  → 方式：git clone --depth 1 --no-checkout → git sparse-checkout set deps/ → git checkout
  → 只拉 deps/ 目录，不全量 clone 仓库
  → 需要网络，需要 git
  → 实测：38.9s，790MB，21 MB/s（国内 CDN）
  → 拉取后缓存到本地 deps/（下次命中 Priority 1）

### 2.3 下载函数 + sha256 校验

GitHub Releases 提供的 sha256 checksum：

| Asset | SHA256 |
|---|---|
| `orchestrator-plugin-bundle-macos.tar.gz` | `632da2069a8ad8df66f5046778e3c134e01c6f60151d616f0074cc3d06b82774` |
| `orchestrator-plugin-bundle-win.tar.gz` | `8c0373bd38bdd8af96cb5e8f76d4116a770e08eabbff27a528b24e656fa03ddd` |
| `bge-m3-offline.tar.gz` | `c489b6e468a6a3b50e37485f572751dcc0c0caf08e43e6e524b2c2a5f73aed6c` |

```bash
# 通用资产获取函数（伪代码）
# 三级 fallback: 本地 deps/ → GitHub Releases → GitCode clone
resolve_asset() {
  local asset_name="$1"        # e.g. "orchestrator-plugin-bundle-macos.tar.gz"
  local local_path="$2"        # e.g. "$SCRIPT_DIR/deps/macos/$asset_name"
  local release_tag="$3"       # e.g. "plugin-bundle-v1.0"
  local expected_sha256="$4"   # e.g. "632da20..."
  local remote_url="https://github.com/lingopi/openry/releases/download/$release_tag/$asset_name"
  local gitcode_url="https://gitcode.com/yifan850902/openry.git"

  # Step 1: Check local (with sha256 verification)
  if [ -f "$local_path" ]; then
    local actual_sha256
    actual_sha256=$(sha256_hash "$local_path" 2>/dev/null) || true
    if [ "$actual_sha256" = "$expected_sha256" ]; then
      echo "$local_path"
      return 0
    else
      echo "  ⚠ Local file corrupt (sha256 mismatch), re-downloading..."
      rm -f "$local_path"
    fi
  fi

  # Step 2: Download from GitHub Releases
  echo "  Downloading $asset_name from GitHub Releases..."
  mkdir -p "$(dirname "$local_path")"
  # --connect-timeout 10: TCP 连不上就放弃
  # --speed-limit 102400 --speed-time 15: 持续 15s 低于 100KB/s 自动断开（跳 GitCode）
  if curl -fSL --connect-timeout 10 --speed-limit 102400 --speed-time 15 --progress-bar -C - -o "$local_path.tmp" "$remote_url"; then
    actual=$(sha256_hash "$local_path.tmp" 2>/dev/null) || true
    if [ "$actual" = "$expected_sha256" ]; then
      mv "$local_path.tmp" "$local_path"
      echo "  ✓ sha256 verified, cached to $(dirname "$local_path")/"
      echo "$local_path"
      return 0
    fi
    echo "  ✗ sha256 mismatch after download"
    rm -f "$local_path.tmp"
  fi
  echo "  GitHub Releases failed, trying GitCode..."

  # Step 3: GitCode sparse clone (only deps/ directory)
  local tmp_clone="/tmp/openry-deps-$$"
  rm -rf "$tmp_clone" 2>/dev/null
  local gitcode_ok=false
  if git clone --depth 1 --filter=blob:none "$gitcode_url" "$tmp_clone" 2>/dev/null; then
    ( cd "$tmp_clone" && git sparse-checkout set deps/ 2>/dev/null ) || true
    if [ -d "$tmp_clone/deps" ]; then
      cp -r "$tmp_clone/deps/"* "$(dirname "$(dirname "$local_path")")/"
      echo "  ✓ deps/ fetched from GitCode"
      gitcode_ok=true
    fi
  fi
  rm -rf "$tmp_clone" 2>/dev/null
  if [ "$gitcode_ok" = true ] && [ -f "$local_path" ]; then
    actual=$(sha256_hash "$local_path" 2>/dev/null) || true
    if [ "$actual" = "$expected_sha256" ]; then
      echo "  ✓ sha256 verified"
      echo "$local_path"
      return 0
    fi
  fi
  return 1
}
```

> **注意**：Windows PowerShell 使用 `Get-FileHash -Algorithm SHA256` 替代 `sha256sum`。

---

## 三、清理策略（先卸后装）

### 3.1 总原则

| 组件 | 清理策略 | 理由 |
|---|---|---|
| Plugin (`node_modules` + `dist`) | **每次都先删再装** | 本地 tar 解压只需几秒，清理成本极低；node_modules 涉及 native 模块，残留风险高 |
| BGE-M3 模型缓存 | **文件级完整性校验**，完整则 skip | 416 MB 解压需 10-30 秒，模型文件是静态的不存在"半损坏"；但必须验证关键文件而非仅检查目录 |
| pip install | **先 `pip uninstall` 再 `pip install`** | 清理 egg-info 残留，避免旧元数据干扰 |
| `--force` 模式 | **全部推倒**（含 BGE-M3 缓存 + OpenClaw 注册 + pip 包） | 提供终极重置能力 |

### 3.2 清理清单

#### 默认安装时（无 `--force`）

| 清理项 | 路径 | 操作 |
|---|---|---|
| Plugin node_modules | `$SCRIPT_DIR/orchestrator-plugin/node_modules/` | `rm -rf` |
| Plugin dist | `$SCRIPT_DIR/orchestrator-plugin/dist/` | `rm -rf` |
| openry pip 包 | — | `pip uninstall openry -y` |  `true` |
| openry.egg-info | `$SCRIPT_DIR/openry.egg-info/` | `rm -rf` |
| Wrapper 脚本 | `~/.local/bin/openry` | `rm -f` |
| Shell RC 配置 | `~/.zshrc` / `~/.bashrc` 中的旧条目 | 清理重复/过期条目 |
| ~/.openry DB | `~/.openry/openry.db*` | `rm -f` |
| BGE-M3 缓存 | `$SCRIPT_DIR/orchestrator-plugin/node_modules/@xenova/transformers/.cache/Xenova/bge-m3/` | 文件级校验后决定 |

#### `--force` 额外清理

| 清理项 | 操作 |
|---|---|
| BGE-M3 缓存 | 无条件 `rm -rf` |
| OpenClaw plugin 注册 | `openclaw plugins uninstall orchestrator-plugin` |
| OpenClaw agent | 从 `~/.openclaw/openclaw.json` 中移除 `openry-worker` |
| OpenClaw gateway | `openclaw gateway stop` |
| Xenova BGE-M3 缓存 | `rm -rf orchestrator-plugin/node_modules/@xenova/transformers/.cache/` |

> **注意**：`~/.cache/huggingface` 和 `~/.cache/transformers` 是 Python 生态的模型缓存（HuggingFace transformers / sentence-transformers 等库使用），OpenRY 插件完全不依赖它们。清理这些目录既不影响安装重试，还可能破坏本机其他 Python 项目的缓存。**不纳入清理范围。**

### 3.3 BGE-M3 完整性校验

不再只检查目录是否存在，改为检查以下 **关键文件** 是否全部存在：

```
$BGE_CACHE_DIR/
├── config.json
├── tokenizer.json
├── tokenizer_config.json
└── onnx/
    └── model_quantized.onnx  ← 最关键，决定模型能否加载
```

检测逻辑：
```bash
bge_is_complete() {
  local dir="$1"
  local required_files=(
    "config.json"
    "tokenizer.json"
    "tokenizer_config.json"
    "onnx/model_quantized.onnx"
  )
  for f in "${required_files[@]}"; do
    [ -f "$dir/$f" ] || return 1
  done
  return 0
}
```

---

## 四、uninstall 盲区补充

当前 `openry uninstall` (`cmd_uninstall` in `openry/cli.py`) 存在以下盲区需补充：

| 盲区 | 当前状态 | 补充方案 |
|---|---|---|
| `orchestrator-plugin/node_modules/` | ❌ 未清理 | 在 `--with-openclaw` 模式下增加清理 |
| `orchestrator-plugin/dist/` | ❌ 未清理 | 同上 |
| `openry.egg-info/` | ❌ 未清理 | 在默认模式下增加清理 |
| Xenova BGE-M3 缓存 | ❌ 未清理（清理的是错误的 Python 生态路径） | 增加正确路径：`orchestrator-plugin/node_modules/@xenova/transformers/.cache/` |
| `~/.cache/huggingface` / `~/.cache/transformers` | ✅ 当前误清理 | **移除清理**——这些是 Python 生态缓存，不与 OpenRY 相关，误删可能影响本机其他项目 |

### 4.1 BGE-M3 缓存路径对照

| 缓存位置 | 使用者 | install 写入 | uninstall 当前行为 | 修复 |
|---|---|---|---|---|
| `orchestrator-plugin/node_modules/@xenova/transformers/.cache/Xenova/bge-m3` | Node.js Xenova（插件实际使用） | ✅ | ❌ 未清理 | **补充清理** |
| `~/.cache/huggingface/` | Python HuggingFace（本机其他项目，OpenRY 不依赖） | ❌ 不写入 | ✅（误删） | **移除清理**——不影响 OpenRY 安装，误删有害 |
| `~/.cache/transformers/` | Python Transformers（本机其他项目，OpenRY 不依赖） | ❌ 不写入 | ✅（误删） | **同上，移除清理** |

---

## 五、新增 CLI 参数设计

### 5.1 install.sh 新增参数

```
Usage: bash install.sh [OPTIONS]

  --skip-python        Skip Python detection and pip install
  --skip-plugin        Skip orchestrator-plugin installation
  --force              Clean everything before install (including BGE-M3 cache)
  --bge-source=SRC     BGE-M3 source: local|github|modelscope (default: auto)
  --help, -h           Show this help
```

### 5.2 install.ps1 新增参数

```
param(
    [switch]$SkipPwsh,
    [switch]$SkipPython,
    [switch]$SkipPlugin,
    [switch]$Force,
    [string]$BgeSource = "auto"
)
```

---

## 六、安装流程重组

### 6.1 整体流程（install.sh）

```
install.sh
│
├─ [0] 解析参数（--force, --skip-*, --bge-source）
│
├─ [1] 如果 --force → 执行 uninstall 流程
│      ├─ pip uninstall openry -y
│      ├─ rm -rf openry.egg-info/
│      ├─ rm -rf orchestrator-plugin/node_modules/
│      ├─ rm -rf orchestrator-plugin/dist/
│      ├─ rm -rf orchestrator-plugin/node_modules/@xenova/transformers/.cache/
│      ├─ openclaw plugins uninstall orchestrator-plugin (if exists)
│      └─ openclaw gateway stop (if running)
│
├─ [2] OS 检测
│
├─ [3] Python 检测 & pip install openry
│      ├─ pip uninstall openry -y    ← 先卸
│      ├─ rm -rf openry.egg-info/     ← 清理残留
│      └─ pip install --user -e .     ← 再装
│
├─ [4] 初始化 ~/.openry/（首次安装保护）
│      ├─ 如果 ~/.openry/workflows/ 不存在 → cp -r seed/* ~/.openry/
│      ├─ 如果已存在 → 跳过复制，保留用户数据
│      └─ rm -f ~/.openry/openry.db*
│
├─ [5] 验证 openry 可用
│
├─ [6] Plugin 安装（--skip-plugin 则跳过）
│      ├─ 检查 openclaw / node / npm 可用性
│      ├─ rm -rf orchestrator-plugin/node_modules/   ← 总是先清
│      ├─ rm -rf orchestrator-plugin/dist/           ← 总是先清
│      ├─ resolve_asset → 本地 deps/ 或 GitHub Release
│      ├─ tar -xzf → 解压
│      ├─ 验证 dist/index.js 存在
│      ├─ 读 seed/tools.yaml → 获取工具列表
│      ├─ 用 tools.yaml 覆盖 openclaw.plugin.json contracts.tools  ← 确保一致
│      ├─ openclaw plugins install "$PLUGIN_DIR" --link
│      ├─ openclaw agents add openry-worker
│      └─ 用 tools.yaml 配置 agent alsoAllow（替换硬编码列表）
│
├─ [7] BGE-M3 安装
│      ├─ bge_is_complete? → skip
│      ├─ resolve_asset → 本地 deps/ 或 GitHub Release（或 ModelScope）
│      ├─ tar -xzf → 解压到 Xenova 缓存目录
│      └─ bge_is_complete? → 验证
│
└─ [8] 完成提示
```

### 6.2 关键改进点对照

| 旧逻辑 | 新逻辑 |
|---|---|
| `[ -d node_modules ] && [ -f dist/index.js ]` → skip | **总是** `rm -rf node_modules dist` → 解压 → 验证 |
| `[ -d "$BGE_CACHE_DIR" ]` → skip | **文件级校验**（4 个关键文件）→ 决定 skip 或重装 |
| `pip install -e .` 直接装 | 先 `pip uninstall -y` → 清理 egg-info → 再 `pip install -e .` |
| 本地 deps/ 不存在 → 报错退出 | 本地 deps/ → GitHub Releases → 明确报错 |
| 无 `--force` | 增加 `--force`，一键推倒重来 |
| seed 复制每次覆盖用户数据 | 首次安装才复制；已有数据跳过，保护用户 workflows/compositions |
| agent tools 硬编码在脚本里 | 读 `seed/tools.yaml` 统一管理，`openry tools sync` 支持增量更新 |
| 加 tool 需重装 | `openry tools sync` 增量同步，不动数据 |

---

## 九、工具配置系统（tools.yaml 单一事实来源）

### 9.1 设计动机

根据踩坑文档 `docs/pitfalls.md`，新增 plugin tool 需要同时修改 **3 个配置位置**：
- `orchestrator-plugin/openclaw.plugin.json` → `contracts.tools`（坑点 #0）
- `~/.openclaw/openclaw.json` → agent `alsoAllow`（坑点 #3）
- Plugin 代码 `api.registerTool()`（坑点 #1）

漏任何一个，agent 都看不到或调不了工具。而当前 install.sh 把 tool 名称硬编码在脚本里，容易与 plugin tar 包中的 contracts 不一致。

### 9.2 方案：seed/tools.yaml

```yaml
# OpenRY Agent Tool 配置（单一事实来源）
# 安装时自动同步到：
#   1. openclaw.plugin.json → contracts.tools
#   2. ~/.openclaw/openclaw.json → agent alsoAllow
#
# 添加自定义 tool：
#   1. 在 plugin 代码中 api.registerTool()
#   2. 在下面加一行
#   3. 运行: openry tools sync --restart
#
# 注意：这里只负责"声明"tool 给 agent 可见，tool 的"实现"仍需在 plugin 代码中注册。

tools:
  - openry_run
  - openry_status
  - openry_payload_query
  - openry_knowledge_query
```

### 9.3 同步时机

| 场景 | 操作 | 覆盖的配置 |
|---|---|---|
| 首次 `install.sh` | 读 tools.yaml → patch openclaw.plugin.json + openclaw.json | contracts.tools + agent alsoAllow |
| 重装 `install.sh` | 同上（每次安装都同步 tool 配置，无破坏性） | 同上 |
| 增量添加 tool | `openry tools sync --restart` | 同上（一条命令，不重装） |

### 9.4 同步工具：`openry tools sync`

同步逻辑作为 CLI 命令实现，不依赖 .sh/.ps1 脚本：

```bash
openry tools sync              # 同步 contracts.tools + agent alsoAllow
openry tools sync --check      # 干跑：只报告差异，不做修改
openry tools sync --restart    # 同步 + 自动重启 gateway（一条命令生效）
```

流程：
1. 读 `seed/tools.yaml`
2. 更新 `orchestrator-plugin/openclaw.plugin.json` → `contracts.tools`
3. 更新 `~/.openclaw/openclaw.json` → agent `alsoAllow`
4. 提示 `openclaw gateway restart`

### 9.5 seed 复制保护

install.sh 中 seed → ~/.openry 的复制逻辑改为首次判断：

```bash
if [ ! -d "$OPENRY_HOME/workflows" ]; then
    cp -r "$SEED_DIR"/* "$OPENRY_HOME/"
    echo "✓ Initialized from seed/"
else
    echo "  ~/.openry already exists, preserving user data"
fi
```

---

## 七、需要修改的文件清单

| 文件 | 修改范围 |
|---|---|
| `scripts/install.sh` | 主要改造：重组流程、增加清理逻辑、增加 GitHub Release fallback、增加 `--force` / `--bge-source` 参数、seed 首次复制保护、调用 `openry tools sync` |
| `scripts/install.ps1` | 同上，Windows 版本同步改造 |
| `openry/cli.py` → `cmd_uninstall()` | 补充盲区：增加 plugin 目录清理、egg-info 清理、修正 BGE-M3 缓存路径 |
| `openry/cli.py` → `cmd_tools_sync()` | **新增**：从 seed/tools.yaml 同步 tool 配置到 openclaw.plugin.json + openclaw.json |
| `scripts/uninstall.sh` | 透传 `--force` 等新参数（薄包装，无需改动） |
| `scripts/uninstall.ps1` | 同上 |
| `seed/tools.yaml` | **新建**：Tool 配置单一事实来源 |

---

## 八、已确认决策

- [x] **GitCode 三级 fallback**：本地 deps/ → GitHub Releases（curl --connect-timeout 10）→ GitCode sparse clone（38.9s，790MB，21 MB/s 国内 CDN）。实测验证通过。
- [x] **curl 超时策略**：仅 `--connect-timeout 10` 探测 TCP 不可达，不设 `--max-time` 总时长限制（大文件下载如 416MB BGE-M3 可能需数分钟）。
- [x] **HuggingFace 缓存不清理**：`~/.cache/huggingface` / `~/.cache/transformers` 是 Python 生态缓存，OpenRY 插件不依赖它们，清理既无必要还可能影响本机其他项目。从 uninstall 的 `--with-openclaw` 流程中移除。
- [x] **tools.yaml 单一事实来源**：Tool 名称集中在 `seed/tools.yaml` 管理，安装时通过 `openry tools sync` 同步。增量添加 tool 只需编辑 tools.yaml → `openry tools sync --restart`（一条命令）。
- [x] **seed 首次复制保护**：`~/.openry/` 已存在则跳过 seed 复制，保护用户自定义 workflows/compositions/prompts。

---

## 十、实施状态

### 10.1 macOS — 实现完成 ✅

| 文件 | 状态 | 说明 |
|---|---|
| `scripts/install.sh` | ✅ 完成并测试 | install → uninstall → reinstall 全流程通过 |
| `openry/cli.py` → `cmd_uninstall()` | ✅ 完成并测试 | 9 项清理全部到位，subprocess bug 已修复 |
| `openry/cli.py` → `cmd_tools_sync()` | ✅ 完成并测试 | `--check` / `--restart` 均通过 |
| `seed/tools.yaml` | ✅ 完成并测试 | 增减 tool 正确同步到两处配置 |
| `scripts/uninstall.sh` | 无需改动 | 薄包装，底层 cmd_uninstall 已覆盖 |

**已测试场景**：
- 全新安装 → 所有组件正常
- `openry tools sync --check` → 干跑报告差异
- `openry tools sync --restart` → 同步 + 重启一条命令
- 增减 tool → 正确传播到 contracts.tools + agent alsoAllow
- 重装不丢用户数据 → `~/.openry/workflows/` 保留
- `openry uninstall --with-openclaw --force` → 7 项全部清理干净
- GitHub Releases 慢速自动断开 → `curl: (28) Operation too slow. Less than 102400 bytes/sec` → 流入 GitCode
- GitCode 三级 fallback 端到端 → 本地缺失 deps/ → GitHub 限速断开 → GitCode sparse clone → deps/ 拉取成功 → sha256 校验通过 → 安装完成
- deps/ 缓存回写 → GitCode 拉取后写入本地 deps/，下次安装命中 Priority 1

### 10.2 Windows — 实现完成 ✅（2026-08-11）

| 文件 | 状态 | 说明 |
|---|---|
| `scripts/install.ps1` | ✅ 完成并测试 | install → uninstall → reinstall → tools sync 全流程通过 |
| `scripts/uninstall.ps1` | ✅ 无需改动 | 薄包装，底层 cmd_uninstall 已覆盖 |
| `openry/cli.py` → `cmd_uninstall()` | ✅ 完成并测试 | 7 项清理全部到位，包括 Xenova BGE-M3 缓存 |
| `openry/cli.py` → `cmd_tools_sync()` | ✅ 完成并测试 | `--check` / `--restart` 均通过 |
| `seed/tools.yaml` | ✅ 完成并测试 | 增减 tool 正确同步到两处配置 |

**已测试场景**（4 轮全通过）：
- ✅ 全新安装 → openry 可用，BGE-M3 4 文件完整（~580 MB），plugin 注册成功
- ✅ `openry tools sync --check` → 干跑报告差异
- ✅ `openry tools sync --restart` → 同步 + Gateway 重启一条命令
- ✅ 增减 tool → 正确传播到 contracts.tools + agent alsoAllow
- ✅ 重装不丢用户数据 → `~/.openry/workflows/` 保留，seed 目录结构完整（5 子目录）
- ✅ `openry uninstall --with-openclaw --force` → 7 项全部清理干净（含 Xenova 缓存），exit 0
- ✅ Agent workspace 路径有效 → `~/.openry/agent-workspace/` 正确创建（robocopy 替代 Copy-Item）

**Windows 特有修复**（见第十一节详细记录）：
| Bug | 说明 |
|---|---|
| `Resolve-Asset` 缺少闭合 `}` | 脚本完全无法解析 → 添加缺失括号 |
| 双重 `Split-Path -Parent` | Scripts 路径错误（`C:\Scripts`）→ 改用 `sysconfig.get_path('scripts')` |
| 注册表 `Get-ItemProperty` 通配符 | 不支持 `*` → `Get-ChildItem` + 逐个查询 |
| `_kill_openry_processes` 杀全部 Python | `taskkill /F /IM python.exe` → 临时 .ps1 精准匹配 openry |
| `_clean_shell_config` 设空字符串 | `setx ""` → `[Environment]::SetEnvironmentVariable(..., $null)` |
| `$bgeTar` 未显式初始化 | 靠 `$null` 兜底 → 显式 `$bgeTar = $null` |
| BGE-M3 找不到 `.ps1` 安装脚本 | 只查 `.sh` → 优先 `.ps1` + `-ExecutionPolicy Bypass` |
| `tools sync --restart` 找不到 openclaw | `subprocess.run` 不补全 `.CMD` → `shutil.which()` 解析 |
| seed Copy-Item 扁平化子目录 | `Copy-Item -Recurse` bug → `robocopy /E` |

### 10.3 已知局限

| 问题 | 严重程度 | 说明 |
|---|---|---|
| `pip install --user -e .` 在 macOS Xcode Python 3.9 下静默失败 | 低 | 已通过 wrapper fallback 兜底，不影响使用 |
| `openclaw gateway restart` 首次安装后需手动执行 | 低 | install.sh 末尾有提示，`tools sync --restart` 已自动处理（Windows 已修复 shutil.which 问题） |
| ModelScope SDK fallback 未端到端测试 | 低 | 代码已实现 `--bge-source=modelscope` 路径，国内场景优先级低 |
| GitHub 慢速 → GitCode fallback 未在 Windows 上端到端测试 | 低 | 代码已实现，逻辑与 macOS 一致 |
| `PowerShell ExecutionPolicy` 可能阻止 `.ps1` 运行 | 低 | BGE-M3 安装已加 `-ExecutionPolicy Bypass`，但用户环境可能有额外组策略限制 |

---

## 十一、Windows 代码审查 Bug 清单（2026-08-11）— 全部已修复 ✅

> 审查 + 测试范围：`scripts/install.ps1`、`scripts/uninstall.ps1`、`openry/cli.py`
> 原则：只做新增/扩展性修改，不触碰 macOS 已固化代码路径

### 11.1 静态审查发现的 Bug（6 个，已修复）

| # | 严重度 | 文件 | 问题 | 修复 |
|---|--------|------|------|------|
| 1 | 🔴 | `install.ps1:58,107` | `Resolve-Asset` 函数缺少闭合 `}`，脚本无法解析 | 添加 2 个 `}` + `return $null` |
| 2 | 🟠 | `cli.py:870` | `taskkill /F /IM python.exe` 杀全部 Python 进程 | 临时 .ps1 脚本精准匹配 openry 进程 |
| 3 | 🟠 | `install.ps1:262` | `Get-ItemProperty` 不支持通配符 `*` | `Get-ChildItem` + 逐个 `Get-ItemProperty` |
| 4 | 🟠 | `cli.py:883` | `setx OPENRY_HOME ""` 设空字符串而非删除 | `[Environment]::SetEnvironmentVariable(..., $null)` |
| 5 | 🟠 | `install.ps1:405` | 双重 `Split-Path -Parent` → `C:\Scripts`（错误） | `sysconfig.get_path('scripts')` |
| 6 | 🟡 | `install.ps1:705` | `$bgeTar` 在 modelscope 路径未显式初始化 | 显式 `$bgeTar = $null` |

### 11.2 测试中发现的额外 Bug（3 个，已修复）

| # | 严重度 | 文件 | 问题 | 修复 |
|---|--------|------|------|------|
| 7 | 🟠 | `install.ps1:740` | BGE-M3 tar 中有 `install-bge-m3.ps1` 但未使用；且 ExecutionPolicy 阻止运行 | 优先 `.ps1` + `-ExecutionPolicy Bypass`；fallback `.sh`+bash |
| 8 | 🟠 | `cli.py:1199` | `cmd_tools_sync` 调用 `subprocess.run(["openclaw"])` 不补全 `.CMD` 扩展名 | 加 `shutil.which("openclaw")` 解析 |
| 9 | 🟠 | `install.ps1:456` | `Copy-Item -Recurse` 扁平化单文件子目录（如 `agent-workspace/`） | `robocopy /E` 替代 |

### 11.3 未触碰的 macOS 代码

所有 `cli.py` 修复均在 `if sys.platform == "win32"` 分支内，macOS 的 `else` 分支零改动。`install.sh` 未做任何修改。
