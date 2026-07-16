"""CLI entry point for openry — Phase 1 command forwarder + Phase 2 action hooks."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

# ── Phase 2: in-process cache for cancel_requested ──
_cancel_cache: dict[str, bool] = {}


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


# ──────────────────────────────────────────────
#  Phase 2: action-level hooks (injected into
#  cmd_execute without modifying Phase 1 core)
# ──────────────────────────────────────────────

def _check_cancel(run_id: str) -> str | None:
    """Check if Orchestrator requested cancel (soft-brake).
    Returns a cancel message string if cancelled, None otherwise.
    """
    if not run_id:
        return None
    # Use in-process cache to avoid DB query on every call
    if run_id in _cancel_cache and _cancel_cache[run_id]:
        return "[OPENRY] ⛔ CANCEL REQUESTED: The orchestrator has cancelled this task. Please call: openry --status cancelled"
    from .db import get_cancel_requested
    cancelled = get_cancel_requested(run_id)
    _cancel_cache[run_id] = cancelled
    if cancelled:
        return "[OPENRY] ⛔ CANCEL REQUESTED: The orchestrator has cancelled this task. Please finish your current thought and call: openry --status cancelled"
    return None


def _check_command_policy(run_id: str, command: str) -> str | None:
    """Check command against allowlist/blocklist policy.
    Returns an error message if blocked, None if allowed.
    """
    if not run_id:
        return None
    from .db import get_task_state
    state = get_task_state(run_id)
    if not state:
        return None
    policy_json = state.get("command_policy_json")
    if not policy_json:
        return None  # No policy = unrestricted
    try:
        policy = json.loads(policy_json)
    except (json.JSONDecodeError, TypeError):
        return None

    mode = policy.get("mode", "unrestricted")
    if mode == "unrestricted":
        return None

    cmd_name = command.strip().split()[0] if command.strip() else ""
    commands_list = policy.get("commands", [])

    if mode == "blocklist" and cmd_name in commands_list:
        return f"Command '{cmd_name}' is blocked by sub_step policy"
    if mode == "allowlist" and cmd_name not in commands_list:
        return f"Command '{cmd_name}' is not in the allowed list: {commands_list}"

    return None


def _check_max_tool_calls(run_id: str) -> str | None:
    """Check if agent has exceeded max_tool_calls for this sub_step.
    Returns an error message if limit exceeded, None otherwise.
    """
    if not run_id:
        return None
    from .db import count_tool_calls, get_task_state
    state = get_task_state(run_id)
    if not state:
        return None
    max_calls = state.get("max_tool_calls", 0)
    if not max_calls:
        return None  # No limit set
    current = count_tool_calls(run_id)
    if current >= max_calls:
        return f"[OPENRY] ⛔ MAX TOOL CALLS EXCEEDED: {current}/{max_calls}. Please call: openry --status failed"
    return None


def _check_output_overflow(run_id: str, stdout: str) -> tuple[str, bool]:
    """Check if command output exceeds max_output_tokens threshold.
    Returns (possibly_modified_stdout, overflow_occurred).
    """
    if not run_id or not stdout:
        return stdout, False
    from .db import get_task_state
    state = get_task_state(run_id)
    if not state:
        return stdout, False
    max_tokens = state.get("max_output_tokens", 0)
    if not max_tokens:
        return stdout, False

    # Rough token estimate: ~4 chars per token for English text
    estimated_tokens = len(stdout) // 4
    if estimated_tokens <= max_tokens:
        return stdout, False

    # Overflow: inject notification (same pattern as soft-brake)
    overflow_msg = (
        f"\n\n[OPENRY] ⚠ OUTPUT OVERFLOW: ~{estimated_tokens} tokens exceed {max_tokens} limit.\n"
        f"Raw output saved. Please call: openry --status overflow\n"
    )
    return stdout[:max_tokens * 4] + overflow_msg, True


# ──────────────────────────────────────────────
#  Phase 1 core (preserved) + Phase 2 hooks
# ──────────────────────────────────────────────


def cmd_execute(args: argparse.Namespace) -> None:
    """Handle the -c / --command path (Phase 1 core + Phase 2 hooks)."""
    from .executor import run_command
    from .db import insert_command, upsert_task_state
    from .utils import utc_now_iso

    command = args.command
    if not command or not command.strip():
        print(json.dumps({"error": "command is required", "exit_code": 1}))
        sys.exit(1)

    run_id, workflow, step_id = _read_env_meta()
    extra_env = _parse_env_flags(args.env or [])

    # ── Phase 2: pre-execution hooks ──
    if run_id:
        cancel_msg = _check_cancel(run_id)
        if cancel_msg:
            print(json.dumps({
                "exit_code": 0,
                "stdout": cancel_msg,
                "stderr": "",
                "duration_ms": 0,
            }, ensure_ascii=False))
            return

        policy_block = _check_command_policy(run_id, command)
        if policy_block:
            print(json.dumps({
                "exit_code": 1,
                "stdout": "",
                "stderr": policy_block,
                "duration_ms": 0,
                "blocked": True,
            }, ensure_ascii=False))
            return

        max_calls_msg = _check_max_tool_calls(run_id)
        if max_calls_msg:
            print(json.dumps({
                "exit_code": 1,
                "stdout": max_calls_msg,
                "stderr": "",
                "duration_ms": 0,
            }, ensure_ascii=False))
            return
    # ── end Phase 2 hooks ──

    start = time.perf_counter()
    result = run_command(
        command,
        cwd=args.cwd,
        timeout=args.timeout if args.timeout else 300,
        extra_env=extra_env,
    )
    elapsed_ms = int((time.perf_counter() - start) * 1000)
    result["duration_ms"] = elapsed_ms

    # ── Phase 2: post-execution overflow check ──
    overflow = False
    if run_id:
        result["stdout"], overflow = _check_output_overflow(run_id, result["stdout"])
    # ── end Phase 2 hook ──

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
    if overflow:
        agent_response["overflow"] = True

    print(json.dumps(agent_response, ensure_ascii=False))


def cmd_status(args: argparse.Namespace) -> None:
    """Handle the --status path (Phase 1: completed/failed + Phase 2: cancelled/overflow)."""
    from .db import upsert_task_state, set_output_overflow

    status = args.status
    # Phase 1 statuses + Phase 2 extended statuses
    valid_statuses = ("completed", "failed", "cancelled", "overflow")
    if status not in valid_statuses:
        print(json.dumps({"error": f"status must be one of: {', '.join(valid_statuses)}"}))
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

    # Phase 2: overflow status triggers DB flag
    if status == "overflow":
        set_output_overflow(run_id)
    elif status == "cancelled":
        # Just update the status, Orchestrator will handle hard-kill
        pass

    upsert_task_state(
        run_id=run_id,
        workflow=workflow,
        step_id=step_id,
        status=status,
        payload=payload_str,
    )

    response = {
        "status": status,
        "payload": json.loads(payload_str),
        "acknowledged": True,
    }
    if status == "cancelled":
        response["message"] = "Task cancelled. Orchestrator will perform cleanup."
    elif status == "overflow":
        response["message"] = "Output overflow acknowledged. Orchestrator will trigger overflow workflow."

    print(json.dumps(response, ensure_ascii=False))


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
        choices=["completed", "failed", "cancelled", "overflow"],
        help="Update task status (requires OPENRY_RUN_ID env var). "
             "Phase 2 adds: cancelled (soft-brake response), overflow (output too large)",
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
