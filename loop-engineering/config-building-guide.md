# OpenRY 配置构建思路指南（Config-Building Guide）

> 本文档是给 AI（配置生成器 agent）读的**构建思路提示词**，与
> `docs/compositions-and-workflows-guide.md` 互补：
>
> | 文档 | 回答的问题 |
> |------|-----------|
> | `docs/compositions-and-workflows-guide.md` | **有什么** —— 字段、规则、路由机制的完整参考手册 |
> | 本文档 | **怎么想** —— 构建配置时的设计原则、验证策略、踩坑经验 |
>
> 本文档会随项目迭代不断总结更新。构建 / 修复 / 审查 workflow 与 composition
> 配置之前，先读这里。

---

## 0. 使用方式

- 本文档将作为 `prompt_blocks` 注入生成 / 修复类 sub_step 的 agent prompt，
  与 `compositions-and-workflows-guide.md` 同时提供。
- 生成配置时：先按本文档的原则确定**设计思路**，再查参考手册确认**字段写法**。
- 每次实践后复盘，把新原则按第 5 节的模板追加进来，并更新第 6 节记录。

---

## 1. 核心原则（第 1 条）

### 1.1 原则：验证生成物 = 真实运行生成物本身，而不是跑验证脚本

**生成 workflow.yaml / composition.yaml 之后，验证它是否正确的最佳方式，
是让 orchestrator 真实地运行这个产物本身**，而不是用 `kind: shell` 去跑一个
检查脚本（yaml 解析、文件存在性、ref 比对等）。

### 1.2 为什么

静态校验（`yaml.safe_load` / `file_exists` / 字段比对）只能回答
「文件合法吗」，不能回答「能跑通吗」。只有真实运行才能暴露：

- 路由目标写错（`on_success` / `on_match` 指向不存在的 step 或 big_step）
- payload 断链（`inherit_payload` 没配、agent 没回传关键 key）
- 验证规则过严 / 过松（agent 反复 retry 或错误放行）
- prompt 描述不精确（agent 产出不合规 payload）
- 跳转后 composition 链归属错误（意外降级 standalone 或提前结束实例）

### 1.3 项目落地方式：套娃式设计（Loop Engineering）

我们当前的做法（`loop-engineering/`）：

```
loop_seed_build.build_initial_yaml（agent 只生成两份 YAML 内容进 payload）
      │
      ▼
loop_seed_build.write_*_yaml（shell 用 write-file 写盘 + verify yaml）
      │
      ▼
loop_seed_build.verify_seed_yaml（shell 入场券：name/ref 非定值就地修复，不可修才回环）
      │
      ▼
loop_seed_build.route_to_run（agent 条件路由：yaml_valid=true → 跳运行环节）
      │
      ▼
loop_trigger_run（agent：echo 开始了 + 上报 run_time/ref，条件路由）
      │  on_match: loop_target（定值 ref）
      ▼
loop_target —— 生成的 workflow 被真实执行（套娃）！
```

关键机制：

- 生成的 workflow 以**定值 big_step ref**（`loop_target`）接入运行中的
  composition 链，通过 Phase 3f 跨 big_step 跳转（`routeToBigStep`）在
  **同一个 workflow instance** 内真实执行，无子 workflow 概念。
- 跳转时才从磁盘 `loadBigStep('loop_target')`，所以每次进入执行的都是
  最新生成的版本 —— 「生成后直接接入运行」。
- 静态校验（shell）被降级为**入场券**：定值槽位（name/首个 ref）非定值就
  **就地修复**（省一次重生成回环）；只有结构不可修（文件缺失、语法错误、
  无 big_steps）才判 `yaml_valid=false` 回构建步；通过后立刻交给真实运行去验证一切。

### 1.4 反例

| 做法 | 问题 |
|------|------|
| ❌ 生成后只跑 `python3 yaml.safe_load(...)` 就视为验证完成 | 只能证明语法合法，路由错、payload 断链、prompt 问题全部漏掉 |
| ❌ 用 `kind: shell` 写一个"模拟验证脚本"代替真实执行 | 模拟 ≠ 真实：orchestrator 的路由 / 验证 / 继承语义只有真实跑才知道 |
| ⚠️ 完全不用任何静态校验，直接上真实运行 | 极端情况会浪费一次运行；静态校验作为入场券快速失败是合理的 |

## 2. 核心原则（第 2 条）

### 2.1 原则：初步构建从简 —— 纯 agent 自然语言播种，边做边改

- **场景**：loop 的第一次 YAML 构建。此时只有用户需求，没有真实运行反馈，
  信息不足以一次写对（超时、验证阈值、命令细节都未知）。
- **原则**：初步构建的 workflow 全部用 `kind: agent` 子步骤 + 自然语言描述
  「要做什么」，不写 shell 命令 / 脚本 / 插值模板。把细节留给迭代循环：
  先跑起来，失败后由 分析 → 最小化修复 → 重跑 逐步收敛。
