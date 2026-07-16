# OpenRY — Phase 2 设计文档：Workflow 编排引擎

> 版本：2.0  
> 日期：2026-07-16  
> 状态：设计讨论稿，已与 Phase 1 对齐，细化重试/超时/软刹车/验证等机制

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
timeout_minutes: 10          # 单次尝试（从 sub_step_1 开始）的最大时长，重试不重置
max_retries: 2               # big_step 级别：失败后最多重试次数（从 sub_step_1 重来）

sub_steps:
  - id: get_original
    kind: agent               # agent | shell（Phase 2 默认 agent，shell 延后 Phase 3）
    description: "根据用户提供的线索找到原始邮件，获取邮件原文和 messageId"
    on_success: edit_draft
    on_failure: abort
    max_tool_calls: 15        # 本 sub_step 最多调用 openry 15 次，超过则判定失败
    expect_payload: true
    payload_keys: ["original_body", "message_id"]
    command_policy:           # 命令白名单/黑名单（可选）
      mode: blocklist
      commands: ["rm", "sudo", "chmod", "kill"]

  - id: edit_draft
    kind: agent
    description: "基于原始邮件内容编辑回复草稿"
    on_success: get_draft
    on_failure: retry          # 只重试当前 sub_step，不计入 big_step 的 max_retries
    max_sub_step_retries: 3    # sub_step 级别最大重试次数，耗尽后升级为 abort
    max_tool_calls: 20
    inherit_payload: true      # 继承上一步的 payload

  - id: get_draft
    kind: agent
    description: "获取草稿邮件的正文和草稿 ID"
    on_success: send_draft
    on_failure: abort
    max_tool_calls: 10
    expect_payload: true
    payload_keys: ["draft_body", "draft_id"]

  - id: send_draft
    kind: agent
    description: "发送草稿邮件"
    on_success: done
    on_failure: abort
    on_validation_fail: retry_current   # 验证失败 ≠ 执行失败，可单独路由
    max_tool_calls: 10
    max_output_tokens: 800000            # 输出超 token 阈值（可选）
    on_output_overflow: overflow_handler # 超 token 时跳转的 big_step ref
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
| `timeout_minutes` | big_step | 单次尝试（从 sub_step_1 开始）的最大时长。**重试不重置计时器**，从 big_step 启动开始持续计时 |
| `max_retries` | big_step | big_step 级别：失败后最多重试次数（从 sub_step_1 重新开始）。见 8.3 节 |
| `sub_steps` | big_step | 子步骤列表，串行执行 |
| `sub_steps[].id` | sub_step | 唯一标识 |
| `sub_steps[].kind` | sub_step | `agent`（默认）：spawn agent session 执行 / `shell`：直接执行命令（Phase 3 支持） |
| `sub_steps[].description` | sub_step | 注入给 agent 的任务描述 |
| `sub_steps[].on_success` | sub_step | 成功后路由到哪个 sub_step ID，或 `done`（big_step 完成） |
| `sub_steps[].on_failure` | sub_step | 失败后路由：`abort`（触发 big_step 级别重试）/ `retry`（只重试当前 sub_step）/ 指定 sub_step ID |
| `sub_steps[].max_sub_step_retries` | sub_step | 当 `on_failure: retry` 时，sub_step 级别最大重试次数。耗尽后升级为 `abort` |
| `sub_steps[].max_tool_calls` | sub_step | 本 sub_step 最多调用 openry 的次数（含 `-c` 和 `--status`），超过则判定失败。防止 agent 无限循环 |
| `sub_steps[].command_policy` | sub_step | 命令白名单/黑名单：`mode: unrestricted\|allowlist\|blocklist` + `commands: [...]`。见 6.4 节 |
| `sub_steps[].max_output_tokens` | sub_step | 单次 openry -c 返回内容的最大 token 数（可选）。超过触发 overflow 机制。见 8.5 节 |
| `sub_steps[].on_output_overflow` | sub_step | 超 token 时跳转到哪个 big_step ref。见 8.5 节 |
| `sub_steps[].expect_payload` | sub_step | agent 完成时**是否必须**通过 `--payload` 提交数据。与 payload 传递无关 |
| `sub_steps[].payload_keys` | sub_step | 必须包含的 payload key 列表（"至少包含"语义，属于硬验证范畴） |
| `sub_steps[].inherit_payload` | sub_step | 是否继承上一步的 payload（默认 false）。见 8.2 节 |
| `sub_steps[].validation` | sub_step | 硬代码验证规则列表。见 7 节 |
| `sub_steps[].on_validation_fail` | sub_step | 验证失败后的路由：`retry_current`（默认）/ `abort` / 指定 sub_step ID |

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
┌──────────────────────────────────────────────────────────────┐
│                  Orchestrator 巡查循环                          │
│                                                               │
│  while True:                                                  │
│      1. 收割僵尸子进程 (os.waitpid WNOHANG)                     │
│      2. 扫描 big_step 超时 → 软刹车（设 cancel_requested）       │
│      3. 扫描 in_progress → 检查 max_tool_calls 是否超限          │
│      4. 扫描 queued 任务 → 有空闲 slot → spawn 子进程            │
│      5. 扫描 in_progress 超过僵死阈值 → 重置为 queued            │
│      6. 扫描 completed 待验证 → 执行 validation                 │
│      7. 扫描 validated → 根据 YAML 激活 next_step               │
│      8. 扫描 cancelled → 硬刹车 SIGTERM → 等 5s → SIGKILL       │
│      9. 扫描 overflow → 触发 overflow_workflow                  │
│     10. 扫描 overflow_completed → 恢复原 sub_step（重新 spawn）   │
│     11. 扫描 failed + 有重试次数 → 重置为 queued（重试）          │
│     12. sleep(5)                                              │
└──────────────────────────────────────────────────────────────┘
```

> **扫描顺序说明**：所有扫描按上述顺序**串行**执行，每一轮遍历所有相关记录。由于都是 SQLite 本地查询，全表扫描也很快（几百行以内）。不需要并行扫描。

### 5.2 超时检测与软刹车

当 big_step 超过 `timeout_minutes`（从 big_step 第一个 sub_step 开始时计时，**永不重置**）：

```
Orchestrator 检测到 big_step 超时
        │
        ▼
  设置 task_state.cancel_requested = True
  （不直接杀进程，等 agent 下一次调 openry）
        │
        ▼
  agent 调 openry --command '...'
        │
        ▼
  openry 查 DB：发现 cancel_requested = True
  openry 在返回给 agent 的 stdout 内容中注入停止消息：
  
  "[OPENRY] ⛔ CANCEL REQUESTED: The orchestrator has cancelled this task.
   Please finish your current thought and call:
   openry --status cancelled"
        │
        ▼
  agent 看到注入消息，主动调用 openry --status cancelled
        │
        ▼
  Orchestrator 扫描到 status = cancelled
  执行硬刹车：SIGTERM → 等 5s → SIGKILL
  更新 task_state 为 failed (timeout)
