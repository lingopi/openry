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
