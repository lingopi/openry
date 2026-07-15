# OpenRY — Phase 2 设计文档：Workflow 编排引擎

> 版本：1.0  
> 日期：2026-07-15  
> 状态：设计讨论稿，Phase 1 完成后细化

---

## 1. 概述

Phase 2 在 Phase 1 的命令转发器之上，构建完整的 **Workflow 编排引擎（Orchestrator）**。

### 1.1 核心原则回顾

```
Agent (大脑)    →  只管"动脑"，不知道 workflow/step/run_id
openry (手)     →  只管"动手"，执行命令 + 记录
Orchestrator    →  只管"编排"，路由、验证、调度、进程管理
```

### 1.2 Phase 2 交付物

| 模块 | 说明 |
|------|------|
| Workflow 配置系统 | YAML 定义 big_step / sub_step / 路由规则 / 验证规则 |
| Orchestrator 巡查循环 | 定时扫描 SQLite，管理任务生命周期 |
| Agent Session 管理 | spawn/kill/monitor 子进程，worker pool 并发控制 |
| 硬代码验证引擎 | 执行 validation 规则，不信任 agent 自述的完成状态 |
| Payload 传递 | sub_step 间的数据传递（如 message_id） |
| 超时与僵死恢复 | 30 分钟无响应自动重置为 queued |
| 并发工作流支持 | 多个 workflow 并行执行，同一 workflow 可多实例并行 |

---

## 2. Workflow 配置体系

### 2.1 文件组织

```
.openry/
├── openry.db                        # Phase 1 的 SQLite
├── workflows/                       # Big Step 定义（可复用模块）
│   ├── send_email.yaml              # 发邮件：4 个 sub_step
│   ├── create_account.yaml          # 创建账户
│   ├── run_tests.yaml               # 运行测试
│   ├── deploy_k8s.yaml              # 部署到 K8s
│   └── ...（几十个）
│
└── compositions/                    # Workflow 组合定义
    ├── customer_onboarding.yaml     # 引用多个 big_step
    ├── incident_response.yaml
    └── daily_report.yaml
```

### 2.2 概念层级

```
Composition（完整业务流程）
  │
  ├── Big Step A  ← 引用 workflows/xxx.yaml
  │     ├── sub_step_1  ← 一个 agent session，一个 run_id
  │     ├── sub_step_2  ← 另一个 agent session
  │     └── sub_step_N
  │
  ├── Big Step B  ← 引用 workflows/yyy.yaml
  │     └── ...
  │
  └── Big Step C
        └── ...
```

### 2.3 并发模型

```
Workflow A (实例1)   Workflow A (实例2)   Workflow B (实例1)
    │                    │                    │
 big_step_1 串行     big_step_1 串行     big_step_1 串行
    ↓                    ↓                    ↓
 big_step_2 串行     big_step_2 串行     big_step_2 串行
    ↓                    ↓                    ↓
 big_step_3 串行     big_step_3 串行     big_step_3 串行
```

- **同一 workflow 实例内**：big_step 串行，sub_step 串行
- **不同实例之间**：完全并行
- **不同 workflow 之间**：完全并行
- **受 worker pool 上限约束**（默认最多 3 个 agent session 同时运行）

---

## 3. Big Step YAML 规范

### 3.1 完整示例

```yaml
# workflows/send_email.yaml
name: send_email
version: "1.0"
description: "发送一封邮件（获取原文 → 编辑草稿 → 获取草稿 → 发送）"
timeout_minutes: 10          # 整个 big_step 的最大时长
max_retries: 2               # 失败后最多重试次数（整个 big_step 重来）

sub_steps:
  - id: get_original
    description: "根据用户提供的线索找到原始邮件，获取邮件原文和 messageId"
    on_success: edit_draft
    on_failure: abort
    expect_payload: true
    payload_keys: ["original_body", "message_id"]

  - id: edit_draft
    description: "基于原始邮件内容编辑回复草稿"
    on_success: get_draft
    on_failure: abort
    inherit_payload: true      # 继承上一步的 payload

  - id: get_draft
    description: "获取草稿邮件的正文和草稿 ID"
    on_success: send_draft
    on_failure: abort
    expect_payload: true
    payload_keys: ["draft_body", "draft_id"]

  - id: send_draft
    description: "发送草稿邮件"
    on_success: done
    on_failure: abort
    expect_payload: true
    payload_keys: ["sent_message_id"]
    validation:                          # 硬代码验证：agent 说完成但我不信
      - type: payload_has_key
        key: sent_message_id
      - type: payload_value_matches
        key: sent_message_id
        regex: "^[A-Za-z0-9]+@.+$"
```