```

> **性能说明**：openry -c 每次执行时查询 `cancel_requested`，但 Phase 1 已经要写 `commands_log`，DB 连接本就存在。一次 SELECT（有索引，WAL 模式）耗时 <0.1ms。建议加进程内缓存：首次查后缓存，仅在值为 False 时下次刷新。

### 5.2b max_tool_calls 检测（防止 agent 无限循环）

```sql
-- 统计当前 sub_step 的 openry 调用次数
SELECT COUNT(*) FROM commands_log 
WHERE run_id = ?;
```

如果计数超过 `max_tool_calls`，Orchestrator 标记该 sub_step 为 failed，理由：`max_tool_calls exceeded`。

### 5.2c Output Overflow 机制（超 token 控制）

当 `openry -c` 返回内容超过 `max_output_tokens` 阈值时：

```
agent 调: openry -c 'cat /var/log/huge.log'
                │
                ▼
        openry 执行命令，输出 1,200,000 tokens
        超过 max_output_tokens (800,000)
                │
                ▼
        openry 将原始输出保存到文件（如 .openry/overflow/{run_id}.raw）
        返回给 agent 的 stdout 中注入：
        
        "[OPENRY] ⚠ OUTPUT OVERFLOW: 1,200,000 tokens exceed 800,000 limit.
         Raw output saved. Please call: openry --status overflow"
                │
                ▼
        agent 看到注入消息，调用 openry --status overflow
                │
                ▼
        task_state.status = "overflow"
                │
                ▼
        Orchestrator 扫描到 status=overflow
        读取 sub_step 的 on_output_overflow 配置
        生成 overflow workflow 实例（引用指定的 big_step）
        当前 agent session 被暂停（软刹车，不硬杀）
                │
                ▼
        overflow workflow 执行（切片 → 压缩/总结）
        完成后，结果写入原 run_id 的 payload：
        payload.overflow_summary = "..." 
                │
                ▼
        task_state.status = "overflow_completed"
                │
                ▼
        Orchestrator 重新 spawn 原 sub_step 的 agent session
        新 prompt = 原 description + 上轮会话摘要 + overflow 结果
        （上下文保留策略见 5.2d）
