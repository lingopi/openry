# OpenRY

> **Put handcuffs on your AI Agent** — a cross-platform command forwarder that makes every "action" of a ReAct Agent controllable, auditable, and stoppable.

## TL;DR

Agent thinks. OpenRY acts. Orchestrator orchestrates.

## Core Features (Phase 1)

- **Command Forwarding**: `openry -c '<shell command>'` — cross-platform execution with automatic shell selection
- **Status Updates**: `openry --status completed/failed` — agent explicitly declares completion
- **Payload Passing**: `--payload '{"key":"val"}'` — data handoff between workflow steps
- **Transparent Audit**: all calls automatically recorded to SQLite, invisible to the agent

## Why OpenRY

When a ReAct Agent calls system commands directly, three fatal problems emerge:

1. **State Machine Breaks** — agent skips or sends wrong status, workflow deadlocks
2. **Infinite Loops** — "call → think → call again" death spiral burns tokens
3. **False Completion** — agent claims success, but the artifact is missing, downstream crashes

OpenRY inserts a controlled intermediary between every agent and every system command, solving this at the root.

## Quick Start

```bash
# Install
git clone https://github.com/lingopi/openry.git
cd openry
./install.sh

# Basic usage
openry -c 'echo hello world'
# → {"exit_code": 0, "stdout": "hello world\n", "stderr": "", "duration_ms": 4}

# With Orchestrator context
OPENRY_RUN_ID="abc" openry --status completed --payload '{"msg_id":"123"}'
# → {"status": "completed", "payload": {"msg_id": "123"}, "acknowledged": true}
```

## Cross-Platform

| Platform | Shell |
|----------|-------|
| Windows  | PowerShell 7 |
| macOS    | /bin/zsh |
| Linux    | /bin/sh |

## Project Structure

```
openry/
├── cli.py          # CLI entry point
├── executor.py     # cross-platform command execution
├── db.py           # SQLite data layer
├── config.py       # configuration loading
└── utils.py        # utility functions
```

Minimal dependencies: `pyyaml` is the only external package. Everything else is Python standard library.

## License

MIT © OpenRY Contributors