### 3.2 字段说明

| 字段 | 层级 | 说明 |
|------|------|------|
| `name` | big_step | 唯一标识，用于 composition 引用 |
| `timeout_minutes` | big_step | 整个 big_step 超时时间，超时后整个 big_step 标记 failed |
| `max_retries` | big_step | 失败后最多重试次数（从第一个 sub_step 重新开始） |
| `sub_steps` | big_step | 子步骤列表，串行执行 |
| `sub_steps[].id` | sub_step | 唯一标识 |
| `sub_steps[].description` | sub_step | 注入给 agent 的任务描述 |
| `sub_steps[].on_success` | sub_step | 成功后路由到哪个 sub_step ID，或 `done`（big_step 完成） |
| `sub_steps[].on_failure` | sub_step | 失败后路由：`abort` / `retry` / 指定 sub_step ID |
| `sub_steps[].expect_payload` | sub_step | agent 是否必须通过 `--payload` 传递数据 |
| `sub_steps[].payload_keys` | sub_step | 必须包含的 payload key 列表 |
| `sub_steps[].inherit_payload` | sub_step | 是否继承上一步的 payload（默认 false） |
| `sub_steps[].validation` | sub_step | 硬代码验证规则列表 |

---

## 4. Composition YAML 规范

### 4.1 示例

```yaml
# compositions/customer_onboarding.yaml
name: customer_onboarding
version: "1.0"
description: "新客户入职流程"

concurrency:
  max_parallel_instances: 5        # 同一 workflow 最多同时跑 5 个实例

big_steps:
  - ref: send_email                 # 引用 workflows/send_email.yaml
    on_success: create_account
    on_failure: notify_admin

  - ref: create_account             # 引用 workflows/create_account.yaml
    on_success: setup_permissions
    on_failure: notify_admin

  - ref: setup_permissions
    on_success: send_welcome
    on_failure: notify_admin

  - ref: send_welcome               # 又一个发邮件，但可能是不同模板
    on_success: done
    on_failure: abort
```

### 4.2 启动方式

```bash
# Orchestrator 启动一个 workflow 实例
openry-orchestrator start customer_onboarding

# 或通过 API
curl -X POST http://localhost:9510/workflows/customer_onboarding/start
```

---

## 5. Orchestrator 巡查循环

### 5.1 主循环（每 5 秒一轮）

```
┌─────────────────────────────────────────────────────────┐
│                  Orchestrator 巡查循环                     │
│                                                          │
│  while True:                                             │
│      1. 收割僵尸子进程 (os.waitpid WNOHANG)               │
│      2. 扫描 queued 任务 → 有空闲 slot → spawn 子进程      │
│      3. 扫描 in_progress 超过 30min → 重置为 queued        │
│      4. 扫描 completed 待验证 → 执行 validation            │
│      5. 扫描 validated → 根据 YAML 激活 next_step          │
│      6. 扫描 failed + 有重试次数 → 重置为 queued           │
│      7. sleep(5)                                         │
└─────────────────────────────────────────────────────────┘
```

### 5.2 状态流转

```
                         Orchestrator 创建任务
                                │
                                ▼
                          ┌──────────┐
                          │  queued   │
                          └─────┬────┘
                                │ 有空闲 worker slot
                                ▼
                     ┌───────────────┐
                     │  in_progress  │ ← agent 正在工作
                     └───────┬───────┘
              ┌──────────────┼──────────────┐
              │              │              │
         agent 调        超时 30 分钟    agent 调
      --status completed  无响应       --status failed
              │              │              │
              ▼              ▼              ▼
        ┌──────────┐  ┌──────────┐  ┌──────────┐
        │completed │  │ queued   │  │ failed   │
        │(待验证)   │  │(重新调度) │  │          │
        └────┬─────┘  └──────────┘  └────┬─────┘
             │                           │
     orchestrator 执行                    │ 还有重试次数？
     validation 规则                      │
        ┌────┴────┐                  ┌───┴───┐
        │         │                  │       │
        ▼         ▼                  ▼       ▼
   ┌────────┐ ┌────────┐      ┌────────┐ ┌──────┐
   │validated│ │failed  │      │ queued │ │failed│
   │        │ │(验证   │      │(重试)  │ │(耗尽)│
   │        │ │ 不通过) │      └────────┘ └──────┘
   └───┬────┘ └────────┘
       │
  orchestrator 读 YAML
  激活 next_step
       │
       ▼
   ┌──────────┐
   │ queued   │  ← 下一个 sub_step 入队
   └──────────┘
```