```

> **关键设计点**：
> 1. openry 不卡住 agent——立即返回 overflow 通知，和软刹车同样模式
> 2. `on_output_overflow` 配置决定跳转到哪个 big_step
> 3. overflow workflow 是独立 workflow 实例，有自己的 run_id
> 4. overflow 完成后，结果写入原 run_id 的 payload，Orchestrator 重新 spawn agent session

### 5.2d Overflow 恢复时的上下文保留

overflow workflow 完成后，原 sub_step 需要恢复执行。Phase 2 采用**简化方案**：重新 spawn agent session，prompt 中包含 overflow 结果。

```
重新 spawn 的 agent session 收到的 prompt：
  ┌─────────────────────────────────────────────┐
  │ 1. 原始 task description                     │
  │ 2. "输出超限处理结果："                        │
  │    [overflow workflow 返回的 payload]          │
  │ 3. "请基于以上信息继续完成任务。"               │
  └─────────────────────────────────────────────┘
```

> **Phase 3 深化**：从 `commands_log` 提取完整历史工具调用上下文 → 写入 payload → overflow workflow 压缩历史上下文 + 原始输出 → 回传后完整恢复。详见 `design/phase3-advanced.md` §7.4。

### 5.3 状态流转（完整版）

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
          ┌──────────────┬───┴───────────┬──────────────┐
          │              │               │              │
     agent 调         big_step       僵死超时       agent 调
  --status completed  超时(软刹车)  (可配置阈值)  --status failed
          │              │               │              │
          ▼              ▼               ▼              ▼
    ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
    │completed │  │cancel_   │  │ queued   │  │ failed   │
    │(待验证)   │  │requested │  │(重新调度) │  │          │
    └────┬─────┘  └────┬─────┘  └──────────┘  └────┬─────┘
         │             │                           │
  validation      agent 看到                     还有重试次数？
     ┌───┴───┐     注入消息后                       ┌───┴───┐
     │       │     调 cancelled                    │       │
     ▼       ▼         │                          ▼       ▼
┌────────┐┌────────┐   ▼                    ┌────────┐┌──────┐
│validated││failed │┌──────────┐            │ queued ││failed│
│        ││(验证  ││cancelled │            │(重试)  ││(耗尽)│
│        ││不通过) │└────┬─────┘            └────────┘└──────┘
└───┬────┘└────────┘     │
    │              Orchestrator 硬刹车
    │              SIGTERM → 5s → SIGKILL
    │                     │
    │                     ▼
    │               ┌──────────┐
    │               │ failed   │
    │               │(timeout) │
    │               └──────────┘
    │
  orchestrator 读 YAML
  激活 next_step
    │
    ▼
┌──────────┐
│ queued   │  ← 下一个 sub_step 入队（新 run_id）
└──────────┘
```

### 5.4 failed 状态的处理——失败耗尽计算

```
sub_step 失败，且 on_failure = abort
        │
        ▼
  big_step_retry_count += 1
        │
        ├── big_step_retry_count <= max_retries?
        │       │
        │       YES → 重置到 sub_step_1，重新入队 queued
        │       NO  → 标记 big_step = failed（耗尽）
        │              通知 composition 级别的 on_failure 路由
        │
        ▼
```

