# openry_analysis_sources 工具 API 设计（定稿）

> 日期：2026-08-18
> 状态：**已实现 + 现场验证**（实例 55 无参调用 / 实例 56 显式 run_id 调用均成功，
> 实例 56 修复闭环跑通）
> 设计参考：`openry_knowledge_query` / `openry_payload_query`（plugin 注册工具模式，
> agent 自助调用、返回 JSON 文本、run_id 隐式解析）
> 关联文档：
> - `analysis-source-ladder.md` —— 数据源阶梯与协议草图（本文是其 §4 的实现级细化）
> - `failure-routing-model.md` —— 失败路由（本工具的 run_id 来自路由指针）
> - `iteration-canonical-form.md` —— 迭代产物规范形（取证步之后的修复产出）
> 实证基础：`test_evidence_collect` 实例 48/49（指针 + L-1~L3 全链路实测通过）

---

## 1. 定位

- 供 **`loop_analyze_failure` 的 analyze_fix（kind: agent）** 自取证使用
  （v0.5 后第一 sub_step 是 shell 硬代码提取，不再有独立取证步）
- 形态：**plugin 注册工具**（与 `openry_knowledge` / `openry_payload_query` 同层），
  不是 shell 命令、不是 CLI 子命令
- agent 只传「要哪几层物料」，**不感知 run_id**——解析链全部硬代码完成

## 2. run_id 隐式解析链（工具内部，agent 无感知）

```
① ctx.sessionKey → parseSessionKey()（复用现成实现）
     → 当前迭代步「自己」的 run_id
② SELECT payload FROM task_state WHERE run_id = 自己
     → payload._inherits_from_run_id（路由时 patrol 必写，实测实例 48/49）
     → = 失败任务的 run_id ✓
③ 兜底：指针缺失/无效时，查本实例
     status IN ('retrieve','failed','dropped') 的最近一行定位失败任务
④ 视角自动分支：
     - 指针指向失败态任务 → single_step 视角（取失败步物料）
     - 指针指向正常完成的任务（成功-低效路径）→ instance 视角
       （整实例 command_count 聚合 + 各步摘要，供效率分析）
```

## 3. 参数设计（对齐现有工具的 TypeBox 风格）

```json
{
  "sources": ["verdict", "payload", "commands_log"],
  "budget_tokens": 8000,
  "run_id": "可选：显式覆盖（调试用，正常流程不传）"
}
```

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `sources` | string[] | `["auto"]` | 请求的物料层；`"auto"` = 按阶梯顺序自动装填；支持数字别名 `"0"`~`"4"`（见 3.2） |
| `budget_tokens` | int | 12000 | 服务端装填预算（估算 token）；12000 可让 auto 覆盖到 L3（实测 ~9.5K） |
| `run_id` | string | 无 | **显式覆盖（双向设计）**：agent 可见 `_inherits_from_run_id` 时可直接传；传了但 DB 查不到 → 自动回落解析链，不报错 |

### 3.1 sources 取值 → 层级映射

| sources 值 | 层级 | 数据源 | 内容 |
|-----------|------|--------|------|
| `verdict` | L-1 | **trajectory jsonl** | 判决字段：aborted/timedOut/finalStatus 等 |
| `payload` | L0 | **DB** task_state | 失败任务行 + 相邻步摘要 |
| `commands_log` | L1 | **DB** commands_log | 聚合（count/total_ms/stdout_bytes）+ 头尾全量条目 |
| `transcript` | L2 | **jsonl** 消息层 | user/assistant 文本 + 工具调用参数摘要（剥 toolResult 大块） |
| `trajectory_dynamic` | L3 | **trajectory jsonl** | model.completed / trace.artifacts / session.ended 三行 |
| `trajectory_full` | L4 | **trajectory jsonl** | 全量事件（默认不进 auto） |
| `auto` | 全部 | — | L-1→L0→L1→L2→L3→L4 按预算装填 |

> 数据源分界（已确认）：`verdict`/`transcript`/`trajectory_*` 读 **jsonl 文件**；
> `payload`/`commands_log` 读 **DB**。jsonl 定位链：run_id → sessions.json 索引
> → sessionId → `~/.openclaw/agents/openry-worker/sessions/{sessionId}.jsonl` 与
> `.trajectory.jsonl`。

### 3.2 run_id 双向设计（2026-08-18 修订）

- agent **可以不传**：隐式解析链（§2）仍是主路径，零参调用即用
- agent **可以传**：`inherit_payload` 已把 `_inherits_from_run_id` 注入其提示词
  （buildTaskDescription 的 Previous step results），agent 直接抄传可省掉工具侧解析
- **传参校验**：`SELECT ... WHERE run_id = 参数` 查不到 → 自动回落隐式解析链，
  不报错，`resolved.fallback_used: true` 标出——不把证据链押在 LLM 抄 UUID 的准确率上
- **数字别名**（语法糖）：`"0"=verdict, "1"=payload, "2"=commands_log,
  "3"=transcript, "4"=trajectory_dynamic`；`trajectory_full` 无别名（默认不进 auto）。
  字符串名为主形式（自解释，避免 0 是 L-1 还是 L0 的歧义）
