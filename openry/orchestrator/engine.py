"""Orchestrator engine: patrol loop, subprocess management, retry logic."""

from __future__ import annotations

import json
import os
import signal
import subprocess
import time
import uuid
from datetime import datetime
from typing import Any

from openry.db import (
    _init_phase2_schema,
    count_active_sessions,
    get_commands_history,
    get_task_state,
    query_cancelled_tasks,
    query_failed_with_retries,
    query_overflow_tasks,
    query_pending_validations,
    query_queued_tasks,
    query_validated_tasks,
    query_zombie_tasks,
    set_cancel_requested,
    update_task_status,
)

from .payload import load_payload, merge_payload, dump_payload
from .validation import validate_step
from .yaml_loader import (
    get_first_sub_step,
    get_next_sub_step,
    get_sub_step_config,
    load_big_step,
    load_composition,
)


class Orchestrator:
    """Phase 2 workflow orchestrator.

    Manages the lifecycle of workflow instances via a patrol loop:
    - Scans DB for state changes
    - Spawns/kills agent sessions
    - Validates completed steps
    - Routes to next steps
    - Handles retries, timeouts, and overflow
    """

    def __init__(
        self,
        max_workers: int = 3,
        patrol_interval: int = 5,
        zombie_timeout_minutes: int = 30,
        grace_shutdown_seconds: int = 10,
    ):
        self.max_workers = max_workers
        self.patrol_interval = patrol_interval
        self.zombie_timeout_minutes = zombie_timeout_minutes
        self.grace_shutdown_seconds = grace_shutdown_seconds

        # In-memory session tracking
        self.active_sessions: dict[str, dict[str, Any]] = {}
        self._running = False

    # ── Public API ─────────────────────────────────

    def start_workflow(self, composition_name: str) -> int:
        """Start a new workflow instance. Returns workflow_instance_id."""
        comp = load_composition(composition_name)
        _init_phase2_schema()

        # Create workflow instance record
        from openry.db import _get_conn
        conn = _get_conn()
        cursor = conn.execute(
            """INSERT INTO workflow_instances (composition, status, current_big_step)
               VALUES (?, 'running', ?)""",
            (composition_name, comp["big_steps"][0]["ref"] if comp.get("big_steps") else None),
        )
        workflow_instance_id = cursor.lastrowid
        conn.commit()
        conn.close()

        # Enqueue the first big_step's first sub_step
        self._enqueue_first_sub_step(workflow_instance_id, comp)
        return workflow_instance_id

    def serve(self) -> None:
        """Run the patrol loop (blocking)."""
        _init_phase2_schema()
        self._running = True
        self._cleanup_orphans()

        print(f"[orchestrator] Patrol loop started (interval={self.patrol_interval}s, "
              f"workers={self.max_workers})")

        while self._running:
            try:
                self._patrol()
            except Exception as e:
                print(f"[orchestrator] Patrol error: {e}")
            time.sleep(self.patrol_interval)

    def shutdown(self) -> None:
        """Graceful shutdown: kill all child processes, write DB, exit."""
        self._running = False
        print("[orchestrator] Shutting down...")
        for run_id, session in list(self.active_sessions.items()):
            pid = session.get("pid")
            if pid:
                print(f"[orchestrator] Terminating session {run_id} (PID={pid})")
                try:
                    os.kill(pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
        time.sleep(self.grace_shutdown_seconds)

        for run_id, session in list(self.active_sessions.items()):
            pid = session.get("pid")
            if pid:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        self.active_sessions.clear()
        print("[orchestrator] Shutdown complete.")

    # ── Patrol Loop ────────────────────────────────

    def _patrol(self) -> None:
        """One round of the patrol loop (serial scans)."""
        self._reap_zombies()              # 1
        self._check_big_step_timeout()     # 2
        self._check_max_tool_calls()       # 3
        self._dispatch_queued()            # 4
        self._check_zombie_sessions()      # 5
        self._validate_completed()         # 6
        self._route_validated()            # 7
        self._hard_kill_cancelled()        # 8
        self._handle_overflow()            # 9
        self._recover_overflow()           # 10
        self._retry_failed()              # 11

    # ── Step 1: Reap zombies ──────────────────────

    def _reap_zombies(self) -> None:
        """Reap finished child processes to prevent zombie accumulation."""
        try:
            while True:
                pid, exit_status = os.waitpid(-1, os.WNOHANG)
                if pid == 0:
                    break
                for run_id, session in list(self.active_sessions.items()):
                    if session.get("pid") == pid:
                        del self.active_sessions[run_id]
                        break
        except ChildProcessError:
            pass

    # ── Step 2: Big step timeout ──────────────────

    def _check_big_step_timeout(self) -> None:
        """Check for big_step timeout and request soft-brake."""
        from openry.db import _get_conn
        conn = _get_conn()
        conn.row_factory = None
        rows = conn.execute(
            """SELECT ts.run_id, wi.timeout_minutes, wi.big_step_started_at
               FROM task_state ts
               JOIN workflow_instances wi ON ts.workflow_instance_id = wi.id
               WHERE ts.status = 'in_progress'
                 AND wi.big_step_started_at IS NOT NULL
                 AND wi.timeout_minutes IS NOT NULL"""
        ).fetchall()
        conn.close()

        for run_id, timeout_min, started_at in rows:
            if not started_at:
                continue
            try:
                started = datetime.fromisoformat(started_at)
            except (ValueError, TypeError):
                continue
            elapsed = (datetime.now() - started).total_seconds() / 60.0
            if elapsed > timeout_min:
                set_cancel_requested(run_id)

    # ── Step 3: Max tool calls ────────────────────

    def _check_max_tool_calls(self) -> None:
        """Check if any in_progress task has exceeded max_tool_calls."""
        from openry.db import count_tool_calls
        for task in query_queued_tasks(limit=100):
            pass  # Only check in_progress
        # Get all in_progress tasks
        from openry.db import _get_conn
        conn = _get_conn()
        conn.row_factory = None
        rows = conn.execute(
            "SELECT run_id, max_tool_calls FROM task_state "
            "WHERE status = 'in_progress' AND max_tool_calls > 0"
        ).fetchall()
        conn.close()

        for run_id, max_calls in rows:
            current = count_tool_calls(run_id)
            if current >= max_calls:
                update_task_status(run_id, "failed")
                if run_id in self.active_sessions:
                    self._kill_session(run_id)

    # ── Step 4: Dispatch queued ───────────────────

    def _dispatch_queued(self) -> None:
        """Spawn agent sessions for queued tasks if worker slots available."""
        active_count = count_active_sessions()
        available = self.max_workers - active_count
        if available <= 0:
            return

        tasks = query_queued_tasks(limit=available)
        for task in tasks:
            self._spawn_agent_session(task)

    def _spawn_agent_session(self, task: dict) -> None:
        """Spawn a new agent subprocess for a queued task."""
        run_id = task["run_id"]
        sub_step_id = task.get("sub_step_id", "")
        workflow = task.get("workflow", "")

        # Build task description from YAML
        description = self._build_task_description(task)

        env = os.environ.copy()
        env["OPENRY_RUN_ID"] = run_id
        env["OPENRY_WORKFLOW"] = workflow
        env["OPENRY_STEP_ID"] = sub_step_id

        try:
            proc = subprocess.Popen(
                ["openclaw", "session", "start", "--task", description],
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            self.active_sessions[run_id] = {
                "pid": proc.pid,
                "workflow": workflow,
                "step_id": sub_step_id,
                "started_at": datetime.now().isoformat(),
            }
            update_task_status(run_id, "in_progress")
        except FileNotFoundError:
            # openclaw not installed — start in mock mode for testing
            print(f"[orchestrator] openclaw not found, starting mock session for {run_id}")
            self.active_sessions[run_id] = {
                "pid": 0,
                "workflow": workflow,
                "step_id": sub_step_id,
                "started_at": datetime.now().isoformat(),
                "mock": True,
            }
            update_task_status(run_id, "in_progress")

    def _build_task_description(self, task: dict) -> str:
        """Build the agent prompt from the sub_step YAML config."""
        sub_step_id = task.get("sub_step_id", "")
        big_step_ref = task.get("big_step_ref", "")

        try:
            big_step = load_big_step(big_step_ref)
            sub_step = get_sub_step_config(big_step, sub_step_id)
            if sub_step and sub_step.get("description"):
                return sub_step["description"]
        except Exception:
            pass

        return f"Execute sub_step: {sub_step_id}"

    # ── Step 5: Zombie sessions ───────────────────

    def _check_zombie_sessions(self) -> None:
        """Reset in_progress tasks that haven't been updated in zombie_timeout."""
        zombies = query_zombie_tasks(self.zombie_timeout_minutes)
        for task in zombies:
            run_id = task["run_id"]
            update_task_status(run_id, "queued")
            if run_id in self.active_sessions:
                self._kill_session(run_id)

    # ── Step 6: Validate completed ────────────────

    def _validate_completed(self) -> None:
        """Run validation on completed tasks."""
        tasks = query_pending_validations()
        for task in tasks:
            run_id = task["run_id"]
            sub_step_id = task.get("sub_step_id", "")
            big_step_ref = task.get("big_step_ref", "")

            try:
                big_step = load_big_step(big_step_ref)
                step_config = get_sub_step_config(big_step, sub_step_id)
            except Exception:
                step_config = {}

            if not step_config:
                # No config = no validation needed → auto-validate
                update_task_status(run_id, "validated", validation_status="passed")
                continue

            passed, reason = validate_step(run_id, step_config)
            if passed:
                update_task_status(run_id, "validated", validation_status="passed")
            else:
                on_fail = step_config.get("on_validation_fail", "retry_current")
                if on_fail == "retry_current":
                    update_task_status(run_id, "queued", validation_status="failed")
                else:
                    update_task_status(run_id, "failed", validation_status="failed")

    # ── Step 7: Route validated ───────────────────

    def _route_validated(self) -> None:
        """Route validated tasks to their next sub_step."""
        tasks = query_validated_tasks()
        for task in tasks:
            run_id = task["run_id"]
            sub_step_id = task.get("sub_step_id", "")
            big_step_ref = task.get("big_step_ref", "")

            try:
                big_step = load_big_step(big_step_ref)
                step_config = get_sub_step_config(big_step, sub_step_id)
            except Exception:
                step_config = {}

            if not step_config:
                update_task_status(run_id, "done")
                continue

            on_success = step_config.get("on_success", "done")
            if on_success == "done":
                update_task_status(run_id, "done")
                # Check for next big_step in composition
                self._advance_big_step(task)
            else:
                # Route to specified next sub_step
                next_step = get_sub_step_config(big_step, on_success)
                if next_step:
                    self._enqueue_next_sub_step(task, big_step, next_step)
                else:
                    update_task_status(run_id, "failed")

    def _enqueue_next_sub_step(
        self, task: dict, big_step: dict, next_step: dict,
    ) -> None:
        """Create a new run_id and enqueue the next sub_step."""
        new_run_id = str(uuid.uuid4())
        workflow_instance_id = task.get("workflow_instance_id")

        # Merge payload
        current_payload = load_payload(task.get("payload"))
        previous_payload = load_payload(task.get("payload"))  # Same for now

        inherit = next_step.get("inherit_payload", False)
        if inherit:
            merged = merge_payload(previous_payload, current_payload, inherit=True)
        else:
            merged = {}

        from openry.db import _get_conn
        conn = _get_conn()
        conn.execute(
            """INSERT INTO task_state
               (run_id, workflow, step_id, big_step_ref, sub_step_id,
                status, payload, workflow_instance_id, max_tool_calls,
                max_retries, max_sub_step_retries, max_output_tokens,
                on_output_overflow, on_validation_fail)
               VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                new_run_id,
                task.get("workflow"),
                next_step.get("id"),
                task.get("big_step_ref"),
                next_step.get("id"),
                dump_payload(merged),
                workflow_instance_id,
                next_step.get("max_tool_calls", 0),
                big_step.get("max_retries", 0),
                next_step.get("max_sub_step_retries", 0),
                next_step.get("max_output_tokens", 0),
                next_step.get("on_output_overflow", ""),
                next_step.get("on_validation_fail", "retry_current"),
            ),
        )
        conn.commit()
        conn.close()

    def _enqueue_first_sub_step(self, workflow_instance_id: int, comp: dict) -> None:
        """Enqueue the first sub_step of the first big_step."""
        big_steps = comp.get("big_steps", [])
        if not big_steps:
            return
        first_ref = big_steps[0].get("ref", "")
        big_step = load_big_step(first_ref)
        first_sub = get_first_sub_step(big_step)
        if not first_sub:
            return

        run_id = str(uuid.uuid4())
        from openry.db import _get_conn
        conn = _get_conn()
        conn.execute(
            """INSERT INTO task_state
               (run_id, workflow, step_id, big_step_ref, sub_step_id,
                status, payload, workflow_instance_id, max_tool_calls,
                max_retries, max_sub_step_retries, max_output_tokens,
                on_output_overflow, on_validation_fail)
               VALUES (?, ?, ?, ?, ?, 'queued', '{}', ?, ?, ?, ?, ?, ?, ?)""",
            (
                run_id,
                comp.get("name"),
                first_sub.get("id"),
                first_ref,
                first_sub.get("id"),
                workflow_instance_id,
                first_sub.get("max_tool_calls", 0),
                big_step.get("max_retries", 0),
                first_sub.get("max_sub_step_retries", 0),
                first_sub.get("max_output_tokens", 0),
                first_sub.get("on_output_overflow", ""),
                first_sub.get("on_validation_fail", "retry_current"),
            ),
        )
        conn.commit()
        conn.close()

    def _advance_big_step(self, task: dict) -> None:
        """When a sub_step routes to 'done', check for next big_step in composition."""
        workflow_instance_id = task.get("workflow_instance_id")
        if not workflow_instance_id:
            return
        # Simplified: mark workflow instance as completed for now
        from openry.db import _get_conn
        conn = _get_conn()
        conn.execute(
            "UPDATE workflow_instances SET status = 'completed', updated_at = datetime('now') "
            "WHERE id = ?",
            (workflow_instance_id,),
        )
        conn.commit()
        conn.close()

    # ── Step 8: Hard-kill cancelled ───────────────

    def _hard_kill_cancelled(self) -> None:
        """SIGTERM → wait → SIGKILL for cancelled sessions."""
        tasks = query_cancelled_tasks()
        for task in tasks:
            run_id = task["run_id"]
            if run_id in self.active_sessions:
                self._kill_session(run_id)
            update_task_status(run_id, "failed")

    # ── Step 9: Handle overflow ───────────────────

    def _handle_overflow(self) -> None:
        """Trigger overflow workflow for tasks in overflow status."""
        tasks = query_overflow_tasks()
        for task in tasks:
            run_id = task["run_id"]
            on_overflow = task.get("on_output_overflow", "")
            if not on_overflow:
                update_task_status(run_id, "failed")
                continue

            # Kill current session if active
            if run_id in self.active_sessions:
                self._kill_session(run_id)

            # Save command history as context for recovery
            history = get_commands_history(run_id)
            if history:
                from openry.db import _get_conn
                conn = _get_conn()
                conn.execute(
                    "UPDATE task_state SET previous_summary = ? WHERE run_id = ?",
                    (json.dumps(history, ensure_ascii=False), run_id),
                )
                conn.commit()
                conn.close()

            # Start overflow workflow as a new workflow instance
            try:
                overflow_id = self.start_workflow(on_overflow)
                from openry.db import _get_conn
                conn = _get_conn()
                conn.execute(
                    "UPDATE task_state SET overflow_workflow_id = ? WHERE run_id = ?",
                    (overflow_id, run_id),
                )
                conn.commit()
                conn.close()
            except Exception:
                update_task_status(run_id, "failed")

    # ── Step 10: Recover from overflow ────────────

    def _recover_overflow(self) -> None:
        """Resume original sub_step after overflow workflow completes."""
        from openry.db import _get_conn
        conn = _get_conn()
        conn.row_factory = None
        rows = conn.execute(
            """SELECT ts.run_id, ts.previous_summary, ts.overflow_workflow_id
               FROM task_state ts
               WHERE ts.status = 'overflow'
                 AND ts.overflow_workflow_id IS NOT NULL"""
        ).fetchall()
        conn.close()

        for run_id, prev_summary, overflow_wf_id in rows:
            # Check if overflow workflow is complete
            overflow_state = get_task_state(f"overflow_{overflow_wf_id}")
            # Simplified: check if any task in overflow workflow is done
            # For now, just re-enqueue based on overflow completion
            # (Phase 3 will have proper completion tracking)
            pass

    # ── Step 11: Retry failed ─────────────────────

    def _retry_failed(self) -> None:
        """Re-enqueue failed tasks that still have retry budget."""
        tasks = query_failed_with_retries()
        for task in tasks:
            run_id = task["run_id"]
            retry_count = task.get("big_step_retry_count", 0)
            max_retries = task.get("max_retries", 0)

            if retry_count >= max_retries:
                continue

            # Increment retry count and re-enqueue
            update_task_status(
                run_id, "queued",
                big_step_retry_count=retry_count + 1,
            )

    # ── Helpers ───────────────────────────────────

    def _kill_session(self, run_id: str) -> None:
        """Kill an agent session: SIGTERM → 5s → SIGKILL."""
        session = self.active_sessions.pop(run_id, None)
        if not session:
            return
        pid = session.get("pid")
        if not pid or session.get("mock"):
            return
        try:
            os.kill(pid, signal.SIGTERM)
            time.sleep(5)
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    def _cleanup_orphans(self) -> None:
        """On startup, reset in_progress tasks whose PID no longer exists."""
        from openry.db import _get_conn
        conn = _get_conn()
        conn.row_factory = None
        rows = conn.execute(
            "SELECT run_id FROM task_state WHERE status = 'in_progress'"
        ).fetchall()
        conn.close()

        for (run_id,) in rows:
            session = self.active_sessions.get(run_id)
            if session and session.get("pid"):
                try:
                    os.kill(session["pid"], 0)  # Check if PID exists
                except (ProcessLookupError, OSError):
                    update_task_status(run_id, "queued")
            else:
                update_task_status(run_id, "queued")
