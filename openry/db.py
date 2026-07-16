"""SQLite database operations: init, insert commands, upsert task state."""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path
from typing import Any

from .config import get_db_path

_SCHEMA = """
CREATE TABLE IF NOT EXISTS commands_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      TEXT,
    workflow    TEXT,
    step_id     TEXT,
    command     TEXT NOT NULL,
    shell       TEXT NOT NULL,
    cwd         TEXT NOT NULL,
    exit_code   INTEGER NOT NULL,
    stdout      TEXT,
    stderr      TEXT,
    duration_ms INTEGER NOT NULL,
    timeout     INTEGER NOT NULL DEFAULT 0,
    timestamp   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_commands_run_id ON commands_log(run_id);
CREATE INDEX IF NOT EXISTS idx_commands_timestamp ON commands_log(timestamp);

CREATE TABLE IF NOT EXISTS task_state (
    run_id      TEXT PRIMARY KEY,
    workflow    TEXT,
    step_id     TEXT,
    status      TEXT NOT NULL DEFAULT 'in_progress',
    payload     TEXT DEFAULT '{}',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_task_status ON task_state(status);
CREATE INDEX IF NOT EXISTS idx_task_updated ON task_state(updated_at);
"""


def _get_conn(db_path: Path | None = None) -> sqlite3.Connection:
    """Get a connection to the SQLite database, initializing schema on first access."""
    if db_path is None:
        db_path = get_db_path()
    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(_SCHEMA)
    conn.commit()
    return conn


