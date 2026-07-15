# OpenRY — Phase 1 设计文档：命令转发器（核心）

> 版本：2.0  
> 日期：2026-07-15  
> 状态：设计定稿，待开发

---

## 1. 概述

### 1.1 项目定位

OpenRY 是 ReAct Agent 与系统之间的**命令转发层**。Agent 不直接调用系统命令，而是通过 `openry` 转发执行。

**核心原则**：Agent 只管"动脑"（推理决策），OpenRY 只管"动手"（执行命令、记录日志、更新状态），硬代码（Orchestrator）管"编排"（路由、验证、调度）。

```
Agent (大脑)          →   openry (手)    →   系统命令
    只知道任务描述           极简CLI工具          实际执行
    不知道workflow          执行+记录
    不知道step/run_id       返回JSON
```

### 1.2 Phase 1 范围

**只做命令转发的核心三项能力**：

| 能力 | CLI | 说明 |
|------|-----|------|
| 执行命令 | `openry -c '<cmd>'` | 转发执行任意 shell 命令 |
| 状态更新 | `openry --status completed/failed` | Agent 声明 step 完成/失败 |
| 传递 payload | `openry --status completed --payload '...'` | 向下一步传递数据 |

**不做**：Workflow 引擎、Orchestrator 巡查循环、子进程管理、YAML 解析。这些属于 Phase 2。

---

## 2. 架构分层

```
┌──────────────────────────────────────────────────────────┐
│                 Orchestrator (硬代码 — Phase 2)             │
│                                                           │
│  • 启动 agent session 前注入环境变量:                       │
│    OPENRY_RUN_ID, OPENRY_STEP_ID, OPENRY_WORKFLOW          │
│  • 读取 SQLite 判断 step 状态，路由 next_step               │
│  • 执行 validation 规则                                    │
│  • 巡查超时/僵死任务                                        │
└──────────────────────────┬───────────────────────────────┘
                           │ 环境变量注入
                           ▼
┌──────────────────────────────────────────────────────────┐
│                  Agent Session (子进程)                     │
│                                                           │
│  agent 只知道：当前任务描述                                  │
│  agent 不知道：workflow / step / run_id / next_step        │
│                                                           │
│  agent 调:  openry -c 'git clone ...'                     │
│  agent 调:  openry --status completed --payload '...'     │
└──────────────────────────┬───────────────────────────────┘
                           │ CLI 调用
                           ▼
┌──────────────────────────────────────────────────────────┐
│                   openry (Phase 1)                         │
│                                                           │
│  1. 从环境变量读取 OPENRY_RUN_ID（可选）                     │
│  2. 检测平台 → 选择 shell → 执行命令                        │
│  3. 写入 SQLite（commands_log + task_state）               │
│  4. 返回简洁 JSON 给 agent                                 │
└──────────────────────────────────────────────────────────┘
```

---

## 3. CLI 设计

### 3.1 子命令：执行命令

```
openry -c '<shell 命令>' [OPTIONS]
openry --command '<shell 命令>' [OPTIONS]
```

| 参数 | 短参数 | 必须 | 类型 | 默认值 | 说明 |
|------|--------|------|------|--------|------|
| `--command` | `-c` | ✅ | `str` | — | 要转发的命令字符串 |
| `--cwd` | `-d` | ❌ | `str` | 当前目录 | 命令执行的工作目录 |
| `--timeout` | `-t` | ❌ | `int` | 300 | 超时秒数 |
| `--env` | `-e` | ❌ | `str` | — | 额外环境变量 `KEY=VAL`，可多次传入 |

### 3.2 子命令：状态更新

```
openry --status <completed|failed> [--payload '<JSON>']
```

| 参数 | 必须 | 类型 | 说明 |
|------|------|------|------|
| `--status` | ✅ | `str` | `completed` 或 `failed` |
| `--payload` | ❌ | `str` | JSON 字符串，传递给下一步的数据 |

### 3.3 调用示例

```bash
# 执行命令（最简）
openry -c 'ls -la'

# 执行 + 超时 + 环境变量
openry -c 'npm run build' -t 600 -e NODE_ENV=production

# Agent 声明完成
openry --status completed

# Agent 声明完成 + 传递 message_id 给下一步
openry --status completed --payload '{"message_id":"abc123","thread_id":"xyz"}'

# Agent 声明失败 + 附带回显
openry --status failed --payload '{"error":"dependency not found: libfoo"}'
```

---

## 4. Shell 选择策略

| 平台 | 优先 Shell | 检测方式 | 回退 |
|------|-----------|----------|------|
| Windows | `pwsh` (PowerShell 7) | `shutil.which("pwsh")` | `cmd.exe` |
| macOS | `/bin/zsh` | 直接使用（系统自带） | `/bin/bash` |
| Linux | `/bin/sh` | 直接使用（POSIX 标准） | `/bin/bash` |

### 4.1 pwsh 调用方式

```python
subprocess.run(
    ["pwsh", "-NoProfile", "-NonInteractive", "-Command", command],
    cwd=cwd, timeout=timeout,
    capture_output=True, text=True, encoding="utf-8"
)
```

### 4.2 zsh / sh 调用方式

```python
subprocess.run(
    command,
    shell=True, executable="/bin/zsh",  # 或 /bin/sh
    cwd=cwd, timeout=timeout,
    capture_output=True, text=True
)
```

---

## 5. 数据存储：SQLite

### 5.1 数据库路径

```
.openry/openry.db
```

### 5.2 表结构

