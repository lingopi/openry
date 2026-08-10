# KnowQL — Agent Payload 查询指南

> 本文档供 AI Agent 阅读，教授如何使用 `openry_payload_query` 工具。

---

## 0. 概念定义（必读）

OpenRY 的数据模型有四层层级，务必区分清楚：

```
composition（工作流组合）
  └─ big_step（大步骤，来自 workflows/ 目录的 YAML 文件）
       └─ sub_step（子步骤，每个 sub_step 有独立的 id 和 payload）
            └─ payload（运行时产出数据）
```

| 术语 | 定义 | 例子 |
|------|------|------|
| **composition** | 工作流组合：多个 big_step 串联而成的完整流程，对应 `compositions/` 目录下的 YAML | `knowql_e2e_test`、`cross_style_guide` |
| **big_step** | 大步骤：一个独立的阶段，包含若干 sub_step，对应 `workflows/` 目录下的 YAML 文件（ref 即文件名） | `cross_style_guide`（workflows/cross_style_guide.yaml） |
| **sub_step** | 子步骤：big_step 内的一个具体任务，真正执行 agent 会话并产出 payload 的最小单元 | `gen_style`、`collect_profile` |
| **payload** | sub_step 执行后的产出数据（JSON），存储在 DB 的 `task_state` 表中 | `{"tone": "专业", "format": "Markdown"}` |

**关键认知**：
- **只有 sub_step 有 payload**，composition 和 big_step 是结构概念，不产生运行时数据
- composition 名和 big_step ref 可能同名（如 `cross_style_guide` 既是 composition 名也是 big_step ref），但它们是不同的东西——composition 是流程编排，big_step 是步骤集合
- 查询 payload 时 `step_id` 填的是 **sub_step 的 id**（如 `gen_style`），不是 big_step ref
- `composition` 字段只在**跨 composition 查 payload** 时需要指定

---

## 1. 安全规则（必读 ⚠️）

**`discover` 是安全的，`query` 才是危险的。** `discover` 只返回元数据（step_id、run_id、描述），体积很小，放心调用。`query` 返回完整 payload（可能包含长文本、大数组），不限制会撑爆 token 上限。

**⚠️ `query` 只能查 sub_step，不能查 big_step！** big_step 是结构概念（步骤集合），没有 payload。如果你只知道 big_step ref，先用 `discover "big_step"` 找到其中的 sub_step id，再用 `query` 查。直接用 big_step ref 作为 `step_id` 是无效的——`step_id` 必须是 sub_step 的 id。

| 规则 | 说明 |
|------|------|
| 🥇 **`query` 优先用 `run_id`** | 主键精确查询，只返回**1 条**结果，无膨胀风险。`run_id` 来自 `discover "runtime"` |
| 🥈 `query` 用 `step_id` 时必须带 `limit` | 默认 `limit=3`，**不要改成大数字**，除非你明确需要遍历历史 |
| 🥉 `query` 不要做全量扫描 | 不要省略 `step_id`——每个 sub_step 的 payload 可能巨大且完全无关 |
| ❌ `query` 不要查未完成的 step | `running`/`in_progress` 状态的 step 还没产出最终 payload，查了浪费 token |
| ✅ `discover` 可以放心调 | 只返回 step_id + run_id + 描述，体积小，token 安全 |

**黄金法则**：`discover "runtime"` → 拿到 `run_id` → `query payload` 用 `run_id`，两点一线，路径最短、数据最精准、token 最省。

---

## 2. 什么时候用？

### ✅ 用

- 需要的上下文不在当前 prompt 中（`inherit_payload` 只传直接上游数据）
- 想知道前面有哪些 step、它们产出了什么数据
- 需要非直接上游 step 的数据
- 需要跨 composition 查另一个流程的数据

### ❌ 不用

- 数据已在 prompt 的 "Previous step results:" 中
- 只是执行 `description` 里描述的任务，不需要额外上下文

---

## 3. 两种操作

| 操作 | 用途 |
|------|------|
| `discover` | 探索：查看有哪些 composition / big_step / sub_step，或查看当前 workflow 已完成的 step |
| `query` | 查询：取回某个 step 的完整 payload |

---

## 4. discover — 探索

### 3.1 discover "runtime" — 当前 workflow 已完成的 step

返回当前 workflow instance 中所有 status 为 `done` 或 `abort` 的 step，附带 `run_id`（用于后续精确查询 payload）和 YAML 中的描述信息。

```json
// 查询
{"discover": "runtime"}

// 返回
{
  "workflow_instance_id": 11,
  "composition": "knowql_e2e_test",
  "steps": [
    {
      "step_id": "collect_profile",
      "run_id": "5355f700-bbf3-4c84-b6a2-0044aa8d1eb9",
      "status": "done",
      "description": "收集用户基本档案信息：姓名、年龄、职位、技能、工作年限、部门",
      "updated_at": "2026-07-23 10:00:14"
    },
    {
      "step_id": "analyze_profile",
      "run_id": "10aa4a38-1c08-4cfa-8fbd-a73e3c8d157f",
      "status": "done",
      "description": "对用户档案数据进行分析，评估资深级别并给出推荐方向",
      "updated_at": "2026-07-23 10:00:34"
    }
  ],
  "total": 2
}
```

注意：
- 当前正在执行的 step（`in_progress`）不会出现
- `run_id` 是每次执行的唯一标识，重试会生成新的 `run_id`
- `description` 来自 YAML 配置，帮助理解每个 step 做了什么

### 3.2 discover "compositions" — 所有可用的 workflow

