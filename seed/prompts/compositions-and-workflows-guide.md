# OpenRY Compositions & Workflows 配置指南

> 本文档供 AI 阅读后掌握如何配置 OpenRY 的 Composition 和 Workflow（Big Step）YAML 文件。
> 所有字段说明均基于 `openry/orchestrator/engine.py`、`openry/orchestrator/validation.py`、`openry/orchestrator/validator.py`、`openry/orchestrator/router.py`、`openry/orchestrator/payload.py`、`openry/orchestrator/yaml_loader.py`、`openry/db.py`、`openry/cli.py` 中的**真实代码实现**。

---

## 1. 概念层级

OpenRY 使用三层概念组织工作任务：

```
Composition（完整业务流程）
  │
  ├── Big Step A（引用 workflows/xxx.yaml）
  │     ├── sub_step_1  ← 一个 agent session，一个 run_id
  │     ├── sub_step_2  ← 另一个 agent session
  │     └── sub_step_N
  │
  ├── Big Step B（引用 workflows/yyy.yaml）
  │     └── ...
  │
  └── Big Step C
        └── ...
```

| 层级 | 对应概念 | 存储位置 | 作用 |
|------|---------|---------|------|
| **Composition** | 完整业务流程 | `.openry/compositions/{name}.yaml` | 串联多个 Big Step，定义步骤之间的成功/失败路由 |
| **Big Step（Workflow）** | 可复用的步骤组 | `.openry/workflows/{name}.yaml` | 定义一组串行的 sub_step，包含验证规则、超时、重试策略 |
| **sub_step** | 原子执行单元 | 内嵌在 Big Step YAML 的 `sub_steps` 列表中 | 每个 sub_step 对应一个 agent session（或 shell 脚本），是 agent 实际工作的最小单元 |

**重要：** Big Step 可以脱离 Composition 独立运行（通过 `Orchestrator.start_big_step()` 方法），此时它作为一个独立的 workflow 实例执行。Composition 的 `composition` 列在数据库中直接存储 workflow 名，schema 完全兼容。

---

## 2. 文件组织

配置目录默认为 `~/.openry/`（可通过 `OPENRY_HOME` 环境变量覆盖）：

```
.openry/
├── config.yaml           # 全局配置（shell、超时、server 等）
├── openry.db             # SQLite 数据库
├── compositions/         # Composition YAML（编排多个 Big Step）
│   ├── customer_onboarding.yaml
│   ├── incident_response.yaml
│   └── daily_report.yaml
└── workflows/            # Big Step YAML（定义 sub_step 序列）
    ├── send_email.yaml
    ├── create_account.yaml
    ├── run_tests.yaml
    └── ...
```

加载优先级：
- `OPENRY_HOME` 环境变量 → `~/.openry/`（默认）

---

## 3. Composition YAML 规范

### 3.1 完整示例

```yaml
# 文件：.openry/compositions/customer_onboarding.yaml
name: customer_onboarding
version: "1.0"
description: "新客户入职流程"

concurrency:
  max_parallel_instances: 5

big_steps:
  - ref: send_email              # 引用 workflows/send_email.yaml
    on_success: create_account
    on_failure: notify_admin

  - ref: create_account          # 引用 workflows/create_account.yaml
    on_success: setup_permissions
    on_failure: notify_admin

  - ref: setup_permissions
    on_success: send_welcome
    on_failure: notify_admin

  - ref: send_welcome
    on_success: done
    on_failure: abort
```

### 3.2 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|:--:|------|
| `name` | string | 是 | Composition 唯一标识，通过文件名 + `name` 字段双重定位 |
| `version` | string | 否 | 版本号，便于迭代管理 |
| `description` | string | 否 | 业务流程描述 |
| `concurrency.max_parallel_instances` | int | 否 | 同一 Composition 最多同时运行的实例数 |
| `big_steps` | list | 是 | Big Step 引用列表，**按顺序串行执行** |
| `big_steps[].ref` | string | 是 | 引用的 Big Step 名称，对应 `workflows/{ref}.yaml` 文件 |
| `big_steps[].on_success` | string | 是 | 当前 Big Step 成功后跳转到哪个 Big Step 的 `ref`，或 `done`（整个 Composition 完成） |
| `big_steps[].on_failure` | string | 是 | 当前 Big Step 失败后跳转到哪个 Big Step 的 `ref`，或 `abort`（整个 Composition 失败） |

### 3.3 启动方式

```bash
# 通过 Orchestrator CLI
openry-orchestrator start customer_onboarding

# 通过 API
curl -X POST http://localhost:9510/api/v1/trigger \
  -H "Content-Type: application/json" \
  -d '{"workflow": "customer_onboarding"}'
```

---

## 4. Workflow（Big Step）YAML 规范

