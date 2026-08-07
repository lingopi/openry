# OpenRY 一键安装方案

> 面向中国大陆用户的可行性设计，解决 npm / GitHub / HuggingFace 访问受限问题。

---

## 1. 设计原则

| 原则 | 说明 |
|------|------|
| **Git 仓库零大文件** | 源码仓库不含任何二进制/模型/依赖包，保持轻量 |
| **一条命令完成安装** | `curl -fsSL https://openry.ai/install.sh \| bash` |
| **智能镜像降级** | 每个网络请求都有国内镜像备用，用户无感知 |
| **渐进式发布** | 先用 GitHub Releases 过渡，后续迁移到 npm/PyPI |

---

## 2. 安装流程总览

```
用户执行: curl -fsSL https://openry.ai/install.sh | bash
│
├── Step 1: 环境检测
│   ├── OS 检测 (macOS / Linux / Windows)
│   ├── Python 3.9+ 检测
│   └── Node.js 18+ 检测
│
├── Step 2: 安装 OpenRY CLI（Python）
│   ├── pip install openry           ← 未来：PyPI
│   │   └── fallback: pip install --index-url https://pypi.tuna.tsinghua.edu.cn/simple openry
│   └── 当前过渡期: git clone + pip install -e .
│
├── Step 3: 安装 Plugin（Node.js）
│   ├── npm install openclaw-plugin-orchestrator-plugin     ← 未来：npm
│   │   └── fallback: npm install --registry https://registry.npmmirror.com ...
│   └── 当前过渡期: npm install（源码目录）+ native 模块镜像下载
│       ├── --ignore-scripts（跳过原生编译）
│       └── download-native.mjs: 从镜像站下载 .node 二进制
│           ├── https://ghfast.top/  (首选)
│           ├── https://ghproxy.com/
│           ├── https://mirror.ghproxy.com/
│           └── (最多 5 级回退)
│
├── Step 4: 安装 BGE-M3 向量模型（~400 MB）
│   ├── 从 GitHub Releases 下载，经镜像代理
│   │   └── https://ghfast.top/https://github.com/lingopi/openry/releases/download/...
│   └── 安装到 @xenova/transformers 缓存目录
│
├── Step 5: 注册 Plugin + 配置 Agent
│   ├── openclaw plugins install . --link
│   ├── openclaw agents add openry-worker ...
│   └── 写入 tools 配置到 openclaw.json
│
└── Step 6: 完成
    ├── openclaw gateway restart
    └── openry serve → http://127.0.0.1:9100
```

---

## 3. 各依赖的分发策略

### 3.1 OpenRY CLI（Python 包）

| 阶段 | 策略 | 国内镜像 |
|------|------|---------|
| **当前** | `git clone` + `pip install -e .`（唯一依赖 pyyaml） | GitHub 本身可用镜像加速 |
| **目标** | 发布到 PyPI：`pip install openry` | `pypi.tuna.tsinghua.edu.cn/simple` |

PyPI 在国内有清华/阿里/中科大等多个镜像，访问不成问题。`pyyaml` 作为唯一依赖也是纯 Python 包。

### 3.2 Plugin（Node.js 包）

| 阶段 | 策略 | 国内镜像 |
|------|------|---------|
| **当前** | npm install（源码目录） + download-native.mjs 从 GitHub Release 镜像下载 .node 二进制 | npm: `registry.npmmirror.com`，二进制: `ghfast.top` |
| **目标** | 发布到 npm：`npm install openclaw-plugin-orchestrator-plugin` | 同上 |

**download-native.mjs 的镜像池**（已实现）：

```
ghfast.top → ghproxy.com → mirror.ghproxy.com → github.moeyy.xyz → gh.con.sh
```

这个脚本已经存在，覆盖了 `better-sqlite3` 和 `sharp` 两个原生模块。

### 3.3 BGE-M3 向量模型

| 策略 | 说明 |
|------|------|
| **分发渠道** | GitHub Releases（`openry` 仓库） |
| **下载方式** | 经 ghfast.top 镜像代理（install.sh / install.ps1 内建） |
| **缓存位置** | `orchestrator-plugin/node_modules/@xenova/transformers/.cache/` |
| **懒加载备选** | 如果下载失败，首次调用 `openry_knowledge_query` 时 @xenova/transformers 会自动从 HuggingFace 下载（已配置 hf-mirror.com 镜像） |

**HuggingFace 镜像配置**（`embedder.ts` 已实现）：
```typescript
process.env.XENOVA_CACHE_HOST = "https://hf-mirror.com";
```

双重保障：install 脚本用 GitHub Release（经镜像代理），运行时懒加载用 HuggingFace 镜像。

### 3.4 OpenClaw Gateway

OpenClaw 本身的安装不在 OpenRY 安装脚本范围。但在 install.sh 中可以提示：

```bash
# 检测 openclaw 是否已安装
if ! command -v openclaw &>/dev/null; then
    echo "请先安装 OpenClaw: npm install -g openclaw"
    echo "（如遇网络问题，使用: npm install -g --registry=https://registry.npmmirror.com openclaw）"
fi
```

---

## 4. 版本发布策略

### 4.1 过渡期（当前）

```
GitHub Releases
├── openry-vX.X.X.tar.gz          # 源码包（轻量）
├── bge-m3-offline.tar.gz         # BGE 模型（~400 MB）—— install.sh 按需下载
├── plugin-bundle-darwin-arm64.tar.gz   # macOS Apple Silicon 预编译插件包
├── plugin-bundle-darwin-x64.tar.gz     # macOS Intel
├── plugin-bundle-linux-x64.tar.gz      # Linux
└── plugin-bundle-win32-x64.tar.gz      # Windows
```

