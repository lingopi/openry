# 语义上报规范（Semantic Reporting Guide）

当你通过 `openry_status completed` 上报结果时，建议按以下 8 类语义原语组织 payload。
**这不是强制格式**，但能让你和下游 agent 更好地理解和检索数据。

## 8 类语义原语

只填与任务相关的桶，空的省略。字段完全自由，以下只是示例：

```json
{
  "entity": [],
  "fact": [],
  "event": [],
  "action": [],
  "rule": [],
  "decision": [],
  "risk": [],
  "relation": [],
  "detail": {}
}
```

### entity — 实体（"有什么"）
系统中的对象或主体。你发现/操作/创建了什么对象？

典型字段：`type`（类型）, `id`（标识符），其他属性自由扩展。
```json
{"type":"server", "id":"web-01", "ip":"10.0.1.5"}
{"type":"file",   "id":"/tmp/report.txt", "size":4096}
{"type":"person", "id":"admin", "role":"superuser", "email":"admin@example.com"}
```

### fact — 事实（"是什么"）
实体在某一时刻的属性或状态。你测量/观察到了什么？

典型字段：`entity`（实体标识）, `attr`（属性名）, `value`（值）, `at`（时间，可选）。
```json
{"entity":"web-01", "attr":"cpu", "value":92, "at":"14:15"}
{"entity":"web-01", "attr":"mem", "value":88}
{"entity":"/tmp/report.txt", "attr":"line_count", "value":4}
```

### event — 事件（"发生了什么"）
时间点上的状态变化。有什么值得记录的事情发生了？

典型字段：`type`（事件类型）, `entity`（相关实体，可选）, `at`（时间）。
```json
{"type":"crash",    "entity":"web-01", "at":"14:15:03"}
{"type":"deploy",   "entity":"app-v2.0", "at":"14:00"}
{"type":"threshold_breach", "entity":"web-01", "at":"14:15"}
```

### action — 行动（"做了什么"）
有主体的操作。你或系统执行了什么动作？

典型字段：`verb`（动作）, `target`（目标）, `by`（执行者，可选）。
```json
{"verb":"restart", "target":"nginx", "by":"agent-ops"}
{"verb":"create",  "target":"/tmp/report.txt"}
{"verb":"reply",   "target":"email_thread", "by":"concordia-worker"}
```

### rule — 规则（"应该怎样"）
条件→结论的约束。有什么规则/策略/阈值被引用或发现？

典型字段：`description`（规则描述）, `if`（条件）, `then`（结论）。
```json
{"description":"CPU告警策略", "if":"cpu>90", "then":"alert", "severity":"critical"}
{"description":"内容合规处置", "if":"收到BJIO摘除指令", "then":"摘除链接→CELA审核→屏蔽执行"}
```

### decision — 决策（"选了什么"）
在多个路径中的选择。你做出了什么决策？为什么？

典型字段：`chose`（选择的方案）, `over`（放弃的方案，可选）, `reason`（理由）。
```json
{"chose":"rollback", "over":"hotfix", "reason":"风险太高，回滚更安全"}
{"chose":"skip_bot_reply", "reason":"Concordia Bot 自动回复无需人工再回"}
```

### risk — 风险（"可能出什么错"）
潜在的负面后果。你发现了什么风险信号？

典型字段：`threat`（威胁类型）, `entity`（关联实体，可选）, `severity`（严重程度：critical/high/medium/low）。
```json
{"threat":"cpu_overload", "entity":"web-01", "severity":"critical"}
{"threat":"data_loss",    "entity":"/tmp/report.txt", "severity":"low"}
{"threat":"compliance_deadline", "severity":"high", "detail":"网信办指令需在时限内完成"}
```

### relation — 关系（"怎么关联的"）
实体之间的连接。A 和 B 之间有什么关系？

典型字段：`from`（源实体）, `type`（关系类型）, `to`（目标实体）。
```json
{"from":"web-01", "type":"belongs_to",  "to":"cluster-A"}
{"from":"web-01", "type":"depends_on",  "to":"database-01"}
{"from":"yifan-du", "type":"initiates", "to":"bjio-0629-01"}
```

## detail — 域特定扩展

如果你的领域需要特殊的结构化字段（如财务的科目/金额、人资的部门/薪资），
放在 `detail` 字段里，自由组织：

```json
{
  "detail": {
    "monitoring": {
      "sampling_interval_ms": 5000,
      "trend": "rising"
    },
    "reply_summary": {"total": 21, "replied": 16, "skipped": 5}
  }
}
```

## concepts — 语义检索标签（重要）

上报 payload 时请额外包含 `concepts` 字段——2-6 个语义标签，
描述这个 step 产出的数据在说什么话题。这让下游 agent 能通过 KnowQL 检索到你的产出。

```json
{
  "entity": [...],
  "fact": [...],
  "concepts": ["cpu_overload", "threshold_breach", "server_health"]
}
```

**标签要求（严格遵守）**：
- **必须使用英文小写 + 下划线**（如 `device_lost`、`compliance_risk`、`content_moderation`）
- **禁止中文**、驼峰命名、空格、特殊字符
- 话题级别——不是字段值的复述，而是"这个话题叫什么"
- 2-6 个，覆盖本 step 的核心语义

## 使用原则

1. **不必填满 8 个桶**——只填与任务相关的原语。大多数 step 只产出 2-3 类。
2. **优先用原语，不够再放 detail**——原语让 KnowQL 可查询，detail 让业务可扩展。
3. **保持原有领域字段**——如 `draft_id`、`draft_link`、`summary` 等紧耦合数据照常上报。
   原语层和领域层共存，互不替代。
4. **concepts 强烈建议带上**——这是零成本的检索标签，让下游 agent 能找到你的 step。
5. **primitives 不需要你填**——系统自动从有数据的原语桶名生成。

## 完整示例

假设你执行了 `check-cpu.sh` 检查三台服务器，建议这样上报：

```json
{
  "entity": [
    {"type":"server", "id":"web-01", "ip":"10.0.1.5"},
    {"type":"server", "id":"web-02", "ip":"10.0.1.6"},
    {"type":"server", "id":"web-03", "ip":"10.0.1.7"}
  ],
  "fact": [
    {"entity":"web-01", "attr":"cpu", "value":92, "at":"14:15"},
    {"entity":"web-02", "attr":"cpu", "value":45, "at":"14:15"},
    {"entity":"web-03", "attr":"cpu", "value":78, "at":"14:15"}
  ],
  "risk": [
    {"threat":"cpu_overload", "entity":"web-01", "severity":"critical"}
  ],
  "concepts": ["cpu_overload", "server_health", "threshold_breach"]
}
```