- **反例**：初次构建就写满 shell 命令、`${payload.x}` 插值、精确验证阈值——
  这些在信息不足时全是猜测，且改起来成本高（一个 shell 细节错了直接
  dropped 卡链，agent 描述错了还能靠 retry 自纠）。
- **项目实践**：`loop_seed_build.build_initial_yaml` 组装全部 prompt_blocks
  （参考手册 + 本文档 + 生成目标硬性约定），只产出两份 YAML **内容**进 payload，
  并由 `payload_yaml_valid` 硬验证 + `retry_current` 当场纠错（第 4 条原则）；
  写盘由 `write_workflow_yaml` / `write_composition_yaml` 两个 shell 步完成（第 3 条原则）。

### 2.2 附：shell 步骤跳过语义蒸馏的两种方式（2026-08-14 实测修正）

- 方式一：配置 `payload_keys` —— stdout 为 JSON 时白名单提取，payload 无
  `_stdout`，`scanAndCompress` 发现无内容可蒸馏 → 不 spawn 蒸馏 agent。
- 方式二：`semantic_reporting: false` 开关 —— `scanAndCompress` 直接跳过蒸馏，
  标记源 step `_compressed: true`。
- ✅ 实测结论（v0.2 测试）：`semantic_reporting: false` 时下游**立即执行**，
  无等待。机制：patrol 每轮顺序中 `scanAndCompress`(3.6) 先于
  `routeValidated`(7)，源 step 的 `_compressed` 先被标记为 true，下游
  `enqueueNextSubStep` 合并的是**已更新**的源 payload（继承 `_compressed: true`），
  `queryQueuedTasks` 直接放行。DB 实测：cat done 与下游 plan 入队同秒。
- 教训：`forceTimeoutQueued`（5 分钟兜底）只覆盖「蒸馏真在跑且未完成」的场景；
  纯代码推断「下游会被拦 5 分钟」是错的——真实运行才是真理（这正是原则 1 的核心）。

### 2.3 附：失败路由的真实实现（2026-08-14 实测 + 全代码栈核查）

- **实测结论**：`on_failure: <sub_step_id>` **不生效**。agent 上报
  `--status failed` 后，CLI 返回 `{"action": "dropped", "reason": "on_failure=abort，任务终止"}`，
  `after_fail` 步骤永远不会被触发（测试：`test_onfailure_jump`）。
- **三套引擎全部一致**：`cli.py _handle_failed_retry` / `engine.py _retry_failed`（旧）
  都是「`retry` → 重试，else → dropped」；`patrol.ts` 里 `on_failure` 只被传进
  `evaluateRouting` 但 router.ts 从不读取。`on_validation_fail: <sub_step_id>` 同样未实现。
- **生成器铁律**：不要写 `on_failure: <sub_step_id>` 或 `on_validation_fail: <sub_step_id>`
  —— 那是参考手册里的设计意图，从未实现（空头支票，实测坐实）。
- ✅ 失败回收路由用 `on_dropped`（2026-08-17 已实现，方案乙）：存在即开关、值即目标
  （对齐 validation_routing 目标语法：sub_step id / big_step 名 / big_step:sub_step）；
  任务失败终态为 retrieve → patrol routeRetrieve 回收路由到目标；
  目标 sub_step 配 inherit_payload 接收失败任务 payload；目标必须查 DB 兑底失败原因
  （shell 失败路径上游 seed 会被 stdout 派生内容覆盖）。
- **失败跳转的唯一现成机制**：agent 上报 `completed` + payload 条件，
  用 `validation_routing` 的 `on_mismatch` 跳 sub_step / big_step。
  即「任何异常都必须 `--status completed` 并携带 `step_ok: false` + error」。
- 待补：dropped 总漏斗（routeDropped + on_failure 快照列），让超时/被杀/
  max_tool_calls 等死亡路径也能回环。

---

## 3. 核心原则（第 3 条）

### 3.1 原则：agent 只做大脑 —— 写盘全部下沉到 kind:shell（2026-08-17 定稿 + 实测）

- **场景**：workflow 里任何「生成内容 → 落盘」的动作（计划文件、工作流 YAML、
  修复产物）。agent 用 openry_run + heredoc 写文件是最脆弱的一环（引号转义、
  半截文件、无法原子验证）。
- **原则**：agent 子步骤只生成内容（payload 携带），**禁止写**（不禁读）；
  文件写入一律由下游 `kind: shell` 步骤用 `openry write-file` 完成：
  `printf '%s' ${payload.content} | openry write-file --path <路径> --stdin --verify yaml --force`。
- **反例**：agent 里 heredoc 写文件；写步把内容全文落 payload（下游污染 +
  蒸馏浪费）；连续两个写步都用 inherit_payload（第二个拿到的是元数据不是内容，
  要用 `payload_from: <生成步id>`）。