> **注意**：`max_retries` 决定的是 big_step 级别重试次数。`max_sub_step_retries` 是 sub_step 级别的独立计数器，见 8.3 节。

### 5.5 无验证规则时 completed → next_step 的逻辑

如果 sub_step 没有配置 `validation` 和 `payload_keys`，`completed` 直接视为 `validated`：

```python
def handle_completed(run_id):
    step_config = get_step_config(run_id)
    
    # 1. expect_payload 检查
    if step_config.get("expect_payload") and not get_payload(run_id):
        mark_failed(run_id, "expect_payload=True but no payload")
        return
    
    # 2. payload_keys 检查（隐式验证）
    for key in step_config.get("payload_keys", []):
        if key not in get_payload(run_id):
            mark_failed(run_id, f"missing required payload key: {key}")
            return
    
    # 3. 显式 validation 规则
    if step_config.get("validation"):
        if not run_validation(run_id, step_config["validation"]):
            mark_failed(run_id, "validation failed")
            return
    
    # 全部通过 → 直接路由到 next_step
    mark_validated(run_id)
    next_step_id = step_config["on_success"]
    enqueue_next_sub_step(run_id, next_step_id)
```

### 5.6 僵死检测可配置

僵死检测阈值从硬编码 30 分钟改为可配置：

```yaml
# .openry/config.yaml（全局配置）
orchestrator:
  patrol_interval_seconds: 5    # 巡查间隔
  zombie_timeout_minutes: 30    # in_progress 超过此时间无响应 → 重置 queued
  grace_shutdown_seconds: 5     # SIGTERM 后等待时间
  max_workers: 3                # worker pool 上限
```

### 5.7 Orchestrator 的 SQL 查询

```sql
-- 查找待调度的任务
SELECT * FROM task_state 
WHERE status = 'queued' 
ORDER BY created_at ASC 
LIMIT 1;

-- 查找超时的 big_step（用于设置 cancel_requested）
SELECT ts.* FROM task_state ts
JOIN workflow_instances wi ON ts.workflow_instance_id = wi.id
WHERE ts.status = 'in_progress'
  AND wi.started_at < datetime('now', '-' || wi.timeout_minutes || ' minutes');

-- 查找僵死任务
SELECT * FROM task_state 
WHERE status = 'in_progress' 
  AND updated_at < datetime('now', '-' || ? || ' minutes');
-- 参数: zombie_timeout_minutes

-- 查找待验证任务
SELECT * FROM task_state 
WHERE status = 'completed' 
  AND validation_status = 'pending';

-- 查找已取消待硬杀的任务
SELECT * FROM task_state 
WHERE status = 'cancelled';

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
| **心跳超时（僵死检测）** | `task_state.updated_at` 超过 `zombie_timeout_minutes`（可配置）未更新 → 判定僵死，重置为 queued |
| **优雅关闭（Orchestrator 退出时）** | Orchestrator 收到 SIGINT/SIGTERM → 遍历所有活跃子进程 → 先 SIGTERM → 等 `grace_shutdown_seconds`（默认 10s）→ SIGKILL → 写 DB → 退出 |
| **优雅关闭（单个 agent 硬刹车）** | cancel 流程的最后一步：SIGTERM → 等 5s → SIGKILL |
| **僵尸收割** | 每轮循环 `os.waitpid(-1, WNOHANG)`：收割已结束但未被 wait 的子进程，防止僵尸进程堆积 |
| **孤儿清理** | Orchestrator 启动时扫描：`in_progress` 但 PID 不存在于系统中 → 重置 `queued` |
| **资源限制** | 可选：`resource.setrlimit()` 限制子进程 CPU/内存（Linux only） |

#### 僵尸收割逻辑详解

```python
# 每轮巡查循环的第一步
def reap_zombies():
    """收割所有已结束但未被 wait 的子进程"""
    while True:
        try:
            pid, exit_status = os.waitpid(-1, os.WNOHANG)
            if pid == 0:
                break  # 没有更多僵尸子进程
            # 从 active_sessions 中移除对应记录
            remove_session_by_pid(pid)
            logger.info(f"Reaped zombie: PID={pid}, exit={exit_status}")
        except ChildProcessError:
            break  # 没有子进程了