- **v0.5 主路径变更（实例 55 实证）**：`_inherits_from_run_id` 每跳会被上游覆盖，
  第二跳起即失真。流程改为：第一步 shell 硬代码第一跳落地 failed_run_id，
  analyze_fix 调用时**显式传 run_id = failed_run_id**（主路径），
  隐式解析链降级为兜底/调试通道

## 4. 响应结构（单次调用返回一个 JSON 文本）

```json
{
  "resolved": {
    "target_run_id": "26ce76f2-...",      // 解析出的失败任务 run_id
    "view": "single_step",                 // single_step | instance
    "session_id": "d78ba06b-...",          // 反查结果（可能为 null）
    "fallback_used": false                 // 是否走了 ③ 兜底
  },
  "catalog": [
    {"source": "verdict",        "available": true,  "bytes": 200,   "est_tokens": 70},
    {"source": "payload",        "available": true,  "bytes": 412,   "est_tokens": 150},
    {"source": "transcript",     "available": true,  "bytes": 10961, "est_tokens": 3836}
  ],
  "verdict": {"aborted": true, "externalAbort": true, "timedOut": false, "finalStatus": "error"},
  "data": {
    "payload":        { ...L0 内容... },
    "commands_log":   { ...L1 内容... },
    "transcript":     { ...L2 内容... }
  },
  "skipped": [{"source": "trajectory_full", "reason": "budget"}]
}
```

- `resolved` 永远返回：让分析步知道「证据是谁的、什么视角、是否兜底」
- `catalog` 永远返回：大小与可用性透明（agent 可据此决定下一轮点名）
- `data` 只含请求的层；`skipped` 列出装不下的
- 多次调用语义：无状态，每次重新走解析链（catalog 可指导后续点名）

## 5. 工具注册与接线（实现清单）

| # | 位置 | 改动 |
|---|------|------|
| 1 | `orchestrator-plugin/src/index.ts` | `api.registerTool` 注册 `openry_analysis_sources`（同 openry_payload_query 模式） |
| 2 | `src/tools/trusted-policy.ts` | `ALLOWED_TOOLS` 加 `openry_analysis_sources`（否则被 exec-gate 拦截） |
| 3 | `seed/tools.yaml` | tools 列表加 `openry_analysis_sources`（安装同步用） |
| 4 | 实现文件 `src/tools/analysis-sources.ts` | 解析链 + DB 读取 + jsonl 读取 + token 估算 + 装填 |
| 5 | plugin 构建 + gateway restart | 常规部署 |

实现要点：
- `sessions.json`（4.8MB）每次调用装载一次即可；可选进程级缓存
- token 估算：CJK×0.7 + 其他÷4，×1.2 边际；文件级 bytes×0.35
- 文件缺失 → catalog `available:false`，不报错
- `trajectory_dynamic` 只取三行事件（实测 145KB 中 115KB 静态噪音，已解剖）

## 6. 测试计划

1. 改造 `test_evidence_collect`：第二 sub_step 从 shell 改为 **agent**，调用
   `openry_analysis_sources {"sources":["verdict","payload","commands_log"]}`，
   把返回回显进 payload（transcript/trajectory 第二次点名再取）
2. 核对：`resolved.target_run_id` = 失败步 run_id；`verdict.aborted=true`；
   `data.commands_log` 含 echo evidence_probe；payload 为空但有相邻步摘要
3. 成功-低效视角：加一个 `command_count` 场景验证 `view: instance`
4. 边界：文件缺失（无 session）、指针缺失（走兜底）各一例

**验证记录**：
- 实例 55：无参调用成功——auto 五层全装填（9310/12000 tokens），
  `resolved.target_run_id` 正确指向失败任务；但暴露教训：语义失败场景
  verdict 无信号、evidence 对象经 `${payload.xxx}` 插值会变 `[object Object]`
- 实例 56：显式 `run_id` 传 failed_run_id 调用成功，证据支撑单块修复，闭环跑通

## 7. 更新记录

| 日期 | 变更 |
|------|------|
| 2026-08-18 | 定稿：工具定位（plugin 注册、agent 自助）、run_id 三层解析链 + 视角分支、sources 参数映射 L-1~L4、响应结构（resolved/catalog/data/skipped）、接线清单、测试计划。实证基础：test_evidence_collect 实例 48/49 |
| 2026-08-18 | 修订 §3.2：run_id 双向设计（agent 可传可不传，传错自动回落）；sources 数字别名 "0"~"4" |
| 2026-08-18 | 实现完成（纯新增）：`src/tools/analysis-sources.ts` + index.ts 注册块 + trusted-policy 白名单追加 + openclaw.plugin.json contracts + openclaw.json alsoAllow + seed/tools.yaml；离线冒烟测试通过（实例 49 真实 run_id：resolved/verdict/data 全对）；fixture 第二步入 agent 化 |
| 2026-08-18 | 修订：默认 budget 8000→12000（auto 覆盖到 L3）；step ① 提示词从详写改为两行（工具描述/参数 schema 自动注入 agent，无需重复写用法） |
| 2026-08-18 | 现场验证（实例 55/56）：无参与显式 run_id 双通道均成功；v0.5 起主路径改为显式传 failed_run_id（指针每跳覆盖的补偿）；补充语义失败场景 verdict 无信号教训（见 §6 验证记录） |
