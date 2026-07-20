# OpenRY — Phase 3a 设计文档：高级验证与条件路由

> 版本：0.1（草案）
> 日期：2026-07-20
> 状态：Phase 3-UI + Phase 3e 完成后启动
> 依赖：Phase 2 `payload_values_equal` 验证基础
> 前置：Phase 3-UI 骨架 + Phase 3e 平台化能力已就位，3a 开发的功能可立即在 UI 上验证

---

## 1. 概述

Phase 3a 是 Phase 3 的**基础设施层**。它在 Phase 2 的单一验证类型（`payload_values_equal`）和二值路由（pass/fail）之上，扩展为 **8 种验证类型** 和 **多分支条件路由**。后续 Phase 3b~3f 的多个特性都依赖此层的验证与路由能力。

### 1.1 为什么验证和路由合并？

验证是"输入"——判断某个条件是否成立；路由是"输出"——根据判断结果决定下一步跳转。两者是一体的：路由的 `when` 条件直接引用验证类型，分开实现会导致接口反复修改。

---

## 2. 高级验证规则

### 2.1 验证类型全览

Phase 2 只做 `payload_values_equal`，Phase 3a 扩展为以下 8 种：

| 验证类型 | 用途 | 参数 | 示例 |
|---------|------|------|------|
| `payload_values_equal` | a == b | `key_a`, `key_b` | 修改前后 hash 一致 |
| `payload_values_not_equal` | a != b | `key_a`, `key_b` | 确保 agent 确实修改了内容 |
| `payload_value_in_set` | a ∈ {x, y, z} | `key`, `values[]` | status ∈ {draft, sent, archived} |
| `payload_value_greater_than` | a > b | `key`, `threshold` | processed_count > 0 |
| `payload_value_less_than` | a < b | `key`, `threshold` | error_count < 5 |
| `payload_type` | type(a) == T | `key`, `expected_type` | count 必须是 int |
| `file_size_greater_than` | file size > N | `path_key`, `min_bytes` | 输出文件 > 0 bytes |
| `http_status` | HTTP code == N | `url`, `expected_status` | GET /health → 200 |
| `json_schema` | JSON Schema 验证 | `key`, `schema` | 复杂嵌套结构校验 |

### 2.2 详细规范

#### `payload_values_equal`（Phase 2 已有，规范化）

```yaml
- type: payload_values_equal
  key_a: original_hash
  key_b: current_hash
```

比较 payload 中两个 key 的值是否相等。支持 string、number、boolean 类型。

#### `payload_values_not_equal`

```yaml
- type: payload_values_not_equal
  key_a: before_content_hash
  key_b: after_content_hash
```

与 `equal` 相反，确保新旧值不同。典型场景：验证 agent 确实做了修改。

#### `payload_value_in_set`

```yaml
- type: payload_value_in_set
  key: status
  values: ["draft", "sent", "archived"]
  mode: allow   # allow | deny
```

`mode: allow` 表示值必须在集合中；`mode: deny` 表示值不能在此集合中。

#### `payload_value_greater_than` / `payload_value_less_than`

```yaml
- type: payload_value_greater_than
  key: processed_count
  threshold: 0
  or_equal: false   # true 表示 >=
```

支持整数和浮点数比较。

#### `payload_type`

```yaml
- type: payload_type
  key: count
  expected_type: int  # int | float | str | bool | list | dict | null
```

#### `file_size_greater_than`

```yaml
- type: file_size_greater_than
  path_key: output_file    # payload 中存储文件路径的 key
  min_bytes: 1
```

Orchestrator 从 payload 中读取文件路径，检查文件系统中的实际大小。

#### `http_status`

```yaml
- type: http_status
  url: "http://localhost:8080/health"
  expected_status: 200
  method: GET
  timeout_seconds: 10
```

Orchestrator 直接发起 HTTP 请求并检查状态码。

#### `json_schema`

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

使用标准 JSON Schema (draft-07) 验证 payload 中的嵌套结构。

### 2.3 实现要点

- 所有验证类型实现统一接口：`validate(context: ValidationContext) -> ValidationResult`
- `ValidationResult` 包含 `passed: bool`、`message: str`、`details: dict`
- `json_schema` 可选依赖 `jsonschema` 库（Python 标准库无内置 JSON Schema 验证），作为可选依赖安装

---

## 3. 条件路由（Conditional Routing）

### 3.1 设计动机

Phase 2 的二值路由只能表达"验证通过 → on_success，失败 → on_failure"。实际场景中，不同失败原因需要不同的处理路径：

| 场景 | 成功 | 失败原因 A | 路由 | 失败原因 B | 路由 |
|------|:--:|----------|------|----------|------|
| 线程一致性 | done | message_id ≠ thread_id | fix_thread | status 缺失 | abort |
| 权限检查 | done | user_role ∉ {admin} | request_upgrade | 未认证 | reauth |
| 数据完整性 | done | count == 0 | retry_current | count < 0 | abort |

### 3.2 YAML 设计

```yaml
- id: check_thread_consistency
  description: "验证邮件线程一致性"
  on_success: done
  on_failure: abort           # 兜底路由

  validation_routing:
    - when:
        type: payload_values_equal
        key_a: message_id
        key_b: thread_id
      on_match: done
      on_mismatch: fix_thread_id
      on_mismatch_message: "thread_id 与 message_id 不一致，需要修复"

    - when:
        type: payload_value_in_set
        key: status
        values: ["draft", "sent"]
        mode: allow
      on_match: done
      on_mismatch: abort
      on_mismatch_message: "非法状态值"
```

