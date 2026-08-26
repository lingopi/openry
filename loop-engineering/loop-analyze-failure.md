# loop_analyze_failure — 迭代分析修复 Big Step（设计定稿）

> 日期：2026-08-18
> 状态：**v0.5-redesign 现场验证通过**（实例 56：失败 → 提取 → 单块修复 → 跳回 → 全链跑通）
> 关联文档：
> - `analysis-source-ladder.md` / `analysis-source-api.md` —— 取证工具（analyze_fix 自取证的输入）
> - `iteration-canonical-form.md` —— 修复产物规范形（analyze_fix 的产出约束）
> - `failure-routing-model.md` —— 失败路由（on_dropped 跳入本 big_step）
> - `config-building-guide.md` —— 第 1-4 条原则（复用件的来源）

---

## 1. 定位

迭代闭环的「分析 + 修复」环节：失败任务经 `on_dropped: loop_analyze_failure`
跨 big_step 跳入本环节 → **硬代码提取失败步现状块** → 单块分析 →
**外科手术修补** → 跳回运行环节重跑。

```
loop_run_workflow 任一 step dropped
  → on_dropped: loop_analyze_failure（跨 big step 跳入）
  → ① extract_failed_step（shell：指针第一跳落地 + 截取失败步现状块）
  → ② analyze_fix（agent：自取证 + 读计划/需求 + 只改这一个块）
  → ③ patch_workflow_yaml（shell：payload_from 拉定位 + 外科替换）
  → ⑤ route_back（agent：fixed:true → 跳回 loop_trigger_run 重跑）
```

## 2. 四步契约（v0.5-redesign，实例 56 验证）

| # | id | kind | 职责 | 关键配置 |
|---|----|------|------|---------|
| ① | extract_failed_step | shell | `openry extract-step --from-run-id ${payload._inherits_from_run_id}`：**第一跳**落地 failed_run_id/failed_step_id + 截取失败步现状块 step_yaml | payload_keys: [failed_run_id, failed_step_id, step_yaml] |
| ② | analyze_fix | agent | 调 openry_analysis_sources（run_id 显式传 failed_run_id）+ 注入 plan.md/requirement.md → root_cause + fix_suggestion + **fixed_step_yaml（单块）** | payload_yaml_valid(fixed_step_yaml) + retry_current |
| ③ | patch_workflow_yaml | shell | `payload_from: extract_failed_step` 拉定位信息 + `openry patch-yaml --step-id --from-run-id`：只换失败步块 | on_dropped: analyze_fix |
| ⑤ | route_back | agent | fixed:true + 条件路由跳回 | validation_routing on_match: loop_trigger_run |

## 3. 修复半径控制（越权问题的硬代码解法）

- agent **没有整个文件的产出权**：② 只产一个 sub_step 块
- agent **没有目标选择权**：failed_step_id 由 ① 硬代码解析（第一跳指针），
  不信任 agent（链上 `_inherits_from_run_id` 每跳会覆盖，必须第一跳落地）
- agent **有现状块**：① 把失败步的当前 YAML 块原样截取进 payload，
  agent 改的是现状，不是凭空重写（实例 55 教训：看不到现状就瞎编）
- patch-yaml 双守门：块首行 id == --step-id；--from-run-id 硬校验
  step-id 与失败任务一致；替换后整文件 yaml 校验；其余 sub_step **字节级不动**

## 4. ② 提示词要点（修复契约，单块版）

1. 取证：`openry_analysis_sources`，run_id **显式传 failed_run_id**
   （不要用默认解析——指针每跳会被覆盖）
2. step_yaml（Previous step results 里）是失败步的当前完整块，必须基于它修改
3. 结合注入的「执行计划」与「用户需求」理解该步原意
4. 三字段产出：root_cause / fix_suggestion / fixed_step_yaml
5. fixed_step_yaml 首行必须是 "- id: <failed_step_id 的值>"，完整规范形块
6. **只许写这一个块**：硬代码只替换该块，其它 step 字节级不动
7. 长文本 `|` 块标量；payload 字符串禁止 `|-`/`|` 前缀
8. 硬验证块语法，不通过当场重改（≤2 次）

## 5. 回环方向

- 写坏 → `on_dropped: analyze_fix`（同款回环模式，不 abort 死链）
- 修好 → ⑤ 跳回 `loop_trigger_run`（loop_run_workflow 第一个 big_step，
  routeToBigStep 重写 composition 列后沿链重跑；跳转时 loadBigStep 读盘上
  新版本 = 自动运行修复产物）

