# OpenRY

> **Put handcuffs on your AI Agent** — a cross-platform command forwarder that makes every "action" of a ReAct Agent controllable, auditable, and stoppable.

## ⚠️ 当前适用范围

| 维度 | 状态 | 说明 |
|------|:----:|------|
| **操作系统** | 🍎 macOS only | 目前仅在 macOS 上完成适配与测试，理论上可在 macOS 上正常安装和运行。Windows / Linux 的适配尚未完成。 |
| **Agent 平台** | 🔌 OpenClaw only | 仅适配了 OpenClaw Gateway Plugin（`orchestrator-plugin/`），其他 Agent 框架暂不可用。 |
| **主力编排器** | TypeScript Plugin | `orchestrator-plugin/` 是**主力编排控制器**，功能完整。Python 版 `openry/orchestrator/` 目前功能不全，仅作参考。 |

## TL;DR

Agent thinks. OpenRY acts. Orchestrator orchestrates.

> 🍎 当前仅支持 macOS + OpenClaw Gateway。详见上方适用范围。

## Development Status

| Phase | Feature | Status |
|-------|---------|:------:|
| **Phase 1** | Command Forwarder — cross-platform `openry -c` execution | ✅ Done |
| **Phase 2** | Orchestrator — state machine, sync validation, retry, payload passing, Workflow YAML | ✅ Done |
| **Phase 2b** | OpenClaw Plugin — TypeScript orchestrator as Gateway plugin (`orchestrator-plugin/`) | ✅ Done |
| **Phase 3a** | Advanced Validation & Routing — 10 validation types, `when`/`when_any` conditional routing | ✅ Done |
| **Phase 3-UI** | Web Dashboard — real-time workflow state tree, payload inspector, transcript viewer | ✅ Done |
| **Config Docs** | AI-readable configuration guide (`docs/compositions-and-workflows-guide.md`) | ✅ Done |

## Core Features

- **Command Forwarding**: `openry -c '<shell command>'` — cross-platform execution with automatic shell selection (Win/macOS/Linux)
- **Status Updates**: `openry --status completed/failed/cancelled/overflow` — agent declares completion with sync validation & retry
- **Payload Passing**: `--payload '{"key":"val"}'` — structured data handoff between workflow steps with `inherit_payload` merging
- **State Machine Guard**: only `in_progress` tasks accept agent actions; terminal states are locked; dropped tasks are gated
- **Sync Retry/Validation**: retry logic & payload validation run synchronously in `--status`, not in a background loop
- **Transparent Audit**: all `openry -c` calls, status updates, and validation results automatically recorded to SQLite
- **OpenClaw Plugin**: TypeScript orchestrator as an OpenClaw Gateway plugin (`orchestrator-plugin/`) with Trusted Tool Policy
- **Workflow YAML**: compose `big_steps` & `sub_steps` with validation rules, retry budgets, overflow handling
- **Conditional Routing**: `when` (single condition) and `when_any` (OR group) routing with short-circuit evaluation
- **10 Validation Types**: `payload_has_key`, `payload_value_matches`, `payload_values_equal/not_equal`, `payload_value_equals`, `payload_value_in_set`, `payload_value_greater/less_than`, `payload_type`, `file_exists/contains/size`, `command`/`command_output_contains`, `db_query`, `http_status`, `json_schema`
- **Web Dashboard**: `openry serve` — browser-based UI for real-time workflow monitoring, payload inspection, and transcript viewing
- **AI Configuration Guide**: comprehensive prompt (`docs/compositions-and-workflows-guide.md`) that teaches AI how to write OpenRY YAML configs

## Why OpenRY

When a ReAct Agent calls system commands directly, three fatal problems emerge:

1. **State Machine Breaks** — agent skips or sends wrong status, workflow deadlocks
2. **Infinite Loops** — "call → think → call again" death spiral burns tokens
3. **False Completion** — agent claims success, but the artifact is missing, downstream crashes

OpenRY inserts a controlled intermediary between every agent and every system command, solving this at the root.

## Quick Start

> **前置条件：macOS** — 当前仅在 macOS 上适配和测试。需要 Python 3.9+、Node.js、OpenClaw Gateway。

```bash
# Install (macOS)
git clone https://github.com/lingopi/openry.git
cd openry
./install.sh

# Basic usage
openry -c 'echo hello world'
# → {"exit_code": 0, "stdout": "hello world\n", "stderr": "", "duration_ms": 4}

# With Orchestrator context (via OpenClaw Plugin)
OPENRY_RUN_ID="abc" openry --status completed --payload '{"msg_id":"123"}'
# → {"status": "completed", "payload": {"msg_id": "123"}, "acknowledged": true}

# Launch Web Dashboard
openry serve
# → http://localhost:9100
```

## Architecture

> **主力编排器：`orchestrator-plugin/`（TypeScript OpenClaw Gateway Plugin）**  
> Python 版 `openry/orchestrator/` 功能不全，仅作参考。所有工作流编排、验证、路由均由 TypeScript 插件完成。