### 4.1 完整示例

```yaml
# 文件：.openry/workflows/send_email.yaml
name: send_email
version: "1.0"
description: "发送一封邮件（获取原文 → 编辑草稿 → 获取草稿 → 发送）"
timeout_minutes: 10
max_retries: 2

sub_steps:
  - id: get_original
    kind: agent
    description: "根据用户提供的线索找到原始邮件，获取邮件原文和 messageId"
    on_success: edit_draft
    on_failure: abort
    max_tool_calls: 15
    expect_payload: true
    payload_keys: ["original_body", "message_id"]
    command_policy:
      mode: blocklist
      commands: ["rm", "sudo", "chmod", "kill"]

  - id: edit_draft
    kind: agent
    description: "基于原始邮件内容编辑回复草稿"
    on_success: get_draft
    on_failure: retry
    max_sub_step_retries: 3
    max_tool_calls: 20
    inherit_payload: true

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
    on_validation_fail: retry_current
    max_tool_calls: 10
    max_output_tokens: 800000
    on_output_overflow: overflow_handler
    expect_payload: true
    payload_keys: ["sent_message_id"]
    validation:
      - type: payload_has_key
        key: sent_message_id
      - type: payload_value_matches
        key: sent_message_id
        regex: "^[A-Za-z0-9]+@.+$"
```

### 4.2 Big Step 级别字段

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|:--:|--------|------|
| `name` | string | 是 | — | Big Step 唯一标识，用于 Composition 的 `ref` 引用。也是文件名（不含 `.yaml`） |
| `version` | string | 否 | — | 版本号 |
| `description` | string | 否 | — | Big Step 描述 |
| `timeout_minutes` | int | 否 | — | 单次尝试的最大时长（分钟）。**从 sub_step_1 开始计时，重试不重置**。超时后 Orchestrator 触发软刹车 → agent 收到取消通知 → 更新为 cancelled → 硬刹车 SIGTERM→SIGKILL |
| `max_retries` | int | 否 | 0 | Big Step 级别最大重试次数。当 `on_failure: abort` 或 timeout 触发，且 `big_step_retry_count < max_retries` 时，从 sub_step_1 重新开始 |
| `sub_steps` | list | 是 | — | sub_step 定义列表，按数组顺序串行执行 |

---

## 5. sub_step 字段详解

### 5.1 基础字段

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|:--:|--------|------|
| `id` | string | 是 | — | sub_step 唯一标识，在同一个 Big Step 内不可重复。用于路由目标 |
| `kind` | string | 否 | `agent` | 执行模式。`agent`：spawn agent session（AI 决策）；`shell`：直接 `subprocess.run` 执行脚本（Phase 3b 设计，代码中已预留） |
| `description` | string | 是* | — | 注入给 agent 的任务描述（prompt）。agent 通过 `openclaw session start --task {description}` 启动时会接收到这段文字。当 `prompt_blocks` 存在时，`description` 被忽略 |

### 5.2 路由字段

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|:--:|--------|------|
| `on_success` | string | 是 | — | sub_step 验证通过后的路由目标。值：`done`（Big Step 完成）、或同 Big Step 内另一个 sub_step 的 `id` |
| `on_failure` | string | 是 | — | sub_step 执行失败后的路由。值：`abort`（触发 Big Step 级别重试）、`retry`（只重试当前 sub_step，不触发 Big Step 重试）、或指定 sub_step `id` |
| `on_validation_fail` | string | 否 | `retry_current` | 硬验证失败后的路由。值：`retry_current`（重试当前 sub_step）、`abort`（直接失败）、或指定 sub_step `id` |

### 5.3 重试控制字段

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|:--:|--------|------|
| `max_sub_step_retries` | int | 否 | 3 | sub_step 级别最大重试次数。对应 DB 列 `max_sub_step_retries`。仅在 `on_failure: retry` 或 `on_validation_fail: retry_current` 时生效。重试计数器为 `sub_step_retry_count`，每次重试 +1。耗尽后升级为 `abort` / `dropped` |
| `max_tool_calls` | int | 否 | 10 | 本 sub_step 中 agent 最多调用 `openry -c` 的次数。超过后标记为 `failed`。由 `commands_log` 表中 `COUNT(*) WHERE run_id = ?` 实现计数 |

### 5.4 Payload 字段

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|:--:|--------|------|
| `expect_payload` | bool | 否 | false | agent 调用 `openry --status completed` 时是否必须携带 `--payload`。若为 true 但 payload 为空，验证失败 |
| `payload_keys` | list[string] | 否 | `[]` | 必须包含的 payload key 列表（"至少包含"语义）。属于硬验证范畴——若缺少任一 key，验证失败且触发重试 |
| `inherit_payload` | bool | 否 | false | 是否继承上一步的 payload。若为 true，当前 payload = 上一步 payload ∪ 当前 agent 提交的 payload（上一步的值会被当前同名字段覆盖）。若为 false，仅使用当前 agent 提交的 payload |

