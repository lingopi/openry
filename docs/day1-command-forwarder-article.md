# 从"控制Agent的手"开始：构建ReAct Agent的命令转发器

> 本文记录了 OpenRY 项目 Phase 1 的设计思路——一个跨平台的命令转发器，用于在 ReAct Agent + Workflow 体系中实现对 Agent 行为的硬约束。

---

## 一、问题的原点：Agent 的手不可信

在基于 ReAct 模式的 AI Agent 开发中，一个反复出现的痛点是：**Agent 太自由了**。

以 OpenCLaw 或 Claude Code 这类 Agent 框架为例，Agent 可以自由调用 `ls`、`cat`、`python`、`curl` 等任何系统命令。这种自由带来了三个致命问题：

### 问题 1：状态机断裂

Agent 完成一个步骤后，可能不发送状态更新、发送错误的状态码、或者发送了但格式不对。硬代码无法判断当前步骤到底完成了没有，整个 Workflow 流程卡死。

### 问题 2：无限循环烧 Token

Agent 在某个步骤中陷入"工具调用 → 结果 → 思考 → 再调用"的死循环。没有外部刹车机制，一次对话轻松烧掉几十美元的 Token 费用。

### 问题 3：虚假完成

Agent "认为"自己完成了任务，但实际上产物缺失、数据错误。它自信满满地告诉编排器"我做好了"，而下一个步骤拿到错误输入后全线崩溃。

**根因只有一个：Agent 同时拥有"大脑"（推理）和"双手"（执行命令），没有任何中间层做约束。**

---

## 二、解法：命令转发器模式

我们的核心思路是**把 Agent 的手砍掉，换上一个可控的假肢**。

改造前，Agent 直接调用系统命令，完全自由。改造后，所有"动手"操作必须通过 `openry` 这个中间层转发，Agent 不再直接接触系统。

这样做的好处：

| 能力 | 实现方式 |
|------|----------|
| **强制状态机** | Agent 完成步骤后必须显式声明完成状态，硬代码可查询验证 |
| **软刹车** | openry 可以修改返回内容，告知 Agent 立即停止当前操作 |
| **命令白名单** | 不同 step 可限制允许的命令集合（Phase 2） |
| **免费审计** | 所有命令调用自动记录，完整可追溯 |
| **调用计数** | 每个 step 的 openry 调用次数可统计，超限可熔断 |

---

## 三、架构设计

### 3.1 三层分离

整个系统分为三层：

- **Orchestrator（硬代码）**：负责路由、验证、调度。它加载 Workflow 配置，决定每一步做什么，验证 Agent 是否真正完成了任务。
- **Agent（大脑）**：只管推理和决策。它不知道 workflow 是什么、当前在第几步、run_id 是什么。它只收到当前任务的描述，然后用 openry 干活。
- **openry（手）**：执行命令、记录日志、返回结构化结果。它是最底层的执行器，对 Agent 透明，对 Orchestrator 可控。

**关键设计：Agent 完全不知道 workflow、step、run_id 这些概念。** 上下文由 Orchestrator 通过环境变量注入给 openry，Agent 全程无感。

### 3.2 跨平台 Shell 策略

| 平台 | 优先 Shell | 回退 |
|------|-----------|------|
| Windows | PowerShell 7 | cmd.exe |
| macOS | /bin/zsh | /bin/bash |
| Linux | /bin/sh | /bin/bash |

Windows 上选择 PowerShell 7 的原因：处理嵌套引号和管道符最稳定，避免 cmd.exe 的引号地狱。

### 3.3 数据存储

使用 SQLite 作为本地数据层，两张核心表：

- **命令日志表**：记录每一次命令转发的完整信息（命令内容、退出码、标准输出、错误输出、耗时）
- **任务状态表**：记录每个 run_id 的当前状态（进行中、已完成、已失败）和 Agent 提交的 Payload 数据

两张表互不依赖，各司其职。Orchestrator 通过查询这两张表就能完整掌握所有 Agent 的行为轨迹。

---

## 四、Phase 1 核心能力

Phase 1 聚焦于最核心的三件事：**执行命令、更新状态、传递 Payload**。

### 4.1 命令转发

Agent 调用 `openry -c '<命令>'` ，openry 自动检测当前平台，选择最优 Shell 执行命令，捕获标准输出、错误输出和退出码，将结果以简洁 JSON 返回给 Agent。

Agent 看到的响应极其精简——只包含 exit_code、stdout、stderr、duration_ms 四个字段。它不知道这条记录同时被写入了 SQLite，更不知道自己的 run_id 是什么。

### 4.2 状态更新

Agent 完成任务后，必须显式调用 `openry --status completed` 来声明完成。如果失败，则调用 `openry --status failed`。