```

`os.waitpid(-1, WNOHANG)` 中：
- `-1`：等待任意子进程
- `WNOHANG`：非阻塞，如果没有已结束的子进程则立即返回 (0, 0)
- 如果子进程已结束但父进程未调用 wait，子进程会变成**僵尸进程**（占用 PID 但不消耗 CPU/内存以外的资源）

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

### 6.4 命令策略（command_policy）

openry 在执行命令前检查当前 sub_step 的 `command_policy` 配置，决定是否放行。

#### 三种模式

| mode | 行为 | 适用场景 |
|------|------|---------|
| `unrestricted` | 不拦截任何命令（默认） | 信任 agent 的通用场景 |
| `allowlist` | 只允许列表中指定的命令 | 只读操作、安全敏感场景 |
| `blocklist` | 禁止列表中的命令，其余放行 | 大多数场景，禁止危险命令 |

#### 配置示例

```yaml
# 白名单模式：只允许读操作
command_policy:
  mode: allowlist
  commands: ["ls", "cat", "grep", "find", "wc", "head", "tail"]

# 黑名单模式：禁止危险操作
command_policy:
  mode: blocklist
  commands: ["rm", "sudo", "chmod", "chown", "kill", "shutdown", "reboot"]

# 不限制（默认）
# 不配置 command_policy 即等同于 unrestricted
```

#### 拦截流程

```
agent 调 openry -c 'rm -rf /data/temp'
        │
        ▼
openry 解析命令，提取第一个 token：rm
        │
        ▼
查 sub_step 的 command_policy：
  mode=blocklist, commands=[rm, sudo, ...]
  rm ∈ blocklist → 拒绝执行
        │
        ▼
返回给 agent：
  {"status": "blocked", "reason": "command 'rm' is in blocklist"}
```

> **Phase 3 展望**：支持更细粒度的策略，如正则匹配命令、参数级别控制、按用户角色动态策略。详见 `design/phase3-advanced.md`。

---

## 7. Validation 验证引擎

### 7.1 设计理念

Agent 调用 `openry --status completed` 只代表 agent **自称**完成了。Orchestrator 必须通过硬代码验证规则来确认。

### 7.2 验证规则类型

Phase 2 支持的验证规则：

| type | 说明 | 参数 |
|------|------|------|
| `payload_has_key` | payload 必须包含指定 key | `key: "message_id"` |
| `payload_value_matches` | payload 值必须匹配正则 | `key`, `regex` |
| `payload_values_equal` | payload 中两个 key 的值必须相等 | `key_a`, `key_b`（如验证 `message_id == thread_id`） |
| `file_exists` | 指定文件必须存在 | `path: "/data/output.txt"` |
| `file_contains` | 文件内容必须包含指定字符串 | `path`, `contains` |
| `command` | 执行 shell 命令，exit_code=0 才算通过 | `run: "grep -q 'OK' /tmp/result.txt"` |
| `command_output_contains` | 命令输出（stdout）必须包含指定文本 | `run`, `contains` |
| `db_query` | 对 openry.db 执行 SQL 查询，返回行数 > 0 才算通过 | `query: "SELECT 1 FROM ..."` |

> **延后到 Phase 3 的验证类型**：`payload_values_not_equal`、`payload_value_in_set`、`payload_value_greater_than`、`payload_value_less_than`、`payload_type`、`file_size_greater_than`、`http_status`、`json_schema`。详见 `design/phase3-advanced.md`。

### 7.3 各验证规则详解

#### `payload_values_equal` — 跨 key 值比较

验证 payload 中两个 key 的值是否相同。**不属于 regex 范畴**，是独立的验证类型。

```yaml
validation:
  - type: payload_values_equal
    key_a: message_id
    key_b: thread_id