### 5.5 超 Token 控制字段

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|:--:|--------|------|
| `max_output_tokens` | int | 否 | 0（不限制） | 单次 `openry -c` 返回 stdout 的最大 token 估算值。以 `len(stdout) // 4` 粗略估算 token 数 |
| `on_output_overflow` | string | 否 | — | 超 token 时跳转到哪个 Big Step ref（作为 overflow workflow 执行）。若为空，直接标记为 `failed` |

超 token 流程：
1. `openry -c` 执行命令后，检查输出 token 数
2. 若超限：stdout 截断 + 注入 overflow 通知消息
3. agent 调用 `openry --status overflow`
4. Orchestrator 暂停当前 sub_step，保存 `commands_log` 中的历史上下文到 `previous_summary`
5. Orchestrator 启动 `on_output_overflow` 指定的 workflow 做切片/压缩
6. overflow workflow 完成后结果写入原 run_id 的 payload
7. Orchestrator 重新 spawn agent session，恢复执行

### 5.6 命令策略字段

`command_policy` 支持三种值形式：

**① 内置预设名（字符串）**：
```yaml
command_policy: strict       # 或 moderate、permissive
```
三个内置预设（strict / moderate / permissive）无需额外文件，直接可用。

**② 自定义策略文件名（字符串）**：
```yaml
command_policy: office_safe
```
从 `~/.openry/policies/office_safe.yaml` 加载自定义策略。策略文件与内置预设格式相同：
```yaml
# ~/.openry/policies/office_safe.yaml
mode: blocklist
commands:
  - rm
  - sudo
  - shutdown
patterns:
  - regex: "^curl\\s+.*evil\\.com"
    description: "禁止访问恶意域名"
```
安装时 `seed/policies/` 中的模板文件会自动复制到 `~/.openry/policies/`。

**③ 内联对象**：
```yaml
command_policy:
  mode: blocklist
  commands: ["rm", "sudo", "chmod", "kill"]
```

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|:--:|--------|------|
| `command_policy` | string/object | 否 | — | 预设名、自定义策略文件名、或内联策略对象 |
| `command_policy.mode` | string | 是* | `unrestricted` | 内联模式才需要。`unrestricted`：不限制；`allowlist`：只允许列表中的命令；`blocklist`：禁止列表中的命令 |
| `command_policy.commands` | list[string] | 否 | `[]` | 命令名列表（取命令字符串的第一个空格前 token 匹配） |
| `command_policy.patterns` | list[object] | 否 | `[]` | 正则表达式列表，每条含 `regex`（正则）和 `description`（说明） |

### 5.7 语义蒸馏字段（Phase D）

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|:--:|--------|------|
| `semantic_reporting` | bool | 否 | `true` | 是否启用语义蒸馏和概念聚类。`false` 时：agent step 不会收到 8 原语 + concepts 上报提示词；shell step 不会触发蒸馏 agent。该 step 的产出不会进入向量知识库 |

**设计意图**：并非所有 step 都需要进入知识库。对于纯工具调用、数据格式转换、或中间临时的 step，设置 `semantic_reporting: false` 可以减少 LLM token 消耗并避免无意义的向量存储。

```yaml
# 示例：一个不需要语义蒸馏的纯工具 step
- id: format_converter
  kind: agent
  description: "将 JSON 转换为 CSV 格式"
  semantic_reporting: false   # 不上报 concepts，不进向量库
  on_success: done
  on_failure: abort
```

**行为差异**：

| `semantic_reporting` | agent step | shell step |
|---------------------|-----------|------------|
| `true`（默认） | prompt 末尾自动注入 `semantic-primitives.md`；agent 可按指南上报 concepts | 输出被扫描 → 触发蒸馏 agent → 蒸馏产物进入向量库 |
| `false` | prompt 中不含语义上报指南；agent 不上报 concepts 也不会报错 | 跳过蒸馏，直接标记 `_compressed: true`；不进向量库 |

---

## 6. 硬代码验证规则（Validation）

验证规则在 sub_step 级别配置，用于核实 agent 自称"完成"的结果是否真的有效。agent 调用 `openry --status completed` 后，Orchestrator 的巡查循环（patrol loop）会执行验证。

### 6.1 验证执行流程

```
agent 调 --status completed
  → task_state.status = "completed", validation_status = "pending"
  → Orchestrator _validate_completed() 扫描到
  → ① expect_payload 检查
  → ② payload_keys 检查（隐式验证）
  → ③ validation 规则列表逐一执行
  → 全部通过 → status = "validated" → _route_validated() 处理路由
  → 任一失败 → 按 on_validation_fail 路由处理
```

