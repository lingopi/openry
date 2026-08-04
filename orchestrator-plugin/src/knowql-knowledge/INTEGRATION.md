# KnowQL Knowledge — 集成点清单

本模块为**实验性质**，未来可能废弃或重构。如需移除，按以下步骤操作。

## 集成点

| # | 文件 | 代码 | 移除操作 |
|---|------|------|---------|
| 1 | `src/index.ts` | `import { registerKnowledgeTool } from "./knowql-knowledge"` | 删除 import + 调用行 |
| 2 | `src/index.ts` | `registerKnowledgeTool(api, db)` | 删除 |
| 3 | `src/orchestrator/patrol.ts` | `import { normalizeConcepts } from "../knowql-knowledge"` | 删除 import |
| 4 | `src/orchestrator/patrol.ts` | `await normalizeConcepts(this.db, rawConcepts)` in `handleDistillComplete` | 注释掉，改用 `display_labels = rawConcepts; core_id = null` |
| 5 | `src/orchestrator/patrol.ts` | `scanAndNormalizeAgentConcepts()` + `queryAgentStepsNeedingNormalization` | 注释掉 patrol() 中的调用行 + 删除方法 |
| 6 | `src/orchestrator/db-client.ts` | `export function queryAgentStepsNeedingNormalization()` | 删除函数 |

## DB 清理

```sql
-- 删除 clusters 表
DROP TABLE IF EXISTS clusters;
```

task_state.payload 中的 `_core_id`、`_raw_concepts` 字段可保留（向后兼容）。

## 依赖清理

```bash
# 仅本模块使用的依赖
npm uninstall @xenova/transformers   # BGE-M3 embedding
```

## 设计文档

`design/phase3d-knowql-knowledge-query.md`
