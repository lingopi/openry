# 失败分析数据源阶梯（设计定稿）

> 日期：2026-08-17
> 状态：定稿（全部规模数字为 DB/文件实测，随文标注）
> 关联文档：
> - `failure-routing-model.md` —— 失败路由模型（on_dropped + retrieve，8 路径 payload 矩阵）
> - `config-building-guide.md` —— 构建思路（怎么想）
> - `iteration-canonical-form.md` —— 迭代产物规范形（loop_analyze 的修复输出格式，2026-08-17 定稿）
> - `analysis-source-api.md` —— openry_analysis_sources 工具 API 设计（本文 §4 的实现级细化，2026-08-18 定稿）
> - `docs/compositions-and-workflows-guide.md` —— 字段手册（有什么）

---

## 1. 问题与目标

loop 迭代的 `loop_analyze` 步骤需要自取证据，两种触发路径：

| 路径 | 触发 | 分析目标 |
|------|------|---------|
| 失败修复 | 失败步 on_dropped 路由 | root_cause + fix（修 bug） |
| 成功-低效 | `command_count > 阈值`（默认 20） | 效率优化（合并写、批处理、机械步骤转 shell） |

约束与原则：
1. **token 预算有限**（phase3d 防溢出）——数据源规模从 200B 到 145KB 不等，必须分级
2. **服务端强制预算**——agent 的预算决策不可靠（实测倾向全取），装填决策留在工具侧，agent 只做覆盖
3. **从简**——一次调用拿全目录 + 自动装填；不强制两阶段

## 2. 数据源阶梯（L-1 ～ L4）

| 层级 | 数据源 | 实测规模 | 作用 |
|------|--------|---------|------|
| **L-1 判决层** | trajectory 提取：`aborted / externalAbort / timedOut / idleTimedOut / timedOutDuringCompaction / timedOutDuringToolExecution / timedOutByRunBudget / finalStatus / status` | **~200B** | 死亡原因定论，一锤定音 |
| **L0** | payload + `error` + `validation_status` + step kind + `routing_target` + 上下游各 1 步的 payload 摘要 | <1KB | 直接失败原因（注意：8 路径矩阵中 4 条 payload 不可靠，空 payload 本身即信号） |
| **L1** | commands_log：聚合指标（count / total_ms / max_ms / stdout_bytes）+ 头 3 尾 3 条全量 | ~5-15KB | 行动轨迹（agent 命令全量落库，shell 截 2KB） |
| **L2** | transcript 消息层：user/assistant 文本 + 工具调用名与参数摘要（剥掉 toolResult 大块） | ~10KB/step | 意图层：agent 当时怎么想 |
| **L3** | trajectory 动态段：`model.completed` + `trace.artifacts` + `session.ended` 三行 | ~20KB | 事件层：模型输出 + 中止原因上下文 |
| **L4** | 全量 transcript / 全量 trajectory | ~10KB / ~145KB | 深度复盘，仅手动点名 |

auto_bundle 按 L-1 → L0 → L1 → L2 → L3 → L4 顺序装填到预算为止，未装进的部分进 `skipped` 清单。

## 3. trajectory 解剖实证（2026-08-17，实例 35 会话文件）

145KB 的 trajectory 里 **115KB 是静态噪音**：

| 行 | type | 大小 | 性质 |
|----|------|------|------|
| 0 | session.started | 0.9KB | 动态 ✓ |
| 1 | trace.metadata | 60KB | ⚠️ 静态噪音（config/plugins/skills/prompting） |
| 2 | context.compiled | 29KB | ⚠️ 编译上下文（系统提示词+消息副本） |
| 3 | prompt.submitted | 26KB | ⚠️ 提示词副本 |
| 4 | model.completed | 12.6KB | ✅ 动态金矿 |
| 5 | trace.artifacts | 6.6KB | ✅ finalStatus + 标志 |
| 6 | session.ended | 0.8KB | ✅ 终态 |

