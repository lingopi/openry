# OpenRY 超时机制实战文档

> 版本：1.0
> 日期：2026-08-05
> 基于：WF #8, #13, #14, #15 实测验证
> 持续更新：后续测试如有新发现，追加到本文档

---

## 1. 两层超时总览

```
┌─────────────────────────────────────────────────────────┐
│  Agent sub_step 生命周期                                  │
│                                                         │
│  ① execSync timeout    10 分钟（可配置）                   │
│     TS 插件 openry_run 工具的单次命令执行上限               │
│     超时后返回 "spawnSync /bin/sh ETIMEDOUT"             │
│     → 仅返回错误消息，不改变 task_state 状态               │
│                                                         │
│  ② checkZombies()      10 分钟（updated_at 为基准）        │
│     patrol step 5，检测 updated_at 过期                    │
│     → status = "queued" + killRun() → SIGTERM            │
│     → 进程被杀（退出码 143）→ status = "failed"            │
│     → retryFailed() → status = "dropped"                 │
│                                                         │
│  注：execSync 超时可配置，位置如下：                        │
│    TS: src/index.ts → timeout: 600_000                  │
│    Python: executor.py → timeout: int = 600             │
│    Python: config.py → DEFAULTS["timeout"]["default"]   │
│    Python: cli.py → args.timeout fallback               │
└─────────────────────────────────────────────────────────┘
```

### openclaw --timeout 已禁用

`openclaw --timeout 600` **已于 2026-08-06 禁用**（改为 `--timeout 0`，即不超时）。

原因：`openclaw --timeout` 不会杀进程，而是切换到 embedded 模式并创建全新 session 重新执行任务。这导致长任务（>10 分钟）被反复重置，无法完成。OpenRY 已有 `checkZombies` + `max_tool_calls` 覆盖所有终止场景，不需要此机制。

## 2. 关键机制：心跳（heartbeat）

**每次 agent 调用 `openry -c`，Python CLI 都会刷新 `task_state.updated_at`。**

```python
# openry/cli.py 第 505-511 行
INSERT INTO task_state (run_id, workflow, step_id, status, updated_at)
VALUES (?, ?, ?, 'in_progress', datetime('now'))
ON CONFLICT(run_id) DO UPDATE SET
    updated_at = datetime('now')
```

这意味着：只要 agent 在积极调 `openry_run`，`updated_at` 就永远新鲜，`checkZombies()` 永远不会触发。**10 分钟僵尸时钟从最后一次 `openry -c` 调用开始算起。**

## 3. 实测场景

### 场景 A：进程被杀 → dropped（#13, #14）

```
条件：agent 调了 openry_run { sleep 1200 } 后不再调其他 openry
      此时 openclaw 进程仍活着（--timeout 还没到或退出码=0）

T+0      spawn → updated_at = T+0
T+~5min  agent 做了几轮短命令（心跳刷新 updated_at）
T+~5min  agent 调 openry_run { sleep 1200 }
         此时 updated_at 约 T+5min
         
T+15min  checkZombies() 触发
         → status = "queued"
         → killRun() → SIGTERM
         → 进程被杀 → close 回调: code≠0 → status = "failed" ← 覆盖！
         → retryFailed() → status = "dropped"

终态:    task = dropped, workflow = running（僵尸）
```

### 场景 B：进程已死 → 复活（#15）

```
条件：execSync 和 openclaw --timeout 同时设为 10 分钟
      execSync 超时时心跳刷新了 updated_at
      同时 openclaw --timeout 杀掉了 agent 进程

T+0      spawn
T+~10min execSync 超时 → Python 返回 timeout 响应
         → 心跳刷新 updated_at = now  ← 时钟重置！
         openclaw --timeout 也到期 → agent 进程死
         没人收 ETIMEDOUT，没人调 openry_status

T+20min  checkZombies() 终于触发（心跳后又等了 10 分钟）
         → status = "queued"
         → killRun() → 进程早已死 → no-op
         → "queued" 没被覆盖！close 回调早已执行完
         
T+20min  dispatchQueued() → 重新 spawn agent
         → 新 agent 调 openry_status completed
         → status = validated → done

终态:    task = done, workflow = running（正常完成但 workflow 未关闭）
```

