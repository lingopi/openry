# OpenRY — Phase 3 设计文档：高级特性

> 版本：0.2（草案）  
> 日期：2026-07-16  
> 状态：Phase 2 讨论中持续更新，新增超 token 控制、kind 字段、loop engineering 等方向

---

## 1. 概述

Phase 3 在 Phase 2 的 Workflow 编排引擎之上，增加高级验证、条件路由、kind 字段、超 token 控制深化、loop engineering 等特性。本文档记录 Phase 2 讨论中确认延后的设计要点，Phase 2 完成后细化。

---

## 2. 高级验证规则

Phase 2 只做 `payload_values_equal`，以下验证类型延后到 Phase 3：

| 验证类型 | 用途 | 示例 |
|---------|------|------|
| `payload_values_not_equal` | a != b，确保新旧值不同（agent 确实做了修改） | 修改前后的 hash 不一致 |
| `payload_value_in_set` | a ∈ {x, y, z}，状态值是否在允许的枚举中 | `status` 必须是 `draft/sent/archived` |
| `payload_value_greater_than` | a > b（数值比较），确保计数增加 | 确保 `processed_count > 0` |
| `payload_value_less_than` | a < b | 确保 `error_count < threshold` |
| `payload_type` | 验证 payload 值的类型 | `count` 必须是 int，`name` 必须是 str |
| `file_size_greater_than` | 文件大小验证 | 输出文件 > 0 bytes |
| `http_status` | HTTP 请求返回状态码验证 | `GET /health` 返回 200 |
| `json_schema` | 用 JSON Schema 验证 payload 结构 | 复杂嵌套结构的验证 |

---

## 3. 条件路由（Conditional Routing）

Phase 2 只做二值路由（pass → on_success，fail → on_validation_fail）。Phase 3 引入条件路由，根据验证结果的**具体值**决定下一步。

### 3.1 `validation_routing` 设计草案

```yaml
- id: check_thread_consistency
  description: "验证邮件线程一致性"
  on_success: done
  on_failure: abort
  
  validation_routing:              # 验证结果驱动的条件路由
    - when:                        # 条件 1
        type: payload_values_equal
        key_a: message_id
        key_b: thread_id
      on_match: done               # 一致 → 正常完成
      on_mismatch: fix_thread_id   # 不一致 → 路由到补救步骤

    - when:                        # 条件 2
        type: payload_value_in_set
        key: status
        values: ["draft", "sent"]
      on_match: done
      on_mismatch: abort           # 非法状态 → 失败
```

### 3.2 常见场景

| 场景 | 条件 | 匹配路由 | 不匹配路由 |
|------|------|---------|-----------|
| 线程一致性检查 | message_id == thread_id | done | fix_thread_id |
| 权限验证 | user_role ∈ {admin, editor} | done | request_permission |
| 数据完整性 | record_count > 0 | done | retry_current |

---

## 4. Prompt 工程增强

Phase 2 的 sub_step 描述通过 `description` 字段直接注入 agent。Phase 3 引入 `prompt_blocks` 拼接机制：

### 4.1 设计草案

```yaml
- id: edit_draft
  prompt_blocks:                   # 替代 description
    - type: text
      content: "请基于以下原始邮件编辑回复草稿："
    - type: payload
      key: original_body           # 从 payload 中注入原始邮件内容
    - type: text
      content: "回复风格要求：专业、简洁。"
    - type: file
      path: /templates/reply_style.txt  # 从文件注入模板
```

### 4.2 与 description 的关系

- `description` 保留用于简单场景
- `prompt_blocks` 用于需要动态拼接 prompt 的复杂场景
- 如果两者都存在，`prompt_blocks` 优先

---

## 5. 动作级别控制增强

Phase 2 已实现：`max_tool_calls`、`cancel_requested`（软刹车）、`command_policy`（基础版）。Phase 3 扩展：

| 控制类型 | Phase 2 | Phase 3 |
|---------|:---:|:---:|
| 软刹车 | ✅ cancel_requested 注入消息 | 增强注入机制，支持更多控制信号 |
| 超步数控制 | ✅ max_tool_calls | 按类别分别计数（-c vs --status） |
| 命令策略 | ✅ allowlist/blocklist 基础版 | 正则匹配命令、参数级别控制、动态策略 |
| 自动迭代 | ❌ | agent 调用工具超过 N 次后，自动将上下文喂回 agent |
| 速率限制 | ❌ | agent 调用 openry 的频率限制（防止疯狂重试） |

