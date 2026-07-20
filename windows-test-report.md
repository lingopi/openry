# OpenRY 测试报告

- **测试日期**:2026-07-16
- **测试平台**:Windows + PowerShell 7 (pwsh)
- **被测版本**:`git clone https://github.com/lingopi/openry.git`(main)
- **测试范围**:命令转发、Orchestrator 上下文、状态更新与 payload、错误处理、SQLite 审计、PowerShell 引号地狱、字符编码

---

## 1. 执行模型

OpenRY 的命令执行是**双层解析**链路:

```
外层 PowerShell (openry -c '...')   ← 解析第 1 层引号
        │  原样传给 openry 的 command 参数
        ▼
openry executor
        │  subprocess.run([pwsh, -NoProfile, -NonInteractive, -Command, <string>])
        ▼
内层 pwsh -Command                  ← 再次解析第 2 层引号 / 变量 / 操作符
```

理解引号与变量行为的关键:**外层与内层各解析一次**。相关代码见
[openry/executor.py](openry/executor.py#L91-L98)。

---

## 2. 功能测试

### 2.1 基础命令转发

| 命令 | 输出 | 结果 |
|------|------|------|
| `openry -c 'echo "hello"'` | `{"exit_code": 0, "stdout": "hello\r\n", "stderr": "", "duration_ms": 569}` | ✅ |

### 2.2 Orchestrator 上下文(环境变量)

设置 `OPENRY_RUN_ID` / `OPENRY_WORKFLOW` / `OPENRY_STEP_ID` 后执行命令:

| 命令 | 输出 | 结果 |
|------|------|------|
| `$env:OPENRY_RUN_ID="run-001"; ... ; openry -c 'echo "hello from orchestrator"'` | `{"exit_code": 0, "stdout": "hello from orchestrator\r\n", ...}` | ✅ 元数据正确写入审计库 |

- 元数据(run_id / workflow / step_id)对 agent 输出**不可见**,仅写入 SQLite,符合"透明审计"设计。

### 2.3 额外环境变量注入(`-e`)

| 命令 | 输出 | 结果 |
|------|------|------|
| `openry -c 'echo "custom var = $env:MY_VAR"' -e MY_VAR=hello123` | `{"exit_code": 0, "stdout": "custom var = hello123\r\n", ...}` | ✅ |

### 2.4 状态更新 + payload

| 命令 | 输出 | 结果 |
|------|------|------|
| `openry --status completed --payload '{"msg_id":"123","artifact":"report.pdf"}'` | `{"status": "completed", "payload": {"msg_id": "123", "artifact": "report.pdf"}, "acknowledged": true}` | ✅ payload 原样回传并入库 |

---

## 3. 错误处理与边界

| 场景 | 命令 | 输出 | 结果 |
|------|------|------|------|
| 无 RUN_ID 做 status | `openry --status completed`(未设 RUN_ID) | `{"error": "OPENRY_RUN_ID not set; --status requires an active run"}` | ✅ |
| 非法 JSON payload | `--payload '{invalid json}'` | `{"error": "payload must be valid JSON"}` | ✅ |
| 非对象 payload | `--payload '["not","an","object"]'` | `{"error": "payload must be a JSON object"}` | ✅ |
| 命令非零退出码 | `openry -c 'exit 3'` | `{"exit_code": 3, ...}` | ✅ 退出码透传 |

---

## 4. SQLite 审计验证

数据库位置:`.openry/openry.db`

### 4.1 `commands_log`(节选)

| id | run_id | workflow | step_id | command | shell | exit_code | timeout |
|----|--------|----------|---------|---------|-------|-----------|---------|
| 2 | (null) | (null) | (null) | `echo "hello"` | pwsh | 0 | 0 |
| 3 | run-001 | demo-flow | step-1 | `echo "hello from orchestrator"` | pwsh | 0 | 0 |
| 4 | run-001 | demo-flow | step-1 | `echo "custom var = $env:MY_VAR"` | pwsh | 0 | 0 |
| 6 | run-002 | (null) | (null) | `exit 3` | pwsh | 3 | 0 |

- ✅ 每次命令均落库;Orchestrator 上下文正确关联。

### 4.2 `task_state`(状态机生命周期)

| run_id | status | payload | created_at | updated_at |
|--------|--------|---------|-----------|-----------|
| run-001 | completed | `{"msg_id":"123","artifact":"report.pdf"}` | 07:22:00 | 07:22:41 |
| run-002 | in_progress | `{}` | 07:22:52 | 07:22:52 |

- ✅ `run-001`:`-c` 执行时创建为 `in_progress`,`--status completed` 后升级为 `completed`,**created_at 保留、updated_at 刷新**。
- ✅ `run-002`:设置了 RUN_ID 后,`exit 3` 自动创建 `in_progress` 行。

---

## 5. PowerShell 引号地狱

| # | 场景 | 命令片段 | stdout 呈现 | 结果 |
|---|------|----------|-------------|------|
| 1 | 单引号裹双引号 | `'echo "hello world"'` | `hello world` | ✅ |
| 2 | 字面量单引号(`''` 转义) | `'echo ''it''''s a test'''` | `it's a test` | ✅ |
| 3 | 单双引号混合 | `'echo "she said ''hi''"'` | `she said 'hi'` | ✅ |
| 4 | 输出 JSON 字面量 | `'echo ''{"name":"openry","ok":true}'''` | `{\"name\": \"openry\", \"ok\": true}` | ✅ 双引号被 JSON 转义为 `\"` |
| 5 | 变量展开(双层陷阱) | `'echo "PID=$PID"'` | `PID=74960` | ⚠️ 外层单引号本应字面量,**内层 pwsh 仍求值** |
| 6 | 阻止内层求值 | `'echo ''literal $PID not expanded'''` | `literal $PID not expanded` | ✅ 内层单引号才字面量 |
| 7 | 内层双引号需反引号转义 | `` 'echo "quote: `"nested`""' `` | `quote: \"nested\"` | ✅ |
| 8 | 语句分隔符 `;` | `'echo A; echo B'` | `A\r\nB` | ✅ 被内层 pwsh 执行 |
| 9 | Unicode/中文/emoji | `'echo "中文 😀 café"'` | `?? ?? caf�` | ❌ **乱码(编码 bug)** |
| 10 | stderr 含引号 | `'Write-Error "oops ''bad'' thing"'` | `...oops 'bad' thing...` | ✅ 引号保留(夹带 ANSI 颜色码 `\u001b[31;1m`) |

### 结论

- **引号地狱可正常呈现**,但使用者必须按"双层解析"心智模型编写命令。
- 案例 5 是核心坑:外层单引号无法阻止**内层** pwsh 对 `$PID` 求值;要字面量必须让内层也用单引号(案例 6)。
- OpenRY 用 `json.dumps` 序列化输出,命令结果中的双引号/反斜杠都会被安全转义,Orchestrator 始终拿到**合法 JSON**,不会被二次破坏。

---

## 6. 缺陷记录

### BUG-1:非 ASCII 输出乱码(中等严重)

- **现象**:`echo "中文 😀 café"` 输出为 `?? ?? caf�`(见案例 9)。
- **影响**:任何含中文、emoji、重音字母的命令输出都会损坏,进而污染审计库与 Orchestrator payload。
- **根因**:
  1. [openry/executor.py](openry/executor.py#L91-L98) 用 `subprocess.run(..., capture_output=True)` 捕获**字节**,但子进程 pwsh 的 `[Console]::OutputEncoding` 在 Windows 默认是系统代码页(非 UTF-8),部分字符在输出阶段即被替换为 `?`;
  2. [openry/utils.py](openry/utils.py#L14-L16) 的 `safe_decode` 用 `sys.getfilesystemencoding()` 解码,与 pwsh 实际输出编码不匹配,`é` 等字节进一步坏成 `�`。
- **建议修复方向**:
  - 调用 pwsh 时强制 UTF-8 输出,例如在 `-Command` 前置 `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8;`;
  - 将 `safe_decode` 固定为 `utf-8`(保留 `errors="surrogateescape"` 或改 `replace`)。

### 观察项:stderr 夹带 ANSI 颜色码

- `Write-Error` 的 stderr 输出包含 ANSI 转义序列(`\u001b[31;1m`,见案例 10)。
- 对机器消费(Orchestrator)可能是噪声。可考虑调用时加 `-NoLogo` 或设置 `$PSStyle.OutputRendering = 'PlainText'`(pwsh 7.2+)。

---

## 7. 总体结论

| 维度 | 评价 |
|------|------|
| 命令转发 | ✅ 稳定,退出码/stdout/stderr 透传正确 |
| Orchestrator 上下文 | ✅ 环境变量注入与元数据关联正确 |
| 状态机 + payload | ✅ `in_progress → completed` 生命周期与 payload 存取正确 |
| 错误处理 | ✅ 边界与非法输入均有明确报错 |
| SQLite 审计 | ✅ 命令与状态完整落库,对 agent 透明 |
| 引号地狱 | ✅ 可呈现(需双层心智模型) |
| 字符编码 | ❌ 非 ASCII 输出乱码(BUG-1,待修复) |

**核心闭环(命令转发 → 上下文注入 → 状态更新 + payload → 透明审计)全部验证通过。** 唯一需要修复的是 Windows 下非 ASCII 输出的 UTF-8 编码问题(BUG-1)。
