# OpenRY Orchestrator Plugin

OpenClaw plugin for the [OpenRY](https://github.com/openry) workflow orchestration system.

## What it does

This plugin adds **two tools** (`openry_run`, `openry_status`) and a **background orchestrator service** to OpenClaw:

- **`openry_run`** — Agent calls this to execute shell commands through the OpenRY command forwarder
- **`openry_status`** — Agent calls this to declare sub-step completion with structured payload data
- **Orchestrator Service** — Background patrol loop that scans the OpenRY SQLite database, dispatches queued tasks to agents, validates results, and routes to next steps

## Quick Start

```bash
# 1. Build
npm install && npm run build

# 2. Install as linked plugin
openclaw plugins install . --link

# 3. Run setup (creates workspace + AGENTS.md)
bash scripts/setup.sh

# 4. Add agent config to ~/.openclaw/openclaw.json (see below)
# 5. Restart Gateway
openclaw gateway restart
```

## Agent Configuration

Add to `~/.openclaw/openclaw.json`:

```json5
{
  "agents": {
    "list": [{
      "id": "openry-worker",
      "name": "OpenRY Worker",
      "tools": {
        "profile": "minimal",
        "alsoAllow": ["openry_run", "openry_status"]
      },
      "workspace": "~/.openry/agent-workspace"
    }]
  }
}
```

## Configuration

The plugin resolves the `.openry` directory in this order:

1. `OPENRY_HOME` environment variable
2. `plugins.entries.orchestrator-plugin.config.openryDir` in `openclaw.json`
3. `./.openry` in the current working directory
4. `~/.openry` (default fallback)

## Example Workflow

```yaml
# ~/.openry/workflows/echo_test.yaml
name: echo_test
timeout_minutes: 5
max_retries: 1

sub_steps:
  - id: step_hello
    kind: agent
    description: "Run 'echo Hello' using openry_run, then call openry_status completed"
    on_success: step_verify
    on_failure: abort
    max_tool_calls: 5
    expect_payload: true
    payload_keys: ["msg"]

  - id: step_verify
    kind: agent
    description: "Run 'date' using openry_run, then call openry_status completed"
    on_success: done
    on_failure: abort
    max_tool_calls: 5
    inherit_payload: true
```

## Compatible with

- **OpenClaw** (plugin mode) — this project
- **Claude Code / generic agents** — use the Python `openry/orchestrator/` directly

Both share the same `openry` CLI and `openry.db`.

## License

MIT — see [LICENSE](../LICENSE)
npm test
```
