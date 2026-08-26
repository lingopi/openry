# 迭代规范形：prompt_blocks + note（设计定稿）

> 日期：2026-08-17
> 状态：定稿（全部条款已实现并实测；§5 写入契约 2026-08-17 定稿）
> 关联文档：
> - `failure-routing-model.md` —— 失败路由模型（loop_analyze 触发与 payload 矩阵）
> - `analysis-source-ladder.md` —— 分析步数据源阶梯（loop_analyze 自取证据）
> - `config-building-guide.md` —— 构建思路 + 生成器铁律（本规范形的执行方）
> - `docs/compositions-and-workflows-guide.md` —— 字段手册（prompt_blocks / note 字段）

---

## 1. 目标

迭代（loop_fix_yaml）产物采用**统一规范形**，让收敛可机械化验证：

- agent step：提示词全部进 `prompt_blocks`，**禁用 `description`**，新增 `note`（≤50 字人类说明）
- shell step：`command` + `note`，无提示词概念

动机：
1. **可验证收敛**：verify ticket 可硬断言「有 prompt_blocks、无 description、有 note」，
   不再靠 agent 自觉
2. **外科手术式修复**：fixer 只重写目标 block，错误面小
3. **file block 减工具调用**：共享文档（如 config-building-guide）注入提示词，
   agent 不用再 `cat` —— 直接服务 command_count 收敛目标
4. **单一事实源**：提示词内容只存一处，杜绝 description 与 prompt_blocks 漂移

## 2. 规范形契约

### 2.1 agent sub_step（必需）

```yaml
- id: xxx
  kind: agent
  note: "一句话说明这一步做什么（≤50 字，人类/下游 agent 阅读）"
  prompt_blocks:            # 全部提示词内容在此，禁止 description
    - type: text
      label: 任务
      content: |
        ...
    - type: file            # 共享文档注入
      path: /Users/.../loop-engineering/config-building-guide.md   # 绝对路径优先
  ...
```

### 2.2 shell sub_step（必需）

```yaml
- id: yyy
  kind: shell
  note: "一句话说明这一步做什么"
  command: '...'            # 支持 ${payload.xxx} / ${env.VAR} 插值
  payload_keys: [written, path, bytes]   # 白名单：payload 只落元数据，不落全文
  semantic_reporting: false             # 可选：跳过语义蒸馏
  ...
```

### 2.3 共同约束

- 每条 sub_step 必须有 `note`（人类语义标签，同时是 knowql discover 的下游输入）
- agent step 的 `prompt_blocks` 中所有 file block 的 path **必须存在且非空**
  （实测：`renderPromptBlocks` 对缺失文件**静默跳过**，agent 会毫无告警地缺提示词）
- file block 路径约定：绝对路径或 `~` 开头优先；相对路径基准是
  `~/.openry/prompt_blocks/`
- 失败路由契约（on_dropped / validation_routing）不变

## 3. 波及面（代码实测 2026-08-17）

| 消费者 | 现状 | 动作 |
|--------|------|------|
| patrol `buildTaskDescription`（生产 spawn 路径） | prompt_blocks 优先渲染，description 排后 | ✅ 无需改 |
| web `workflow-tree.js` | 不使用 description | ✅ 无需改 |
| knowql `query-executor.ts` discover runtime | 用 `ss.description` 做 step 语义标签 | ⚠️ 改 `ss.note ?? ss.description` 兜底 |
| knowql `index.ts` buildTopology（知识图谱检索） | 用 `ss.description` | ⚠️ 同上兜底 |
| Python `engine._build_task_description` | **只读 description，不支持 prompt_blocks**（当前生产走 TS patrol，此为遗留雷） | ⚠️ 同步支持 prompt_blocks + note 兜底 |
| `yaml-loader.ts` SubStep 类型 | 无 `note` 字段（loader 不严格校验未知键） | ⚠️ 加 `note?: string` |

## 4. verify ticket（迭代验收，供 verify 步硬断言）