### 5.3 Orchestrator 的 SQL 查询

```sql
-- 查找待调度的任务
SELECT * FROM task_state 
WHERE status = 'queued' 
ORDER BY created_at ASC 
LIMIT 1;

-- 查找僵死任务
SELECT * FROM task_state 
WHERE status = 'in_progress' 
  AND updated_at < datetime('now', '-30 minutes');

-- 查找待验证任务
SELECT * FROM task_state 
WHERE status = 'completed' 
  AND validation_status = 'pending';

-- 统计当前 in_progress 数量（用于 worker pool 限流）
SELECT COUNT(*) FROM task_state WHERE status = 'in_progress';
```

---

## 6. Agent Session 管理（子进程生命周期）

### 6.1 数据结构

```python
# Orchestrator 内存中维护
active_sessions: dict[str, SessionInfo] = {
    "run_id_aaa": SessionInfo(
        pid=12345,
        workflow="customer_onboarding",
        step_id="get_original",
        started_at=datetime(...),
        openclaw_session_id="xxx"
    ),
}
```

### 6.2 防护机制

| 机制 | 说明 |
|------|------|
| **Worker Pool 上限** | `max_workers` 可配置（默认 3），超过则排队 |
| **PID 追踪** | 所有活跃子进程 PID 记录在内存 + SQLite |
| **心跳超时 30min** | `task_state.updated_at` 超过 30 分钟未更新 → 判定僵死 |
| **优雅关闭** | SIGTERM → 等 10s → SIGKILL |
| **僵尸收割** | 每轮循环 `os.waitpid(-1, WNOHANG)` |
| **孤儿清理** | Orchestrator 启动时扫描：`in_progress` 但 PID 不存在 → 重置 `queued` |
| **优雅退出** | Orchestrator 收到 SIGINT/SIGTERM → 遍历所有子进程 → kill → 写 DB → 退出 |
| **资源限制** | 可选：`resource.setrlimit()` 限制子进程 CPU/内存（Linux only） |

### 6.3 启动 Agent Session

```python
def spawn_agent_session(run_id: str, workflow: str, step_id: str, task_description: str):
    env = os.environ.copy()
    env["OPENRY_RUN_ID"] = run_id
    env["OPENRY_WORKFLOW"] = workflow
    env["OPENRY_STEP_ID"] = step_id
    
    # 通过 openclaw CLI 启动 agent session（或其他 agent 框架）
    proc = subprocess.Popen(
        ["openclaw", "session", "start", "--task", task_description],
        env=env,
        # ... 
    )
    
    active_sessions[run_id] = SessionInfo(pid=proc.pid, ...)
    update_task_state(run_id, status="in_progress")
```

---

## 7. Validation 验证引擎

### 7.1 设计理念

Agent 调用 `openry --status completed` 只代表 agent **自称**完成了。Orchestrator 必须通过硬代码验证规则来确认。

### 7.2 验证规则类型

| type | 说明 | 参数 |
|------|------|------|
| `payload_has_key` | payload 必须包含指定 key | `key: "message_id"` |
| `payload_value_matches` | payload 值必须匹配正则 | `key`, `regex` |
| `file_exists` | 指定文件必须存在 | `path: "/data/output.txt"` |
| `file_contains` | 文件内容必须包含指定字符串 | `path`, `contains` |
| `command` | 执行命令，exit_code=0 才算通过 | `run: "grep -q 'OK' /tmp/result.txt"` |
| `command_output_contains` | 命令输出必须包含指定文本 | `run`, `contains` |
| `db_query` | SQL 查询返回行数 > 0 | `query: "SELECT 1 FROM ..."` |

### 7.3 验证流程

```python
def validate_step(run_id: str, step_config: dict) -> bool:
    if "validation" not in step_config:
        return True  # 无验证规则 = 直接通过
    
    for rule in step_config["validation"]:
        if rule["type"] == "payload_has_key":
            payload = get_payload(run_id)
            if rule["key"] not in payload:
                return False
        elif rule["type"] == "file_exists":
            if not os.path.exists(rule["path"]):
                return False
        elif rule["type"] == "command":
            result = subprocess.run(rule["run"], shell=True, ...)
            if result.returncode != 0:
                return False
        # ... etc
    
    return True
```

---

## 8. Payload 传递机制

### 8.1 数据流