### 6.2 Phase 2 验证规则（8 种 — 已实现）

这些规则在 `openry/orchestrator/validation.py` 的 `validate_step()` 和 `openry/cli.py` 的 `_validate_payload()` 中**均已完整实现**：

#### `payload_has_key` — 检查 payload 是否包含指定 key

```yaml
validation:
  - type: payload_has_key
    key: sent_message_id
```

实现：`key in payload`

#### `payload_value_matches` — 使用正则匹配 payload 值

```yaml
validation:
  - type: payload_value_matches
    key: sent_message_id
    regex: "^[A-Za-z0-9]+@.+$"
```

实现：`re.match(rule["regex"], str(payload.get(rule["key"], "")))`

#### `payload_values_equal` — 比较 payload 中两个 key 的值是否相等

```yaml
validation:
  - type: payload_values_equal
    key_a: message_id
    key_b: thread_id
```

实现：`payload.get("key_a") == payload.get("key_b")`。支持 string、number、boolean 类型的比较。这是 Phase 2 唯一支持跨 key 比较的验证类型。

#### `file_exists` — 检查文件是否存在

```yaml
validation:
  - type: file_exists
    path: "/data/output.txt"
```

实现：`os.path.exists(path)`

#### `file_contains` — 检查文件内容是否包含指定字符串

```yaml
validation:
  - type: file_contains
    path: "/data/output.txt"
    contains: "SUCCESS"
```

实现：读取文件全文，`contains in file_content`

#### `command` — 执行 shell 命令，exit_code=0 算通过

```yaml
validation:
  - type: command
    run: "grep -q 'OK' /tmp/result.txt"
```

实现：`subprocess.run(run, shell=True, capture_output=True, timeout=60)`，检查 `returncode == 0`

#### `command_output_contains` — 命令输出（stdout）必须包含指定文本

```yaml
validation:
  - type: command_output_contains
    run: "cat /tmp/result.txt"
    contains: "SUCCESS"
```

实现：`subprocess.run(run, shell=True, capture_output=True, text=True, timeout=60)`，检查 `contains in result.stdout`

#### `db_query` — 对 openry.db 执行 SQL，有返回行则通过

```yaml
validation:
  - type: db_query
    query: "SELECT 1 FROM commands_log WHERE run_id = ? AND exit_code = 0"
```

实现：`conn.execute(query).fetchone() is not None`

### 6.3 Phase 3a 验证规则（10 种 — 已实现）

这些规则在 `openry/orchestrator/validator.py` 中**均已完整实现**，通过统一的 `validate(ctx, rule)` 入口调用：

#### `payload_values_not_equal` — a != b

```yaml
# 用于 validation_routing 的 when 条件
- type: payload_values_not_equal
  key_a: before_hash
  key_b: after_hash
```

确保新旧值不同。典型场景：验证 agent 确实修改了内容。

#### `payload_value_equals` — key 值等于字面量

```yaml
- type: payload_value_equals
  key: status
  value: "active"
```

比较 payload 中指定 key 的值是否等于给定字面量。支持 string、number、boolean、null。

#### `payload_value_in_set` — 值在/不在集合中

```yaml
- type: payload_value_in_set
  key: status
  values: ["draft", "sent", "archived"]
  mode: allow    # allow | deny
```

`mode: allow`：值必须在集合中；`mode: deny`：值必须不在集合中。

#### `payload_value_greater_than` — 数值大于（或 >=）

```yaml
- type: payload_value_greater_than
  key: processed_count
  threshold: 0
  or_equal: false   # true 表示 >=
```

值不存在或非数字时返回失败。

#### `payload_value_less_than` — 数值小于（或 <=）

```yaml
- type: payload_value_less_than
  key: error_count
  threshold: 5
  or_equal: true
```

#### `payload_type` — 类型检查

```yaml
- type: payload_type
  key: count
  expected_type: int   # int | float | str | bool | list | dict | null
```

#### `file_size_greater_than` — 文件大小检查

```yaml
- type: file_size_greater_than
  path_key: output_file    # payload 中存储文件路径的 key
  min_bytes: 1
```

从 payload 读取文件路径，在文件系统中检查实际大小。

#### `http_status` — HTTP 状态码检查

```yaml
- type: http_status
  url: "http://localhost:8080/health"
  expected_status: 200
  method: GET
  timeout_seconds: 10
```

Orchestrator 直接发起 HTTP 请求并验证状态码。

#### `json_schema` — JSON Schema 验证

```yaml
- type: json_schema
  key: response_data
  schema:
    type: object
    required: ["id", "name", "items"]
    properties:
      id:
        type: integer
      name:
        type: string
      items:
        type: array
        minItems: 1
```