---

## 6. kind 字段：agent vs shell

Phase 2 的 sub_step 默认 `kind: agent`（spawn agent session）。Phase 3 正式支持 `kind: shell`，让某些步骤直接执行脚本而不启动 agent。

### 6.1 设计

```yaml
# kind: agent（Phase 2 已支持，默认值）
- id: analyze_data
  kind: agent
  description: "分析数据找出异常"
  max_tool_calls: 15

# kind: shell（Phase 3 新增）
- id: compress_logs
  kind: shell
  command: "python -m /scripts/slice_and_summarize.py --input $PAYLOAD_RAW"
  timeout_seconds: 120
  expect_payload: true
  payload_keys: ["compressed_output"]
```

### 6.2 区别

| | kind: agent | kind: shell |
|---|---|---|
| 执行方式 | spawn agent session → agent 调 openry | Orchestrator 直接 subprocess.run |
| 能否调用 openry | 是 | 否（或可选） |
| 适用场景 | 需要 AI 决策的步骤 | 确定性脚本、数据处理 |
| 状态管理 | agent 通过 `--status` 控制 | Orchestrator 根据 exit_code 判断 |
| 超时 | big_step timeout_minutes | 独立的 timeout_seconds |

---

## 7. 超 Token 控制详细设计

### 7.1 完整生命周期

Phase 2 已实现基础框架（`max_output_tokens`、`on_output_overflow`、overflow 通知+跳转）。Phase 3 深化：

```
Phase 2（已设计）                    Phase 3（深化）
─────────────────────────────────────────────────────
openry 检测输出 > 阈值              支持多种阈值策略（total / per-chunk）
返回 overflow 通知                 返回更多元数据（token 计数、文件路径）
agent 调 --status overflow         自动检测（agent 无需手动调）
跳转 overflow_workflow             支持多个 overflow 策略（按输出类型）
overflow 完成 → 重新 spawn         上下文保留增强（完整 session resume）
```

### 7.2 配置增强

```yaml
# Phase 3 的 overflow 配置
- id: analyze_data
  overflow_policy:
    max_output_tokens: 800000      # 阈值
    max_output_tokens_pct: 0.8     # 或按模型上下文的百分比
    strategy: workflow             # workflow | truncate | paginate
    workflow_ref: overflow_handler # strategy=workflow 时跳转目标
    auto_resume: true              # overflow 完成后自动恢复（无需 agent 手动操作）
```

### 7.3 默认 Overflow Workflow

Phase 3 提供一个内置的基础切片压缩 workflow：

```
.openry/builtin/overflow_default.yaml

sub_step_1 (shell): 按 chunk_size 切片原始输出
sub_step_2 (agent): 逐片调用 LLM 做摘要
sub_step_3 (shell): 合并所有摘要 → 写入原 run_id 的 payload
```

用户可以覆盖默认 workflow，设计自己的切片压缩策略。

### 7.4 上下文历史保留（硬代码方案）

**完全不依赖 openclaw。** 上下文来源是 `commands_log` 表中该 run_id 的全部记录。

#### 数据流

```
原始 sub_step (run_id=abc)，agent 已执行 N 轮工具调用
        │
        ▼
  overflow 触发
        │
        ▼
  Orchestrator 从 commands_log 读取 run_id=abc 的全部记录：
  
  SELECT command, exit_code, stdout, stderr, created_at
  FROM commands_log WHERE run_id = 'abc'
  ORDER BY created_at ASC
  
  写入 payload.previous_tool_calls：
  [
    {cmd: "ls /data",          exit: 0, out: "file1.txt\nhuge.log"},
    {cmd: "cat config.yaml",   exit: 0, out: "api_key: xxx..."},
    {cmd: "grep ERROR *.log",  exit: 0, out: "15 matches"},
    {cmd: "cat huge.log",      exit: 0, out: "[OVERFLOW: 1.2M tokens]"},
  ]
        │
        ▼
  overflow_workflow (run_id=xyz) 执行
  输入：previous_tool_calls + 原始大文件
  处理：切片 + 压缩/总结
  输出：compressed_context + compressed_output
  写入 run_id=abc 的 payload
        │
        ▼
  Orchestrator 重新 spawn run_id=abc 的 agent session
  prompt =
    description +
    "你之前已执行以下操作，请基于这些上下文继续：" +
    render(previous_tool_calls) +        ← 完整工具调用历史
    compressed_context +                 ← 压缩后的上下文（如历史也超大）
    compressed_output                    ← 大文件压缩结果
        │
        ▼
  新 agent session 拥有完整上下文，从断点继续
```