### 场景 C：agent 存活 → 复活（#8）

```
条件：openclaw --timeout 退出码=0，checkZombies 先触发

T+10min  checkZombies() 触发
         → status = "queued"
         → killRun() → SIGTERM
         → openclaw 退出码=0 → close 回调: code=0, 不改 status
         → "queued" 存活！

T+10min  dispatchQueued() → 重新 spawn
         → 新 agent 收到 execSync 的 ETIMEDOUT
         → 调 openry_status completed → done

终态:    task = done
```

## 4. 竞态条件总结

```
checkZombies() 设 queued
        vs
proc.on("close") 的 status 覆盖
```

| close 回调行为 | 结果 |
|:---|:---|
| code=0，不改 status | `queued` 存活 → **重 dispatch** ✅ |
| code≠0，设 failed | `queued` 被覆盖 → `failed` → `dropped` ❌ |
| 进程早已死，close 已执行完 | `queued` 存活 → **重 dispatch** ✅ |

## 5. 已知问题

### 5.1 retry 配置在进程死亡路径不生效

```yaml
on_failure: retry
max_sub_step_retries: 1
```

只在 agent 主动调 `openry --status failed` 时生效。进程被 SIGTERM 杀时：
- close 回调直接设 `failed`
- `retryFailed()` 无条件全量 `dropped`
- `max_sub_step_retries` 从未被读取

### 5.2 僵尸 workflow

`retryFailed()` 把 task 标为 `dropped` 后，不更新 `workflow_instances`。workflow 永远 `running`。

### 5.3 心跳时钟重置

execSync 超时后 Python 的 heartbeat 会刷新 `updated_at`。如果 agent 进程同时死了，任务会在 `in_progress` 多卡 10 分钟。

## 6. 代码位置速查

| 机制 | 文件 | 行号 |
|------|------|------|
| execSync timeout | `orchestrator-plugin/src/index.ts` | `timeout: 600_000` |
| Python run_command timeout | `openry/executor.py` | `timeout: int = 600` |
| Python CLI fallback | `openry/cli.py` | `args.timeout if args.timeout else 600` |
| Config default | `openry/config.py` | `DEFAULTS["timeout"]["default"]` |
| ~~openclaw --timeout~~ | `orchestrator-plugin/src/orchestrator/patrol.ts` | **已禁用**（`--timeout 0`） |
| checkZombies | `orchestrator-plugin/src/orchestrator/patrol.ts` | `checkZombies()` step 5 |
| retryFailed | `orchestrator-plugin/src/orchestrator/patrol.ts` | `retryFailed()` step 11 |
| heartbeat | `openry/cli.py` | 505-511 |
| proc.on("close") agent | `orchestrator-plugin/src/orchestrator/patrol.ts` | `spawnAgentSession()` |
| proc.on("close") shell | `orchestrator-plugin/src/orchestrator/patrol.ts` | `spawnShellSession()` |

## 7. 变更记录

| 日期 | 变更 | 触发测试 |
|------|------|---------|
| 2026-08-06 | **禁用 openclaw --timeout**（改为 `--timeout 0`）。该机制会重置长任务而非终止，与 checkZombies 冲突且无益 | 实测分析 |
| 2026-08-05 | 实测验证退出码：SIGTERM 杀 → 143，openclaw 自超时 → 0（embedded fallback） | #16 |
| 2026-08-05 | 初版，基于 #8, #13, #14, #15 | — |
| 2026-08-05 | execSync/Python timeout 从 5min → 15min → 10min | #8, #13, #14, #15 |