使用标准 JSON Schema (draft-07) 验证 payload 中的嵌套结构。需要 `jsonschema` 库作为可选依赖。

---

## 7. 条件路由（Phase 3a — 已实现）

条件路由在 sub_step 级别通过 `validation_routing` 字段配置。它在硬验证（`payload_keys` + `expect_payload`）通过之后执行，实现**多分支条件决策**。

### 7.1 路由条目类型

| 类型 | 语法 | 语义 |
|------|------|------|
| `when` | 单条件 | 条件成立 → `on_match`；不成立 → `on_mismatch` |
| `when_any` | 多条件 OR 组 | 任一子条件成立 → `on_match`；全部不成立 → `on_mismatch` |

### 7.2 路由目标

| 目标值 | 含义 |
|--------|------|
| `done` | 当前 Big Step 完成（成功） |
| `abort` | 当前 Big Step 失败（终止） |
| `retry_current` | 重试当前 sub_step（受 `max_sub_step_retries` 限制） |
| `continue` | 本条路由通过，继续求值下一条 `validation_routing` 条目 |
| 其他字符串 | 被视为同 Big Step 内另一个 sub_step 的 `id`，跳转到该 sub_step |

### 7.3 求值逻辑（短路求值 —— 代码实现于 `router.py`）

```
条目 #1 (when 或 when_any)
  ├── 匹配 → 使用 on_match
  │         ├── on_match = "continue" → 继续条目 #2
  │         └── on_match = 其他目标 → 立即路由（短路，后续条目不再求值）
  └── 不匹配 → 使用 on_mismatch → 立即路由（短路）

条目 #2 ...
...

所有条目都通过（或全部 continue） → 使用全局 on_success
```

### 7.4 完整示例

```yaml
- id: check_thread_consistency
  description: "验证邮件线程一致性"
  on_success: done
  on_failure: abort
  payload_keys: ["message_id", "thread_id", "status"]

  validation_routing:
    # 条目 1：线程一致性检查
    - when:
        type: payload_values_equal
        key_a: message_id
        key_b: thread_id
      on_match: continue           # 通过，继续下一条
      on_mismatch: fix_thread_id   # 不通过，跳转到修复步骤
      on_mismatch_message: "thread_id 与 message_id 不一致"

    # 条目 2：状态值合法性检查
    - when:
        type: payload_value_in_set
        key: status
        values: ["draft", "sent"]
        mode: allow
      on_match: done               # 通过，Big Step 完成
      on_mismatch: abort           # 不通过，终止
      on_mismatch_message: "非法状态值"
```

#### when_any 示例（权限门控）

```yaml
- id: check_access
  description: "验证用户访问权限"
  on_success: done
  on_failure: abort

  validation_routing:
    - when_any:
        - type: payload_value_equals
          key: is_admin
          value: true
        - type: payload_value_in_set
          key: role
          values: ["editor", "reviewer"]
          mode: allow
      on_match: continue
      on_mismatch: escalate_permission

    - when:
        type: payload_value_greater_than
        key: quota_remaining
        threshold: 0
      on_match: done
      on_mismatch: abort
```

### 7.5 关键约束

1. **硬验证先于条件路由**：`payload_keys` 和 `expect_payload` 检查必须通过后才会执行 `validation_routing`
2. **硬验证只能决定 retry/abort**：硬验证失败的目标只能是 `retry_current` 或 `abort`。跳转到其他 workflow/big_step/sub_step 必须使用条件路由
3. **未配置 `validation_routing` 时**：回退到 Phase 2 的二值路由（`on_success` / `on_validation_fail`）

---

## 8. KnowQL Payload 查询（Phase 3b v2 — 已重构）

### 8.1 概述

KnowQL 是 agent 在运行时主动查询历史 payload 数据的知识图谱查询系统。agent 通过调用 `openry_payload_query` 工具进行探索和查询。

**与 `inherit_payload` 的区别：**

| 机制 | 触发时机 | 数据来源 | 用途 |
|------|----------|------|------|
| `inherit_payload` | Prompt 构建时（push） | 直接上游 step 的 payload | 自动将上一步产出注入当前 agent 的 prompt |
| KnowQL | Agent 运行时（pull） | 任意历史 step（跨 big_step、跨 composition） | Agent 按需主动探索超出直接上游范围的数据 |

**API 设计**：两种操作——`discover`（探索）和 `query`（精确查询）。扁平化参数，无 key 投影，全量返回 payload。详细指南见 `prompts/openry-payload-query-enhance.md`。

### 8.2 配置字段