```json
// 查询
{"discover": "compositions"}

// 返回
{
  "compositions": [
    {
      "name": "file_analysis_demo",
      "description": "文件分析流水线：打招呼 → 文件分析 → 权限验证",
      "big_steps": [
        {"ref": "hello_world", "description": "最简单的 OpenRY workflow 示例"},
        {"ref": "file_analysis", "description": "多步骤文件探索、创建、修改与分析"},
        {"ref": "permission_gate", "description": "演示 when_any OR 组路由"}
      ]
    },
    {
      "name": "hello_world",
      "description": "最简单的 Composition",
      "big_steps": [
        {"ref": "hello_world", "description": "最简单的 OpenRY workflow 示例"}
      ]
    }
  ],
  "total": 2
}
```

### 3.3 discover "big_step" — 查看某个 big_step 的 sub_steps

`ref` 是 `workflows/` 目录下的 YAML 文件名（全局唯一）。不需要指定 composition。

```json
// 查询
{"discover": "big_step", "ref": "file_analysis"}

// 返回
{
  "ref": "file_analysis",
  "name": "file_analysis",
  "description": "多步骤文件探索、创建、修改与分析，演示 payload 在步骤间传递",
  "sub_steps": [
    {"id": "step_explore", "kind": "agent", "description": "请完成以下文件探索与分析任务..."},
    {"id": "step_modify", "kind": "agent", "description": "在上一步创建的文件基础上继续操作..."}
  ]
}
```

---

## 5. query — 查询 payload

### 4.1 通过 run_id 精确查询（推荐）

当你知道 `run_id` 时（来自 `discover "runtime"`），使用主键精确查询，O(1) 最快。

```json
// 查询
{"query": "payload", "run_id": "5355f700-bbf3-4c84-b6a2-0044aa8d1eb9"}

// 返回
{
  "run_id": "5355f700-bbf3-4c84-b6a2-0044aa8d1eb9",
  "step_id": "collect_profile",
  "status": "done",
  "workflow_instance_id": 11,
  "updated_at": "2026-07-23 10:00:14",
  "payload": {
    "name": "张三",
    "age": 35,
    "role": "高级AI工程师",
    "skills": ["Python", "机器学习", "大语言模型", "知识图谱"],
    "years_experience": 10,
    "department": "AI研究院"
  }
}
```

### 4.2 通过 step_id 条件查询

适用于跨 composition 或没有 `run_id` 的场景。支持以下可选筛选维度：

| 维度 | 字段 | 说明 | 默认值 |
|------|------|------|:---:|
| 跨 composition | `composition` | 目标 composition 名 | 当前 composition |
| 时间 | `time` | `"latest"` 或 `"2026-07-23"` 格式日期 | `"latest"` |
| 状态 | `status` | `"done"` / `"abort"` 或数组 | `["done", "abort"]` |
| 数量 | `limit` | 返回条数上限 | `3` |
| 内容搜索 | `contains` | 在 payload JSON 全文中搜索 | 无 |

```json
// 基础查询
{"query": "payload", "step_id": "collect_profile"}

// 返回
{
  "step_id": "collect_profile",
  "results": [
    {
      "run_id": "5355f700-bbf3-4c84-b6a2-0044aa8d1eb9",
      "step_id": "collect_profile",
      "status": "done",
      "workflow_instance_id": 11,
      "updated_at": "2026-07-23 10:00:14",
      "payload": { "name": "张三", "age": 35, ... }
    }
  ],
  "total": 1
}
```

```json
// 跨 composition 查询
{"query": "payload", "step_id": "gen_style", "composition": "cross_style_guide"}

// 返回（无运行时数据时）
{
  "step_id": "gen_style",
  "composition": "cross_style_guide",
  "results": [],
  "total": 0,
  "hint": "composition 'cross_style_guide' 存在，但 step 'gen_style' 尚未被执行过，无运行时数据"
}
```

```json
// 内容搜索
{"query": "payload", "step_id": "analyze_profile", "contains": "AI技术专家"}
```

---

## 6. 推荐流程

```
当前 workflow 内查询：
  ① {"discover": "runtime"}
     → 看到已完成的 step 及其 run_id、描述
  ② {"query": "payload", "run_id": "<来自步骤①>"}
     → 拿到完整 payload

跨 composition 查询：
  ① {"discover": "compositions"}
     → 浏览可用的 workflow
  ② {"discover": "big_step", "ref": "<感兴趣的 ref>"}
     → 查看该 big_step 的 sub_steps
  ③ {"query": "payload", "step_id": "<id>", "composition": "<name>"}
     → 跨 composition 取 payload
```

---

## 7. 并发隔离

所有查询默认限定在当前 workflow instance 内，不会跨实例串数据。跨 composition 查询需显式指定 `composition` 字段。

---

## 8. 常见错误

| 错误 | 正确 |
|------|------|
| 把 big_step ref 当 step_id 用 | `step_id` 是 sub_step 的 id（如 `gen_style`），不是 big_step ref（如 `cross_style_guide`）。先用 `discover "big_step"` 查看有哪些 sub_step |
| 数据已在 prompt 里还查 | 先看 "Previous step results:" |
| 跨 composition 不先 discover | 先 `{"discover": "compositions"}` → 找到 composition 名 → `{"discover": "big_step", "ref": "..."}` → 找到 sub_step id → 再查 payload |
| `discover "big_step"` 带了 `composition` | 不需要，ref 在 `workflows/` 目录中全局唯一 |
| 查不存在的 step 不知所措 | 返回的 `hint` 字段会告诉你下一步该调什么 |

---

## 9. 权限

YAML 可能限制了你的 KnowQL 能力：
- `allow_payload_query: false` → 工具不可用
- `max_queries: N` → 单 session 最多 N 次
- `compositions: [current]` → 不能跨 composition 查询