#### 与依赖 openclaw 方案的区别

| | 依赖 openclaw session resume | 硬代码方案（Phase 3） |
|---|---|---|
| 上下文来源 | openclaw 内部状态 | `commands_log` 表 |
| 可控性 | 低（黑盒） | 高（透明、可审计） |
| 压缩能力 | 依赖 openclaw | 用户自定义 workflow |
| 上下文完整性 | 可能完整但不可控 | 精确到每一次工具调用 |
| 实现复杂度 | 低（如果 openclaw 支持） | 中（但完全自主） |

#### 兜底：如果上下文历史本身也超大

如果 agent 在 overflow 之前已经积累了 50 轮工具调用，`previous_tool_calls` 本身也超 token：

```
previous_tool_calls 也超阈值
        │
        ▼
  overflow_workflow 对 previous_tool_calls 也做压缩
  保留：最近 N 轮 + 关键结果的摘要
  → 写入 payload.compressed_context
        │
        ▼
  新 agent session 看到的是压缩后的上下文
```

> overflow workflow 递归处理自身——这正是 workflow 编排的威力。

---

## 8. Loop Engineering（Workflow 自动迭代）

### 8.1 设计愿景

```
用户用自然语言描述需求
        │
        ▼
  AI (Plan & Execute) 生成初始 workflow YAML
        │
        ▼
  Orchestrator 运行 workflow
        │
        ▼
  运行过程中触发自动迭代：
    - 某个 step 反复失败 → AI 分析失败原因 → 修改 YAML → 重新运行
    - 验证规则太宽松/太紧 → AI 调整规则
    - 发现新的边界情况 → AI 添加新的 sub_step
        │
        ▼
  迭代 N 轮后收敛 → 最终稳定的 workflow YAML
```

### 8.2 关键能力需求

| 能力 | 说明 |
|------|------|
| AI 可读写的 YAML | workflow 配置文件需要机器友好格式 |
| 失败分析 API | Orchestrator 暴露失败详情（哪个 step 失败、验证结果、payload 状态） |
| 自动重配置 | AI 修改 YAML 后 Orchestrator 热重载 |
| 迭代计数器 | 防止无限迭代，设置最大迭代轮数 |
| A/B 版本管理 | 保留每次迭代的 workflow 版本，可回滚 |

> 这是 Phase 3 的核心差异化能力，也是开源项目的长期愿景。

---

## 9. 命令策略高级特性

Phase 2 的 `command_policy` 只支持简单的 allowlist/blocklist。Phase 3 增强：

### 9.1 正则匹配

```yaml
command_policy:
  mode: blocklist
  patterns:
    - regex: "^rm\\s+-rf\\s+/"     # 禁止 rm -rf /
    - regex: ">\\s*/dev/"          # 禁止重定向到 /dev/
```

### 9.2 参数级别控制

```yaml
command_policy:
  mode: allowlist_with_params
  rules:
    - command: curl
      allowed_flags: ["-s", "-L", "-o"]
      blocked_flags: ["-u", "--data"]   # 禁止带认证或 POST 数据
```

### 9.3 动态策略（按上下文）

```yaml
command_policy:
  mode: contextual
  rules:
    - if:
        payload_key: "env"
        value: "production"
      then:
        mode: blocklist
        commands: ["rm", "sudo", "kill", "reboot"]
    - if:
        payload_key: "env"
        value: "staging"
      then:
        mode: unrestricted
```

---

## 10. 其他预留项

| 项目 | 说明 |
|------|------|
| **分布式支持** | SQLite → PostgreSQL，多 Orchestrator 实例 + 分布式锁 |
| **Plugin 激活方式** | Orchestrator 暴露 HTTP/gRPC API，agent 框架 plugin 主动拉取任务 |
| **Web Dashboard** | 可视化 workflow 状态、命令历史、payload 流转 |
| **Hooks** | sub_step 前后执行自定义脚本（pre_hook / post_hook） |
| **通知** | big_step/composition 完成/失败时发送通知（webhook、邮件等） |
| **Session Resume** | overflow 恢复时保留完整 agent 对话历史（而非摘要） |