```

#### `command` — 执行命令验证

执行任意 shell 命令，以 exit_code 判断。常用于调用外部工具验证结果。

```yaml
validation:
  - type: command
    run: "grep -q 'OK' /tmp/result.txt"
```

#### `command_output_contains` — 命令输出内容验证

执行命令后检查 stdout 是否包含指定文本。比 `command` 更精确。

```yaml
validation:
  - type: command_output_contains
    run: "cat /tmp/result.txt"
    contains: "SUCCESS"
```

#### `db_query` — 数据库查询验证

对 openry.db 执行 SELECT 查询，返回行数 > 0 则通过。用于验证 agent 的操作是否在 DB 中留下了预期记录。

```yaml
validation:
  - type: db_query
    query: "SELECT 1 FROM commands_log WHERE run_id = ? AND exit_code = 0"
```

### 7.4 验证能否作为路由？

Phase 2 采用**二值路由**：验证 pass → `on_success`，验证 fail → `on_validation_fail`。足以覆盖大多数场景。

> **延后到 Phase 3**：条件路由（`validation_routing`），根据验证结果的具体值路由到不同的 sub_step。详见 `design/phase3-advanced.md` 第 3 节。

```yaml
- id: send_draft
  on_success: done
  on_failure: abort
  on_validation_fail: retry_current   # 验证失败不同于执行失败
  # 可选值：retry_current / abort / 指定 sub_step_id
```

常见的验证结果路由场景：

| 验证场景 | 验证内容 | 失败路由 |
|---------|---------|---------|
| payload 中 `message_id == thread_id` | 确保 agent 没搞混 | `retry_current`（让 agent 重新确认） |
| 文件存在性检查 | agent 声称创建的文件 | `abort`（文件没创建，彻底失败） |
| 命令输出包含 "SUCCESS" | 外部工具执行结果 | `retry_current` |

### 7.5 验证流程

```python
def validate_step(run_id: str, step_config: dict) -> tuple[bool, str]:
    """
    返回 (passed, failure_reason)
    """
    if not any([
        step_config.get("validation"),
        step_config.get("payload_keys"),
        step_config.get("expect_payload"),
    ]):
        return True, ""  # 无验证规则 = 直接通过
    
    payload = get_payload(run_id)
    
    # 1. expect_payload 检查
    if step_config.get("expect_payload") and not payload:
        return False, "expect_payload=True but no payload provided"
    
    # 2. payload_keys 检查
    for key in step_config.get("payload_keys", []):
        if key not in payload:
            return False, f"missing required payload key: {key}"
    
    # 3. 显式 validation 规则
    for rule in step_config.get("validation", []):
        if rule["type"] == "payload_has_key":
            if rule["key"] not in payload:
                return False, f"payload missing key: {rule['key']}"
        elif rule["type"] == "payload_value_matches":
            value = payload.get(rule["key"], "")
            if not re.match(rule["regex"], str(value)):
                return False, f"value mismatch: {rule['key']}={value}"
        elif rule["type"] == "payload_values_equal":
            if payload.get(rule["key_a"]) != payload.get(rule["key_b"]):
                return False, f"values not equal: {rule['key_a']} vs {rule['key_b']}"
        elif rule["type"] == "file_exists":
            if not os.path.exists(rule["path"]):
                return False, f"file not found: {rule['path']}"
        elif rule["type"] == "file_contains":
            if not os.path.exists(rule["path"]):
                return False, f"file not found: {rule['path']}"
            with open(rule["path"]) as f:
                if rule["contains"] not in f.read():
                    return False, f"file missing content: {rule['contains']}"
        elif rule["type"] == "command":
            result = subprocess.run(rule["run"], shell=True, capture_output=True)
            if result.returncode != 0:
                return False, f"command failed: {rule['run']}"
        elif rule["type"] == "command_output_contains":
            result = subprocess.run(rule["run"], shell=True, capture_output=True, text=True)
            if rule["contains"] not in result.stdout:
                return False, f"output missing: {rule['contains']}"
        elif rule["type"] == "db_query":
            cursor = db.execute(rule["query"])
            if cursor.fetchone() is None:
                return False, f"db query returned no rows: {rule['query']}"
    
    return True, ""
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

