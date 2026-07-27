# OpenRY Orchestrator Plugin

OpenClaw plugin for [OpenRY](https://github.com/lingopi/openry) workflow orchestration.

详见项目根目录的 [README.md](../README.md)。

## Tools

| 工具 | 功能 |
|------|------|
| `openry_run` | 通过 OpenRY 命令转发器执行 shell 命令 |
| `openry_status` | 声明子步骤状态，附带 payload 数据 |
| `openry_payload_query` | **KnowQL**：agent 运行时沿知识图谱查询历史 payload |

## 快速开始

```bash
npm install && npm run build
openclaw plugins install . --link
bash scripts/setup.sh
openclaw gateway restart
```

MIT — see [LICENSE](../LICENSE)
npm test
```