**判决层实测验证**（四会话全对）：

| 会话 | aborted | timedOut | finalStatus | 实际死因 |
|------|---------|----------|-------------|---------|
| timeout_step(35) | True | False | — | 被 gateway abort 击杀 ✓ |
| cancel_step(34) | True | False | — | 被 hardKillCancelled ✓ |
| after_fail(33) | False | False | — | 正常完成 ✓ |
| after_cancel(34) | False | False | — | 正常完成 ✓ |

注意：实例 35 gateway 日志出现过 "LLM request timed out."，但判决字段 `timedOut=False`、
`aborted=True` —— **判决层是权威死因**（gateway 日志是过程信息）。分析步以判决层为准。

**例外（实例 55/56 实证）**：语义失败场景（步骤按任务约定上报失败、或
on_dropped 路由跳入）下判决层 `finalStatus=success` 无信号——此时分析应以
payload 层 + 路由指针为准。

## 4. 工具协议：`openry_analysis_sources`

> 实现级 API 设计已细化定稿于 `analysis-source-api.md`（run_id 三层隐式解析链 +
> sources 参数映射 + 响应结构 + 接线清单）。本节保留概念级协议。

```
openry_analysis_sources(
  run_id: string,                    # 必填，目标 step 的 run_id
  budget_tokens?: number,            # 默认 8000
  mode?: "auto" | "catalog_only",    # 默认 auto
  sources?: string[],                # 手动点名覆盖 auto：["commands_log","transcript",
                                     #   "trajectory_dynamic","trajectory_full","adjacent_payloads"]
)
```

响应（一次调用）：

```
{
  "catalog": [                      # 常驻目录层 —— 即"L0 前的 list"，不单独成阶段
    {"source":"payload","available":true,"bytes":412,"est_tokens":150},
    {"source":"commands_log","available":true,"bytes":8432,"est_tokens":2900},
    {"source":"transcript","available":true,"bytes":11491,"est_tokens":4000},
    {"source":"trajectory_dynamic","available":true,"bytes":20019,"est_tokens":7000},
    {"source":"trajectory_full","available":true,"bytes":146602,"est_tokens":51000}
  ],
  "verdict": {                       # L-1 判决层，永远附带
    "aborted":true, "externalAbort":false, "timedOut":false,
    "timedOutDuringToolExecution":false, "timedOutByRunBudget":false,
    "finalStatus":"killed"
  },
  "auto_bundle": {                   # L-1→L4 装填到预算的结果
    "included": ["verdict","payload","commands_log","transcript_head"],
    "content": {...}
  },
  "skipped": [                       # 预算装不下的，附大小供手动点名
    {"source":"trajectory_dynamic","bytes":20019,"reason":"budget"}
  ]
}
```

**为什么目录不独立成前置阶段**（讨论结论）：
1. auto_bundle 已由服务端强制预算，目录信息附带即可；拆两步 = 多一个失败点 +
   多一轮 LLM turn + 多一次 4.8MB `sessions.json` 装载，收益为零
2. agent 拿目录自己选，实测倾向"全取"——决策责任留在服务端
3. 保留 `mode: catalog_only`：agent 想"先探路再点菜"时可显式使用，不强制

**数据获取链路**（均已实测可用）：
- payload / commands_log / 相邻步：`~/.openry/openry.db`（SQLite 直查）
- transcript / trajectory：`sessions.json` 的 key 含 `:run:{run_id}` → sessionId →
  `~/.openclaw/agents/openry-worker/sessions/{sessionId}.jsonl` 与 `.trajectory.jsonl`

## 5. Token 估算约定

不需要真 tokenizer（估算值，文档标注）：
- 内容级：`est_tokens = CJK字符数 × 0.7 + 其他字符数 ÷ 4`，再 ×1.2 安全边际
- 文件级快速估算（不读内容）：`bytes × 0.35`（trajectory 为拉丁字符为主的 JSON）
- catalog 中一律标 `est_tokens`，auto_bundle 用估算值执行预算