### 8.3 重试语义：两级 retry 详解

#### big_step 级别 vs sub_step 级别

| | big_step 级别 retry | sub_step 级别 retry |
|---|---|---|
| **触发条件** | 任何 sub_step `on_failure: abort` 或 timeout | 当前 sub_step 失败且 `on_failure: retry` |
| **重试范围** | 从 sub_step_1 重新开始整个 big_step | 只重试当前这一个 sub_step |
| **计数器** | `big_step_retry_count` | `sub_step_retry_count`（独立） |
| **上限配置** | `max_retries`（big_step YAML 字段） | `max_sub_step_retries`（sub_step YAML 字段） |
| **耗尽后行为** | big_step 标记 failed | 升级为 `abort`，触发 big_step 级别 retry |
| **计时器** | 不重置（方案 A） | 不影响 big_step 计时器 |

#### 流程图

```
sub_step_2 (edit_draft) 执行中...
        │
        ▼
    失败了
        │
        ▼
  on_failure = ?
    ┌──────┴──────────┐
    │                 │
  retry             abort
    │                 │
    ▼                 ▼
sub_step_retry    big_step_retry_count += 1
_count += 1       重置到 sub_step_1，入队 queued
    │
    ▼
sub_step_retry_count <= max_sub_step_retries?
    ┌──────┴──────┐
    │             │
   YES           NO (耗尽)
    │             │
    ▼             ▼
重试当前         升级为 abort
sub_step_2       → big_step_retry_count += 1
(不入队新任务，    从 sub_step_1 重来
仅重新 spawn)

```

### 8.4 超时计时详解（方案 A）

```
T=0min    sub_step_1 (get_original) 开始，big_step_started_at 记录，永不修改
T=3min    sub_step_1 完成 ✅ → sub_step_2 (edit_draft) 开始
T=5min    sub_step_2 失败 (on_failure: abort)
          → big_step_retry_count = 1，从 sub_step_1 重新开始（计时器继续走！）
T=7min    sub_step_1 完成 ✅ → sub_step_2 开始
T=9min    sub_step_2 又失败 → big_step_retry_count = 2，再次从 sub_step_1 开始
T=9.5min  sub_step_1 正在跑...
T=10min   ⏰ 超时！big_step 超时（timeout_minutes=10）
          → Orchestrator 设 cancel_requested = True（软刹车）
          → agent 看到后调 --status cancelled
          → 硬刹车 SIGTERM → SIGKILL
          → big_step 标记 failed (timeout)
```

> **方案 A 的核心思想**：计时器是**不可变起点**，代码最简洁。用户配置 `timeout_minutes` 时需要把重试耗时也算进去。

### 8.5 Output Overflow 流程（超 token 控制）

完整的 overflow 生命周期：

```
┌─────────────────────────────────────────────────────────┐
│  原 sub_step (run_id=abc)                               │
│                                                          │
│  agent 调 openry -c 'cat huge.log'                       │
│    → openry 检测输出 > max_output_tokens                 │
│    → 保存原始输出，返回 overflow 通知                     │
│    → agent 调 --status overflow                         │
│    → task_state.status = "overflow"                      │
│    → Orchestrator 软暂停 agent session                   │
│                                                          │
├─────────────────────────────────────────────────────────┤
│  overflow_workflow (新 run_id=xyz, 独立实例)              │
│                                                          │
│  sub_step_1: 按 chunk_size 切片原始输出                   │
│  sub_step_2: 逐片调用 LLM/脚本做摘要                      │
│  sub_step_3: 合并所有摘要                                │
│  → 结果写入 abc 的 payload.summarized_output              │
│  → task_state(abc).status = "overflow_completed"         │
│                                                          │
├─────────────────────────────────────────────────────────┤
│  原 sub_step 恢复 (run_id=abc)                           │
│                                                          │
│  Orchestrator 重新 spawn agent session                   │
│  prompt = description + 上轮摘要 + summarized_output     │
│  agent 继续完成任务                                      │
└─────────────────────────────────────────────────────────┘
```

配置关联：