## 6. 完成与未完成

### 6.1 已完成（实例 56 实证）

- 四步链 v0.5-redesign + `openry extract-step` 新子命令（locate-failed 死代码已删）
- file-bridge：plan.md / requirement.md 跨写步注入（实例 53 幻觉根治）
- payload_from 定位信息拉取（agent 上报覆盖 payload 的补偿通道）
- patch-yaml 越权守门 + 字节级不动其它步（T1-T4 终端测试）

### 6.2 未完成（暂缓）

- 迭代计数器 `_loop_iteration < 5`（**风险**：全部 sub_step on_dropped 指向
  本环节，计数器未上前存在无限循环风险——仅适用于手动测试阶段）
- 成功-低效路径（command_count > 20 触发）与 loop_finalize 归档
- shell 步 OPENRY_RUN_ID 环境注入（write-file --from-payload 依赖）
- loop_trigger_run 及 fixtures 仍用 description（规范形迁移尾巴）
- 工作区镜像 loop-engineering/workflows/loop_analyze_failure.yaml 未建立
- git 基线提交（当前 cli.py/patrol.ts 等均为未提交修改）

## 7. 测试记录（实例 56，2026-08-18）

| 阶段 | 结果 |
|------|------|
| 触发 | t_check_source（占位符版）dropped → 跨 big step 跳入本环节 |
| ① 提取 | 指针第一跳正确解析 70e89f9e → t_check_source，17 行现状块截取成功 |
| ② 分析 | 根因命中「prompt_blocks 内容是占位符」，产出真实任务块（保留 note/command_policy/on_dropped/payload_keys） |
| ③ 修补 | patched=true，unchanged_lines=109（仅 prompt_blocks 内容被替换） |
| 跳回 | route_back → loop_trigger_run → loop_run_workflow 六业务步全 done |

## 8. 更新记录

| 日期 | 变更 |
|------|------|
| 2026-08-18 | 定稿 v0.1：五步链（取证→分析→写盘×2→路由跳回）、复用件映射（③.5a/③.5b 原样命令、payload_yaml_valid 硬验证、跨 big step 跳回）、修复契约、回环方向、暂缓项（迭代计数器/成功路径/生成契约联动）、测试计划 |
| 2026-08-18 | v0.2 接入正式流程：loop_target 全部 sub_step 配 on_dropped: loop_analyze_failure（生成契约第 7 条 + ④ 入场券硬断言）；移除 test_loop_analyze 作为启动入口；标注计数器未上前的无限循环风险 |
| 2026-08-18 | v0.3-surgical：修复半径控制——新增 `openry patch-yaml`（单块替换+双 id 校验+字节级不动其它步）与 `openry locate-failed`（硬代码解析失败步 id）；② 产出收窄为单个 sub_step 块；链改为取证→定位→单块分析→外科修补→路由（五步）；composition 本轮不碰 |
| 2026-08-18 | v0.4-filebridge：证据文件桥——①.5 扩展为「定位 + evidence 写盘 evidence.json」，② 用 prompt_blocks file 块注入（实例 53 幻觉教训：payload_keys 提取替换继承内容，payload_from 只对 shell 步生效） |
| 2026-08-18 | v0.5-redesign（实例 55 四连 bug 重构）：砍掉 collect_evidence / locate_failed_step——agent 自取证自修，杜绝「取一遍、分析又查一遍」；新增 `openry extract-step`（指针第一跳落地 + 截取失败步现状块 step_yaml 进 payload，agent 改的是现状而非凭空重写）；② prompt_blocks 补 plan.md + requirement.md 文件桥，取证 run_id 显式传 failed_run_id（指针每跳被覆盖）；③ 修补步 payload_from: extract_failed_step 拉定位信息 + patch-yaml --from-run-id 越权校验——不再依赖 payload 继承链（agent 上报覆盖 payload） |
| 2026-08-18 | 实例 56 现场验证：完整闭环一次跑通——占位符版 t_check_source dropped → ① 提取正确解析 70e89f9e/t_check_source → ② 命中根因（prompt_blocks 是占位符）产出真实任务块 → ③ patched=true/unchanged_lines=109 → 跳回后 loop_run_workflow 六业务步全 done；`locate-failed` 死代码已删除（被 extract-step 取代） |