- **项目实践**：`openry write-file` 子命令（原子写/三内容源/verify/JSON 契约）；
  `loop_seed_build` v0.6 两段式；`test_write_file` 实例 39 全链实测通过。
- **硬性细节**：禁止 heredoc+插值（引号变字面量）；写步 payload 只落元数据
  （payload_keys 白名单）；迭代重写加 --force；内容 ≤50KB 走插值；
  写步 `semantic_reporting: false`。详见 `iteration-canonical-form.md` §5。
- **文件桥铁律（2026-08-18，实例 53 幻觉实证）**：写步的 payload_keys 提取会
  **替换**继承内容——内容一旦经过写步就断链；`payload_from` 只对 shell 步生效。
  因此**内容跨写步传给 agent 步的唯一干净通道 = 文件桥**：写步落盘（它本来就写文件），
  消费 agent 步用 `prompt_blocks` 的 file 块注入固定路径。不要写「根据 Previous 里的
  xxx」——那是幻觉温床。

---

## 4. 核心原则（第 4 条）

### 4.1 原则：硬验证必须挂在 agent 步上；agent step 强制 prompt_blocks（2026-08-17 定稿）

- **场景**：agent 产出结构化内容（YAML / JSON / 文本）进 payload，下游消费该内容。
- **原则**：
  1. **业务硬验证一律配置在产出 payload 的 agent 步**的 `validation:` 字段上
     （如 `payload_yaml_valid`），失败配 `on_validation_fail: retry_current`
     让 agent **当场重改**——坏内容根本走不到下游
  2. shell 步内的本地校验（如 `openry write-file --verify yaml`）只作写盘安全的
     **最后防线**，不是验证手段
  3. **所有 agent sub_step 强制 `prompt_blocks` + `note`，禁止 `description`**（规范形）
- **反例**：把语法验证只放在末尾 shell 写步 → 失败时 `on_failure: abort` 直接死链
  （实例 43/44/45 三连翻车）；description 与 prompt_blocks 混用；写步 payload 落全文
- **项目实践**：新增验证类型 `payload_yaml_valid`（Python + TS 双引擎）；
  `loop_seed_build.build_initial_yaml` 挂 `validation: [payload_yaml_valid × 2]` +
  `on_validation_fail: retry_current`；写步 `on_dropped: build_initial_yaml` 回环兜底。
  详见 `iteration-canonical-form.md` 与 `docs/compositions-and-workflows-guide.md` §6.3/9.1

---

## 5. 原则条目模板（后续总结按此格式追加）

```markdown
### 2.x 原则标题
- 场景：什么情况下会遇到这个问题
- 原则：遇到时应该怎么做
- 反例：什么做法是错的
- 项目实践：我们在 loop-engineering 里是怎么落地的（引用具体文件 / step id）
```

---

## 6. 更新记录

| 日期 | 变更 |
|------|------|
| 2026-08-14 | 新增第 1 条原则：验证生成物 = 真实运行生成物本身（套娃式设计）；建立文档结构与条目模板 |
| 2026-08-14 | 新增第 2 条原则：初步构建从简（纯 agent 自然语言播种，边做边改）；附 shell 跳过蒸馏的两种方式；1.3 落地引用同步为新结构命名（loop_seed_build） |
| 2026-08-14 | 实测修正 2.2：`semantic_reporting: false` 下游立即执行（patrol 顺序 3.6 先于 7，源先标记、下游后入队），推翻「最多等 5 分钟」的代码推断 |
| 2026-08-14 | 新增 2.3 附：实测证明 `on_failure: <sub_step_id>` 从未实现（三套引擎均 retry/else dropped）；失败跳转唯一现成机制 = completed + validation_routing on_mismatch；生成器铁律更新 |
| 2026-08-17 | 新增第 3 条原则：agent 只做大脑 + 写盘下沉 shell（`openry write-file`）；loop_seed_build 改造 v0.6-writefile（②.5/③.5 写步）；test_write_file 实例 39 实测通过 |
| 2026-08-17 | 新增第 4 条原则：硬验证必须挂在 agent 步（`payload_yaml_valid` + retry_current 当场重改，shell 只作最后防线）；agent step 强制 prompt_blocks + note、禁止 description。实例 43/44/45 三连翻车教训 |
| 2026-08-18 | 第 3 条补充「文件桥铁律」：写步 payload_keys 提取会替换继承内容（实例 53：plan_text 死于 write_plan_md，build_initial_yaml 零命令纯幻觉生成）；payload_from 只对 shell 步生效；内容跨写步传给 agent 步必须走写盘 + prompt_blocks file 块注入 |
| 2026-08-18 | ④ verify_seed_yaml 改为「定值修复」：name/首个 ref 非 loop_target 就地修复（surgical 行替换保格式），结构不可修才 yaml_valid=false 回环；payload 增加 fixed 字段 |