```
sub_step_1 (get_original)
  agent 调: openry --status completed --payload '{"message_id":"abc","original_body":"..."}'
  task_state.payload = {"message_id":"abc","original_body":"..."}

sub_step_2 (edit_draft) inherit_payload: true
  orchestrator 注入到 agent session:
  环境变量 OPENRY_INHERITED_PAYLOAD = '{"message_id":"abc","original_body":"..."}'
  同时写入 task 描述中

sub_step_3 (get_draft)
  agent 调: openry --status completed --payload '{"draft_id":"xyz","draft_body":"..."}'
  task_state.payload += {"draft_id":"xyz","draft_body":"..."}
  如果 inherit_payload: true，则合并上一步 payload

sub_step_4 (send_draft)
  orchestrator 注入完整 payload: message_id + draft_id + draft_body
```

### 8.2 Payload 合并规则

- `inherit_payload: true`：当前 payload = 上一步 payload ∪ 当前 agent 提交的 payload
- `inherit_payload: false`（默认）：当前 payload = 仅 agent 提交的 payload

---

## 9. 增强的 SQLite 表结构

Phase 2 在 Phase 1 的基础上新增以下表：

```sql
-- Workflow 实例表：一次 workflow 启动 = 一行
CREATE TABLE IF NOT EXISTS workflow_instances (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    composition     TEXT NOT NULL,                     -- composition 名称
    status          TEXT NOT NULL DEFAULT 'running',    -- running | completed | failed
    current_big_step TEXT,                             -- 当前正在执行的 big_step ref
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- task_state 表新增字段（Phase 1 基础上扩展）
-- 增加字段（通过 ALTER 或重建）：

-- task_state 扩展：
--   big_step_ref    TEXT,        -- 所属 big step 的 ref 名称
--   sub_step_id     TEXT,        -- 当前 sub_step ID（替换原来的 step_id）
--   retry_count     INTEGER DEFAULT 0,
--   max_retries     INTEGER DEFAULT 0,
--   validation_status TEXT DEFAULT 'pending',  -- pending | passed | failed
--   workflow_instance_id INTEGER,  -- 关联 workflow_instances.id

-- Worker Pool 状态表
CREATE TABLE IF NOT EXISTS worker_pool (
    slot_id     INTEGER PRIMARY KEY,
    run_id      TEXT,
    pid         INTEGER,
    allocated_at TEXT
);

-- Validation 结果表
CREATE TABLE IF NOT EXISTS validation_results (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      TEXT NOT NULL,
    rule_type   TEXT NOT NULL,
    rule_params TEXT,
    passed      INTEGER NOT NULL,
    message     TEXT,
    checked_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

---

## 10. Orchestrator CLI

### 10.1 命令

```bash
# 启动 orchestrator 守护进程
openry-orchestrator serve --max-workers 3 --port 9510

# 启动一个 workflow 实例
openry-orchestrator start customer_onboarding

# 查看所有 workflow 实例状态
openry-orchestrator list

# 查看某个 run_id 的详情
openry-orchestrator inspect <run_id>

# 手动重试失败的 step
openry-orchestrator retry <run_id>

# 手动 kill 某个 agent session
openry-orchestrator kill <run_id>

# 查看 worker pool 使用情况
openry-orchestrator workers
```

---

## 11. 扩展性考虑

### 11.1 Plugin 激活方式（后期）

当前方案是 Orchestrator 轮询 SQLite 发现 queued 任务后 spawn 子进程。后期可改为：

- Orchestrator 暴露 HTTP/gRPC API
- OpenCLaw plugin 监听 API，收到任务后主动激活 session
- 好处：不需要 orchestrator 管理子进程，解耦更彻底

### 11.2 分布式支持（远期）

- SQLite 替换为 PostgreSQL
- Orchestrator 多实例部署 + 分布式锁
- 任务队列用 Redis/RabbitMQ

---

## 12. Phase 1 → Phase 2 衔接点

Phase 1 的 openry 需要为 Phase 2 预留以下接口（但不实现）：

| Phase 1 预留 | Phase 2 使用 |
|-------------|-------------|
| `commands_log` 表中的 `run_id`, `workflow`, `step_id` 字段 | Orchestrator 按 run_id 查询命令历史 |
| `task_state` 表中的 `status`, `payload` 字段 | Orchestrator 巡查 + validation 读取 |
| 环境变量 `OPENRY_RUN_ID`, `OPENRY_WORKFLOW`, `OPENRY_STEP_ID` | Orchestrator 注入 |
| `openry --status completed/failed --payload` | Agent 声明完成，触发 Orchestrator 巡查 |

Phase 1 只需把这四个接口做稳、做对，Phase 2 的 Orchestrator 就能无缝接上。