```
┌──────────────────────────────────────────────────┐
│                  OpenClaw Gateway                 │
│  ┌──────────────┐  ┌──────────────────────────┐  │
│  │  AI Agent    │  │  ★ Orchestrator Plugin   │  │
│  │  (Claude/GPT)│  │    (TypeScript — 主力)    │  │
│  │              │  │  • Spawn agent sessions   │  │
│  │  Tools:      │  │  • Patrol validation loop  │  │
│  │  openry_run  │  │  • Route between steps     │  │
│  │  openry_status│ │  • Soft-brake on timeout   │  │
│  └──────┬───────┘  └────────────┬─────────────┘  │
└─────────┼───────────────────────┼────────────────┘
          │                       │
          ▼                       ▼
┌──────────────────────────────────────────────────┐
│                    OpenRY CLI                      │
│  ┌──────────┐  ┌──────────┐  ┌────────────────┐  │
│  │ Executor │  │   DB     │  │  Validator     │  │
│  │ (shell)  │  │ (SQLite) │  │  (18 rules)    │  │
│  └──────────┘  └──────────┘  └────────────────┘  │
│  ┌──────────┐  ┌──────────┐  ┌────────────────┐  │
│  │  Router  │  │ Payload  │  │  Config        │  │
│  │(condition)│  │ (merge)  │  │  (YAML loader) │  │
│  └──────────┘  └──────────┘  └────────────────┘  │
└──────────────────────────────────────────────────┘
          │
          ▼
    ┌──────────┐
    │  System  │
    │  Shell   │
    └──────────┘
```

## Examples

After running `./install.sh`, example YAML configs are automatically copied to `~/.openry/`:

### Workflows (`~/.openry/workflows/`)

| File | Demonstrates |
|------|-------------|
| `hello_world.yaml` | Simplest workflow: sub_step → payload → done |
| `file_analysis.yaml` | Multi-step with `inherit_payload` and long agent sessions |
| `basic_validation.yaml` | Hard validation: `expect_payload` + `payload_keys` |
| `conditional_routing.yaml` | `when` single-condition routing (safe vs. dangerous) |
| `permission_gate.yaml` | `when_any` OR-group routing (admin or editor) |
| `conditional_routing_demo.yaml` | Full demo: hard validation + `when` + `when_any` + type checks |
| `trusted_tool_policy.yaml` | Trusted Tool Policy with minimal agent tool set |

### Compositions (`~/.openry/compositions/`)

| File | Demonstrates |
|------|-------------|
| `hello_world.yaml` | Minimal composition referencing a single workflow |
| `file_analysis_demo.yaml` | Multi-step pipeline: hello → analysis → permission gate |

All examples are also available in the repo under `example/`.

## 平台与 Agent 支持

| 维度 | 支持情况 |
|------|---------|
| 🍎 macOS | ✅ 已适配并测试，可正常安装和运行 |
| 🐧 Linux | ⏳ 计划中（CLI 有理论支持，但未经测试） |
| 🪟 Windows | ⏳ 计划中（CLI 有理论支持，但未经测试） |
| 🔌 OpenClaw Gateway | ✅ 唯一支持的 Agent 平台（通过 `orchestrator-plugin/`） |
| 🤖 其他 Agent 框架 | ❌ 暂不支持 |

## Project Structure

> ★ = 主力模块

```
OpenRY/
├── install.sh              # One-click installer (macOS)
├── pyproject.toml           # Python package config
├── README.md
├── example/                 # Example YAML configs (copied to ~/.openry/ on install)
│   ├── compositions/        #   Composition examples
│   └── workflows/           #   Workflow (Big Step) examples
├── openry/                  # Python CLI — the command forwarder
│   ├── cli.py               #   CLI entry point (openry -c, openry --status)
│   ├── executor.py          #   Cross-platform command execution
│   ├── db.py                #   SQLite data layer
│   ├── config.py            #   Configuration loading
│   ├── utils.py             #   Utility functions
│   ├── orchestrator/        #   Python orchestrator (功能不全，仅作参考)
│   │   ├── engine.py        #     Core orchestration loop
│   │   ├── validation.py    #     Phase 2 validation rules (8 types)
│   │   ├── validator.py     #     Phase 3a validation rules (10 types)
│   │   ├── router.py        #     Conditional routing (when/when_any)
│   │   ├── payload.py       #     Payload merge & inheritance
│   │   └── yaml_loader.py   #     Workflow/Composition YAML loader
│   ├── server/              #   Web Dashboard server
│   └── web/                 #   Dashboard UI (static assets)
├── orchestrator-plugin/  ★  # TypeScript OpenClaw Gateway Plugin — 主力编排控制器
│   ├── openclaw.plugin.json
│   ├── package.json
│   └── src/
├── design/                  # Design documents (phases 1–4)
├── docs/                    # Documentation
│   └── compositions-and-workflows-guide.md  # AI-readable YAML config guide
└── tests/                   # Integration & E2E tests
```

Minimal Python dependency: `pyyaml`. Everything else is Python standard library.

## Documentation

- **[Compositions & Workflows Guide](docs/compositions-and-workflows-guide.md)** — AI-readable prompt covering all YAML fields, validation rules, routing, and best practices
- **[Design Documents](design/)** — Architecture decisions for each development phase
- **[Pitfalls](docs/pitfalls.md)** — Common mistakes and lessons learned

## License

MIT © OpenRY Contributors
