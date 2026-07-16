#!/usr/bin/env python3
"""CLI entry point for openry-orchestrator (Phase 2 workflow engine)."""

from __future__ import annotations

import argparse
import signal
import sys

from openry.orchestrator import Orchestrator
from openry.orchestrator.yaml_loader import (
    list_available_compositions,
    list_available_workflows,
)


def cmd_serve(args: argparse.Namespace) -> None:
    """Start the orchestrator daemon."""
    orch = Orchestrator(
        max_workers=args.max_workers,
        patrol_interval=args.patrol_interval,
        zombie_timeout_minutes=args.zombie_timeout,
        grace_shutdown_seconds=args.grace_shutdown,
    )

    def _handle_signal(signum, frame):
        print(f"\n[orchestrator] Received signal {signum}")
        orch.shutdown()
        sys.exit(0)

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    orch.serve()


def cmd_start(args: argparse.Namespace) -> None:
    """Start a new workflow instance."""
    orch = Orchestrator(max_workers=args.max_workers)
    wf_id = orch.start_workflow(args.composition)
    print(f"Workflow instance started: ID={wf_id}")


def cmd_list(args: argparse.Namespace) -> None:
    """List available workflows and compositions."""
    workflows = list_available_workflows()
    compositions = list_available_compositions()

    if workflows:
        print("Available Big Steps (workflows/):")
        for w in workflows:
            print(f"  - {w}")
    else:
        print("No big step workflows found.")

    if compositions:
        print("\nAvailable Compositions (compositions/):")
        for c in compositions:
            print(f"  - {c}")
    else:
        print("\nNo compositions found.")


def cmd_inspect(args: argparse.Namespace) -> None:
    """Show details for a run_id."""
    from openry.db import get_task_state, get_commands_history
    state = get_task_state(args.run_id)
    if not state:
        print(f"Run ID not found: {args.run_id}")
        return

    print(f"Run ID:      {state['run_id']}")
    print(f"Status:      {state.get('status')}")
    print(f"Workflow:    {state.get('workflow')}")
    print(f"Sub Step:    {state.get('sub_step_id')}")
    print(f"Big Step:    {state.get('big_step_ref')}")
    print(f"Retries:     {state.get('big_step_retry_count', 0)}/{state.get('max_retries', 0)}")
    print(f"Validation:  {state.get('validation_status')}")
    print(f"Payload:     {state.get('payload')}")
    print(f"Created:     {state.get('created_at')}")
    print(f"Updated:     {state.get('updated_at')}")

    history = get_commands_history(args.run_id)
    if history:
        print(f"\nCommands ({len(history)}):")
        for h in history[:10]:
            print(f"  [{h['timestamp']}] {h['command'][:80]} (exit={h['exit_code']})")


def cmd_retry(args: argparse.Namespace) -> None:
    """Manually retry a failed task."""
    from openry.db import get_task_state, update_task_status
    state = get_task_state(args.run_id)
    if not state:
        print(f"Run ID not found: {args.run_id}")
        return
    if state.get("status") not in ("failed", "cancelled"):
        print(f"Cannot retry: status is '{state.get('status')}', not 'failed'")
        return
    update_task_status(args.run_id, "queued")
    print(f"Task {args.run_id} re-queued for retry.")


def cmd_kill(args: argparse.Namespace) -> None:
    """Manually kill an agent session."""
    from openry.db import get_task_state, set_cancel_requested
    state = get_task_state(args.run_id)
    if not state:
        print(f"Run ID not found: {args.run_id}")
        return
    set_cancel_requested(args.run_id)
    print(f"Cancel requested for {args.run_id}. Orchestrator will perform hard-kill.")


def cmd_workers(args: argparse.Namespace) -> None:
    """Show worker pool usage."""
    from openry.db import count_active_sessions
    active = count_active_sessions()
    print(f"Active sessions: {active}/{args.max_workers}")


def main() -> None:
    """Main entry point for openry-orchestrator."""
    parser = argparse.ArgumentParser(
        prog="openry-orchestrator",
        description="OpenRY Workflow Orchestrator (Phase 2)",
    )
    sub = parser.add_subparsers(dest="command", help="Commands")

    # serve
    p_serve = sub.add_parser("serve", help="Start orchestrator daemon")
    p_serve.add_argument("--max-workers", type=int, default=3)
    p_serve.add_argument("--patrol-interval", type=int, default=5)
    p_serve.add_argument("--zombie-timeout", type=int, default=30)
    p_serve.add_argument("--grace-shutdown", type=int, default=10)

    # start
    p_start = sub.add_parser("start", help="Start a workflow instance")
    p_start.add_argument("composition", type=str)
    p_start.add_argument("--max-workers", type=int, default=3)

    # list
    sub.add_parser("list", help="List available workflows and compositions")

    # inspect
    p_inspect = sub.add_parser("inspect", help="Inspect a run_id")
    p_inspect.add_argument("run_id", type=str)

    # retry
    p_retry = sub.add_parser("retry", help="Manually retry a failed task")
    p_retry.add_argument("run_id", type=str)

    # kill
    p_kill = sub.add_parser("kill", help="Kill an agent session")
    p_kill.add_argument("run_id", type=str)

    # workers
    p_workers = sub.add_parser("workers", help="Show worker pool usage")
    p_workers.add_argument("--max-workers", type=int, default=3)

    args = parser.parse_args()

    if args.command == "serve":
        cmd_serve(args)
    elif args.command == "start":
        cmd_start(args)
    elif args.command == "list":
        cmd_list(args)
    elif args.command == "inspect":
        cmd_inspect(args)
    elif args.command == "retry":
        cmd_retry(args)
    elif args.command == "kill":
        cmd_kill(args)
    elif args.command == "workers":
        cmd_workers(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
