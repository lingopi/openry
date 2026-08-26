# Loop Engineering 进度总结（2026-08-17 收工）

> 目的：明天接着干时快速恢复上下文。
> 关联文档：`failure-routing-model.md` / `analysis-source-ladder.md` / `iteration-canonical-form.md` / `config-building-guide.md`

---

## 一、今日主线回顾

讨论了「自我迭代」（loop 闭环）的三块内容，状态如下：

| 议题 | 状态 |
|------|------|
| ① 迭代前需要哪些材料（分析步自取证据） | ✅ **定稿**：`analysis-source-ladder.md` |
| ② 迭代产物长什么样（规范形） | ✅ **定稿**：`iteration-canonical-form.md`（含写入契约 §5） |
| ③ 完整迭代闭环（触发→分析→修复→收敛） | ⚠️ **未定稿、未实现**（明天的方向） |

### ① 迭代前材料（已定稿）

`analysis-source-ladder.md`：

- 数据源阶梯：**L-1 判决层**（trajectory 提取 aborted/timedOut 等标志，~200B，实测四会话全对）→ **L0** payload+error+相邻步摘要 → **L1** commands_log 聚合+头尾 → **L2** transcript 消息层（~10KB）→ **L3** trajectory 动态段（model.completed+artifacts+ended，~20KB）→ **L4** 全量（手动点名）
- 关键实证：trajectory 145KB 中 **115KB 是静态噪音**（metadata/compiled/submitted）
- `openry_analysis_sources` 工具协议：catalog 常驻 + auto_bundle 服务端按预算装填 + `catalog_only` 可选；token 估算 = CJK×0.7+其他÷4 ×1.2
- 双路径触发已核实：失败走 `on_dropped`（已实现）；成功走 `payload_value_greater_than`（command_count>20，双端 registry 均有）

### ② 迭代产物规范形（已定稿 + 大部分已实现实测）

`iteration-canonical-form.md`：

- agent step：强制 `prompt_blocks` + `note`，**禁止 description**（仅 workflow 级 description 可用）
- 写入契约：agent 只做大脑（禁写不禁读），写盘下沉 `kind:shell`（`openry write-file`）；printf 模式禁 heredoc；写步 payload 只落元数据
- 硬验证必须挂在 **agent 步**的 `validation:`（新增 `payload_yaml_valid` 类型，双引擎），失败 `retry_current` 当场重改；shell 的 `--verify yaml` 只作最后防线

---

## 二、已实现 + 实测清单

| 项 | 证据 |
|----|------|
| `openry write-file` 子命令（纯新增） | 终端 T1-T8 全过；test_write_file 实例 **39/42** 全链 completed |
| loop_seed_build 两段式改造 | 实例 **40** 全链 completed（12 步含套娃执行） |
| `openry_run` 异步化（execOpenryAsync） | 并发实测：长命令不再冻结 patrol |
| `payload_yaml_valid` 硬验证 + retry_current + 写步 on_dropped 回环 | 冒烟测试过（坏 YAML 拦/好 YAML 过）；**未现场重跑** |
| prompt 文件统一走 `~/.openry/prompts/` | seed/prompts 为唯一事实源，安装自动分发；两份 loop_seed_build 引用已改 `~` 路径并验证存在 |

### 版本现状

- 测试版 `~/.openry/workflows/loop_seed_build.yaml`：**v0.8-contractfix**
- 工作区 `loop-engineering/workflows/loop_seed_build.yaml`：**v1.3-contractfix**

### 今日翻车教训（实例 43/44/45，已写入文档）

1. 43：生成 YAML 的 description 漏闭合双引号
2. 44：agent 把「长文本用 \| 块标量」误解为 payload 字符串要加 `|-` 前缀（指令歧义，已修措辞）
3. 45：`content: "|` 块标量写成双引号字符串未闭合
4. 共性：**硬验证不在 agent 步、失败即 abort 死链** → 已改为 payload_yaml_valid + retry_current + on_dropped 回环

---

## 三、明天开工顺序（建议）

1. **重跑 `loop_bootstrap`**：验证 payload_yaml_valid 硬验证 + ③ 当场重改链路（今天实现后唯一没现场验证的）
2. **定稿完整迭代闭环设计**（一份文档说清）：
   - 三个新 workflow：`loop_analyze_failure`（双身份提示词）→ `loop_fix_yaml`（生成修复内容→shell 写回）→ `loop_finalize`（归档 v{N}）
   - 触发：失败 on_dropped（已有机制）/ 成功 `t_report_result` 上报 command_count + 阈值路由
   - 收敛：`_loop_iteration < 5`、增益守卫（command_count ≥ 上轮×0.8 即停）、软阈值 20 < max_tool_calls 硬上限
3. 实现顺序：`openry_analysis_sources` 工具 → loop_analyze_failure → loop_fix_yaml → loop_finalize → 改 loop_run_workflow 触发

## 四、遗留小项

- shell 步无 `OPENRY_RUN_ID`（`--from-payload` 在 shell 里用不了）
- zombie 测试（10 分钟）未跑
- git 基线未 commit（建议 commit 一次，之后每次改造 git diff 验真）
- `loop_trigger_run` / `test_write_file` 两个 workflow 仍含 description（规范形迁移漏网）
- big_step 超时未武装（`big_step_started_at` 全库 NULL）

## 五、工作约定（防遗忘）

- 改动必须纯新增/扩展，用 `git diff` 验真
- 先改测试版 `~/.openry` 现场验证，通过后再同步工作区
- plugin 改动需 `npm run build` + `openclaw gateway restart`
- 测试用 web UI 跑，DB 实例号对照分析（DB 时间 UTC，网关日志 +08:00）