1. 每个 agent step：`prompt_blocks` 非空、**无 `description`**、`note` 非空且 ≤50 字
2. 每个 file block：path 存在且文件非空（python3 脚本检查）
3. 每个 shell step：`command` 非空、`note` 非空
4. YAML 可解析（`python3 yaml.safe_load` 双文件）
5. 失败路由字段保留（on_dropped / validation_routing 不被迭代误删）

## 5. 写入契约：agent 只做大脑，写盘下沉 shell（定稿 2026-08-17）

### 5.1 原则

- agent 子步骤**只生成内容**（payload 携带），**不执行任何写操作**；文件写入
  一律由下游 `kind: shell` 步骤用 `openry write-file` 完成
- agent **可以读**（cat / sed -n 等只读命令），契约只禁写
- 初版 YAML 即产出规范形：agent step 用 prompt_blocks，全程无 description

### 5.2 标准两段式

```yaml
# 生成步（agent）：内容进 payload，禁止写文件
- id: generate_x
  kind: agent
  description: ...        # 规范形迁移后改为 prompt_blocks
  payload_keys: [content, filename]

# 写入步（shell）：printf + write-file，payload 只落元数据
- id: write_x
  kind: shell
  inherit_payload: true   # 写入步紧跟生成步时用 inherit；跨步取内容用 payload_from
  command: >
    printf '%s' ${payload.content} |
    openry write-file --path ${payload.filename} --stdin --verify yaml --force
  payload_keys: [written, bytes, verified]
  semantic_reporting: false
```

### 5.3 硬性细节（均有实测/代码依据）

| 规则 | 原因 |
|------|------|
| 写入用 `printf '%s' ${payload.x}`，**禁止 heredoc** | 插值先于 shell 执行，替换后的单引号在 heredoc 体内是字面量 |
| 写步 payload 只落元数据（payload_keys 白名单） | 内容落 payload 会 (a) 下游 inherit 污染提示词 (b) 触发语义蒸馏浪费 LLM |
| 连续两个写步共享同一生成步时，第二个用 `payload_from: <生成步id>` | 链式 inherit 拿到的是第一个写步的元数据，不是内容 |
| **内容跨写步传给 agent 步 → 文件桥** | `payload_from` 只对 shell 步生效（代码实测）；写步把内容落盘（它本来就是写文件），消费 agent 步用 `prompt_blocks` 的 file 块注入固定路径（实例 53 幻觉实证：plan_text 被写步元数据替换丢失） |
| 迭代重写场景加 `--force` | create 模式拒绝已存在文件 |
| `--verify yaml` 挂在写入时 | 语法错误当场失败（文件保留作诊断物），无需额外验证步 |
| 内容 ≤50KB 走 payload 插值 | SQLite TEXT + ARG_MAX 安全边界；更大内容分段写 |
| shell 步配 `semantic_reporting: false` | 避免 spawn 蒸馏 agent |

### 5.4 落地现状

- `openry write-file` 子命令已实现：原子写（temp+rename）、三内容源
  （--stdin / --content / --from-payload）、--mode/--force/--verify/--ensure-newline、
  stdout JSON 契约
- 终端测试 T1-T8 全通过（含 exists 拒绝、append、yaml verify 拦截、from-payload）
- `test_write_file` workflow 真实运行全链通过（实例 39）：shell 字面量写 →
  agent 生成 → payload 插值写+verify → agent 只读验证，completed
- `loop_seed_build` 已改造为两段式（测试版 v0.6-writefile，8 步链：
  ②.5 write_plan_md / ③.5 write_workflow_yaml / write_composition_yaml）

## 6. 更新记录

| 日期 | 变更 |
|------|------|
| 2026-08-17 | 定稿：规范形契约（agent: prompt_blocks+note 无 description / shell: command+note）、波及面实测清单（knowql 两处兜底、Python 引擎防雷、yaml-loader 加 note）、verify ticket、file block 缺失静默跳过的坑、开放问题（agent 大脑 + shell 写入） |
| 2026-08-17 | §5 定稿为「写入契约」：agent 只做大脑（禁写不禁读）+ 写盘下沉 kind:shell；`openry write-file` 子命令实现；终端 T1-T8 + test_write_file 实例 39 全链实测通过；loop_seed_build 改造 v0.6-writefile |
