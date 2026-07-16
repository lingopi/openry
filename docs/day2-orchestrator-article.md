# OpenRY Day 2：Workflow 编排引擎——给 Agent 装上"硬代码控制器"

> 本文是 OpenRY 项目开发日志的第二篇。Phase 1 我造了一副"可控的假肢"（命令转发器），Phase 2 我给它装上了一个纯粹由硬代码驱动的 Workflow 编排引擎。

---

## 一、回顾：Phase 1 解决了什么

在 [Day 1](https://blog.csdn.net/yifan850902/article/details/162915284?spm=1001.2014.3001.5501) 中，我搞定了最核心的组件：**命令转发器 `openry`**。

Agent 不再直接调系统命令，而是通过 `openry -c 'your command'` 转发。每次调用都被记录到 SQLite，每次状态更新都必须显式声明。Agent 只负责"动脑"，`openry` 负责"动手"。

但 Phase 1 留下了一个巨大的空白：**谁来告诉 Agent 下一步做什么？**

这就是 Phase 2 要解决的问题。

---

## 二、Phase 2：Workflow 编排引擎

### 2.1 核心思路

Phase 2 构建了一个**完全由硬代码驱动的 Workflow 编排器（Orchestrator）**。它做的事情很简单：

```
每隔 5 秒扫一遍 SQLite →
  发现 queued 的任务 → 拉起 agent 进程开干
  发现 completed 的任务 → 跑硬代码验证规则
  发现 validated 的任务 → 根据 YAML 配置路由到下一步
  发现超时的任务 → 软刹车通知 agent 停止
  发现僵死的任务 → 重置重新调度
  发现失败的但有重试次数 → 重新入队
```

Agent 从头到尾不知道自己在哪个 workflow、第几个 step、run_id 是什么。编排器通过环境变量静默注入这些信息，Agent 无感。

### 2.2 新增的能力清单

| 模块 | 能力 | 说明 |
|------|------|------|
| **YAML 配置** | Workflow 定义 | Big Step / Sub Step 的 DSL，支持路由、重试、验证规则 |
| **巡查循环** | 状态机驱动 | 11 步串行扫描，覆盖 queued→in_progress→completed→validated→next_step 全生命周期 |
| **硬验证引擎** | 8 种规则 | payload_has_key、payload_value_matches、payload_values_equal、file_exists、file_contains、command、command_output_contains、db_query |
| **两级重试** | big_step + sub_step | sub_step 失败可只重试当前步骤，big_step 失败可整体重来 |
| **软刹车** | cancel 机制 | Orchestrator 在 DB 中设标记 → openry 在命令返回中注入停止消息 → agent 主动调 `--status cancelled` |
| **Payload 传递** | 步骤间数据流 | `inherit_payload` 控制是否合并上一步数据，`expect_payload` 控制是否强制 agent 提交数据 |
| **超步数熔断** | max_tool_calls | 每个 sub_step 最多调 N 次 openry，超过即判定失败 |
| **命令策略** | allowlist/blocklist | 每个 sub_step 可限制允许或禁止的系统命令 |
| **Overflow 框架** | 超 token 控制 | 检测输出过大 → 注入通知 → 跳转用户自定义的切片压缩 workflow → 恢复执行 |

### 2.3 关键设计决策

经过两天的深入思考，我确认了以下设计原则：

**超时计时器永不重置。** 从 big_step 第一个 sub_step 开始时计时，中间重试 N 次也继续走。代码最简洁，逻辑最清晰。

**软刹车不杀进程。** Orchestrator 只设一个 DB 标记，openry 在下一次命令调用时检查标记，在返回给 agent 的内容中注入停止消息。agent 看到后**主动**调 `--status cancelled`，然后 Orchestrator 才执行硬刹车（SIGTERM → 5s → SIGKILL）。

**每个 sub_step 一个独立 run_id。** 追踪粒度精确到步骤级别，命令历史、payload、验证结果全部独立可查。

**硬验证结果驱动路由。** 验证失败不是"报个错就完了"，而是通过 `on_validation_fail` 决定下一步：是重试当前步骤、直接失败、还是跳转到补救步骤。

---

## 三、代码结构

Phase 2 在 Phase 1 基础上**纯扩展，零删除**：

```
openry/
├── cli.py              # 扩展：新增 cancel/policy/overflow/tool_calls 四个检查钩子
├── db.py               # 扩展：新增 5 张表 + 15 列 + 20+ 查询函数
├── executor.py         # 锁死，不动
├── config.py           # 不动
├── utils.py            # 不动
└── orchestrator/       # 全新包
    ├── engine.py       # 巡查循环 + 子进程管理 + 重试逻辑
    ├── yaml_loader.py  # Workflow/Composition YAML 解析
    ├── validation.py   # 8 种硬验证规则引擎
    ├── payload.py      # Payload 合并与路由
    └── cli.py          # openry-orchestrator CLI（7 个子命令）
```

对外合约完全不变。Phase 1 的 `openry -c` 和 `openry --status` 调用方式、返回格式、环境变量——一个都没改。

---

## 四、端到端测试

启动一个 workflow → agent 执行 step_hello → agent 声明完成 → Orchestrator 验证 → 路由到 step_verify：

```
$ openry-orchestrator start test_composition
Workflow instance started: ID=1

$ OPENRY_RUN_ID="<run_id>" openry -c 'echo "agent doing work"'
$ OPENRY_RUN_ID="<run_id>" openry --status completed --payload '{"result":"ok"}'

# 巡查一轮
$ python3 -c "from openry.orchestrator.engine import Orchestrator; Orchestrator()._patrol()"

# step_hello → validated → step_verify 已自动入队 ✅
$ python3 -c "
from openry.db import _get_conn
conn = _get_conn()
rows = conn.execute('SELECT status, sub_step_id FROM task_state ORDER BY created_at').fetchall()
for r in rows: print(f'{r[0]:15s} {r[1]}')
"
validated       step_hello
queued          step_verify
```

---

## 五、未来方向：要解决什么用户痛点

Phase 1 + Phase 2 实现了一个完整的 Workflow 编排引擎。但这不是终点。我们做开源项目的宗旨是：

> **提供基础能力，把"解决问题的方法"交给用户自己去拼装。**

下面用两个核心用户痛点来说明这个理念。

### 痛点 1：小模型跑不出付费模型的效果

GPT-4、Claude Opus 一次推理就要几毛钱，而开源的 Qwen、DeepSeek 等小模型便宜几十倍——但能力差距明显。

我的答案不是"让模型变强"，而是**让 Workflow 变聪明**。

Phase 3 规划的 **Loop Engineering** 思路：

```
用户用自然语言说："帮我处理客户邮件"
    ↓
AI 用 Plan & Execute 生成初始 Workflow YAML
    ↓
Orchestrator 运行 workflow
    ↓
某个 step 反复失败 → AI 读取 commands_log（完整的执行记录）
                     → 分析为什么失败
                     → 自动修改 YAML（调整 prompt、增加验证规则、拆分 step）
                     → 重新运行
    ↓
迭代 N 轮后收敛 → 一个稳定的 Workflow 诞生
```

**小模型单次推理能力弱，但如果你让它跑 10 轮、每轮都能看到上一轮的完整执行记录并自我修正——10 次便宜的推理加起来，效果可能超过一次昂贵的推理。**

提供的能力：
- `commands_log`：完整的、结构化的执行历史
- Orchestrator 巡查循环：自动检测失败、触发重试
- Workflow YAML 的可读写性：AI 可以修改配置后热重载

不提供的：
- 一个"完美的默认 prompt"
- 一个"开箱即用的万能 workflow"

用户用积木搭自己的解决方案。

### 痛点 2：小模型上下文窗口不够

很多开源模型的上下文只有 32K、128K token。Agent 跑着跑着，`cat` 一个 100 万 token 的日志文件，直接炸了。

我的答案是 **Output Overflow 机制**——但不替你决定"怎么压缩"。

流程是这样的：

```
Agent 调 openry -c 'cat huge.log'
    ↓
openry 检测输出 > max_output_tokens（比如 80 万 token）
    ↓
openry 返回给 agent："输出太大了，原始内容已保存，请调 --status overflow"
（注意：openry 不卡住 agent，立即返回！）
    ↓
agent 调 --status overflow
    ↓
Orchestrator 发现 status=overflow
    ↓
从 commands_log 提取 agent 在这个 step 里的完整历史上下文
    ↓
跳转到用户配置的 overflow_workflow（比如叫 log_overflow_handler）
    ↓
overflow_workflow 执行：
    sub_step_1 (shell): python slice.py → 按 50 万 token 切片
    sub_step_2 (agent): 对每个切片调用 LLM 做摘要
    sub_step_3 (shell): python merge.py → 合并所有摘要
    ↓
结果写回原 run_id 的 payload
    ↓
Orchestrator 重新拉起 agent session
新 prompt = 原任务描述 + 完整历史上下文 + 压缩后的结果
    ↓
agent 从断点继续干活，完全不知道中间发生了什么
```

**关键设计**：
- **不依赖 openclaw 或任何 agent 框架**来做上下文保留。上下文来源是自己的 `commands_log` 表——每一轮工具调用都在里面。
- **不替你决定怎么切片压缩**。你可以用 LLM 做摘要、可以写 Python 脚本硬裁剪、可以调外部 API——overflow_workflow 是你自己设计的。
- 但**提供一个默认的 overflow_workflow 模板**，开箱即用，不满意就自己改。

这就是我的产品哲学：**提供的是"能配置切片压缩 workflow 的能力"，不是"一个完美的切片压缩算法"。**

---

## 六、我们不是什么

为避免误解，有必要说清楚我们**不做**什么：

| 我们不做 | 原因 |
|---------|------|
| 一个"比 GPT-5 更聪明"的 Agent | 我们是 Workflow 引擎，不是模型 |
| 一个开箱即用的万能 workflow 模板库 | 场景千差万别，模板由社区贡献 |
| 一个完美的自动压缩算法 | 提供能力，不替用户做决策 |
| 一个替代 LangChain/AutoGPT 的框架 | 我们在更底层，是命令转发 + 硬约束层 |

我们做的是**给 Agent 戴上一副可控的镣铐**——让它能跳舞，但跳不出舞台。

---

## 七、下一步

Phase 2 的代码已经完成，但仍然无法运行起一个完整的workflow，预计 Phase 3 的工作完成后，就可以真正的开始跑真实测试了，目标使用openclaw做成plugin来测试。GitHub 仓库地址：[github.com/lingopi/openry](https://github.com/lingopi/openry)。

Phase 3 将在以下方向深入：
- **Loop Engineering**：AI 自动生成和迭代 Workflow
- **Overflow 机制完善**：上下文历史的自动压缩与恢复
- **`kind: shell` 支持**：Workflow 中直接嵌入脚本步骤
- **条件路由**：根据验证结果的具体值（而非简单的 pass/fail）决定下一步

欢迎 Star、Issue、PR。

---

*OpenRY — 让 Agent 戴上镣铐跳舞。*