## 6. 双路径触发

### 6.1 失败路径（已实现）

`on_dropped: loop_analyze` → 失败步置 `retrieve` → `routeRetrieve` 路由进分析步，
payload 照传 + verdict 判决。详见 `failure-routing-model.md` §5。

### 6.2 成功-低效路径（机制现成，零新代码）

1. `t_report_result` 上报 `command_count: N`（用 `openry_run` 查
   `commands_log` 的 COUNT，今天即可实现）
2. `validation_routing`：
   ```yaml
   validation_routing:
     - when_any:
         - type: payload_value_greater_than
           key: command_count
           value: 20
       on_match: loop_analyze          # 跨 big step，现成
       on_mismatch: done
   ```
3. 已核实：`payload_value_greater_than` 存在于双端 registry
   （`openry/orchestrator/validator.py` 与 `orchestrator-plugin/.../validator.ts`），
   Phase 3a 路由可直接消费

**软阈值约束**：`command_count` 软阈值（20）必须 **< `max_tool_calls` 硬上限**，
否则硬砍先触发，该 step 走失败路径而不是效率路径。

### 6.3 分析步提示词区分

`loop_analyze` 依据判决与入参区分两种身份：
- `verdict.aborted / error 存在` → 失败分析（root_cause + fix）
- `command_count 超阈 + verdict 全 False` → 效率分析（合并写文件、批量读、
  机械步骤转 shell、semantic_reporting 引导）

两种身份的修复手段相同（重写 YAML），可共用 `loop_analyze → loop_fix_yaml` 管道。

## 7. 收敛守卫（成功路径特有风险）

合法长流程（本来就要写 20+ 文件）会被无限迭代，守卫：
1. 全局迭代上限：`_loop_iteration < 5` → 否则 `loop_finalize`
2. **增益守卫**：本轮 `command_count ≥ 上轮 × 0.8`（减量 < 20%）→ `loop_finalize`；
   历史 command_count 沿 payload 链（inherit_payload）传递
3. 失败路径天然收敛：修好即停（`step_ok=true` 后不再路由回环）

## 8. 风险与未决

| 风险 | 说明 | 缓解 |
|------|------|------|
| trajectory schema 变更 | 提取字段基于 `traceSchema/openclaw-trajectory` schemaVersion 1 | 提取前校验 schemaVersion，不符则判决层置 `unavailable` 降级 |
| sessions.json 装载成本 | 4.8MB dict，每次工具调用装载一次 ~100ms | 可接受；频繁调用时插件内做进程级缓存 |
| 判决层 vs DB 状态冲突 | 判决层描述会话死亡原因，task_state.status 描述编排状态，可能不一致（实例 35：session killed + task dropped） | 分析步两者都看，冲突本身就是一条分析线索 |
| big_step 超时未武装 | `timeout_minutes` 无效，`timedOut` 类判决目前只会来自会话级 | 后续武装 `big_step_started_at` 写入（独立任务） |
| shell 步骤无 transcript | shell kind 不产生会话文件 | catalog 标 `available:false`，分析依赖 commands_log + payload |

## 9. 更新记录

| 日期 | 变更 |
|------|------|
| 2026-08-17 | 定稿：L-1~L4 阶梯、判决层（200B 提取）、trajectory 解剖实证（115KB 静态噪音）、openry_analysis_sources 工具协议（catalog 常驻 + auto_bundle + catalog_only）、token 估算约定、双路径触发（失败 on_dropped / 成功 payload_value_greater_than 已核实）、收敛守卫、风险清单 |
| 2026-08-18 | 现场验证（实例 55/56）：auto 五层装填 9310/12000 tokens；判决层补「语义失败无信号」例外；§6.2 成功-低效路径与 §7 收敛守卫仍暂缓（未接入 workflow） |
