"""CLI entry point for openry — Phase 1 command forwarder."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time


def _read_env_meta() -> tuple[str | None, str | None, str | None]:
    """Read workflow metadata from environment variables (injected by Orchestrator)."""
    return (
        os.environ.get("OPENRY_RUN_ID"),
        os.environ.get("OPENRY_WORKFLOW"),
        os.environ.get("OPENRY_STEP_ID"),
    )


def _parse_env_flags(args: list[str]) -> dict[str, str]:
    """Parse repeated -e KEY=VAL flags into a dict."""
    env_dict: dict[str, str] = {}
    if not args:
        return env_dict
    for item in args:
        if "=" not in item:
            print(json.dumps({"error": f"Invalid env format: '{item}', expected KEY=VAL"}))
            sys.exit(1)
        key, _, val = item.partition("=")
        env_dict[key] = val
    return env_dict


def cmd_execute(args: argparse.Namespace) -> None:
    """Handle the -c / --command path."""
    from .executor import run_command
    from .db import insert_command, upsert_task_state
    from .utils import utc_now_iso

    command = args.command
    if not command or not command.strip():
        print(json.dumps({"error": "command is required", "exit_code": 1}))
        sys.exit(1)

    run_id, workflow, step_id = _read_env_meta()
    extra_env = _parse_env_flags(args.env or [])

    start = time.perf_counter()
    result = run_command(
        command,
        cwd=args.cwd,
        timeout=args.timeout if args.timeout else 300,
        extra_env=extra_env,
    )
    elapsed_ms = int((time.perf_counter() - start) * 1000)
    result["duration_ms"] = elapsed_ms

    # Write to SQLite (best-effort, don't fail the CLI if DB is unwritable)
    try:
        insert_command(
            run_id=run_id,
            workflow=workflow,
            step_id=step_id,
            command=command,
            shell=result["shell"],
            cwd=result["cwd"],
            exit_code=result["exit_code"],
            stdout=result["stdout"],
            stderr=result["stderr"],
            duration_ms=elapsed_ms,
            timeout=result.get("timeout", False),
        )

        if run_id:
            # Ensure a task_state row exists (for Orchestrator to track)
            upsert_task_state(
                run_id=run_id,
                workflow=workflow,
                step_id=step_id,
                status="in_progress",
            )
    except Exception:
        # DB write failure is non-fatal for command execution
        pass

    # Return to agent: clean JSON, no metadata exposed
    agent_response = {
        "exit_code": result["exit_code"],
        "stdout": result["stdout"],
        "stderr": result["stderr"],
        "duration_ms": elapsed_ms,
    }
    if result.get("timeout"):
        agent_response["timeout"] = True

    print(json.dumps(agent_response, ensure_ascii=False))


def cmd_status(args: argparse.Namespace) -> None:
    """Handle the --status path."""
    from .db import upsert_task_state

    status = args.status
    if status not in ("completed", "failed"):
        print(json.dumps({"error": "status must be 'completed' or 'failed'"}))
        sys.exit(1)

    run_id, workflow, step_id = _read_env_meta()
    if not run_id:
        print(json.dumps({"error": "OPENRY_RUN_ID not set; --status requires an active run"}))
        sys.exit(1)

    # Validate and normalize payload
    payload_str = "{}"
    if args.payload:
        try:
            parsed = json.loads(args.payload)
            if not isinstance(parsed, dict):
                print(json.dumps({"error": "payload must be a JSON object"}))
                sys.exit(1)
            payload_str = json.dumps(parsed, ensure_ascii=False)
        except json.JSONDecodeError:
            print(json.dumps({"error": "payload must be valid JSON"}))
            sys.exit(1)

    upsert_task_state(
        run_id=run_id,
        workflow=workflow,
        step_id=step_id,
        status=status,
        payload=payload_str,
    )

    print(json.dumps({
        "status": status,
        "payload": json.loads(payload_str),
        "acknowledged": True,
    }, ensure_ascii=False))


def main() -> None:
    """Main entry point for the openry CLI."""
    parser = argparse.ArgumentParser(
        prog="openry",
        description="Command forwarder for ReAct Agent workflow systems",
    )

    # Mutually exclusive: -c or --status
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument(
        "-c", "--command",
        type=str,
        help="Shell command to execute",
    )
    group.add_argument(
        "--status",
        type=str,
        choices=["completed", "failed"],
        help="Update task status (requires OPENRY_RUN_ID env var)",
    )

    parser.add_argument(
        "--payload",
        type=str,
        default=None,
        help="JSON payload to attach to status update",
    )
    parser.add_argument(
        "-d", "--cwd",
        type=str,
        default=None,
        help="Working directory for command execution",
    )
    parser.add_argument(
        "-t", "--timeout",
        type=int,
        default=None,
        help="Command timeout in seconds (default: 300)",
    )
    parser.add_argument(
        "-e", "--env",
        type=str,
        action="append",
        default=None,
        help="Extra environment variable in KEY=VAL format (repeatable)",
    )

    args = parser.parse_args()

    if args.command is not None:
        cmd_execute(args)
    elif args.status is not None:
        cmd_status(args)
    else:
        # argparse mutually exclusive group should prevent this, but safety net
        print(json.dumps({"error": "either --command or --status is required"}))
        sys.exit(1)


if __name__ == "__main__":
    main()