```yaml
sub_steps:
  - id: compose_reply
    kind: agent
    allow_payload_query: true       # 允许 agent 使用 openry_payload_query 工具
    payload_query_scope:
      compositions: [current]       # current | all | ["comp_a", "comp_b"]
      max_queries: 10               # 单 session 最大查询次数（默认 5）
      allowed_intents:              # 允许的操作白名单（可选）
        - discover
        - query
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|:---:|------|
| `allow_payload_query` | bool | `false` | 是否允许 agent 使用 `openry_payload_query` |
| `payload_query_scope.compositions` | string/array | `"current"` | 允许查询哪些 composition 的数据 |
| `payload_query_scope.max_queries` | int | `5` | 单次 agent session 最大查询次数 |

### 8.3 两种操作

#### discover — 探索

| 模式 | 调用 | 用途 |
|------|------|------|
| `runtime` | `{"discover":"runtime"}` | 列出当前 workflow 已完成的 sub_step（含 `run_id`、`description`） |
| `compositions` | `{"discover":"compositions"}` | 列出所有可用的 workflow composition 及其 big_step |
| `big_step` | `{"discover":"big_step","ref":"..."}` | 查看某个 big_step 的 sub_step 列表 |

#### query — 查询 payload

| 路径 | 调用 | 场景 |
|------|------|------|
| `run_id`（推荐） | `{"query":"payload","run_id":"<uuid>"}` | 主键精确查询，O(1)，来自 `discover "runtime"` |
| `step_id` | `{"query":"payload","step_id":"<id>"}` | 条件查询，可选 `composition`/`time`/`status`/`limit`/`contains` |

### 8.4 推荐流程

```
当前 workflow 内查询：
  discover "runtime" → 拿到 run_id → query payload 用 run_id

跨 composition 查询：
  discover "compositions" → discover "big_step" → query payload 用 step_id + composition
```

### 8.5 并发隔离

所有查询默认限定在当前 workflow instance 内。跨 composition 查询需显式指定 `composition` 字段。

---

## 9. Prompt Blocks（Phase 3b — 已实现）

### 9.1 概述

`prompt_blocks` 允许在 sub_step 的 agent prompt 中动态拼接多个内容源。支持内联文本和外部文件两种类型。

**文件路径解析**：相对路径 → 从 `~/.openry/prompt_blocks/` 目录查找；绝对路径和 `~` 路径直接使用。

### 9.2 YAML 配置

```yaml
sub_steps:
  - id: edit_draft
    kind: agent
    description: "基于原始邮件编辑回复草稿"   # prompt_blocks 存在时 description 作为 fallback
    inherit_payload: true

    prompt_blocks:
      # 内联文本 + 标题
      - type: text
        label: "回复要求"
        content: "请使用中文回复。语气：专业但不生硬。\n"

      # 内联文本（无标题）
      - type: text
        content: "必须使用 Markdown 格式输出。\n"

      # 从 prompt_blocks 目录加载
      - type: file
        path: "company-style.md"
        label: "公司风格指南"

      # 绝对路径
      - type: file
        path: "/etc/legal-disclaimer.md"
        label: "法律声明"
```

### 9.3 Block 类型

| 类型 | 参数 | 说明 |
|------|------|------|
| `text` | `content`（必填）, `label`（可选） | 内联文本块。有 label 时渲染为 `--- label ---\ncontent` |
| `file` | `path`（必填）, `label`（可选） | 从文件读取内容。文件不存在时静默跳过 |

### 9.4 文件存放

安装时自动创建 `~/.openry/prompt_blocks/` 目录。用户将 `.md` 文件放入该目录后，在 YAML 中写文件名即可引用。也可使用绝对路径引用任意位置的文件。

### 9.5 渲染顺序

`prompt_blocks` 按数组顺序依次渲染，在 agent 的 opening message 中出现在任务描述之前。

---

## 10. Payload 传递机制

### 10.1 数据流

```
sub_step_1 (get_original)
  agent 调: openry --status completed --payload '{"message_id":"abc","original_body":"..."}'
  → task_state.payload = {"message_id":"abc","original_body":"..."}

sub_step_2 (edit_draft) inherit_payload: true
  → Orchestrator 合并上一步 payload + 当前 agent 提交的 payload
  → 同名字段以当前 agent 提交的为准

sub_step_3 (get_draft)
  agent 调: openry --status completed --payload '{"draft_id":"xyz","draft_body":"..."}'
  → 如果 inherit_payload: false → payload 仅含当前提交的内容
```

### 10.2 合并规则（代码实现于 `payload.py`）

- `inherit_payload: true`：`merged = {**previous_payload, **current_payload}`（上一步的值被当前同名字段覆盖）
- `inherit_payload: false`（默认）：仅使用当前 agent 提交的 payload
- `expect_payload` 与 `inherit_payload` 无关：`expect_payload` 只控制 agent 是否**必须**携带 `--payload` 参数

---

## 11. 状态机与软刹车

### 11.1 任务状态流转

```
queued → in_progress → completed → validated → done（路由到下一步）
                    ↘ failed    → queued（有重试次数）或 dropped（耗尽）
                    ↘ cancelled → failed
                    ↘ overflow  → overflow workflow → 恢复 → queued