def insert_command(
    *,
    run_id: str | None = None,
    workflow: str | None = None,
    step_id: str | None = None,
    command: str,
    shell: str,
    cwd: str,
    exit_code: int,
    stdout: str,
    stderr: str,
    duration_ms: int,
    timeout: bool = False,
) -> None:
    """Insert a command execution record into commands_log."""
    conn = _get_conn()
    conn.execute(
        """INSERT INTO commands_log
           (run_id, workflow, step_id, command, shell, cwd,
            exit_code, stdout, stderr, duration_ms, timeout)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            run_id,
            workflow,
            step_id,
            command,
            shell,
            cwd,
            exit_code,
            stdout,
            stderr,
            duration_ms,
            1 if timeout else 0,
        ),
    )
    conn.commit()
    conn.close()


def upsert_task_state(
    *,
    run_id: str,
    workflow: str | None = None,
    step_id: str | None = None,
    status: str = "in_progress",
    payload: str = "{}",
) -> None:
    """Insert or update a task state row.

    For --status calls: status should be 'completed' or 'failed'.
    For -c calls without a run_id in DB yet: status defaults to 'in_progress'.
    """
    conn = _get_conn()
    conn.execute(
        """INSERT INTO task_state (run_id, workflow, step_id, status, payload)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(run_id) DO UPDATE SET
               workflow = COALESCE(excluded.workflow, task_state.workflow),
               step_id  = COALESCE(excluded.step_id, task_state.step_id),
               status   = excluded.status,
               payload  = excluded.payload,
               updated_at = datetime('now')""",
        (run_id, workflow, step_id, status, payload),
    )
    conn.commit()
    conn.close()


# ──────────────────────────────────────────────
#  Phase 2: extended schema & orchestrator queries
# ──────────────────────────────────────────────

_PHASE2_SCHEMA_EXTENSION = """
-- Workflow instances table
CREATE TABLE IF NOT EXISTS workflow_instances (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    composition         TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'running',
    current_big_step    TEXT,
    big_step_started_at TEXT,
    timeout_minutes     INTEGER DEFAULT 10,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Worker pool state
CREATE TABLE IF NOT EXISTS worker_pool (
    slot_id     INTEGER PRIMARY KEY,
    run_id      TEXT,
    pid         INTEGER,
    allocated_at TEXT
);

-- Validation results log
CREATE TABLE IF NOT EXISTS validation_results (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      TEXT NOT NULL,
    rule_type   TEXT NOT NULL,
    rule_params TEXT,
    passed      INTEGER NOT NULL,
    message     TEXT,
    checked_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Orchestrator global config
CREATE TABLE IF NOT EXISTS orchestrator_config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

# Extended task_state columns (Phase 2 additions via ALTER TABLE)
_TASK_STATE_EXTENSION = [
    ("big_step_ref",           "TEXT"),
    ("sub_step_id",            "TEXT"),
    ("big_step_retry_count",   "INTEGER DEFAULT 0"),
    ("max_retries",            "INTEGER DEFAULT 0"),
    ("sub_step_retry_count",   "INTEGER DEFAULT 0"),
    ("max_sub_step_retries",   "INTEGER DEFAULT 0"),
    ("max_tool_calls",         "INTEGER DEFAULT 0"),
    ("max_output_tokens",      "INTEGER DEFAULT 0"),
    ("command_policy_json",    "TEXT"),
    ("validation_status",      "TEXT DEFAULT 'pending'"),
    ("cancel_requested",       "INTEGER DEFAULT 0"),
    ("output_overflow",        "INTEGER DEFAULT 0"),
    ("overflow_workflow_id",   "INTEGER"),
    ("workflow_instance_id",   "INTEGER"),
    ("on_validation_fail",     "TEXT"),
    ("on_output_overflow",     "TEXT"),
    ("previous_summary",       "TEXT"),
]


def _init_phase2_schema(db_path: Path | None = None) -> None:
    """Apply Phase 2 schema extensions to an existing Phase 1 DB."""
    conn = _get_conn(db_path)
    conn.executescript(_PHASE2_SCHEMA_EXTENSION)

    # Add missing columns to task_state (ignore if they already exist)
    existing_cols = {
        row[1] for row in conn.execute("PRAGMA table_info(task_state)").fetchall()
    }
    for col_name, col_def in _TASK_STATE_EXTENSION:
        if col_name not in existing_cols:
            try:
                conn.execute(
                    f"ALTER TABLE task_state ADD COLUMN {col_name} {col_def}"
                )
            except sqlite3.OperationalError:
                pass  # Column already exists (race condition safety)
    conn.commit()
    conn.close()


# ──────────────────────────────────────────────
#  Phase 2: orchestrator query helpers
# ──────────────────────────────────────────────


def get_conn(db_path: Path | None = None) -> sqlite3.Connection:
    """Public accessor for Phase 2 modules (reuses Phase 1 connection logic)."""
    return _get_conn(db_path)


def count_tool_calls(run_id: str) -> int:
    """Count how many times openry has been called for a given run_id."""
    conn = _get_conn()
    row = conn.execute(
        "SELECT COUNT(*) FROM commands_log WHERE run_id = ?", (run_id,)
    ).fetchone()
    conn.close()
    return row[0] if row else 0


def get_task_state(run_id: str) -> dict | None:
    """Return the full task_state row as a dict, or None."""
    conn = _get_conn()
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        "SELECT * FROM task_state WHERE run_id = ?", (run_id,)
    ).fetchone()
    conn.close()
    if row is None:
        return None
    return dict(row)


def get_cancel_requested(run_id: str) -> bool:
    """Check if Orchestrator has requested cancel for this run_id."""
    row = get_task_state(run_id)
    if row is None:
        return False
    return bool(row.get("cancel_requested", 0))


def set_cancel_requested(run_id: str) -> None:
    """Set the cancel_requested flag for a run_id."""
    conn = _get_conn()
    conn.execute(
        "UPDATE task_state SET cancel_requested = 1, updated_at = datetime('now') WHERE run_id = ?",
        (run_id,),
    )
    conn.commit()
    conn.close()


def set_output_overflow(run_id: str, overflow_workflow_id: int | None = None) -> None:
    """Mark a run_id as having output overflow."""
    conn = _get_conn()
    conn.execute(
        """UPDATE task_state
           SET output_overflow = 1,
               overflow_workflow_id = ?,
               status = 'overflow',
               updated_at = datetime('now')
           WHERE run_id = ?""",
        (overflow_workflow_id, run_id),
    )
    conn.commit()
    conn.close()


def query_queued_tasks(limit: int = 1) -> list[dict]:
    """Return queued tasks ordered by creation time."""
    conn = _get_conn()
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT * FROM task_state WHERE status = 'queued' ORDER BY created_at ASC LIMIT ?",
        (limit,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def query_zombie_tasks(zombie_minutes: int = 30) -> list[dict]:
    """Return in_progress tasks that haven't been updated in zombie_minutes."""
    conn = _get_conn()
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """SELECT * FROM task_state
           WHERE status = 'in_progress'
             AND updated_at < datetime('now', '-' || ? || ' minutes')""",
        (str(zombie_minutes),),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def query_pending_validations() -> list[dict]:
    """Return completed tasks awaiting validation."""
    conn = _get_conn()
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT * FROM task_state WHERE status = 'completed' AND validation_status = 'pending'"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def query_validated_tasks() -> list[dict]:
    """Return validated tasks ready for next_step routing."""
    conn = _get_conn()
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT * FROM task_state WHERE status = 'validated'"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def query_overflow_tasks() -> list[dict]:
    """Return tasks in overflow status."""
    conn = _get_conn()
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT * FROM task_state WHERE status = 'overflow'"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def query_cancelled_tasks() -> list[dict]:
    """Return cancelled tasks awaiting hard-kill."""
    conn = _get_conn()
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT * FROM task_state WHERE status = 'cancelled'"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def query_failed_with_retries() -> list[dict]:
    """Return failed tasks that still have retry budget."""
    conn = _get_conn()
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """SELECT * FROM task_state
           WHERE status = 'failed'
             AND big_step_retry_count < max_retries"""
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def count_active_sessions() -> int:
    """Count currently in_progress sessions (for worker pool limit)."""
    conn = _get_conn()
    row = conn.execute(
        "SELECT COUNT(*) FROM task_state WHERE status = 'in_progress'"
    ).fetchone()
    conn.close()
    return row[0] if row else 0


def update_task_status(
    run_id: str,
    status: str,
    **extra_fields: str | int | None,
) -> None:
    """Update task_state status and optional extra fields."""
    set_clauses = ["status = ?", "updated_at = datetime('now')"]
    params: list[str | int | None] = [status]

    for key, val in extra_fields.items():
        set_clauses.append(f"{key} = ?")
        params.append(val)

    params.append(run_id)
    conn = _get_conn()
    conn.execute(
        f"UPDATE task_state SET {', '.join(set_clauses)} WHERE run_id = ?",
        params,
    )
    conn.commit()
    conn.close()


def insert_validation_result(
    run_id: str,
    rule_type: str,
    rule_params: str | None,
    passed: bool,
    message: str | None = None,
) -> None:
    """Log a validation result."""
    conn = _get_conn()
    conn.execute(
        """INSERT INTO validation_results (run_id, rule_type, rule_params, passed, message)
           VALUES (?, ?, ?, ?, ?)""",
        (run_id, rule_type, rule_params, 1 if passed else 0, message),
    )
    conn.commit()
    conn.close()


def get_commands_history(run_id: str) -> list[dict]:
    """Return all commands_log entries for a run_id (for overflow context recovery)."""
    conn = _get_conn()
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT command, exit_code, stdout, stderr, duration_ms, timestamp "
        "FROM commands_log WHERE run_id = ? ORDER BY id ASC",
        (run_id,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]