### 3.3 路由语义

#### 单条 `when` 的处理

```
when 条件成立 → 执行 on_match 路由
when 条件不成立 → 执行 on_mismatch 路由
```

#### 多条 `when` 的处理（短路求值）

```
按定义顺序依次求值，第一条匹配的 when 决定路由：
  ├── 某条 when 匹配 (passed=true)  → 使用该条的 on_match
  ├── 某条 when 不匹配 (passed=false) → 使用该条的 on_mismatch
  └── 所有 when 都通过 (passed=true) → 使用全局 on_success

如果某条 when 的验证执行出错（非 passed/failed，而是验证本身异常）：
  → 跳过该条，继续下一条
  → 如果全部出错，使用全局 on_failure
```

#### 路由目标

路由目标可以是：
- `done` — 结束当前 big_step，标记成功
- `abort` — 结束当前 big_step，标记失败
- 同 composition 内任意 `big_step_id` 或 `sub_step_id`
- `retry_current` — 重试当前 sub_step（受 max_retries 限制）

### 3.4 与 Phase 2 `on_fail` 的关系

```
Phase 2: on_success → A,  on_validation_fail → B
Phase 3a 兼容层:
  validation_routing 未定义 → 沿用 Phase 2 二值路由
  validation_routing 已定义 → on_success/on_failure 变为兜底路由
```

### 3.5 常见场景模板

#### 模板 1：状态一致性检查

```yaml
validation_routing:
  - when:
      type: payload_values_equal
      key_a: expected_status
      key_b: actual_status
    on_match: done
    on_mismatch: reconcile_status
```

#### 模板 2：权限门控

```yaml
validation_routing:
  - when:
      type: payload_value_in_set
      key: user_role
      values: ["admin", "editor"]
      mode: allow
    on_match: done
    on_mismatch: escalate_permission
```

#### 模板 3：数据完整性门控

```yaml
validation_routing:
  - when:
      type: payload_value_greater_than
      key: record_count
      threshold: 0
      or_equal: true
    on_match: done
    on_mismatch: retry_current
```

---

### 3.6 硬验证与条件路由的执行顺序

Phase 2 已有的 `payload_keys`（硬验证）和 Phase 3a 新增的 `validation_routing`（条件路由）按 **先后顺序** 执行，互不冲突：

```
sub_step 完成 → agent 上报 payload
  │
  ├── ① 硬验证（Phase 2 payload_keys）
  │     ├── 缺少必需 key → retry_current / abort
  │     │     agent 重新 spawn，任务描述附带缺失字段信息
  │     └── 全部通过 → 继续
  │
  └── ② 条件路由（Phase 3a validation_routing）
        ├── when #1 匹配 → on_match / on_mismatch
        ├── when #2 匹配 → ...
        ├── ...
        └── 全部通过 → 全局 on_success
```

**关键设计**：条件路由只在硬验证全部通过后才执行。如果 agent 上报的 payload 缺少必填字段，条件路由根本不会触发，agent 会被直接打回。

**完整 YAML 示例**：

```yaml
- id: analyze_report
  kind: agent
  description: "分析报告并生成摘要"
  max_tool_calls: 10

  # 硬验证：payload 必须有这些 key
  expect_payload: true
  payload_keys: [summary, confidence, category]
  on_payload_missing: retry_current

  # 条件路由：key 齐全后才走这里
  validation_routing:
    - when:
        type: payload_value_greater_than
        key: confidence
        threshold: 0.8
      on_match: auto_publish
      on_mismatch: human_review

    - when:
        type: payload_value_in_set
        key: category
        values: [safe, neutral]
        mode: allow
      on_match: done
      on_mismatch: escalate_to_moderator
```

---

## 4. 实现任务清单

| # | 任务 | 优先级 |
|:--|------|:-----:|
| 1 | 定义统一 `ValidationRule` 接口与 `ValidationResult` 数据结构 | P0 |
| 2 | 实现 8 种验证类型的 validator | P0 |
| 3 | `json_schema` 验证的可选依赖集成 | P1 |
| 4 | `http_status` 的 HTTP 客户端封装 | P1 |
| 5 | `file_size_greater_than` 的文件系统检查 | P2 |
| 6 | 扩展 sub_step YAML schema 支持 `validation_routing` | P0 |
| 7 | 实现 `validation_routing` 短路求值逻辑 | P0 |
| 8 | 实现路由目标解析（done/abort/step_id/retry_current） | P0 |
| 9 | Phase 2 二值路由的兼容层 | P0 |
| 10 | 3 个场景模板的内置支持（状态一致性/权限门控/数据完整性） | P1 |
| 11 | 单元测试 + 集成测试 | P0 |

---

## 5. 变更影响

| 受影响模块 | 变更程度 |
|-----------|:---:|
| `orchestrator/validator.py`（新建） | 新模块 |
| `orchestrator/router.py`（新建） | 新模块 |
| `orchestrator/sub_step_executor.py` | 中等：验证调用点从硬编码改为分发 |
| `config.py` YAML schema | 扩展 |
| `db.py`（如有验证结果存储） | 轻量扩展 |

---

## 6. 为后续 Phase 预留的接口

- `ValidationResult.details` 字段供 Phase 3f（Loop Engineering）做失败分析
- 验证类型的注册机制供 Phase 3c（命令策略动态验证）复用
- 路由目标解析器供 Phase 3d（overflow workflow 跳转）复用