```yaml
# 原 sub_step 中：
- id: analyze_log
  max_output_tokens: 800000
  on_output_overflow: log_overflow_handler   # 跳转目标

# workflows/log_overflow_handler.yaml（独立 big_step）
name: log_overflow_handler
sub_steps:
  - id: slice_raw
    kind: shell                    # Phase 3 支持
    command: "python -m /scripts/slice.py --input $OVERFLOW_RAW --chunk 500000"
  - id: summarize_chunks
    kind: agent
    description: "对每个切片做摘要"
  - id: merge_summaries
    kind: shell
    command: "python -m /scripts/merge.py"
```

> 用户也可以完全自己设计 overflow workflow——用 agent 做总结，或者纯 shell 裁剪，或者调用外部 API。我们只提供触发能力和跳转机制。

---

## 9. 增强的 SQLite 表结构

Phase 2 在 Phase 1 的基础上新增以下表：

```sql
-- Workflow 实例表：一次 workflow 启动 = 一行
CREATE TABLE IF NOT EXISTS workflow_instances (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    composition         TEXT NOT NULL,                     -- composition 名称
    status              TEXT NOT NULL DEFAULT 'running',    -- running | completed | failed
    current_big_step    TEXT,                              -- 当前正在执行的 big_step ref
    big_step_started_at TEXT,                              -- 当前 big_step 开始时间（超时计时起点）
    timeout_minutes     INTEGER DEFAULT 10,                -- 当前 big_step 的超时配置
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- task_state 表扩展（Phase 1 基础上新增字段）
-- 新增字段：
--   big_step_ref           TEXT,       -- 所属 big step 的 ref 名称
--   sub_step_id            TEXT,       -- 当前 sub_step ID
--   big_step_retry_count   INTEGER DEFAULT 0,   -- big_step 级别重试计数
--   max_retries            INTEGER DEFAULT 0,   -- big_step 最大重试次数（从 YAML 读取）
--   sub_step_retry_count   INTEGER DEFAULT 0,   -- sub_step 级别重试计数
--   max_sub_step_retries   INTEGER DEFAULT 0,   -- sub_step 最大重试次数（从 YAML 读取）
--   max_tool_calls         INTEGER DEFAULT 0,   -- sub_step 最多调用 openry 的次数
--   validation_status      TEXT DEFAULT 'pending',  -- pending | passed | failed
--   cancel_requested       INTEGER DEFAULT 0,  -- 软刹车标志
--   output_overflow        INTEGER DEFAULT 0,  -- 输出超 token 标志
--   overflow_workflow_id   INTEGER,           -- overflow workflow 实例 ID
--   workflow_instance_id   INTEGER,           -- 关联 workflow_instances.id
--   on_validation_fail     TEXT,              -- 验证失败后的路由策略
--   on_output_overflow     TEXT,              -- 超 token 跳转的 big_step ref
--   previous_summary       TEXT,              -- 上轮 agent 会话摘要（用于 overflow 恢复）

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

-- Orchestrator 全局配置表
CREATE TABLE IF NOT EXISTS orchestrator_config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
-- 预置默认值：
-- INSERT INTO orchestrator_config VALUES ('zombie_timeout_minutes', '30');
-- INSERT INTO orchestrator_config VALUES ('patrol_interval_seconds', '5');
-- INSERT INTO orchestrator_config VALUES ('grace_shutdown_seconds', '10');
-- INSERT INTO orchestrator_config VALUES ('max_workers', '3');
```

### 9.1 run_id 生命周期

**每个 sub_step 生成一个新的 run_id。** 当一个 sub_step 完成且 validated，下一个 sub_step 入队时会生成全新的 run_id。

```
sub_step_1 (get_original):
  run_id = "abc-123"  ← Orchestrator 生成
  完成后，next_step = sub_step_2

sub_step_2 (edit_draft):
  run_id = "def-456"  ← 新生成，与 abc-123 无关
  ...

sub_step_3 (get_draft):
  run_id = "ghi-789"  ← 新生成
  ...
```

> 这使得每个 sub_step 都有独立的命令历史（通过 run_id 关联 commands_log），便于追踪和调试。

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
