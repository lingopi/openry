# Windows BGE 向量化失败调查报告

> 日期：2026-08-11
> 状态：根因已定位，待修复
> 影响：concepts 无法写入 `clusters` 向量表，`_core_id` 永远为 NULL

---

## 一、问题现象

- `openry` 命令执行正常，concepts 正确写入 `task_state.payload`
- `clusters` 表始终为空（0 行）
- 所有 `task_state` 记录的 `_core_id` 均为 NULL（未归一化）
- 向量搜索（`openry_knowledge_query`）无结果

## 二、故障链路

```
Agent 创建 concepts → Python CLI 写入 task_state.payload ✅
  → patrol 巡逻检测 concepts 未归一化
    → normalizeConcepts() 调用 embed()
      → getPipeline() 动态 import("@xenova/transformers")
        → ❌ require("sharp") 失败！
        → 整个 embed() 不可用
          → normalizeConcepts 静默失败（patrol try/catch 吞掉）
            → _core_id 永远为 NULL
              → clusters 表永远为空
```

## 三、根因

**`sharp` 原生模块缺少 `sharp-win32-x64.node`**，导致 `@xenova/transformers` 无法加载。

### 3.1 依赖链

```
@xenova/transformers (^2.17.2)
├── sharp (^0.32.0)          ← required dependency，负责图像处理
│   └── ❌ 缺少 build/Release/sharp-win32-x64.node
├── onnxruntime-node (1.14.0) ← optional dependency，原生 ONNX 推理
│   └── ❌ 完全未安装
└── onnxruntime-web (1.14.0)  ← WASM fallback，性能差但可用
    └── ✅ 存在
```

### 3.2 为什么 sharp 会影响文本向量化？

`sharp` 是 `@xenova/transformers` 的 **required** dependency（`dependencies`，非 `optionalDependencies`），Node.js 在 `require("@xenova/transformers")` 时会**立即**加载 sharp。即使 BGE-M3 是纯文本模型、不需要图像处理，sharp 的加载失败也会阻止整个 transformers 库的初始化。

### 3.3 模块状态详情

| 模块 | 目录存在 | 原生 .node | require() | 说明 |
|------|---------|-----------|-----------|------|
| `sharp` | ✅ | ❌ 缺失 | ❌ Error | v0.32.6, NAPI v7 |
| `@xenova/transformers` | ✅ | — | ❌ 连带失败 | 被 sharp 阻塞 |
| `onnxruntime-node` | ❌ 不存在 | ❌ | ❌ | 未安装 |
| `onnxruntime-web` | ✅ | WASM | ✅ | 存在但未使用 |
| `better-sqlite3` | ✅ | ✅ | ✅ | 正常 |

### 3.4 环境信息

- **OS**: Windows (win32-x64)
- **Node.js**: v24.14.1
- **sharp version**: 0.32.6 (NAPI v7, 与 Node 24 兼容)
- **sharp binary**: 应为 `sharp-win32-x64.node`，但在 `node_modules/sharp/build/Release/` 下不存在

## 四、日志证据

OpenClaw gateway 日志（`~\AppData\Local\Temp\openclaw\openclaw-2026-08-11.log`）：

```
[orchestrator-plugin] agent concept normalization failed for 40cba5f4...:
Error: Something went wrong installing the "sharp" module
Cannot find module '../build/Release/sharp-win32-x64.node'
Require stack:
- ...\node_modules\sharp\lib\sharp.js
- ...\node_modules\sharp\lib\constructor.js
- ...\node_modules\sharp\lib\index.js

[orchestrator-plugin] agent concept normalization failed for 8613bfb7...:
Error: Something went wrong installing the "sharp" module
...
```

> 所有 4 个 concepts 的归一化全部失败，错误完全一致。

## 五、数据库状态

```sql
-- clusters: 0 行
SELECT COUNT(*) FROM clusters;  -- 0

-- task_state: 4 行，全部 _core_id=NULL
SELECT COUNT(*) FROM task_state;  -- 4
SELECT COUNT(*) FROM task_state 
  WHERE json_extract(payload, '$._core_id') IS NOT NULL;  -- 0
```

## 六、修复方向

### 方案 A：重建原生模块（推荐）

```powershell
cd orchestrator-plugin
npm rebuild sharp
npm install onnxruntime-node
```

然后重启 gateway：`openclaw gateway restart`

### 方案 B：重新 npm install（不带 --ignore-scripts）

```powershell
cd orchestrator-plugin
rm -r node_modules
npm install
```

### 方案 C：修复 tar 包

在打包 `orchestrator-plugin-bundle-win.tar.gz` 时确保：
1. `npm install` 正常执行（不使用 `--ignore-scripts`）
2. `node_modules/sharp/build/Release/sharp-win32-x64.node` 存在
3. `node_modules/onnxruntime-node/` 完整

## 七、与 macOS 的差异

macOS 上 sharp 通过 npm postinstall 自动下载了 `sharp-darwin-arm64v8.node`，安装正常。

Windows 失败的可能原因：
1. tar 包制作时 npm install 使用了 `--ignore-scripts`，跳过了 sharp 的 postinstall
2. tar 包跨机器使用时，预编译的 .node 文件不兼容当前 Node.js 版本
3. 打包时 `onnxruntime-node` 被遗漏（optionalDependency 可能在某些条件下不安装）

## 八、验证方法

修复后验证：
```powershell
# 1. 确认原生模块可加载
cd orchestrator-plugin
node -e "require('sharp'); console.log('sharp: OK')"
node -e "require('@xenova/transformers'); console.log('xenova: OK')"
node -e "require('onnxruntime-node'); console.log('onnxruntime: OK')"

# 2. 重启 gateway
openclaw gateway restart

# 3. 触发一个新的 workflow run（产生 concepts）
openry -c 'echo test workflow'

# 4. 等待 patrol 归一化（~10-30 秒），检查数据库
python -c "
import sqlite3, os
db = os.path.expanduser(r'~\.openry\openry.db')
conn = sqlite3.connect(db)
c = conn.execute('SELECT COUNT(*) FROM clusters').fetchone()[0]
print(f'clusters: {c} rows')
c = conn.execute(\"SELECT COUNT(*) FROM task_state WHERE json_extract(payload, '\$._core_id') IS NOT NULL\").fetchone()[0]
print(f'normalized concepts: {c}')
conn.close()
"
```
