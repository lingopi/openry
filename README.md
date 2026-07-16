# OpenRY

> **给 AI Agent 戴上镣铐跳舞**——一个跨平台的命令转发器，让 ReAct Agent 的每一次"动手"都可控、可审计、可刹车。

## 一句话

Agent 只负责动脑，OpenRY 负责动手，Orchestrator 负责编排。

## 核心能力（Phase 1）

- **命令转发**：`openry -c '<shell命令>'` — 跨平台执行，自动选择最优 Shell
- **状态更新**：`openry --status completed/failed` — Agent 显式声明完成
- **Payload 传递**：`--payload '{"key":"val"}'` — 步骤间数据传递
- **透明审计**：所有调用自动记录到 SQLite，Agent 无感

## 为什么需要 OpenRY

ReAct Agent 直接调用系统命令时，三个致命问题：

1. **状态机断裂** — Agent 不发送或发错状态，流程卡死
2. **无限循环** — 陷入"调用→思考→再调用"死循环，烧 Token
3. **虚假完成** — Agent 自称完成，实际产物缺失，下游崩溃

OpenRY 在所有 Agent 和系统命令之间插入可控中间层，从源头解决。

## 快速开始

```bash
# 安装
git clone https://github.com/lingopi/openry.git
cd openry
./install.sh

# 基础用法
openry -c 'echo hello world'
# → {"exit_code": 0, "stdout": "hello world\n", "stderr": "", "duration_ms": 4}

# 带 Orchestrator 上下文
OPENRY_RUN_ID="abc" openry --status completed --payload '{"msg_id":"123"}'
# → {"status": "completed", "payload": {"msg_id": "123"}, "acknowledged": true}
```

## 跨平台支持

| 平台 | Shell | 
|------|-------|
| Windows | PowerShell 7 |
| macOS | /bin/zsh |
| Linux | /bin/sh |

## 项目结构

```
openry/
├── cli.py          # 命令行入口
├── executor.py     # 跨平台命令执行
├── db.py           # SQLite 数据层
├── config.py       # 配置加载
└── utils.py        # 工具函数
```

依赖极简：`pyyaml` 一个外部包，其余全部 Python 标准库。

## License

MIT © OpenRY Contributors
