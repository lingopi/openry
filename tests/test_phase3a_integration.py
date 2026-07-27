"""Phase 3a: Integration tests — evaluate_routing with DB-backed context."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

import pytest

# Use a temp DB for tests
os.environ["OPENRY_HOME"] = ""


@pytest.fixture
def temp_openry_home():
    """Create a temporary .openry directory with a test DB."""
    with tempfile.TemporaryDirectory() as tmp:
        old_home = os.environ.get("OPENRY_HOME")
        os.environ["OPENRY_HOME"] = tmp
        try:
            yield Path(tmp)
        finally:
            if old_home:
                os.environ["OPENRY_HOME"] = old_home
            else:
                del os.environ["OPENRY_HOME"]


def _init_test_db(tmpdir: Path, payload: dict):
    """Initialize DB with a test task_state row."""
    from openry.db import _get_conn, _init_phase2_schema

    db_path = tmpdir / "openry.db"
    _init_phase2_schema(db_path)

    conn = _get_conn(db_path)
    conn.execute(
        """INSERT INTO task_state
           (run_id, workflow, step_id, big_step_ref, sub_step_id,
            status, payload, workflow_instance_id, max_tool_calls,
            max_retries, max_sub_step_retries, max_output_tokens,
            on_output_overflow, on_validation_fail)
           VALUES (?, ?, ?, ?, ?, 'completed', ?, 1, 0, 0, 0, 0, '', 'retry_current')""",
        ("test-run-001", "test_wf", "check_access", "test_big_step", "check_access",
         json.dumps(payload)),
    )
    conn.commit()
    conn.close()


# ── Full integration tests ─────────────────────────────────────


def test_evaluate_routing_all_pass(temp_openry_home):
    """All when entries pass → global on_success."""
    _init_test_db(temp_openry_home, {"status": "active", "count": 5, "role": "admin"})

    step_config = {
        "on_success": "done",
        "on_failure": "abort",
        "validation_routing": [
            {
                "when": {"type": "payload_value_equals", "key": "status", "value": "active"},
                "on_match": "continue",
                "on_mismatch": "fix_status",
            },
            {
                "when": {"type": "payload_value_greater_than", "key": "count", "threshold": 0},
                "on_match": "continue",
                "on_mismatch": "abort",
            },
            {
                "when": {"type": "payload_value_in_set", "key": "role", "values": ["admin", "editor"], "mode": "allow"},
                "on_match": "done",
                "on_mismatch": "abort",
            },
        ],
    }

    from openry.orchestrator.router import evaluate_routing
    result = evaluate_routing("test-run-001", step_config)
    assert result.action == "route"
    assert result.target == "done"


def test_evaluate_routing_first_fails_short_circuit(temp_openry_home):
    """First entry fails → short-circuit, subsequent entries not evaluated."""
    _init_test_db(temp_openry_home, {"status": "inactive", "count": 5})

    step_config = {
        "on_success": "done",
        "on_failure": "abort",
        "validation_routing": [
            {
                "when": {"type": "payload_value_equals", "key": "status", "value": "active"},
                "on_match": "continue",
                "on_mismatch": "fix_status",
            },
            # This would pass, but should never be reached
            {
                "when": {"type": "payload_value_greater_than", "key": "count", "threshold": 0},
                "on_match": "done",
                "on_mismatch": "abort",
            },
        ],
    }

    from openry.orchestrator.router import evaluate_routing
    result = evaluate_routing("test-run-001", step_config)
    assert result.action == "route"
    assert result.target == "fix_status"


def test_evaluate_routing_with_when_any(temp_openry_home):
    """when_any OR group + when combination."""
    _init_test_db(temp_openry_home, {"is_admin": False, "role": "editor", "quota": 10})

    step_config = {
        "on_success": "done",
        "on_failure": "abort",
        "validation_routing": [
            {
                "when_any": [
                    {"type": "payload_value_equals", "key": "is_admin", "value": True},
                    {"type": "payload_value_in_set", "key": "role", "values": ["editor", "reviewer"], "mode": "allow"},
                ],
                "on_match": "continue",
                "on_mismatch": "escalate",
            },
            {
                "when": {"type": "payload_value_greater_than", "key": "quota", "threshold": 0},
                "on_match": "done",
                "on_mismatch": "abort",
            },
        ],
    }

    from openry.orchestrator.router import evaluate_routing
    result = evaluate_routing("test-run-001", step_config)
    assert result.action == "route"
    assert result.target == "done"


def test_evaluate_routing_when_any_fails_short_circuit(temp_openry_home):
    """when_any all fail → short-circuit to on_mismatch."""
    _init_test_db(temp_openry_home, {"is_admin": False, "role": "viewer"})

    step_config = {
        "on_success": "done",
        "on_failure": "abort",
        "validation_routing": [
            {
                "when_any": [
                    {"type": "payload_value_equals", "key": "is_admin", "value": True},
                    {"type": "payload_value_in_set", "key": "role", "values": ["editor", "reviewer"], "mode": "allow"},
                ],
                "on_match": "continue",
                "on_mismatch": "escalate_permission",
                "on_mismatch_message": "Insufficient permissions",
            },
            # Should never be reached
            {
                "when": {"type": "payload_value_greater_than", "key": "quota", "threshold": 0},
                "on_match": "done",
                "on_mismatch": "abort",
            },
        ],
    }

    from openry.orchestrator.router import evaluate_routing
    result = evaluate_routing("test-run-001", step_config)
    assert result.action == "route"
    assert result.target == "escalate_permission"
    assert "Insufficient permissions" in result.message


def test_evaluate_routing_no_entries(temp_openry_home):
    """No validation_routing → fallthrough."""
    _init_test_db(temp_openry_home, {"x": 1})
    step_config = {"on_success": "done", "on_failure": "abort"}

    from openry.orchestrator.router import evaluate_routing
    result = evaluate_routing("test-run-001", step_config)
    assert result.action == "fallthrough"


def test_evaluate_routing_empty_entries(temp_openry_home):
    """Empty validation_routing list → fallthrough."""
    _init_test_db(temp_openry_home, {"x": 1})
    step_config = {"on_success": "done", "on_failure": "abort", "validation_routing": []}

    from openry.orchestrator.router import evaluate_routing
    result = evaluate_routing("test-run-001", step_config)
    assert result.action == "fallthrough"


# ── yaml_loader helpers ────────────────────────────────────────


def test_has_validation_routing():
    from openry.orchestrator.yaml_loader import has_validation_routing

    assert has_validation_routing({"validation_routing": [{"when": {}}]})
    assert not has_validation_routing({})
    assert not has_validation_routing({"validation_routing": []})


def test_get_validation_routing_entries():
    from openry.orchestrator.yaml_loader import get_validation_routing_entries

    entries = [{"when": {"type": "payload_value_equals", "key": "x", "value": 1}}]
    result = get_validation_routing_entries({"validation_routing": entries})
    assert result == entries

    result2 = get_validation_routing_entries({})
    assert result2 == []