```sql
-- 命令执行日志：一次 -c 调用一条记录
CREATE TABLE IF NOT EXISTS commands_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      TEXT,                              -- 来自环境变量 OPENRY_RUN_ID
    workflow    TEXT,                              -- 来自环境变量 OPENRY_WORKFLOW
    step_id     TEXT,                              -- 来自环境变量 OPENRY_STEP_ID
    command     TEXT NOT NULL,
    shell       TEXT NOT NULL,
    cwd         TEXT NOT NULL,
    exit_code   INTEGER NOT NULL,
    stdout      TEXT,
    stderr      TEXT,
    duration_ms INTEGER NOT NULL,
    timeout     INTEGER NOT NULL DEFAULT 0,
    timestamp   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_commands_run_id ON commands_log(run_id);
CREATE INDEX IF NOT EXISTS idx_commands_timestamp ON commands_log(timestamp);

-- 任务状态表：一次 --status 更新一条（upsert）
CREATE TABLE IF NOT EXISTS task_state (
    run_id      TEXT PRIMARY KEY,
    workflow    TEXT,
    step_id     TEXT,
    status      TEXT NOT NULL DEFAULT 'in_progress',  -- in_progress | completed | failed
    payload     TEXT DEFAULT '{}',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_task_status ON task_state(status);
CREATE INDEX IF NOT EXISTS idx_task_updated ON task_state(updated_at);
```

### 5.3 写入时机

| 操作 | 写入表 |
|------|--------|
| `openry -c '...'` | `commands_log` INSERT 一条 |
| `openry --status completed/failed` | `task_state` INSERT OR REPLACE（更新 status/payload/updated_at）当 `-c` 不带 run_id 时也先写入 task_state 一行 `in_progress` |

---

## 6. 环境变量接口（给 Orchestrator 用）

openry 启动时从 `os.environ` 读取以下变量：

| 变量名 | 说明 | 用途 |
|--------|------|------|
| `OPENRY_RUN_ID` | 当前 sub_step 的 run_id（UUID4） | 写入 commands_log.run_id 和 task_state.run_id |
| `OPENRY_WORKFLOW` | workflow 名称 | 写入 commands_log.workflow |
| `OPENRY_STEP_ID` | 当前 sub_step ID | 写入 commands_log.step_id |

**全都不设置也完全能跑**——不设时对应字段为 NULL。

---

## 7. 返回给 Agent 的 JSON

### 7.1 -c 命令执行

```json
{
  "exit_code": 0,
  "stdout": "total 48\ndrwxr-xr-x ...",
  "stderr": "",
  "duration_ms": 23
}
```

### 7.2 -c 超时

```json
{
  "exit_code": -1,
  "stdout": "",
  "stderr": "Command timed out after 300 seconds",
  "duration_ms": 300000,
  "timeout": true
}
```

### 7.3 --status 状态更新

```json
{
  "status": "completed",
  "payload": {"message_id": "abc123"},
  "acknowledged": true
}
```

### 7.4 设计原则

- **Agent 看到的 JSON 极其简洁**——不暴露 run_id、workflow、step_id 等元数据
- Agent 不知道自己在哪个 workflow 的哪个 step
- 这些元数据只写入 SQLite，供 Orchestrator 消费

---

## 8. 错误处理

| 场景 | 行为 |
|------|------|
| 命令为空 | `{"exit_code": 1, "error": "command is required"}` |
| shell 不存在且回退失败 | `{"exit_code": 2, "error": "no usable shell found"}` |
| 执行超时 | kill 子进程，`exit_code=-1, timeout=true` |
| cwd 不存在 | `{"exit_code": 3, "error": "cwd not found: /path"}` |
| 无法写入 SQLite | 打印错误到 stderr，但不影响命令执行和 JSON 返回 |
| 子进程被 SIGINT | 捕获后 kill 子进程，返回 `exit_code=-2` |
| stdout/stderr 编码异常 | surrogateescape 处理，不崩溃 |
| `--status` 值非法 | `{"error": "status must be completed or failed"}` |
| `--payload` JSON 非法 | `{"error": "payload must be valid JSON"}` |
| `-c` 和 `--status` 同时传 | `{"error": "cannot use --command and --status together"}` |

所有错误以 JSON 返回，绝不输出裸文本。

---

## 9. 项目结构

```
OpenRY/
├── openry/
│   ├── __init__.py
│   ├── __main__.py              # python -m openry 入口
│   ├── cli.py                   # argparse 定义 + 主流程
│   ├── executor.py              # 命令执行 + shell 检测/选择
│   ├── db.py                    # SQLite 初始化 + 读写
│   ├── config.py                # 配置加载（YAML + 默认值）
│   └── utils.py                 # 工具函数（时间戳、截断、编码）
├── design/
│   ├── phase1-command-forwarder.md
│   └── phase2-orchestrator.md
├── pyproject.toml
├── README.md
└── .gitignore
```

### 9.1 依赖

| 包 | 用途 | 来源 |
|----|------|------|
| `pyyaml` | 解析 config.yaml | 外部 |
| `sqlite3` | 数据库 | 标准库 |
| `subprocess` | 执行命令 | 标准库 |
| `argparse` | CLI | 标准库 |
| `uuid` | run_id 生成（预留） | 标准库 |
| `platform` | OS 检测 | 标准库 |

### 9.2 最低 Python 版本

Python 3.9+

---

## 10. 测试策略

| 层级 | 内容 | 工具 |
|------|------|------|
| 单元测试 | executor（shell选择）、db（CRUD）、config（加载） | pytest |
| 集成测试 | 端到端 `-c 'echo hello'`、`--status`、SQLite 写入验证 | pytest |
| 超时测试 | `-c 'sleep 100' -t 1` | pytest |
| CI matrix | ubuntu / macos / windows | GitHub Actions |