```

### 11.2 软刹车机制

Orchestrator 不直接杀进程，而是通过 `cancel_requested` 标志通知 agent：

1. Orchestrator 检测到超时 → `set_cancel_requested(run_id)` → `DB.cancel_requested = 1`
2. agent 下一次调用 `openry -c` 时 → `_check_cancel()` 查询 DB → 在 stdout 中注入取消消息
3. agent 看到注入消息 → 调 `openry --status cancelled`
4. Orchestrator 扫描到 `cancelled` → 硬刹车：SIGTERM → 等 5s → SIGKILL

### 11.3 僵死检测

`in_progress` 状态超过 `zombie_timeout_minutes`（默认 30 分钟，可在 `config.yaml` 的 `orchestrator.zombie_timeout_minutes` 配置）无 `updated_at` 更新 → 重置为 `queued`。

---

## 12. 配置建议与技巧

### 12.1 粒度设计

- **每个 sub_step 只做一件事**：不要让 agent 在一个 sub_step 中完成多个不相关任务。粒度越细，验证越精确，重试成本越低
- **description 要具体**：包含明确的输入、输出格式要求。例如："请执行以下任务，完成后调用 `openry --status completed --payload '{"key":"value"}'`"
- **敏感操作前加验证 sub_step**：如在 `send_draft` 前加一个 `review_draft` sub_step，确保人工或自动审核

### 12.2 Payload 设计

- 使用 `payload_keys` 约束 agent 必须产出的字段，避免 agent 遗漏关键数据
- 用 `inherit_payload: true` 在步骤间传递上下文（如 `message_id`、`thread_id`），而非让 agent 重新查询
- payload 中的 key 应使用 snake_case（`message_id`、`draft_body`），保持与代码库风格一致
- 不要将超大内容放入 payload——payload 存储在 SQLite 中，超大 JSON 会影响性能。大数据应写入文件，payload 中只存文件路径

### 12.3 重试策略

- `on_failure: retry` + `max_sub_step_retries`：适用于"agent 可能偶然犯错"的场景（如 API 临时不可用）
- `on_failure: abort` + `max_retries`（Big Step 级别）：适用于"整个流程需要从头重来"的场景
- 避免 `max_sub_step_retries` 设置过大——过多次重试通常是 prompt 或 workflow 设计问题
- **超时时间要包含重试耗时**：`timeout_minutes` 从 sub_step_1 开始时计时，永不重置

### 12.4 安全控制

- 对涉及文件删除、系统修改的 sub_step，务必设置 `command_policy`
- 推荐大多数 sub_step 使用 `mode: blocklist`，禁止 `rm`、`sudo`、`chmod`、`chown`、`kill`、`shutdown`、`reboot`
- 只读类 sub_step（如数据查询）可使用 `mode: allowlist`，只允许 `cat`、`grep`、`ls`、`find`、`wc`、`head`、`tail`

### 12.5 语义蒸馏控制

- 对纯工具型、数据转换型、或中间临时的 step，设置 `semantic_reporting: false` 以减少 LLM token 消耗
- 对产出可供下游检索的业务知识的 step，保持默认 `true` 让 concepts 进入向量库
- shell step 搭配 `semantic_reporting: false` 可完全跳过蒸馏流程，适用于简单文件读取等无语义价值的操作

### 12.6 验证规则选择

| 场景 | 推荐验证类型 |
|------|------------|
| 确保 agent 产出了某个字段 | `payload_has_key` |
| 验证字段格式（如 email、ID 格式） | `payload_value_matches`（正则） |
| 验证两个字段一致性 | `payload_values_equal` |
| 验证字段是否为特定值 | `payload_value_equals` |
| 验证字段在允许的枚举中 | `payload_value_in_set` |
| 验证 agent 创建了文件 | `file_exists` |
| 验证文件内容正确 | `file_contains` |
| 验证数值范围 | `payload_value_greater_than` / `payload_value_less_than` |
| 验证复杂嵌套结构 | `json_schema` |

### 12.7 条件路由设计

- **先硬验证，后条件路由**：`payload_keys` 确保 agent 产出了必要数据，`validation_routing` 基于已有数据做决策
- **`when` 用于 AND 逻辑**：多个 `when` 条目串联形成"全部满足才通过"的效果
- **`when_any` 用于 OR 逻辑**：多个条件中任一满足即算该组通过
- **`on_mismatch` 优先选择 `retry_current`**：让 agent 尝修正，而非直接 abort
- **`on_mismatch_message` 要有指导性**：告诉 agent 具体哪里不对，而非泛泛的"验证失败"

### 12.8 调试技巧

- 配置好 workflow 后，先用最小的 sub_step（如 `echo` 测试）验证整个链路通畅
- 查看 `commands_log` 表了解 agent 的工具调用历史
- 查看 `validation_results` 表了解每次验证的详细信息
- 使用 `openry serve` 启动 Dashboard UI，在浏览器中实时查看 workflow 状态树和 payload 流转

---

## 13. 快速配置模板

### 最简单的 Big Step（一个 sub_step 的 echo 测试）

```yaml
name: echo_test
version: "1.0"
description: "简单回显测试"
timeout_minutes: 5
max_retries: 1