install.sh 自动检测平台 → 下载对应 bundle → 解压 → 完成。不推 git，走 GitHub Releases。

### 4.2 正式发布（目标）

```
PyPI:  pip install openry
npm:   npm install openclaw-plugin-orchestrator-plugin
CDN:   BGE model 发布到国内对象存储（如阿里云 OSS）
```

---

## 5. install.sh 镜像降级策略

每个网络操作的三级回退：

| 操作 | 首选 | 备选 1 | 备选 2 |
|------|------|--------|--------|
| git clone | GitHub 直连 | `ghfast.top` 镜像 | `ghproxy.com` 镜像 |
| npm install | npm 官方 | `npmmirror.com` | — |
| BGE 下载 | GitHub Release + `ghfast.top` | GitHub Release + `ghproxy.com` | HuggingFace 镜像懒加载 |
| pip install（未来） | PyPI 官方 | `tuna.tsinghua.edu.cn` | `mirrors.aliyun.com` |

---

## 6. 平台支持矩阵

| 平台 | CLI | Plugin | 原生模块 | BGE 模型 |
|------|:---:|:---:|:---:|:---:|
| 🍎 macOS ARM | pip install | npm / bundle | ✅ download-native | ✅ |
| 🍎 macOS Intel | pip install | npm / bundle | ✅ download-native | ✅ |
| 🐧 Linux x64 | pip install | npm / bundle | ✅ download-native | ✅ |
| 🪟 Windows x64 | pip install | npm / bundle | ✅ download-native | ✅ |

所有平台的原生模块都通过 `download-native.mjs` 从镜像下载，不需要编译。

---

## 7. 用户实际安装命令

### macOS / Linux

```bash
# 一条命令
curl -fsSL https://raw.githubusercontent.com/lingopi/openry/main/install.sh | bash
```

### Windows (PowerShell)

```powershell
# 一条命令
irm https://raw.githubusercontent.com/lingopi/openry/main/install.ps1 | iex
```

### 手动安装（网络受限环境）

```bash
# 1. 用镜像克隆
git clone https://ghfast.top/https://github.com/lingopi/openry.git
cd openry

# 2. 手动安装
bash install.sh
# install.sh 会自动使用镜像下载所有依赖
```

---

## 8. Git 仓库最终结构

```
OpenRY/
├── install.sh              # 一键安装（macOS/Linux）
├── install.ps1              # 一键安装（Windows）
├── uninstall.sh             # 卸载
├── uninstall.ps1            # 卸载
├── openry/                  # Python CLI 源码
├── orchestrator-plugin/     # TypeScript Plugin 源码
│   ├── scripts/
│   │   └── download-native.mjs   # 镜像下载原生模块
│   └── src/
├── example/                 # 示例 YAML 配置
├── prompts/                 # Agent Prompt 文件
├── docs/                    # 公开文档
└── .github/
    └── workflows/           # CI/CD（自动构建 Release）
```

**不在 git 中的**（通过 GitHub Releases 分发）：
- `bge-m3-offline.tar.gz`（~400 MB）
- 各平台 `plugin-bundle-*.tar.gz`（~150 MB/平台）

---

## 9. 与 OpenClaw 策略的对比

| 维度 | OpenClaw | OpenRY（本方案） |
|------|----------|-----------------|
| CLI 分发 | npm 全局安装 | pip install（目标 PyPI） |
| 原生模块 | optionalDependencies 预编译 | download-native.mjs + 镜像 |
| 大模型 | ❌ 不需要 | GitHub Release + 镜像代理 |
| 安装入口 | openclaw.ai/install.sh | GitHub raw URL（过渡）/ openry.ai（目标） |
| 国内适配 | 无特殊处理 | 所有网络请求三级镜像回退 |

---

## 10. 实施路线

| 优先级 | 任务 | 状态 |
|:---:|------|:---:|
| P0 | install.sh / install.ps1 完善镜像降级逻辑 | ✅ 已实现 |
| P0 | download-native.mjs 多镜像回退 | ✅ 已实现 |
| P1 | BGE 模型发布到 GitHub Releases | ✅ 已实现 |
| P1 | 各平台 Plugin Bundle 发布到 GitHub Releases | 待实现（CI 自动构建） |
| P2 | 申请/搭建 openry.ai 域名，托管 install.sh | 待实现 |
| P2 | 发布 Python 包到 PyPI | 待实现 |
| P3 | 发布 Plugin 到 npm | 待实现 |
| P3 | BGE 模型上传国内 OSS | 待调研 |

---

## 附录：关键代码引用

| 组件 | 文件 | 说明 |
|------|------|------|
| 安装脚本 | `install.sh` / `install.ps1` | 一键安装入口 |
| 卸载脚本 | `uninstall.sh` / `uninstall.ps1` | 完整清理 |
| 原生模块下载 | `orchestrator-plugin/scripts/download-native.mjs` | 5 级镜像回退 |
| BGE 懒加载镜像 | `orchestrator-plugin/src/knowql-knowledge/embedder.ts:14` | `XENOVA_CACHE_HOST` → hf-mirror.com |
| 工具注册 | `orchestrator-plugin/src/index.ts` | openry_run / openry_status / openry_payload_query |
| 知识检索 | `orchestrator-plugin/src/knowql-knowledge/tool.ts` | openry_knowledge_query |