这个设计的关键在于：**Agent 说自己完成了，但我们默认它不可信。** 状态写入 SQLite 后，由 Orchestrator 执行硬代码验证规则（比如检查指定文件是否真的被创建了），通过后才算真正完成。

### 4.3 Payload 传递

Workflow 中多个步骤之间需要传递数据。比如发邮件的第一步获取了 message_id，第二步编辑草稿时需要用到这个 ID。Agent 通过 `openry --status completed --payload '{"message_id":"xxx"}'` 将数据提交，Orchestrator 在启动下一个 step 时自动注入。

### 4.4 实测验证

以下是在 macOS 上的实际终端输出：

**基础命令转发：**

```text
$ openry -c 'echo hello world'
{"exit_code": 0, "stdout": "hello world\n", "stderr": "", "duration_ms": 4}
```

**复杂命令：**

```text
$ openry -c 'ls -la openry/'
{"exit_code": 0, "stdout": "total 64\n-rw-r--r--@  cli.py\n-rw-r--r--@  executor.py\n...",
 "stderr": "", "duration_ms": 9}
```

**带环境变量注入（模拟 Orchestrator）：**

```text
$ OPENRY_RUN_ID="test-001" OPENRY_WORKFLOW="demo" \
  OPENRY_STEP_ID="check" openry -c 'echo building...'
{"exit_code": 0, "stdout": "building...\n", "stderr": "", "duration_ms": 4}
```

**状态更新 + Payload：**

```text
$ OPENRY_RUN_ID="test-001" openry --status completed \
  --payload '{"message_id":"abc123"}'
{"status": "completed", "payload": {"message_id": "abc123"}, "acknowledged": true}
```

从输出可以看到：Agent 收到的 JSON 干净简洁，不包含任何 workflow 元数据。而 SQLite 中已正确记录：

```text
commands_log  (3, 'test-001', 'demo', 'check', 'echo building...', 0)
task_state    ('test-001', 'demo', 'check', 'completed', '{"message_id":"abc123"}', ...)
```

---

## 五、软刹车机制

软刹车的核心思路：**openry 不只做透明转发，它可以在特定条件下修改返回给 Agent 的内容，引导 Agent 停止操作。**

具体做法：当 Orchestrator 检测到当前 step 的调用次数超过阈值、耗时过长或 Token 预算耗尽时，openry 不再返回命令的真实执行结果，而是返回：

```json
{
  "exit_code": 0,
  "stdout": "User requested immediate stop",
  "stderr": "",
  "duration_ms": 0
}
```

Agent 的 System Prompt 中提前约定：**如果你收到的 stdout 内容是 "User requested immediate stop"，你必须立即停止当前操作，调用 openry --status completed 或 openry --status failed，不得继续执行任何命令。**

这比在 JSON 中增加额外字段更优雅——Agent 不需要理解新的协议字段，它只是在"读取命令输出"这个已有的行为路径上被引导。对于 LLM 来说，stdout 里的自然语言指令是最自然的"刹车信号"。

---

## 六、项目结构

Phase 1 的 Python 包只包含 6 个模块，依赖极简（一个 pyyaml，其余全部标准库）：

- **cli**：命令行入口，参数解析，主流程编排
- **executor**：跨平台命令执行，Shell 检测与选择
- **db**：SQLite 初始化、命令日志写入、任务状态更新
- **config**：YAML 配置文件加载，合并默认值
- **utils**：时间戳生成、输出截断、编码安全处理

---

## 七、下一步：Phase 2

Phase 1 解决了"手"的问题。Phase 2 将构建 Orchestrator（编排引擎），核心能力包括：

- **Workflow YAML 配置**：用声明式语法定义 big_step → sub_step 的树形结构，每个 step 可配置验证规则和路由策略
- **巡查循环**：Orchestrator 作为守护进程，每 N 秒扫描 SQLite，调度 queued 任务，检测僵死进程并自动重置
- **硬代码验证**：Agent 说完成了？先跑一遍文件存在性检查、命令回归测试、Payload 完整性校验再说
- **并发控制**：Worker Pool 管理，同一 workflow 可多实例并行执行，实例内 big_step 和 sub_step 严格串行

---

## 八、总结

OpenRY Phase 1 做的事情非常简单：**在所有 Agent 和系统命令之间插入一个可控的中间层。** 这个中间层对 Agent 几乎透明（它只看到简洁的 JSON 返回），但对硬代码完全可控（所有行为被记录、所有状态被追踪、关键节点可干预）。

这就像一个沙箱——Agent 在里面可以自由思考，但每一次伸手触碰外部世界，都必须经过我们的安检门。

> **Agent 应该动脑，不应该动手。手动得越多，系统越不可控。把手指砍掉，换上我们能控制的那一根。**

---

*项目地址：[GitHub] | 设计文档：design/phase1-command-forwarder.md*
