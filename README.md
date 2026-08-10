# OpenRY

> **Put handcuffs on your AI Agent** — 一个跨平台的 AI Agent 可观测、可审计、可中断的命令护栏。

[English](#english) 👇

---

## 这是什么？

OpenRY 在 AI Agent 和系统命令之间插入一个可控的**中间层**。Agent 不能直接调用 `rm -rf /` 或 `curl evil.com`——它必须通过 OpenRY 的 `openry_run` 工具。每一条命令都被记录、可审计，每次任务完成都经过验证和重试。

**支持平台**：🍎 macOS · 🪟 Windows（OpenClaw Gateway）

---

## 能做什么？

| 能力 | 说明 |
|------|------|
| 🔒 **命令护栏** | Agent 的所有 shell 命令经过 OpenRY 白名单/黑名单过滤，支持 `strict` / `moderate` / `permissive` 三档预设 |
| 📋 **工作流编排** | 用 YAML 定义多步骤业务流程（`sub_steps`），每个步骤独立验证、重试、负载传递 |
| ✅ **自动验证** | 17 种验证规则 + 2 种隐式检查：字段存在性、正则匹配、数值比较、文件检查、HTTP 状态码、JSON Schema…… |
| 🔀 **条件路由** | `when`（单条件）和 `when_any`（或条件组）实现多分支决策，支持短路求值 |
| 📊 **Web 看板** | `openry serve` 启动浏览器 UI，实时查看工作流状态树、payload 流转、Agent 对话记录 |
| 🔍 **语义知识检索** | Agent 通过 `openry_payload_query`（精确查历史 payload）+ `openry_knowledge_query`（BGE-M3 语义搜索）两个工具查询历史数据 |
| 📝 **全程审计** | 每条命令、每次状态变更自动写入 SQLite，完整可追溯 |
| 🛑 **软刹车** | 超时/手动取消时先通知 Agent，给其保存上下文的机会，再硬终止 |

> 详细的 Workflow YAML 配置语法、验证规则、条件路由用法，请参阅 **[AI 可读配置指南](prompts/compositions-and-workflows-guide.md)**。

---

## 快速开始

### 前提条件

- Python 3.9+
- Node.js 18+
- [OpenClaw Gateway](https://openclaw.ai) 已安装

### 安装

```bash
# macOS / Linux
git clone https://github.com/lingopi/openry.git
cd openry
bash scripts/install.sh
```

```powershell
# Windows (PowerShell 7+)
git clone https://github.com/lingopi/openry.git
cd openry
pwsh -File scripts/install.ps1
```

安装脚本自动完成：pip 安装 → npm 依赖 → 插件注册 → Agent 配置 → BGE-M3 向量模型。

### 离线安装（可选）

将预编译的依赖包放入 `deps/` 目录，安装脚本优先使用本地包，**零网络依赖**：

```
deps/
├── common/
│   └── bge-m3-offline.tar.gz           # BGE-M3 向量模型
├── macos/
│   └── orchestrator-plugin-bundle.tar.gz  # macOS 插件完整依赖
└── windows/
    └── orchestrator-plugin-bundle.tar.gz  # Windows 插件完整依赖
```

### 卸载

```bash
# 保留用户数据（DB + 工作流 + 模型缓存）
bash scripts/uninstall.sh

# 彻底清除一切（含 DB + 工作流 + AI 模型缓存）
bash scripts/uninstall.sh --force --all
```

| 选项 | 说明 |
|------|------|
| `--force` | 跳过确认提示 |
| `--all` | 删除 `~/.openry` 数据目录 + HuggingFace 模型缓存 |
| `--keep-data` | 保留 `~/.openry`（默认行为） |
| `--keep-env` | 保留 shell 环境变量配置 |
| `--skip-gateway` | 不停止 OpenClaw Gateway |

### 启动

```bash
# 1. 重启 OpenClaw Gateway（加载插件）
openclaw gateway restart

# 2. 启动 Web 看板
openry serve

# 3. 测试 CLI
openry -c 'echo hello'
```

然后打开浏览器访问 `http://127.0.0.1:9100`。

---

## 配置

在 `~/.openclaw/openclaw.json` 中可调整插件参数（全部可选，不写用默认值）：

```json
{
  "plugins": {
    "entries": {
      "orchestrator-plugin": {
        "enabled": true,
        "config": {
          "maxWorkers": 3,
          "patrolIntervalMs": 5000,
          "zombieTimeoutMinutes": 10,
          "commandTimeoutSeconds": 600,
          "openryDir": "~/.openry"
        }
      }
    }
  }
}
```

| 参数 | 默认值 | 说明 |
|------|:---:|------|
| `maxWorkers` | 3 | 最大并行 Agent 数 |
| `patrolIntervalMs` | 5000 | 巡查间隔（毫秒） |
| `zombieTimeoutMinutes` | 10 | 僵死检测阈值 |
| `commandTimeoutSeconds` | 600 | 命令执行超时（秒） |
| `openryDir` | `~/.openry` | 数据目录 |

---

## 文档

| 文档 | 说明 |
|------|------|
| [AI 可读配置指南](prompts/compositions-and-workflows-guide.md) | Workflow / Composition YAML 完整语法、验证规则、条件路由、Prompt Blocks、KnowQL |
| [Timeout 机制](docs/timeout-mechanism.md) | 三层超时、心跳、竞态条件 |

---

## License

MIT © OpenRY Contributors

---

<a name="english"></a>
## English

### What is OpenRY?

OpenRY is a cross-platform command guardrail for AI agents. It sits between the agent and the operating system, ensuring every shell command is logged, validated, and governed by configurable policies. Agents work through OpenRY's tools (`openry_run`, `openry_status`) rather than calling system commands directly — making every action auditable and every workflow stoppable.

**Supported platforms**: 🍎 macOS · 🪟 Windows (via OpenClaw Gateway)

### Key Capabilities

| Capability | Description |
|------------|-------------|
| 🔒 **Command Guard** | Whitelist/blocklist filtering with `strict` / `moderate` / `permissive` presets |
| 📋 **Workflow Orchestration** | YAML-defined multi-step business processes with per-step validation, retry, and payload passing |
| ✅ **Auto-Validation** | 17 rule types + 2 implicit checks: field existence, regex, comparisons, file checks, HTTP status, JSON Schema… |
| 🔀 **Conditional Routing** | `when` / `when_any` branching with short-circuit evaluation |
| 📊 **Web Dashboard** | `openry serve` — browser UI for workflow state tree, payload inspector, transcript viewer |
| 🔍 **Semantic Knowledge Retrieval** | Two tools: `openry_payload_query` (exact SQL lookup) + `openry_knowledge_query` (BGE-M3 semantic search by concept clusters) |
| 📝 **Full Audit Trail** | Every command and status change recorded to SQLite |
| 🛑 **Soft-Brake** | Graceful cancellation: notify agent → save context → hard terminate |

> See the **[AI-Readable Config Guide](prompts/compositions-and-workflows-guide.md)** for complete YAML syntax, validation rules, and routing documentation.

### Quick Start

**Prerequisites**: Python 3.9+, Node.js 18+, [OpenClaw Gateway](https://openclaw.ai)

```bash
# Install
git clone https://github.com/lingopi/openry.git
cd openry
bash scripts/install.sh           # macOS / Linux
# pwsh -File scripts/install.ps1   # Windows

# Start
openclaw gateway restart
openry serve            # → http://127.0.0.1:9100
```

For offline install, place pre-built dependency tarballs in `deps/{common,macos,windows}/` — the installer prefers local files with zero network dependency.

### Uninstall

```bash
# Keep user data (DB + workflows + model cache)
bash scripts/uninstall.sh

# Complete removal (DB + workflows + AI model cache)
bash scripts/uninstall.sh --force --all
```

| Option | Description |
|--------|-------------|
| `--force` | Skip confirmation prompts |
| `--all` | Remove `~/.openry` data dir + HuggingFace model cache |
| `--keep-data` | Keep `~/.openry` (default behavior) |
| `--keep-env` | Keep shell environment variable config |
| `--skip-gateway` | Don't stop OpenClaw Gateway |

### Architecture

```
OpenClaw Gateway
  ├── AI Agent (Claude / GPT)
  │     Tools: openry_run · openry_status · openry_payload_query · openry_knowledge_query
  └── Orchestrator Plugin (TypeScript)
        • Spawn agent sessions • Patrol validation loop
        • Route between steps • Soft-brake on timeout
              │
              ▼
OpenRY CLI (Python)
  Executor · SQLite DB · Validator (18 rules)
  Router · Payload Merge · YAML Config Loader
              │
              ▼
         System Shell
```

### Configuration

In `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "orchestrator-plugin": {
        "enabled": true,
        "config": {
          "maxWorkers": 3,
          "patrolIntervalMs": 5000,
          "zombieTimeoutMinutes": 10,
          "commandTimeoutSeconds": 600,
          "openryDir": "~/.openry"
        }
      }
    }
  }
}
```

### Documentation

- **[AI-Readable Config Guide](prompts/compositions-and-workflows-guide.md)** — Complete YAML syntax, validation rules, routing, Prompt Blocks, KnowQL
- [Timeout Mechanism](docs/timeout-mechanism.md) — Three-tier timeout, heartbeat, race conditions

### License

MIT © OpenRY Contributors