sub_steps:
  - id: step_hello
    kind: agent
    description: "只回复一句你好呀，就可以了。说完之后使用 openry --status completed。"
    on_success: done
    on_failure: abort
    max_tool_calls: 5
```

### 带 payload 传递的 Big Step

```yaml
name: date_check
version: "1.0"
description: "获取日期并验证"
timeout_minutes: 5

sub_steps:
  - id: get_date
    kind: agent
    description: "使用 openry -c 'date' 获取当前日期，然后调用 openry --status completed --payload '{\"date\": \"粘贴date输出\"}'"
    on_success: done
    on_failure: abort
    max_tool_calls: 5
    expect_payload: true
    payload_keys: ["date"]
```

### 带条件路由的 Big Step

```yaml
name: thread_check
version: "1.0"
description: "检查邮件线程一致性"
timeout_minutes: 10

sub_steps:
  - id: get_thread_info
    kind: agent
    description: "获取邮件的 message_id 和 thread_id，完成后提交 payload: {\"message_id\": \"...\", \"thread_id\": \"...\"}"
    on_success: done
    on_failure: abort
    max_tool_calls: 10
    expect_payload: true
    payload_keys: ["message_id", "thread_id"]

    validation_routing:
      - when:
          type: payload_values_equal
          key_a: message_id
          key_b: thread_id
        on_match: done
        on_mismatch: fix_thread
        on_mismatch_message: "message_id 与 thread_id 不一致，需要修复"

  - id: fix_thread
    kind: agent
    description: "message_id 和 thread_id 不一致。请修复 thread_id 使其与 message_id 一致，然后重新提交 payload。"
    on_success: done
    on_failure: abort
    max_tool_calls: 10
    max_sub_step_retries: 2
    expect_payload: true
    payload_keys: ["message_id", "thread_id"]
    inherit_payload: true
```

### 最小 Composition

```yaml
name: simple_pipeline
version: "1.0"
description: "最小流水线示例"

big_steps:
  - ref: echo_test
    on_success: date_check
    on_failure: abort

  - ref: date_check
    on_success: done
    on_failure: abort
```

---

## 14. 关键代码引用（供验证）

| YAML 字段 | 加载位置 | 使用位置 |
|-----------|---------|---------|
| `name`、`sub_steps`、`timeout_minutes`、`max_retries` | `yaml_loader.py:load_big_step()` | `engine.py:_spawn_agent_session()` |
| `compositions/*.yaml` 全部字段 | `yaml_loader.py:load_composition()` | `engine.py:start_workflow()` |
| `sub_steps[].id` | `yaml_loader.py:get_sub_step_config()` | `engine.py:_enqueue_first_sub_step()` |
| `sub_steps[].description` | `engine.py:_build_task_description()` | `engine.py:_spawn_agent_session()`（传给 openclaw） |
| `sub_steps[].on_success` | `engine.py:_route_validated()` | `engine.py:_enqueue_next_sub_step()` |
| `sub_steps[].max_tool_calls` | `engine.py:_check_max_tool_calls()` | `cli.py:_check_max_tool_calls()` |
| `sub_steps[].validation` | `validation.py:validate_step()` | `cli.py:_validate_payload()` |
| `sub_steps[].validation_routing` | `router.py:evaluate_routing()` | `cli.py:_evaluate_routing_sync()` |
| `sub_steps[].payload_keys` | `validation.py:validate_step()` | `cli.py:_validate_payload()` |
| `sub_steps[].inherit_payload` | `payload.py:merge_payload()` | `engine.py:_enqueue_next_sub_step()` |
| `sub_steps[].command_policy` | `cli.py:_check_command_policy()` | `cli.py:cmd_execute()` |
| `sub_steps[].max_output_tokens` | `cli.py:_check_output_overflow()` | `cli.py:cmd_execute()` |
| `sub_steps[].on_output_overflow` | `engine.py:_handle_overflow()` | `engine.py:_handle_overflow()` |
| `sub_steps[].max_sub_step_retries` | `engine.py:_retry_failed()` / `_validate_completed()` | `cli.py:_handle_failed_retry()` |
